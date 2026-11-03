// Today AI · 登录与凭据
//
// 三种登录，都是把「会话 cookie」或「现成的 Bearer」变成 magpie 的账号记录：
//
//  ① 手机号 + 短信验证码（auth.todayai.cn 的 better-auth phone-number 插件）
//     POST /api/auth/phone-number/send-otp {phoneNumber}
//     POST /api/auth/phone-number/verify   {phoneNumber, otp}  → Set-Cookie 会话
//  ② 粘贴 Cookie（从浏览器今天的会话里复制 better-auth.session_token=…）
//  ③ 粘贴 Bearer（POST /api/token 拿到的那个 JWT，1 小时有效）
//
// ②③ 走同一条验证路径：有 cookie 就先换 token；只有 token 就直接验它。
// 换 token 的端点两个域名都认（cookie 的 domain 可能是 .todayai.cn，
// 也可能只有 auth.todayai.cn），src/http.mjs 里依次试。
//
// 记住的关键点：**magpie 的 auth.refresh 返回的是合并**，我们把 cookie 存在
// refresh 字段里 —— 于是续期不需要 refresh_token，直接用 cookie 再换一次。

import {
  exchangeToken,
  fetchCapabilities,
  fetchMe,
  isAuthFailure,
  registerDevice,
  sendPhoneOtp,
  verifyPhoneOtp,
} from "./http.mjs"
import { deviceIdFor, jwtExpiryMs, normalizeCookieInput } from "./pure.mjs"

/**
 * 从用户的输入里认出这是 cookie 还是 token。
 *
 * cookie 带 "="；JWT 是三段 base64url 用 "." 连起来；都不是就当 cookie 拼。
 */
export function classifyCredential(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return { kind: "empty", value: "" }
  const cookie = normalizeCookieInput(s)
  if (cookie) return { kind: "cookie", value: cookie }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return { kind: "token", value: s }
  return { kind: "token", value: s }
}

/**
 * 校验一份凭据，返回能直接存进 magpie 账号的字段。
 *
 * 返回：{ access, refresh(cookie), expires, accountId, uid, mainConversationId, deviceId }
 */
export async function resolveCredential(raw, { signal } = {}) {
  const { kind, value } = classifyCredential(raw)
  if (kind === "empty") throw new Error("请填写 Cookie 或 Bearer token")

  let token = ""
  let cookie = ""
  let expires = 0

  if (kind === "cookie") {
    cookie = value
    const exchanged = await exchangeToken(cookie, { signal })
    token = exchanged.token
    expires = exchanged.expires
  } else {
    token = value
    expires = jwtExpiryMs(token) ?? Date.now() + 3600_000
  }

  let me
  try {
    me = await fetchMe({ token, deviceId: deviceIdFor(token.slice(-24)), signal })
  } catch (error) {
    if (isAuthFailure(error)) {
      throw new Error(kind === "cookie" ? "会话 cookie 无效或已过期" : "这个 Bearer token 无效或已过期")
    }
    throw error
  }

  const seed = me.id || token.slice(-24)
  const deviceId = deviceIdFor(seed)

  // 能力接口拿到主会话 id；拿不到就退化 —— 主聊用 isMainChat:true，不需要它
  let mainConversationId = ""
  try {
    const cap = await fetchCapabilities({ token, deviceId, signal })
    mainConversationId = cap.mainConversationId
  } catch {
    mainConversationId = ""
  }

  return {
    access: token,
    refresh: cookie, // 没有 cookie 就只有 access，账号到期后要重新登录
    expires,
    accountId: me.email || me.name || me.id.slice(0, 8),
    uid: me.id,
    mainConversationId,
    deviceId,
  }
}

/**
 * 手机号验证码登录的第一步：发码。
 *
 * 用户在 prompts 里填了手机号，authorize() 立刻把码发出去，然后返回一个
 * 「输入验证码」的 code 流程 —— authorize 不能等，等的是 callback。
 */
export async function requestPhoneCode(phoneNumber, { signal } = {}) {
  const phone = normalizePhone(phoneNumber)
  if (!phone) throw new Error("手机号格式不对（要带国家码，例如 +86 后接 11 位手机号）")
  await sendPhoneOtp(phone, { signal })
  return phone
}

/** 第二步：验证码换会话，再换 Bearer */
export async function completePhoneSignIn(phoneNumber, code, { signal } = {}) {
  const phone = normalizePhone(phoneNumber)
  if (!phone) throw new Error("手机号格式不对")
  const { cookie } = await verifyPhoneOtp(phone, String(code ?? "").trim(), { signal })
  return resolveCredential(cookie, { signal })
}

/** 大陆号码补 +86；其它保持原样 */
export function normalizePhone(raw) {
  const s = String(raw ?? "").trim().replaceAll(/[\s-]/g, "")
  if (!s) return ""
  if (s.startsWith("+")) return /^\+\d{6,15}$/.test(s) ? s : ""
  if (/^1[3-9]\d{9}$/.test(s)) return `+86${s}`
  if (/^86\d{11}$/.test(s)) return `+${s}`
  return /^\d{6,15}$/.test(s) ? `+${s}` : ""
}

/**
 * 在内存里看住 Bearer。
 *
 * 为什么不写回 magpie 的账号记录：`client.auth.set` 是整体替换，多账号并发时
 * 很容易把别的账号的记录盖掉；而这个 token 只活 1 小时，进程内缓存足够。
 * 账号记录里的 access 过期了也没关系 —— 只要 cookie 还在，这里会自己续。
 */
export class TokenKeeper {
  constructor() {
    this.byAccount = new Map()
  }

  /**
   * @param {object} auth magpie 的账号记录
   * @returns {Promise<{token: string, deviceId: string, mainConversationId: string}>}
   */
  /**
   * 把客户端自己编的 `web_<uuid>` 换成**服务端注册过的设备 id**。
   *
   * 不注册就握手，服务端会回 `Device not found or inactive` 并 4003 断开 ——
   * 于是 WS 全废、只剩轮询（实测 2026-11-03）。注册幂等，一次进程内只做一次。
   */
  async ensureDevice(value) {
    if (value.registeredDeviceId) return
    if (value.registering) return value.registering
    const machine = value.clientMachineId || value.deviceId || deviceIdFor(value.account || "today")
    value.registering = (async () => {
      try {
        const { id } = await registerDevice({
          token: value.token,
          deviceId: machine,
          clientMachineId: machine,
        })
        value.registeredDeviceId = id
        value.deviceId = id
      } catch {
        // 注册失败就先用机器 id 硬上：WS 会失败，轮询还能跑
      } finally {
        value.registering = null
      }
    })()
    await value.registering
  }

  /**
   * 补主会话 id。
   *
   * 轮询兜底必须知道 conversationId；WS 路线不需要，但账号级只查一次很便宜
   * （10 分钟缓存，失败就当没有 —— 主聊用 isMainChat:true）。
   */
  async fillConversation(value) {
    const now = Date.now()
    if (value.conversationCheckedAt && now - value.conversationCheckedAt < 600_000) return
    value.conversationCheckedAt = now
    try {
      const cap = await fetchCapabilities({ token: value.token, deviceId: value.deviceId })
      if (cap?.mainConversationId) value.mainConversationId = cap.mainConversationId
    } catch {
      // 拿不到就让轮询自己报错
    }
  }

  async tokenFor(auth) {
    const key = String(auth?.uid || auth?.accountId || auth?.refresh || auth?.access || "default")
    const hit = this.byAccount.get(key)
    const now = Date.now()
    if (hit && hit.expires - now > 120_000) {
      await this.ensureDevice(hit)
      if (!hit.mainConversationId) await this.fillConversation(hit)
      return hit
    }

    const cookie = auth?.refresh || ""
    if (cookie) {
      try {
        const exchanged = await exchangeToken(cookie)
        const value = {
          token: exchanged.token,
          expires: exchanged.expires,
          deviceId: auth?.deviceId || deviceIdFor(auth?.uid || key),
          mainConversationId: auth?.mainConversationId || "",
          account: auth?.uid || "",
        }
        value.clientMachineId = auth?.deviceId || value.deviceId
        this.byAccount.set(key, value)
        await this.ensureDevice(value)
        await this.fillConversation(value)
        return value
      } catch (error) {
        // cookie 也不行了：把内存里的旧 token 交出去，让它撞一次 401 暴露给用户
        if (hit && hit.token) return hit
        throw error
      }
    }

    if (auth?.access && (auth?.expires ?? 0) - now > 120_000) {
      const value = {
        token: auth.access,
        expires: auth.expires ?? now + 300_000,
        deviceId: auth?.deviceId || deviceIdFor(auth?.uid || key),
        mainConversationId: auth?.mainConversationId || "",
        account: auth?.uid || "",
      }
      value.clientMachineId = auth?.deviceId || value.deviceId
      this.byAccount.set(key, value)
      await this.ensureDevice(value)
      await this.fillConversation(value)
      return value
    }

    if (auth?.access) {
      // 过期又没有 cookie：只能让用户重登
      throw Object.assign(new Error("Today 登录已过期，请重新登录（Cookie 方式登录可以自动续期）"), {
        signIn: "expired",
      })
    }
    throw new Error("没有可用的 Today 凭据")
  }
}