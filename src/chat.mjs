// Today AI · 请求接管（loader 的 fetch）
//
// magpie 按 provider 的 npm（@ai-sdk/openai-compatible）把请求发到
// `{baseURL}/chat/completions`，所以这里收到的是 **OpenAI Chat Completions**，
// 回给它的也必须是 OpenAI 形状 —— 中间这段「OpenAI ↔ Today canonical」由我们翻译。
//
// 一次请求要做的事：
//   ① 解析 body：model、messages、stream、stream_options
//   ② 模型 → Today 的档位（mode.power / model.glm-5.3 …），账号级开关变了才 PUT
//   ③ messages → 一条 canonical 用户消息（取最后一条 user，截断到 1 MiB 以内）
//   ④ POST /v1/messages，然后从 WebSocket（兜底轮询）拿整条快照的增量
//   ⑤ 边收边吐 SSE：chat.completion.chunk（role → content → finish_reason → usage → [DONE]）
//
// 不支持：工具调用（Today 自己跑工具，不能把 tool_calls 交回给 agent）、
// 图片/附件（要先 POST /v1/files 拿 fileRef，v1 没做）。

import { randomUUID } from "node:crypto"
import { CHAT_TIMEOUT_MS, PROMPT_MAX_CHARS } from "./constants.mjs"
import {
  ensureRegisteredDevice,
  fetchCapabilities,
  fetchPricingStatus,
  isAuthFailure,
  putModelOption,
  TodayApiError,
  uploadedFileOf,
  uploadFile,
} from "./http.mjs"
import {
  attachmentsOf,
  bodyForPrompt,
  byteLength,
  extensionOf,
  chunkFrame,
  completionFrame,
  estimateTokens,
  FALLBACK_MODEL_ID,
  promptFromMessages,
  SSE_DONE,
  truncate,
} from "./pure.mjs"
import { isFresh, optionIdForModel, optionsFromStatus, rememberOptions } from "./catalog.mjs"
import { DONE, ERROR, TEXT, streamReply } from "./stream.mjs"

// ── 错误码（magpie-community ERROR-CODES §3 词表 v1，不许自造词）──────
export const CODES = Object.freeze({
  signInRequired: "sign_in_required",
  sessionExpired: "session_expired",
  auditBlocked: "audit_blocked",
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  concurrencyConflict: "concurrency_conflict",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
})

/**
 * 把一条错误分类成 (status, code)。
 *
 * 判据只有一条（ERROR-CODES §2）：5xx = 上游那边出事了、重试有意义；
 * 4xx = 这次请求本身有问题、重试没用。分类错了，宿主会把所有号换一遍还是失败。
 */
export function classifyError(error, fallback = CODES.upstreamError) {
  const message = String(error?.message ?? error ?? "")
  if (error?.name === "TimeoutError" || error?.timeout === true) {
    return { status: 504, code: CODES.upstreamTimeout }
  }
  if (/超时|timed out|timeout|没有收到回复|无事件|已关闭|流被截断/i.test(message)) {
    return { status: 504, code: CODES.upstreamTimeout }
  }
  if (error?.status === 401 || error?.status === 403) {
    return { status: 401, code: CODES.sessionExpired }
  }
  if (error?.status === 429) return { status: 429, code: CODES.rateLimited }
  if (error?.status === 409) return { status: 409, code: CODES.concurrencyConflict }
  if (error?.status === 400) return { status: 400, code: CODES.invalidRequest }
  if (error?.status === 404) return { status: 404, code: CODES.modelNotFound }
  if (error?.status >= 500) return { status: 503, code: CODES.upstreamUnavailable }
  if (/1 ?MiB|too large|payload too large|超过.*上限/i.test(message)) {
    return { status: 400, code: CODES.invalidRequest }
  }
  return { status: 502, code: fallback }
}

/** 账号级档位：每个账号最后一次 PUT 成功的是哪个，避免每请求都打一次 */
const modeCache = new Map()

/** token → 主会话 id（一次进程内只查一次） */
const conversationCache = new Map()

async function resolveConversation({ token, deviceId, mainConversationId }) {
  if (mainConversationId) return mainConversationId
  const hit = conversationCache.get(token)
  if (hit) return hit
  try {
    const cap = await fetchCapabilities({ token, deviceId })
    if (cap?.mainConversationId) {
      conversationCache.set(token, cap.mainConversationId)
      return cap.mainConversationId
    }
  } catch {
    // 拿不到就走 WS；WS 也不可用时轮询会报错，错误信息里会说清楚
  }
  return ""
}

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function openAiError(status, message, { code = CODES.upstreamError, type = "upstream_error", headers = {} } = {}) {
  return json(status, { error: { message, type, code, status } }, headers)
}

/** R6：流式错误帧必须同时带 code 和 status */
function sseErrorFrame(error, fallbackCode) {
  const message = String(error?.message ?? error)
  const { status, code } = classifyError(error, fallbackCode)
  return `data: ${JSON.stringify({ error: { message, type: "upstream_error", code, status } })}\n\n`
}

/**
 * 入口。
 *
 * @param {object} args
 * @param {Request|string|URL} args.input
 * @param {RequestInit} [args.init]
 * @param {string} args.token         Bearer
 * @param {string} args.deviceId
 * @param {string} [args.accountKey]  账号身份（档位缓存用）
 * @param {(m: string, level?: string) => void} [args.log]
 */
export async function chatFetch({
  input,
  init,
  token,
  deviceId,
  accountKey = "",
  mainConversationId = "",
  isolation = "task",
  attachments = true,
  log = () => {},
}) {
  const request = input instanceof Request ? new Request(input, init) : null
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (request?.url ?? "")

  if (!/\/chat\/completions(\?|$)/.test(url)) {
    return openAiError(501, `Today 插件只实现 /chat/completions，收到 ${url}`, {
      code: CODES.notImplemented,
    })
  }

  let bodyText = ""
  const rawBody = request ? request.body : init?.body
  if (rawBody != null) bodyText = typeof rawBody === "string" ? rawBody : await new Response(rawBody).text()

  let payload = {}
  try {
    payload = bodyText ? JSON.parse(bodyText) : {}
  } catch {
    return openAiError(400, "请求体不是合法 JSON", { code: CODES.invalidRequest })
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : []
  if (messages.length === 0) return openAiError(400, "messages 为空", { code: CODES.invalidRequest })

  const requestedModel = String(payload.model ?? "")
  const model = requestedModel || FALLBACK_MODEL_ID
  const wantStream = payload.stream === true
  const includeUsage = payload?.stream_options?.include_usage === true || payload?.stream_options?.include_usage === undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("timeout")), CHAT_TIMEOUT_MS)
  timer.unref?.()
  const signal = request?.signal ? anySignal([request.signal, controller.signal], controller) : controller.signal

  const prompt = truncate(promptFromMessages(messages, { maxChars: PROMPT_MAX_CHARS }), PROMPT_MAX_CHARS)
  const images = attachments ? attachmentsOf(lastUserContent(messages)) : []
  if (!prompt.trim() && images.length === 0) {
    return openAiError(400, "没有可发送的用户文本", { code: CODES.invalidRequest })
  }

  // 附件：先 POST /v1/files 拿 fileRef，再把 ref 塞进 parts（正文不背 base64）
  let fileParts = []
  if (images.length > 0) {
    try {
      fileParts = await buildAttachmentParts({ token, deviceId, images, signal })
    } catch (error) {
      log(`附件上传失败，只发文本：${error?.message ?? error}`, "warning")
    }
  }

  const body = bodyForPrompt(prompt)
  for (const part of fileParts) body.parts.push(part)
  if (byteLength(body) > 1024 * 1024 - 4096) {
    return openAiError(400, "上下文超出长度限制：消息超过 Today 单条 1 MiB 上限", {
      code: CODES.invalidRequest,
    })
  }

  // 档位：账号级设置，变了才写。
  // ⚠ 两条实测教训（2026-11-03）：
  //   ① 传**不属于这个账号**的 optionId 会回 403 auth.forbidden
  //      （早期版本写死 mode.power，就是这个 403）；
  //   ② 切档失败绝不能让这轮对话失败 —— 早期版本把它当登录失效，整个请求 401，
  //      表现就是 magpie 里「测试模型不通过」。
  try {
    await ensureMode({ token, deviceId, model, accountKey: accountKey || deviceId, log })
  } catch (error) {
    log(`切档没成功（继续用账号当前档位，不影响对话）：${error?.message ?? error}`, "debug")
  }

  // 设备没注册时 WS 会被服务端拒（Device not found）；这里兜一次底
  try {
    deviceId = await ensureRegisteredDevice({ token, deviceId })
  } catch {
    // 注册失败就硬上，WS 会失败、轮询还能跑
  }

  const conversationId = await resolveConversation({ token, deviceId, mainConversationId })

  const clientMessageId = randomUUID()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`

  const sessionKey = String(request?.headers?.get("x-today-session") ?? "").slice(0, 128)
  const iterator = streamReply({
    token,
    deviceId,
    clientMessageId,
    body,
    prompt,
    mainConversationId: conversationId,
    isolation,
    sessionKey,
    accountKey: accountKey || deviceId,
    signal,
    log,
  })

  if (!wantStream) {
    try {
      let text = ""
      for await (const event of iterator) {
        if (event.type === TEXT && !event.kind) text += event.text
        if (event.type === ERROR) return upstreamError(event.error)
      }
      const usage = {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(text),
        total_tokens: estimateTokens(prompt) + estimateTokens(text),
      }
      return json(200, completionFrame({ id, model, created, text, usage }))
    } finally {
      clearTimeout(timer)
    }
  }

  // ⚠ 先把第一个事件拿到手，再决定要不要用 200 开头：
  //   SSE 一旦以 200 开始，状态码就改不了了（ERROR-CODES §5）。登录失效这种
  //   还没吐出任何正文的失败，必须**在此之前**以 401 交回去，而不是 200 + 错误帧。
  let first
  try {
    first = await iterator.next()
  } catch (error) {
    clearTimeout(timer)
    return upstreamError(error)
  }
  if (first?.done) {
    clearTimeout(timer)
    return upstreamError(new Error("Today 没有返回任何内容"))
  }
  if (first.value?.type === ERROR) {
    clearTimeout(timer)
    return upstreamError(first.value.error)
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(streamController) {
      const push = (chunk) => {
        try {
          streamController.enqueue(encoder.encode(chunk))
          return true
        } catch {
          return false
        }
      }
      push(chunkFrame({ id, model, created, delta: { role: "assistant", content: "" } }))
      let text = ""
      let finished = false
      const handle = (event) => {
        if (event?.type === "notice") {
          log(`服务端提示：${event.message}`, "debug")
          return true
        }
        if (event?.type === TEXT) {
          if (event.kind === "thinking") return true // 思考段不作为正文
          text += event.text
          return push(chunkFrame({ id, model, created, delta: { content: event.text } }))
        }
        if (event?.type === DONE) {
          finished = true
          return false
        }
        if (event?.type === ERROR) {
          push(sseErrorFrame(event.error))
          return false
        }
        return true
      }
      try {
        if (!handle(first.value)) {
          // 第一个事件就是收尾
        } else {
          for await (const event of iterator) {
            if (signal.aborted) break
            if (!handle(event)) break
          }
        }
      } catch (error) {
        push(sseErrorFrame(error))
      } finally {
        clearTimeout(timer)
        if (finished) {
          if (includeUsage) {
            push(
              chunkFrame({
                id,
                model,
                created,
                delta: {},
                usage: {
                  prompt_tokens: estimateTokens(prompt),
                  completion_tokens: estimateTokens(text),
                  total_tokens: estimateTokens(prompt) + estimateTokens(text),
                },
              }),
            )
          }
          push(chunkFrame({ id, model, created, delta: {}, finishReason: "stop" }))
          push(SSE_DONE)
        }
        try {
          streamController.close()
        } catch {
          // 客户端先断了
        }
      }
    },
    cancel() {
      clearTimeout(timer)
      controller.abort(new Error("client closed"))
      iterator.return?.()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-today-model": model,
    },
  })
}

/** 最后一条 user 消息的 content（图片在里面） */
function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i]?.content
  }
  return undefined
}

/**
 * 把附件上传成 canonical parts。
 *
 * data URL 解码后直接传字节；http(s) 的先下回来再上传 —— Today 的 part 只认自己
 * 文件系统里的 fileRef，不认外部 URL。
 */
async function buildAttachmentParts({ token, deviceId, images, signal }) {
  const parts = []
  for (const image of images) {
    let data = null
    let mimeType = image.mimeType ?? "image/png"
    if (image.kind === "data") {
      data = Buffer.from(image.base64, "base64")
    } else {
      const response = await fetch(image.url, { signal, redirect: "follow" })
      if (!response.ok) throw new TodayApiError(`下载附件失败：HTTP ${response.status}`, { phase: "upload" })
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim()
      if (type.startsWith("image/")) mimeType = type
      data = Buffer.from(await response.arrayBuffer())
    }
    if (!data || data.length === 0) continue
    if (data.length > 20 * 1024 * 1024) throw new TodayApiError("附件超过 20 MB", { phase: "upload" })
    const file = await uploadFile({
      token,
      deviceId,
      data,
      filename: `image.${extensionOf(mimeType)}`,
      mimeType,
      signal,
    })
    parts.push({
      id: file.id,
      type: file.type === "image" ? "image" : "file",
      uploadedFile: uploadedFileOf(file),
    })
  }
  return parts
}

/**
 * 档位切换：同一账号同一档位只 PUT 一次。
 *
 * 这个端点是**账号级**的，而且不是每个账号都能写（403 auth.forbidden 实测见过）。
 * 所以：成功就记下来别重复打；失败就把这个账号标成「写不动」，之后本进程不再试，
 * 也绝不把错误抛给对话。
 */
const modeInaccessible = new Set()

async function ensureMode({ token, deviceId, model, accountKey, log }) {
  if (modeInaccessible.has(accountKey)) return
  if (!isFresh(accountKey)) {
    try {
      const status = await fetchPricingStatus({ token, deviceId })
      const parsed = optionsFromStatus({ data: { status } })
      if (parsed) rememberOptions(accountKey, parsed)
    } catch {
      // 拉不到目录就不切档，用账号当前档位
    }
  }
  const optionId = optionIdForModel(model, accountKey)
  if (!optionId) {
    log(`模型 ${model} 不在这个账号的档位表里，按账号当前档位跑`, "debug")
    return
  }
  const key = `${accountKey}\n${optionId}`
  if (modeCache.get(key)) return
  try {
    await putModelOption({ token, deviceId, optionId })
    modeCache.set(key, Date.now())
    log(`已把 Today 档位切到 ${optionId}`, "debug")
  } catch (error) {
    const status = Number(error?.status) || 0
    if (status === 401 || status === 403) {
      modeInaccessible.add(accountKey)
      log(
        `这个账号不能通过 API 切档（${status} ${error?.code ?? ""}），后续按账号当前档位跑：${error?.message ?? error}`,
        "warning",
      )
      return
    }
    throw error
  }
}

function authExpired(error) {
  // R5：这是真的登录失效，才允许 magpie 摘账号
  return openAiError(401, String(error?.message ?? "Today 登录已失效"), {
    code: CODES.sessionExpired,
    headers: { "x-magpie-sign-in": "expired" },
  })
}

function upstreamError(error) {
  if (isAuthFailure(error)) return authExpired(error)
  const message = String(error?.message ?? error)
  const { status, code } = classifyError(error)
  return json(status, { error: { message, type: "upstream_error", code, status } })
}

/** 把一个 abort 信号和超时信号合成一个 */
function anySignal(signals, controller) {
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      return controller.signal
    }
    s.addEventListener?.("abort", () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}