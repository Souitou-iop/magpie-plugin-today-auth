// Today AI · 回复流
//
// 两条路，一条主用一条兜底：
//
//  ① WebSocket（主路，和 web 客户端一模一样）
//     POST /ws-ticket → {ticket}
//     wss://api.todayai.cn/ws?ticket=<ticket>
//     开连后 {type:"device.hello", deviceId, tools:[], messageProtocolVersion:"canonical-v1"}
//     服务端回 {type:"cloud.hello_ack", sessionId, heartbeatIntervalMs, messageProtocolVersion}
//     {type:"client.status", inChat:true}
//     之后服务端推 {type:"event.push", id, timestamp, seq, payload:{event, data}}
//        event = chat.message_ready.v2 / chat.message_updated.v2 / chat.presentation.updated.v1
//                 chat.run_completed.v2 / chat.run_failed.v2
//     每收一帧要回 {type:"client.received", originId, originType, originSeq, originTimestamp}
//     心跳 {type:"device.heartbeat", deviceId}，间隔由 hello_ack 给（默认 30s）
//
//  ② HTTP 轮询（兜底）
//     GET /v1/conversations/messages?conversationId=<main>&after=<cursor>&limit=50
//     这是 web 客户端自己的 catch-up 路径（canonical.sync.thinking_fallback），
//     断线重连、实时通道被代理掐掉时它就是这么补的。
//
// 两条路产出同一种东西：**整条快照**。文本增量由 pure.mjs 的 deltaOf 算，
// 所以哪条路先到都不会把一段话发两遍。

import { API_BASE, IDLE_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_PAGE_LIMIT, WS_SETUP_TIMEOUT_MS } from "./constants.mjs"
import { appendMessage, fetchHistory, fetchWsTicket } from "./http.mjs"
import { deltaOf, isMessageDone, isReplyTo, textOfMessage, bodyForPrompt } from "./pure.mjs"

const WS_GLOBAL = () => globalThis.WebSocket

/** 生成器产出的三种东西 */
export const TEXT = "text"
export const DONE = "done"
export const ERROR = "error"

/**
 * 跑一轮对话。
 *
 * @returns async generator，产出 {type:"text"|"done"|"error", ...}
 */
export async function* streamReply({
  token,
  deviceId,
  clientMessageId,
  prompt,
  body,
  isMainChat = true,
  conversationId,
  mainConversationId,
  signal,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  log = () => {},
}) {
  const local = new AbortController()
  const forwardAbort = () => local.abort(signal?.reason ?? new Error("aborted"))
  if (signal) {
    if (signal.aborted) forwardAbort()
    else signal.addEventListener("abort", forwardAbort, { once: true })
  }
  const cleanupAbort = () => signal?.removeEventListener?.("abort", forwardAbort)

  const state = { answer: "", thinking: "", done: false }
  let socket = null
  try {
    const messageBody = body ?? bodyForPrompt(prompt)
    const target = conversationId ?? mainConversationId

    // ① 先把 WS 连上 —— 反过来会漏掉「刚发出去就推回来」的头几帧
    let wsFailure = null
    try {
      socket = await openCloudSocket({ token, deviceId, signal: local.signal, log })
    } catch (error) {
      wsFailure = error
      if (local.signal.aborted) throw error
      log(`WebSocket 不可用，改用轮询：${error?.message ?? error}`, "debug")
    }

    // ①.5 轮询需要「发这条消息之前」的游标，否则第一次轮询会把自己的用户消息当成回复
    let cursor = null
    if (!socket && target) {
      cursor = await latestCursor(token, deviceId, target, local.signal).catch(() => null)
    }

    // ② 追加消息
    let userMessage = null
    try {
      const accepted = await appendMessage({
        token,
        deviceId,
        clientMessageId,
        body: messageBody,
        isMainChat,
        conversationId,
        signal: local.signal,
      })
      userMessage = accepted.message
    } finally {
      // 发不出去就没什么可等的了
    }

    // ③ 收
    if (socket) {
      const pump = pumpSocket(socket, { clientMessageId, state, idleTimeoutMs, signal: local.signal })
      let fellBack = false
      try {
        for await (const event of pump) {
          if (event.type === ERROR) {
            // 流断了：还有轮询这条路
            log(`实时通道中断，改用轮询补齐：${event.error?.message ?? event.error}`, "debug")
            fellBack = true
            break
          }
          yield event
          if (event.type === DONE) return
        }
      } finally {
        pump.return?.()
      }
      if (!fellBack) return
      yield* pollUntilDone({
        token,
        deviceId,
        conversationId: target,
        after: cursor,
        clientMessageId,
        state,
        idleTimeoutMs,
        signal: local.signal,
      })
      return
    }

    if (!userMessage && !target) {
      yield { type: ERROR, error: new Error(wsFailure?.message ?? "没有可用的接收通道") }
      return
    }

    yield* pollUntilDone({
      token,
      deviceId,
      conversationId: target,
      after: cursor,
      clientMessageId,
      state,
      idleTimeoutMs,
      signal: local.signal,
    })
  } finally {
    cleanupAbort()
    try {
      socket?.close()
    } catch {
      // 关不掉就算了
    }
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────

/**
 * 建连并完成握手。
 *
 * 失败一律抛 —— 上层据此改走轮询。**不要**在这里重试：ticket 是一次性的，
 * 一个坏 ticket 重试十次也不会变好，只会把首字延迟拖到十秒。
 */
async function openCloudSocket({ token, deviceId, signal, log }) {
  const WebSocketImpl = WS_GLOBAL()
  if (typeof WebSocketImpl !== "function") throw new Error("这个运行时没有 WebSocket")
  const { ticket, webSocketUrl } = await fetchWsTicket({ token, deviceId, signal })
  const url = wsUrlOf(webSocketUrl, ticket)

  const socket = new WebSocketImpl(url)
  const frames = []
  const waiters = []
  let closed = false

  const pushFrame = (data) => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(data)
    else frames.push(data)
  }

  /**
   * 取下一帧。
   *
   * timeoutMs 到点就**把 waiter 摘掉**再 reject —— 只 reject 不摘，会留下一个
   * 已经死掉的 waiter：下一帧喂给它，真正等帧的那个调用就丢了一帧（曾经踩过）。
   */
  const nextFrame = (timeoutMs = 0) => {
    if (frames.length > 0) return Promise.resolve(frames.shift())
    if (closed) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          const error = new Error("idle")
          error.name = "TimeoutError"
          error.timeout = true
          reject(error)
        }, timeoutMs)
        timer.unref?.()
      }
      waiter.resolve = (value) => {
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      waiters.push(waiter)
    })
  }

  socket.addEventListener("message", (event) => {
    let parsed = null
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data))
    } catch {
      return
    }
    pushFrame(parsed)
  })
  socket.addEventListener("close", () => {
    closed = true
    for (const w of waiters.splice(0)) w.resolve(null)
  })
  socket.addEventListener("error", () => {
    closed = true
    for (const w of waiters.splice(0)) w.resolve(null)
  })

  await withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("close", () => reject(new Error("WebSocket 一开就关了")), { once: true })
      socket.addEventListener("error", () => reject(new Error("WebSocket 建连失败")), { once: true })
    }),
    WS_SETUP_TIMEOUT_MS,
    "WebSocket 建连超时",
  )

  const send = (payload) => {
    try {
      socket.send(
        JSON.stringify({
          id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          timestamp: new Date().toISOString(),
          ...payload,
        }),
      )
      return true
    } catch {
      return false
    }
  }

  send({ type: "device.hello", deviceId, tools: [], messageProtocolVersion: "canonical-v1" })

  let ack
  try {
    ack = await nextFrame(WS_SETUP_TIMEOUT_MS)
  } catch {
    throw new Error("等 hello_ack 超时")
  }
  if (!ack) throw new Error("握手期间连接被关闭")
  if (ack.type === "cloud.resume_failed") throw new Error("服务端拒绝了续连")
  if (ack.type !== "cloud.hello_ack") throw new Error(`握手失败：收到 ${ack.type ?? "未知帧"}`)

  const heartbeatMs = clamp(Number(ack.heartbeatIntervalMs) || 30_000, 1_000, 60_000)
  const heartbeat = setInterval(() => send({ type: "device.heartbeat", deviceId }), heartbeatMs)
  heartbeat.unref?.()

  // ⚠ 不要发 {type:"client.status"}：真服务端会回一帧
  //   {"type":"error","message":"Invalid input"}（实测 2026-11-03），
  //   而 chat.* 事件与它无关，不发也照推。

  log(`WebSocket 已连上（心跳 ${Math.round(heartbeatMs / 1000)}s）`, "debug")

  return {
    send,
    nextFrame,
    close() {
      clearInterval(heartbeat)
      closed = true
      try {
        socket.close(1000, "done")
      } catch {
        // ignore
      }
    },
  }
}

/** API_BASE → 同一主机的 /ws（wss） */
function wsBase() {
  try {
    const u = new URL(API_BASE)
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
    u.pathname = "/ws"
    return u.toString()
  } catch {
    return "wss://api.todayai.cn/ws"
  }
}

function wsUrlOf(overrideUrl, ticket) {
  // 服务端可能用 x-websocket-url 指定地址；只接受同源的 ws(s) 地址
  const base = overrideUrl && /^wss?:\/\//i.test(overrideUrl) ? overrideUrl : wsBase()
  let url
  try {
    url = new URL(base)
  } catch {
    url = new URL(wsBase())
  }
  if (url.protocol === "https:") url.protocol = "wss:"
  if (url.protocol === "http:") url.protocol = "ws:"
  if (!url.pathname || url.pathname === "/") url.pathname = "/ws"
  url.searchParams.set("ticket", ticket)
  return url.toString()
}

/** 从 WS 抽事件，直到我们这条回复收完 / 断线 / 空闲超时 */
async function* pumpSocket(socket, { clientMessageId, state, idleTimeoutMs, signal }) {
  let lastEventAt = Date.now()
  while (true) {
    if (signal?.aborted) {
      yield { type: ERROR, error: signal.reason ?? new Error("aborted") }
      return
    }
    if (Date.now() - lastEventAt > idleTimeoutMs) {
      yield { type: ERROR, error: new Error(`实时通道 ${Math.round(idleTimeoutMs / 1000)}s 无事件`) }
      return
    }
    let frame
    try {
      frame = await socket.nextFrame(Math.min(5_000, idleTimeoutMs))
    } catch (error) {
      // 只是这一段没帧：回到循环顶部重算空闲时间
      if (error?.timeout === true || error?.name === "TimeoutError") continue
      yield { type: ERROR, error }
      return
    }
    if (!frame) {
      yield { type: ERROR, error: new Error("实时通道已关闭") }
      return
    }
    lastEventAt = Date.now()

    if (frame.type === "event.push") {
      ackFrame(socket, frame)
      const payload = frame.payload ?? {}
      const event = String(payload.event ?? "")
      const data = payload.data ?? payload
      if (/^chat\.(message_ready|message_updated)\.v2$/.test(event)) {
        const message = data?.message ?? normalizeLegacyMessage(data)
        if (!message || !isReplyTo(message, clientMessageId)) continue
        for (const piece of applySnapshot(state, message)) yield piece
        if (isMessageDone(message)) {
          yield { type: DONE, state }
          return
        }
      } else if (event === "chat.presentation.updated.v1") {
        const working = data?.working
        const message = working?.current ? { ...working.current, role: "assistant", body: { parts: [working.current] } } : null
        if (message) for (const piece of applySnapshot(state, message, { thinkingOnly: true })) yield piece
        if (working?.current?.state === "completed" && state.answer) {
          yield { type: DONE, state }
          return
        }
      } else if (event === "chat.run_completed.v2" || event === "chat.run_failed.v2") {
        if (event === "chat.run_failed.v2") {
          yield { type: ERROR, error: new Error(String(data?.error ?? data?.failureType ?? "Today 服务端报告 run 失败")) }
          return
        }
        if (state.answer) {
          yield { type: DONE, state }
          return
        }
      } else if (event === "error") {
        yield { type: ERROR, error: new Error(String(data?.message ?? "服务端 error 帧")) }
        return
      }
      continue
    }

    if (frame.type === "error") {
      // 单帧被拒（例如 client.status 这种非必需帧）不代表流断了：
      // 真正的断开由 nextFrame 返回 null / 空闲看门狗发现。
      yield { type: "notice", message: String(frame.message ?? frame.code ?? "服务端 error 帧") }
      continue
    }
    if (frame.type === "cloud.resume_failed") {
      yield { type: ERROR, error: new Error("服务端拒绝了续连") }
      return
    }
    // cloud.hello_ack / cloud.devices_updated / 心跳应答之类：忽略
  }
}

function ackFrame(socket, frame) {
  if (typeof frame?.id !== "string" || typeof frame?.timestamp !== "string") return
  const payload = frame.payload ?? {}
  socket.send({
    type: "client.received",
    originId: frame.id,
    originType: typeof payload.event === "string" ? payload.event : frame.type,
    ...(typeof frame.seq === "number" ? { originSeq: frame.seq } : {}),
    originTimestamp: frame.timestamp,
  })
}

/** 老形态（chat.message_ready 的前身）把 parts 放在 messages[] 里 */
function normalizeLegacyMessage(data) {
  if (!data || typeof data !== "object") return null
  if (!Array.isArray(data.messages)) return null
  return {
    id: data.id,
    conversationId: data.threadId,
    role: data.role,
    state: data.isFinal ? "completed" : (data.state ?? "in_progress"),
    isFinal: data.isFinal === true,
    originClientMessageId: data.originClientMessageId,
    originClientMessageIds: data.originClientMessageIds,
    body: { parts: data.messages },
  }
}

/**
 * 把一条快照折成增量。
 *
 * 返回要吐给上层的片段数组（可能是 0 个，也可能是 text + done）。
 * thinkingOnly 时只取思考段，不产生正文。
 */
function applySnapshot(state, message, { thinkingOnly = false } = {}) {
  const { answer, thinking } = textOfMessage(message)
  const out = []
  if (thinking && thinking.length > state.thinking.length) {
    const delta = thinking.slice(state.thinking.length)
    state.thinking = thinking
    out.push({ type: TEXT, kind: "thinking", text: delta })
  }
  if (!thinkingOnly && answer) {
    const step = deltaOf(state.answer, answer)
    if (step.text) out.push({ type: TEXT, text: step.text })
    state.answer = step.total
  }
  return out
}

// ── HTTP 轮询 ─────────────────────────────────────────────────────────

async function latestCursor(token, deviceId, conversationId, signal) {
  const page = await fetchHistory({ token, deviceId, conversationId, limit: 1, signal })
  const last = page.items[page.items.length - 1]
  return last?.cursor ?? page.nextCursor ?? null
}

async function* pollUntilDone({ token, deviceId, conversationId, after, clientMessageId, state, idleTimeoutMs, signal }) {
  if (!conversationId) {
    yield { type: ERROR, error: new Error("没有 conversationId，无法轮询") }
    return
  }
  let cursor = after ?? null
  let lastProgressAt = Date.now()
  let sawReply = false
  while (true) {
    if (signal?.aborted) {
      yield { type: ERROR, error: signal.reason ?? new Error("aborted") }
      return
    }
    if (Date.now() - lastProgressAt > idleTimeoutMs) {
      yield {
        type: ERROR,
        error: new Error(`等了 ${Math.round(idleTimeoutMs / 1000)}s 没有收到回复（上游可能仍在生成）`),
      }
      return
    }
    let page
    try {
      page = await fetchHistory({
        token,
        deviceId,
        conversationId,
        after: cursor ?? undefined,
        limit: POLL_PAGE_LIMIT,
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      await sleep(POLL_INTERVAL_MS * 2, signal)
      continue
    }
    for (const message of page.items) {
      if (!isReplyTo(message, clientMessageId)) continue
      sawReply = true
      let emitted = false
      for (const piece of applySnapshot(state, message)) {
        emitted = true
        yield piece
      }
      if (emitted) lastProgressAt = Date.now()
      if (isMessageDone(message)) {
        yield { type: DONE, state }
        return
      }
    }
    cursor = page.nextCursor ?? page.items[page.items.length - 1]?.cursor ?? cursor
    if (!sawReply) lastProgressAt = Date.now() // 还没出现回复，不算空闲
    await sleep(POLL_INTERVAL_MS, signal)
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", done)
      resolve()
    }
    signal?.addEventListener?.("abort", done, { once: true })
  })
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(label)
      error.name = "TimeoutError"
      error.timeout = true
      reject(error)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}