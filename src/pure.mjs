// Today AI · 纯函数
//
// 这里只放**不碰网络、不碰宿主**的东西，好处是能用 node --test 单独锁住：
//   · canonical 消息 → 文本（增量差分就是靠它）
//   · OpenAI 请求体 → 一条 Today 消息
//   · Set-Cookie 合并、JWT 过期时间
//   · 模型目录（mode.* / model.*）

import { createHash, randomUUID } from "node:crypto"

// ── 模型 ──────────────────────────────────────────────────────────────
//
// ⚠ 不要在这个文件里写死 Today 的档位表。实测（2026-11-03）：web 构建的 mock
//   里是 `mode.fast/balanced/power`，而真账号下发的是
//   `model.deepseek-v4.1-flash / model.minimax-m31-flash / model.glm-5.3`。
//   账号、套餐、地区都会变，所以目录一律**从 `/v1/pricing/status` 现拉**，
//   见 src/catalog.mjs。这里只留一个「未登录时的兜底模型」。

/** 未登录 / 拉不到目录时的唯一兜底：不切档，用账号当前档位 */
export const FALLBACK_MODEL_ID = "today"
export const FALLBACK_MODEL_NAME = "Today AI（账号当前档位）"

// ── canonical 消息 → 文本 ─────────────────────────────────────────────

const ANSWER_PART_TYPES = new Set(["turn", "text", "markdown"])

/** content.text 可能是字符串、字符串数组（流式分段，要首尾相接）或缺失 */
export function textOf(value) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  let out = ""
  for (const s of value) if (typeof s === "string") out += s
  return out
}

/**
 * 一条 canonical 消息的正文 → { answer, thinking }。
 *
 * 结构是 body.parts[]，每项 { messageType, content }：
 *   messageType "turn"  content.text 是**分段数组**，拼接才是全文
 *   content.presentation "thinking"  → 思考过程，不算回答
 *   其余类型（card / tool / task …）一律忽略
 */
export function textOfMessage(message) {
  let answer = ""
  let thinking = ""
  for (const part of message?.body?.parts ?? []) {
    const content = part?.content
    if (!content || typeof content !== "object") continue
    const chunk = textOf(content.text)
    if (!chunk) continue
    if (content.presentation === "thinking") {
      thinking += chunk
      continue
    }
    if (ANSWER_PART_TYPES.has(part?.messageType)) answer += chunk
  }
  return { answer, thinking }
}

/**
 * 增量：新快照相对已发出文本的尾巴。
 *
 * 服务端下发的永远是**整条快照**，不是 delta。正常情况下前缀不变、只变长；
 * 极少数情况（revision 回滚、服务端改写）前缀会变 —— 这时按「已发多少字符
 * 之后就重发」处理，只补尾巴，不重发开头，避免客户端把一段话显示两遍。
 */
export function deltaOf(previous, next) {
  const p = typeof previous === "string" ? previous : ""
  const n = typeof next === "string" ? next : ""
  if (n.length >= p.length && n.startsWith(p)) return { text: n.slice(p.length), total: n }
  if (n.length > p.length) return { text: n.slice(p.length), total: n }
  // 变短：不动。等下一次快照。
  return { text: "", total: p }
}

/** 这条助手消息是不是对我这条用户消息的回复 */
export function isReplyTo(message, clientMessageId) {
  if (!message || !clientMessageId) return false
  if (message.role !== "assistant") return false
  if (message.originClientMessageId === clientMessageId) return true
  const many = message.originClientMessageIds
  return Array.isArray(many) && many.includes(clientMessageId)
}

/** 这条消息收完了没有 */
export function isMessageDone(message) {
  if (!message) return false
  if (message.isFinal === true) return true
  return message.state === "completed" || message.state === "interrupted"
}

// ── OpenAI 请求 → Today 消息 ──────────────────────────────────────────

function contentToText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const piece of content) {
    if (typeof piece === "string") {
      out += piece
      continue
    }
    if (piece?.type === "text" && typeof piece.text === "string") out += piece.text
    // 图片/音频不走 Today 的附件通道（需要先 POST /v1/files 拿 fileRef），
    // 直接跳过，别把 base64 塞进正文把 1 MiB 撑爆
  }
  return out
}

/**
 * OpenAI messages → 一条 Today 消息的正文。
 *
 * Today 是一个**会话式 agent**：它自己有历史、有记忆、有工具。把 agent 的
 * 完整对话历史灌进一条消息既超 1 MiB，也会让它的记忆和我们的历史打架。
 * 所以取**最后一条 user 消息**作为输入；它通常已经包含了 agent 拼好的上下文
 * （system prompt + 历史摘要在里面）。
 *
 * 只有拿不到 user 消息时（少见：magpie 的 classify/decide 这类调用）才退化成
 * 把整段对话拍平。
 */
export function promptFromMessages(messages, { maxChars = 180_000 } = {}) {
  const list = Array.isArray(messages) ? messages : []
  let picked = ""
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.role !== "user") continue
    const t = contentToText(m.content).trim()
    if (t) {
      picked = t
      break
    }
  }
  if (!picked) {
    const flat = []
    for (const m of list) {
      const t = contentToText(m?.content).trim()
      if (t) flat.push(`${m?.role ?? "user"}: ${t}`)
    }
    picked = flat.join("\n\n").trim()
  }
  return truncate(picked, maxChars)
}

/**
 * 截断：留头 60% + 尾 40%。
 *
 * 头留着是因为 agent 的 system prompt / 任务说明在前面，尾巴一般是当前这一步
 * 的指令 —— 中间的历史最不值钱。
 */
export function truncate(text, maxChars) {
  const s = typeof text === "string" ? text : ""
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 180_000
  if (s.length <= limit) return s
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return (
    s.slice(0, head) +
    `\n\n…（上下文过长，中间 ${s.length - limit} 字符已省略）…\n\n` +
    s.slice(-tail)
  )
}

/** 一条 canonical 用户消息的 body（POST /v1/messages 的 body 字段） */
export function bodyForPrompt(prompt) {
  return {
    parts: [{ id: randomUUID(), type: "text", text: String(prompt ?? "") }],
  }
}

/** JSON 字节数，用来守住 1 MiB 上限 */
export function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")
}

// ── 认证 ──────────────────────────────────────────────────────────────

/** Set-Cookie 数组 → 一个 Cookie 请求头的值（同名取最后一个，服务端说的算） */
export function cookieFromSetCookies(list) {
  const jar = new Map()
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== "string") continue
    const first = raw.split(";")[0]
    const eq = first.indexOf("=")
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name || /^max-age$/i.test(name)) continue
    if (value === "" || value === "deleted") {
      jar.delete(name)
      continue
    }
    jar.set(name, value)
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
}

/** 已经是一段 Cookie 头的话，原样收；多行/带 "Cookie:" 前缀的都容错 */
export function normalizeCookieInput(raw) {
  let s = String(raw ?? "").trim()
  if (!s) return ""
  // 从抓包工具里粘出来的整段头
  s = s.replace(/^\s*cookie\s*:\s*/i, "")
  s = s.replace(/[\r\n]+/g, "; ")
  const parts = s
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
  return parts.join("; ")
}

/** JWT 的 exp → 毫秒时间戳；不是 JWT 就 null */
export function jwtExpiryMs(token) {
  const s = String(token ?? "")
  const bits = s.split(".")
  if (bits.length < 2) return null
  try {
    const json = Buffer.from(bits[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    const exp = JSON.parse(json)?.exp
    return typeof exp === "number" ? exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * 设备 id：web 端是 localStorage 里的 `web_<uuid>`，我们按账号种子生成一个
 * 稳定的（同一账号每次启动都一样，服务端不会看到一堆设备）。
 */
export function deviceIdFor(seed) {
  const h = createHash("sha256").update(String(seed ?? "")).digest("hex")
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
  return `web_${uuid}`
}

// ── SSE ───────────────────────────────────────────────────────────────

/** OpenAI chat.completion.chunk 的一帧 */
export function chunkFrame({ id, model, created, delta, finishReason = null, usage }) {
  const frame = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: delta ?? {}, finish_reason: finishReason }],
  }
  if (usage) frame.usage = usage
  return `data: ${JSON.stringify(frame)}\n\n`
}

export const SSE_DONE = "data: [DONE]\n\n"

/** 非流式的整条响应 */
export function completionFrame({ id, model, created, text, usage }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage,
  }
}

/** 估算 token（上游不给 token 数，只能粗算：英文 4 字符≈1，中文 1.6 字符≈1） */
export function estimateTokens(text) {
  const s = typeof text === "string" ? text : ""
  let cjk = 0
  for (const ch of s) if (ch.codePointAt(0) > 0x2e80) cjk++
  const rest = s.length - cjk
  return Math.ceil(cjk / 1.6 + rest / 4)
}
// ── 静态模型表 ────────────────────────────────────────────────────────

/**
 * 未登录 / 拉目录失败时的兜底表。
 *
 * ⚠ 必须有内容：magpie 的卡片在未登录时也读它，空表显示 "0 models"。
 * 只有一个模型 —— 因为「有哪些档位」只有登录后才知道（见 src/catalog.mjs），
 * 编一个假表比只给一个诚实的兜底更糟。
 */
export function staticModels(npm = "@ai-sdk/openai-compatible") {
  return {
    [FALLBACK_MODEL_ID]: {
      id: FALLBACK_MODEL_ID,
      name: FALLBACK_MODEL_NAME,
      api: { id: FALLBACK_MODEL_ID, url: "https://api.todayai.cn", npm },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200_000, output: 64_000 },
      modalities: { input: ["text"], output: ["text"] },
      capabilities: {
        temperature: false, // Today 不接受采样参数，档位是账号级的
        reasoning: false,
        toolcall: false, // 工具在 Today 自己那侧运行
        attachment: false,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true },
      },
    },
  }
}
