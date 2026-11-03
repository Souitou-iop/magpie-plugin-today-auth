// Today AI（todayai.cn）· magpie 供应商插件
//
// ═══════════════════════════════════════════════════════════════════════
// 这个插件做什么
// ═══════════════════════════════════════════════════════════════════════
//
// 让 magpie 里的 agent 用**你自己的 Today AI 账号**跑请求，而不是官方桌面端。
//
// Today 是个「会话式 agent」，不是裸模型 API：它没有 /chat/completions，
// 它有的是 canonical 消息协议 ——
//
//     POST /v1/messages           追加一条用户消息（body.parts[]）
//     WS  wss://api.todayai.cn/ws 服务端把整条助手消息的快照推回来
//     GET /v1/conversations/messages?after=  断线后的增量补齐（轮询兜底）
//
// 本插件把这套协议翻译成 OpenAI Chat Completions，再交给 magpie 去转给
// Claude Code / Codex / OpenCode 等 agent。
//
// ═══════════════════════════════════════════════════════════════════════
// 九个钩子
// ═══════════════════════════════════════════════════════════════════════
//
//   ① config(cfg)                       声明 provider + 静态模型表
//   ② auth.methods[].authorize()        手机号验证码 / 粘贴 Cookie / 粘贴 Bearer
//   ③ auth.refresh                      用 cookie 换新 Bearer（不需要 refresh_token）
//   ④ auth.loader(getAuth, provider)    请求接管 → src/chat.mjs
//   ⑤ auth.usage(getAuth, provider)     套餐 + 每条额度窗口 → src/usage.mjs
//   ⑥ provider.models(provider,{auth})  账号真实的档位表（/v1/pricing/status）
//   ⑦ "chat.headers"                    请求头透传（会话 id）
//   ⑧ accountId / uid / icon / maxConcurrency
//   ⑨ magpie.icon                       卡片与插件列表的图标
//
// ═══════════════════════════════════════════════════════════════════════
// 三条铁律（和别的插件一样，不是本插件特有）
// ═══════════════════════════════════════════════════════════════════════
//
// 1. config.models 必须有内容 —— 未登录也要有，否则卡片显示 "0 models"
// 2. authorize() 立刻返回 —— 真正等登录的是 callback()，否则和 magpie 死锁
// 3. 入口只导出工厂 —— magpie 把每个函数导出都当插件工厂调用，
//    所以 helper 全在 src/ 里（`_pure` 这种非函数对象是唯一例外）

import { APP_VERSION } from "./src/constants.mjs"
import { chatFetch } from "./src/chat.mjs"
import {
  classifyCredential,
  completePhoneSignIn,
  requestPhoneCode,
  resolveCredential,
  TokenKeeper,
} from "./src/auth.mjs"
import { exchangeToken, fetchPricingStatus, isAuthFailure } from "./src/http.mjs"
import { FALLBACK_MODEL_ID, staticModels } from "./src/pure.mjs"
import { optionsFromStatus, rememberOptions } from "./src/catalog.mjs"
import { readUsage } from "./src/usage.mjs"
import { ICON, NPM, PROVIDER, PROVIDER_NAME } from "./src/identity.mjs"

const REFRESH_LEAD_MS = 5 * 60_000

export const TodayAuthPlugin = async (ctx = {}) => {
  const log = (message, level = "info") => {
    try {
      ctx?.client?.app?.log?.({ service: PROVIDER, level, message })
    } catch {
      // 没有日志通道就算了
    }
  }

  const tokens = new TokenKeeper()

  return {
    // ═══ ① provider 声明 ══════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: NPM,
        api: "https://api.todayai.cn",
        models: staticModels(),
      }
      // magpie 的 OpenAI 兼容层需要知道「这家没有 /models 端点」
      cfg.provider[PROVIDER].models ??= staticModels()
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 2, // 档位是账号级开关，并发太高会互相踩
      refreshLead: REFRESH_LEAD_MS,

      // ═══ ② 登录 ═══════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: "Today 手机号验证码登录",
          prompts: [
            {
              type: "text",
              key: "phone",
              message: "手机号",
              placeholder: "11 位手机号，或带国家码的 +… 号码",
              validate: (value) => {
                const v = String(value ?? "").replaceAll(/[\s-]/g, "")
                if (!v) return "必填"
                if (/^1[3-9]\d{9}$/.test(v) || /^\+\d{6,15}$/.test(v) || /^86\d{11}$/.test(v)) return undefined
                return "填 11 位大陆手机号，或带国家码的 +… 号码"
              },
            },
          ],
          async authorize(inputs) {
            let phone = ""
            let failure = ""
            try {
              phone = await requestPhoneCode(inputs?.phone)
            } catch (error) {
              failure = String(error?.message ?? error)
            }
            return {
              // 空 url = 不弹浏览器（magpie 只在 url 非空时才 open）
              url: "",
              instructions: failure
                ? `${failure}\n也可以改用「粘贴 Cookie 登录」。`
                : `验证码已发到 ${phone}，把收到的 6 位数字填在下面。`,
              method: "code",
              placeholder: "6 位短信验证码",
              opened: false,
              async callback(code) {
                if (!phone) return { type: "failed", error: failure || "没有可用的手机号" }
                try {
                  const account = await completePhoneSignIn(phone, code)
                  log(`登录成功：${account.accountId}`)
                  return {
                    type: "success",
                    access: account.access,
                    refresh: account.refresh,
                    expires: account.expires,
                    accountId: account.accountId,
                    uid: account.uid,
                    mainConversationId: account.mainConversationId,
                    deviceId: account.deviceId,
                  }
                } catch (error) {
                  const reason = String(error?.message ?? error)
                  log(`手机验证码登录失败：${reason}`, "warning")
                  return { type: "failed", error: reason }
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "粘贴 Today 的 Cookie 或 Bearer",
          async authorize() {
            return {
              url: "",
              instructions: [
                "在浏览器里打开 https://todayai.cn/login 登录，然后：",
                "  ① 开发者工具 → Application → Cookies → https://todayai.cn",
                "     把 better-auth.session_token 那一行（含名字）复制过来",
                "  ② 或者：Console 里跑",
                '     await (await fetch("/api/token",{method:"POST",headers:{"content-type":"application/json"},',
                '       body:JSON.stringify({audience:"https://api.todayai.cn",expiresIn:3600})})).json()',
                "     把拿到的 token 复制过来（只有 1 小时，不带 Cookie 不会自动续）",
                "",
                "Cookie 方式能用 30 天并自动续期，推荐这个。",
              ].join("\n"),
              method: "code",
              placeholder: "better-auth.session_token=… 或 eyJ…（JWT）",
              opened: false,
              async callback(raw) {
                try {
                  const account = await resolveCredential(raw)
                  log(`登录成功：${account.accountId}（${classifyCredential(raw).kind}）`)
                  return {
                    type: "success",
                    access: account.access,
                    refresh: account.refresh,
                    expires: account.expires,
                    accountId: account.accountId,
                    uid: account.uid,
                    mainConversationId: account.mainConversationId,
                    deviceId: account.deviceId,
                  }
                } catch (error) {
                  const reason = String(error?.message ?? error)
                  log(`Cookie/Bearer 登录失败：${reason}`, "warning")
                  return { type: "failed", error: reason }
                }
              },
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════
      /**
       * Today 没有 refresh_token，只有 cookie。
       *
       * cookie 存在 `auth.refresh` 里：拿它再打一次 `POST /api/token` 就有一小时新的。
       * 返回的是**合并**，所以只回 access / expires（refresh 里那份 cookie 继续有效）。
       */
      async refresh(auth) {
        if (!auth?.refresh) return undefined
        const exchanged = await exchangeToken(auth.refresh)
        return { access: exchanged.token, expires: exchanged.expires }
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}

        const first = await tokens.tokenFor(auth).catch((error) => {
          log(`取 token 失败：${error?.message ?? error}`, "warning")
          return null
        })
        if (!first) return {}

        return {
          baseURL: "https://api.todayai.cn/plugin",
          apiKey: "today-account", // 真正的头在 fetch 里换
          headers: {
            "user-agent": `TodayDesktop/1.24.0 (web)`,
            "x-app-version": APP_VERSION,
          },

          async fetch(input, init) {
            // ⚠ 每次重读 auth：token 可能刚被续期、账号可能被换掉
            const fresh = await getAuth()
            let current = null
            try {
              current = fresh ? await tokens.tokenFor(fresh) : null
            } catch (error) {
              // 登录态拿不出来：这是「要人重新登录」，才允许摘账号
              return jsonError(401, String(error?.message ?? error), "session_expired", {
                "x-magpie-sign-in": "expired",
              })
            }
            if (!current?.token) {
              return jsonError(401, "Today 未登录：没有可用的凭据", "sign_in_required")
            }

            const response = await chatFetch({
              input,
              init,
              token: current.token,
              deviceId: current.deviceId,
              accountKey: current.account || auth.uid || "",
              mainConversationId: current.mainConversationId || "",
              log,
            })

            // 401 且确实换不出新 token → 让 magpie 把账号标成过期，用户重新登录
            if (response.status === 401 && !response.headers.get("x-magpie-sign-in")) {
              const headers = new Headers(response.headers)
              headers.set("x-magpie-sign-in", "expired")
              return new Response(response.body, { status: 401, headers })
            }
            return response
          },
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) return { error: "未登录", windows: [] }
        let current
        try {
          current = await tokens.tokenFor(auth)
        } catch (error) {
          return { error: String(error?.message ?? error), windows: [] }
        }
        try {
          return await readUsage({ token: current.token, deviceId: current.deviceId, log })
        } catch (error) {
          if (isAuthFailure(error)) return { error: "登录已失效，请重新登录", windows: [], signIn: "expired" }
          return { error: String(error?.message ?? error), windows: [] }
        }
      },
    },

    // ═══ ⑥ 每账号的档位表 ═════════════════════════════════════════
    //
    // 档位不是固定的：同一个 Pro 账号今天下发的可能是
    // `model.deepseek-v4.1-flash / model.minimax-m31-flash / model.glm-5.3`，
    // 换个套餐就换成 `mode.*`。所以一律读 `/v1/pricing/status`，不猜。
    provider: {
      id: PROVIDER,

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        if (!auth) return fallback

        let current
        try {
          current = await tokens.tokenFor(auth)
        } catch {
          return fallback
        }

        try {
          const status = await fetchPricingStatus({ token: current.token, deviceId: current.deviceId })
          const parsed = optionsFromStatus({ data: { status } })
          if (!parsed) return fallback

          const accountKey = current.account || auth.uid || ""
          rememberOptions(accountKey, parsed)

          const out = {}
          for (const o of parsed.options) {
            if (o.disabled) continue
            out[o.id] = {
              id: o.id,
              name: o.name,
              api: { id: o.id, url: "https://api.todayai.cn", npm: NPM },
              status: "active",
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              // Today 不回 token 数也不给窗口，先给保守值；填大只会让 agent 晚压缩
              limit: { context: 200_000, output: 64_000 },
              modalities: { input: ["text"], output: ["text"] },
              capabilities: {
                temperature: false,
                reasoning: false,
                toolcall: false,
                attachment: false,
                input: { text: true, image: false, audio: false, video: false, pdf: false },
                output: { text: true },
              },
            }
          }
          return Object.keys(out).length > 0 ? out : fallback
        } catch (error) {
          if (isAuthFailure(error)) {
            throw Object.assign(new Error("Today 登录已失效，请重新登录"), { signIn: "expired" })
          }
          return fallback
        }
      },
    },

    // ═══ ⑦ 每请求加头 ═════════════════════════════════════════════
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER || !input?.sessionID) return
      output.headers["x-today-session"] = String(input.sessionID).slice(0, 128)
    },
  }
}

/** 统一错误体：与 magpie-community ERROR-CODES §1 的 OpenAI 兼容形状一致 */
function jsonError(status, message, code, headers = {}) {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code, status } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

// 供测试引用（入口不能导出 helper 函数，否则会被当插件工厂调用）
export const _pure = {
  PROVIDER,
  NPM,
  PROVIDER_NAME,
  FALLBACK_MODEL_ID,
  staticModels,
}