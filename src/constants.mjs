// Today AI · 常量与端点
//
// 全部来自 today-macos-arm64.dmg（Today 1.24.0 / today-desktop-cn）与
// web.todayai.cn 的构建产物，实测于 2026-11-03。
//
//   app.asar → dist/app/app/index.js   云端配置（apiBaseUrl / oidcClientId / audience）
//   web → _next chunks                请求头、/api/token、canonical 协议

export const PROVIDER = "today"
export const PROVIDER_NAME = "Today AI"

/** API 主机：Bearer 全走这里。来自 DESKTOP_CLOUD_PUBLIC_CONFIG_DEFAULTS.prod */
const env = (key, fallback) => {
  const v = globalThis.process?.env?.[key]
  return typeof v === "string" && v.trim() ? v.trim().replace(/\/+$/, "") : fallback
}

export const API_BASE = env("TODAY_API_BASE", "https://api.todayai.cn")
/** Web 主机：会话 cookie 在这里，`POST /api/token` 在这里（auth 也会回它） */
export const WEB_BASE = env("TODAY_WEB_BASE", "https://todayai.cn")
/** better-auth 实例：手机号验证码登录在这里 */
export const AUTH_BASE = env("TODAY_AUTH_BASE", "https://auth.todayai.cn")

/** /api/token 的 audience —— 必须与 JWT 的 aud 一致，否则 API 回 401 */
export const AUDIENCE = "https://api.todayai.cn"
/** better-auth 的 OIDC 客户端（桌面端 today-connector 用的那一个） */
export const OIDC_CLIENT_ID = "Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx"

/** X-App-Version：web 构建里写死的 "2.0.0"（APP_VERSION_HEADER_VALUE） */
export const APP_VERSION = "2.0.0"
/** X-Client-Capabilities：照抄 web 的 CLIENT_CAPABILITIES_HEADER_VALUE */
export const CLIENT_CAPABILITIES =
  "chat.automation_card.v1,chat.brief_card.v1,chat.browser.v1,chat.connector_automation_card.v1," +
  "chat.connector_auth_card.v1,chat.follow_up_recommendations.v1,chat.qa_single_select.immediate.v1," +
  "chat.qa_cardflow_single.v1,chat.message_reactions.unicode.v1,connectors.account_management.v1," +
  "pricing.cn_usage_locked_recovery.v1"
/** X-Client-Platform：桌面端是 "macos"，web 是 "web"。用 web 更好掩盖「不是客户端」 */
export const CLIENT_PLATFORM = "web"

/** 单条消息追加的请求体上限（canonical message body ≤ 1 MiB，schema 里写死的） */
export const BODY_LIMIT_BYTES = 1024 * 1024
/** 提示词截断上限（字符）—— 留出 JSON 转义与 parts 包装的余量 */
export const PROMPT_MAX_CHARS = 180_000

/** 一条回复最长等多久 */
export const CHAT_TIMEOUT_MS = 30 * 60_000
/** 多久没有任何事件就认定这条流死了 */
export const IDLE_TIMEOUT_MS = 90_000
/** WS 建连（拿 ticket + hello_ack）多久算失败 */
export const WS_SETUP_TIMEOUT_MS = 8_000
/** 轮询回退的间隔 */
export const POLL_INTERVAL_MS = 700
/** 轮询一次取多少条 */
export const POLL_PAGE_LIMIT = 50