// Today AI · 会话（magpie session ↔ Today task conversation）
//
// 为什么不用主会话：Today 只有**一个**主会话（`mainConversationId`）。所有 agent
// 的请求都灌进那一条对话，会互相串台，也会盖住用户自己平时的聊天。
//
// 实测（2026-11-03）确认可用的隔离方式：
//
//   POST /v1/messages { clientMessageId, body:{parts}, target:{type:"new_task",surface:"task_panel"} }
//     → 202 { canonicalMessage:{ conversationId, taskId, threadId } }
//   POST /v1/messages { isMainChat:false, conversationId, taskId?, clientMessageId, body:{parts} }
//     → 202（往同一条会话里追加）
//   GET  /v1/conversations/messages?conversationId=<它>  → 200（历史、轮询都通）
//
// 所以：**一个 magpie session 一条 Today 会话**。session id 由 magpie 的
// `chat.headers` 钩子以 `x-today-session` 头传进来（见 index.mjs）。
//
// 代价：每个 session 在 Today 的 Tasks 里会留下一条任务记录。不想要就设
// 插件选项 `isolation:"main"`，退回单条主会话。

const TTL_MS = 7 * 24 * 3600_000
const MAX_ENTRIES = 200

/** key → { conversationId, taskId, at } */
const bySession = new Map()

function keyOf(accountKey, sessionKey) {
  return `${accountKey ?? ""}\n${sessionKey ?? ""}`
}

export function conversationOf(accountKey, sessionKey) {
  const hit = bySession.get(keyOf(accountKey, sessionKey))
  if (!hit) return null
  if (Date.now() - hit.at > TTL_MS) {
    bySession.delete(keyOf(accountKey, sessionKey))
    return null
  }
  return hit
}

export function rememberConversation(accountKey, sessionKey, { conversationId, taskId }) {
  if (!conversationId) return null
  const key = keyOf(accountKey, sessionKey)
  const value = { conversationId, taskId: taskId ?? null, at: Date.now() }
  bySession.delete(key) // 重新插入，保持 LRU 顺序
  bySession.set(key, value)
  while (bySession.size > MAX_ENTRIES) {
    const oldest = bySession.keys().next().value
    bySession.delete(oldest)
  }
  return value
}

export function forgetConversation(accountKey, sessionKey) {
  bySession.delete(keyOf(accountKey, sessionKey))
}

/** 测试用 */
export function resetSessions() {
  bySession.clear()
}

export function sessionCount() {
  return bySession.size
}