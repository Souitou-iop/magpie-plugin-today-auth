// Today AI · HTTP 层
//
// 全部端点实测自 web 构建（todayai.cn/_next chunks）与桌面端配置：
//
//   POST {api}/ws-ticket                      → { ticket }（+ x-websocket-url 头）
//   GET  {api}/v1/users/me                    → 身份
//   GET  {api}/v1/users/me/protocol-capabilities → mainConversationId / 协议版本
//   GET  {api}/v1/pricing/status              → 套餐 + 额度 + modelOptions
//   GET  {api}/v1/pricing/resets              → 重置窗口
//   PUT  {api}/v1/pricing/model-option        → { optionId } 切档
//   POST {api}/v1/messages                    → canonical 消息（追加一条 user 消息）
//   GET  {api}/v1/conversations/messages      → 历史/增量（?conversationId&after&limit）
//   POST {web|auth}/api/token                 → { token, expiresAt }（cookie 换 Bearer）
//   POST {auth}/api/auth/phone-number/send-otp → 短信验证码
//   POST {auth}/api/auth/phone-number/verify   → 换会话 cookie
//
// 请求头必须齐（少 X-Device-Id 或 X-Client-Capabilities 会被当成非客户端）：
//   Authorization、X-App-Version、X-Client-Capabilities、X-Client-Platform、
//   X-Device-Id、Accept-Language、X-Timezone

import {
  API_BASE,
  APP_VERSION,
  AUDIENCE,
  AUTH_BASE,
  CLIENT_CAPABILITIES,
  CLIENT_PLATFORM,
  WEB_BASE,
} from "./constants.mjs"
import { cookieFromSetCookies, jwtExpiryMs } from "./pure.mjs"

export class TodayApiError extends Error {
  constructor(message, { status = 0, code = "", phase = "" } = {}) {
    super(message)
    this.name = "TodayApiError"
    this.status = status
    this.code = code
    this.phase = phase
  }
}

/** 401/403 说明登录态没了 —— 上层据此把账号标成 expired */
export function isAuthFailure(error) {
  if (!error) return false
  if (error.status === 401 || error.status === 403) return true
  const m = String(error.message ?? "")
  return /unauthorized|401|invalid token|token expired|login required|未登录/i.test(m)
}

function clientHeaders(token, deviceId, { json = false } = {}) {
  const h = {
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "x-app-version": APP_VERSION,
    "x-client-capabilities": CLIENT_CAPABILITIES,
    "x-client-platform": CLIENT_PLATFORM,
    "x-device-id": deviceId,
    "x-timezone": "Asia/Shanghai",
    "user-agent": `TodayDesktop/1.24.0 (${CLIENT_PLATFORM})`,
  }
  if (token) h.authorization = `Bearer ${token}`
  if (json) h["content-type"] = "application/json"
  return h
}

async function readJson(response) {
  const text = await response.text().catch(() => "")
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { rawText: text.slice(0, 400) }
  }
}

function envelopeError(payload, status) {
  // 成功信封：{success:true, code:"common.ok", message, data}
  // 失败信封：{code:"...", message:"..."} 或 {error:"..."}
  const code = String(payload?.code ?? payload?.error?.code ?? "")
  const message = String(payload?.message ?? payload?.error?.message ?? payload?.error ?? "").trim()
  return new TodayApiError(message || `HTTP ${status}`, { status, code })
}

/** 带信封判断的 JSON 请求 */
async function requestJson(url, { method = "GET", token, deviceId, body, signal, phase = "" } = {}) {
  let response
  try {
    response = await fetch(url, {
      method,
      headers: clientHeaders(token, deviceId, { json: body !== undefined }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TodayApiError(`${phase || method} 请求失败：${error?.message ?? error}`, { phase })
  }
  const payload = await readJson(response)
  if (!response.ok) {
    const err = envelopeError(payload, response.status)
    err.phase = phase
    throw err
  }
  if (payload && payload.success === false) {
    const err = envelopeError(payload, response.status)
    err.phase = phase
    throw err
  }
  return payload
}

// ── 登录 ──────────────────────────────────────────────────────────────

/**
 * cookie → Bearer。
 *
 * web 的 `/api/token` 与 auth 的 `/api/token` 是同一个 better-auth 实例的两张皮，
 * 谁认这个 cookie 就用谁（cookie 的 domain 可能是 .todayai.cn 也可能只有
 * auth.todayai.cn）。
 */
export async function exchangeToken(cookie, { signal } = {}) {
  const jar = String(cookie ?? "").trim()
  if (!jar) throw new TodayApiError("没有会话 cookie", { phase: "token" })
  const body = JSON.stringify({ audience: AUDIENCE, expiresIn: 3600 })
  const tries = [`${WEB_BASE}/api/token`, `${AUTH_BASE}/api/token`]
  let last = null
  for (const url of tries) {
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          cookie: jar,
        },
        body,
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      last = new TodayApiError(`换取 token 失败：${error?.message ?? error}`, { phase: "token" })
      continue
    }
    const payload = await readJson(response)
    if (response.status === 401 || response.status === 403) {
      last = new TodayApiError("会话 cookie 已失效，请重新登录", { status: response.status, phase: "token" })
      continue
    }
    if (!response.ok) {
      last = envelopeError(payload, response.status)
      last.phase = "token"
      continue
    }
    const token = payload?.token ?? payload?.data?.token
    if (typeof token !== "string" || !token) {
      last = new TodayApiError("token 响应里没有 token", { phase: "token" })
      continue
    }
    const expiresAt = Date.parse(payload?.expiresAt ?? payload?.data?.expiresAt ?? "")
    return {
      token,
      expires: Number.isFinite(expiresAt) ? expiresAt : (jwtExpiryMs(token) ?? Date.now() + 3600_000),
    }
  }
  throw last ?? new TodayApiError("换取 token 失败", { phase: "token" })
}

/** 手机号验证码：发码 */
export async function sendPhoneOtp(phoneNumber, { signal } = {}) {
  let response
  try {
    response = await fetch(`${AUTH_BASE}/api/auth/phone-number/send-otp`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: WEB_BASE,
        referer: `${WEB_BASE}/login`,
        "user-agent": `TodayDesktop/1.24.0 (${CLIENT_PLATFORM})`,
      },
      body: JSON.stringify({ phoneNumber }),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TodayApiError(`发验证码失败：${error?.message ?? error}`, { phase: "send-otp" })
  }
  const payload = await readJson(response)
  if (!response.ok) {
    const message = String(payload?.message ?? `HTTP ${response.status}`)
    const code = String(payload?.code ?? "")
    const friendly =
      code === "INVALID_PHONE_NUMBER" ? `这个号码 Today 不接受（${message}）` : message
    throw new TodayApiError(`发验证码失败：${friendly}${code ? `（${code}）` : ""}`, {
      status: response.status,
      code,
      phase: "send-otp",
    })
  }
  return payload
}

/**
 * 手机号验证码：校验并拿会话 cookie。
 *
 * 两个坑（都实测踩过）：
 *  ① 请求体字段是 **`code`**，不是 `otp`。写成 otp 会被 better-auth 回
 *     `VALIDATION_ERROR: [body.code] Invalid input`，magpie 那边只会显示「授权失败」。
 *  ② 必须 `redirect:"manual"` —— Set-Cookie 挂在 3xx 上，fetch 自动跟随会把它丢掉。
 *
 * 有些部署不回 Set-Cookie，只在 body 里给 `token`；那种情况拼成
 * `better-auth.session_token=<token>` 的 Cookie 头，后面一样能换 Bearer。
 */
export async function verifyPhoneOtp(phoneNumber, code, { signal } = {}) {
  let response
  try {
    response = await fetch(`${AUTH_BASE}/api/auth/phone-number/verify`, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // better-auth 的 CSRF 检查看 Origin；浏览器客户端带的是这两个
        origin: WEB_BASE,
        referer: `${WEB_BASE}/login`,
        "user-agent": `TodayDesktop/1.24.0 (${CLIENT_PLATFORM})`,
      },
      body: JSON.stringify({ phoneNumber, code: String(code ?? "").trim() }),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TodayApiError(`验证码校验失败：${error?.message ?? error}`, { phase: "verify-otp" })
  }

  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")]
        : []
  let cookie = cookieFromSetCookies(cookies)
  const payload = await readJson(response)

  if (response.status >= 400) {
    const message = String(payload?.message ?? payload?.error?.message ?? `HTTP ${response.status}`)
    const codeText = String(payload?.code ?? "")
    throw new TodayApiError(`验证码没通过：${message}${codeText ? `（${codeText}）` : ""}`, {
      status: response.status,
      code: codeText,
      phase: "verify-otp",
    })
  }

  if (!cookie) {
    // 少数部署只给 body 里的 session token
    const bodyToken = payload?.token ?? payload?.data?.token
    if (typeof bodyToken === "string" && bodyToken) {
      cookie = `better-auth.session_token=${bodyToken}`
    }
  }
  if (!cookie) {
    const sample = JSON.stringify(payload ?? {}).slice(0, 200)
    throw new TodayApiError(`验证码通过了，但响应里没有会话 cookie：${sample}`, {
      status: response.status,
      phase: "verify-otp",
    })
  }
  return { cookie, payload }
}

// ── 设备注册 ──────────────────────────────────────────────────────────
//
// WS 用的是**服务端注册过的设备 id**，不是客户端自己编的 `web_<uuid>`。
// 没注册就握手，服务端回 `{"type":"error","message":"Device not found or inactive"}` 并 4003 断开
// （实测 2026-11-03）。注册是幂等的：同一个 clientMachineId 再注册会回 created:false。
//
//   POST /registry/devices
//   { name:"Today Web", clientPlatform:"web", clientType:"web-dashboard",
//     platform:"macOS", version:"2.0.0", notificationEnabled:false, clientMachineId:"web_…" }
//   → { device:{ id }, created }
export async function registerDevice({ token, deviceId, clientMachineId, platform = "macOS", signal }) {
  const payload = await requestJson(`${API_BASE}/registry/devices`, {
    method: "POST",
    token,
    deviceId,
    body: {
      name: "Today Web",
      clientPlatform: CLIENT_PLATFORM,
      clientType: "web-dashboard",
      platform,
      version: APP_VERSION,
      notificationEnabled: false,
      clientMachineId,
    },
    signal,
    phase: "register-device",
  })
  const id = payload?.device?.id ?? payload?.data?.device?.id
  if (typeof id !== "string" || !id) {
    throw new TodayApiError("设备注册响应里没有 device.id", { phase: "register-device" })
  }
  return { id, created: payload?.created === true }
}

/** token+机器 id → 注册过的设备 id（一个进程里只注册一次） */
const registeredDevices = new Map()

/**
 * 只认「客户端自己编的」id：`web_…` 才注册。已经是服务端 id 的（不透明串）
 * 直接放行 —— 再注册一次会在服务端造出第二台设备。
 */
export async function ensureRegisteredDevice({ token, deviceId, signal }) {
  if (!deviceId || !/^web_/.test(deviceId)) return deviceId
  const key = `${token}\n${deviceId}`
  const hit = registeredDevices.get(key)
  if (hit) return hit
  const { id } = await registerDevice({ token, deviceId, clientMachineId: deviceId, signal })
  registeredDevices.set(key, id)
  return id
}

// ── 账号与能力 ────────────────────────────────────────────────────────

export async function fetchMe({ token, deviceId, signal }) {
  const payload = await requestJson(`${API_BASE}/v1/users/me`, { token, deviceId, signal, phase: "me" })
  const data = payload?.data ?? payload ?? {}
  return {
    id: String(data.id ?? ""),
    name: String(data.preferredName ?? data.name ?? ""),
    email: String(data?.account?.email ?? data.email ?? ""),
    avatarUrl: String(data.avatarUrl ?? ""),
  }
}

export async function fetchCapabilities({ token, deviceId, signal }) {
  const payload = await requestJson(`${API_BASE}/v1/users/me/protocol-capabilities`, {
    token,
    deviceId,
    signal,
    phase: "capabilities",
  })
  const data = payload?.data ?? payload ?? {}
  // ⚠ 实测（2026-11-03）：这些字段在 **data.messageCapabilities** 下面，
  //   不在 data 上。按旧位置读会永远拿到空 mainConversationId，于是轮询兜底全废。
  const caps = data.messageCapabilities ?? data
  return {
    messageProtocolVersion: String(caps.messageProtocolVersion ?? "canonical-v1"),
    mainConversationId: String(caps.mainConversationId ?? caps.conversationId ?? ""),
    authSubject: String(caps.authSubject ?? ""),
    supportsLongPoll: caps.supportsLongPoll === true,
    longPollWaitMaxMs: Number(caps.longPollWaitMaxMs) || 0,
  }
}

// ── 套餐 / 额度 / 模型档位 ────────────────────────────────────────────

export async function fetchPricingStatus({ token, deviceId, signal }) {
  const payload = await requestJson(`${API_BASE}/v1/pricing/status`, {
    token,
    deviceId,
    signal,
    phase: "pricing",
  })
  return payload?.data?.status ?? payload?.data ?? payload ?? {}
}

export async function fetchPricingResets({ token, deviceId, signal }) {
  try {
    const payload = await requestJson(`${API_BASE}/v1/pricing/resets`, { token, deviceId, signal, phase: "resets" })
    return payload?.data ?? payload ?? null
  } catch {
    return null // 重置表是加分项，读不到就不画
  }
}

/** 切档：账号级设置，PUT 幂等 */
export async function putModelOption({ token, deviceId, optionId, signal }) {
  const payload = await requestJson(`${API_BASE}/v1/pricing/model-option`, {
    method: "PUT",
    token,
    deviceId,
    body: { optionId },
    signal,
    phase: "model-option",
  })
  return payload?.data ?? payload ?? null
}

// ── 会话 ──────────────────────────────────────────────────────────────

/**
 * 追加一条消息。
 *
 * body 是 `appendCanonicalMessageRequestSchema` 的主聊形态：
 *   { isMainChat: true, clientMessageId, body: { parts: [...] } }
 * 非主聊形态还要 conversationId（+ 可选 taskId），但服务端是否会为未知
 * conversationId 建会话没有实测证据，所以默认只用主聊。
 */
export async function appendMessage({ token, deviceId, clientMessageId, body, isMainChat = true, conversationId, signal }) {
  const request = isMainChat
    ? { isMainChat: true, clientMessageId, body }
    : { isMainChat: false, conversationId, clientMessageId, body }
  const payload = await requestJson(`${API_BASE}/v1/messages`, {
    method: "POST",
    token,
    deviceId,
    body: request,
    signal,
    phase: "append",
  })
  const message = payload?.data?.canonicalMessage ?? payload?.canonicalMessage ?? null
  return { message, payload }
}

export async function fetchHistory({ token, deviceId, conversationId, after, before, limit = 50, signal }) {
  const params = new URLSearchParams()
  params.set("conversationId", conversationId)
  if (after) params.set("after", after)
  if (before) params.set("before", before)
  if (limit) params.set("limit", String(limit))
  const payload = await requestJson(`${API_BASE}/v1/conversations/messages?${params.toString()}`, {
    token,
    deviceId,
    signal,
    phase: "history",
  })
  const data = payload?.data ?? payload ?? {}
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.messages) ? data.messages : []
  const paging = data.paging ?? {}
  return {
    items,
    nextCursor: paging.nextCursor ?? null,
    hasMore: paging.hasMore === true,
  }
}

/** WebSocket 门票 */
export async function fetchWsTicket({ token, deviceId, signal }) {
  let response
  try {
    response = await fetch(`${API_BASE}/ws-ticket`, {
      method: "POST",
      headers: clientHeaders(token, deviceId, { json: false }),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TodayApiError(`ws-ticket 失败：${error?.message ?? error}`, { phase: "ws-ticket" })
  }
  const payload = await readJson(response)
  if (!response.ok) {
    const err = envelopeError(payload, response.status)
    err.phase = "ws-ticket"
    throw err
  }
  const ticket = payload?.ticket ?? payload?.data?.ticket
  if (typeof ticket !== "string" || !ticket) {
    throw new TodayApiError("ws-ticket 响应里没有 ticket", { phase: "ws-ticket" })
  }
  const overrideUrl = response.headers.get("x-websocket-url")?.trim() || ""
  return { ticket, webSocketUrl: overrideUrl }
}