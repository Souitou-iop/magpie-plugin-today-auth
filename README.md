# magpie-plugin-today-auth · Today AI

把 **Today AI**（[todayai.cn](https://todayai.cn)）接进 magpie：用你自己账号的套餐跑
Claude Code、Codex、OpenCode 这些 agent，模型、对话、额度都走 magpie 同一套。

协议细节来自官方 macOS 客户端 `today-macos-arm64.dmg`（Today 1.24.0）与 `todayai.cn`
的前端构建产物；每个端点、每个字段的出处都写在对应 `src/*.mjs` 顶部注释里。

---

## 它做了什么

Today 不是裸模型 API。它没有 `/chat/completions`，有的是一条 **canonical 消息协议**：

```
POST /v1/messages                    追加一条用户消息（body.parts[]）
WS   wss://api.todayai.cn/ws         服务端把整条助手消息的快照推回来
GET  /v1/conversations/messages      断线后按 ?conversationId&after= 补齐（轮询兜底）
```

插件把这条协议翻译成 OpenAI Chat Completions，剩下的交给 magpie：

| magpie 侧 | Today 侧 |
| --- | --- |
| `POST {base}/chat/completions` | `POST /v1/messages`，之后读 WS / 轮询 |
| `messages[]` | 取**最后一条 user** 当输入，截断到 1 MiB 以内 |
| 流式 SSE `chat.completion.chunk` | `event.push` 快照 → 算出文本增量 |
| `model` | 账号级档位（`PUT /v1/pricing/model-option`） |
| 额度卡片 | `GET /v1/pricing/status` 的 `usage.progress` + `usage.breakdown.items[]` |

---

## 装

```sh
magpie plugin add magpie-plugin-today-auth        # 上架后
magpie plugin add /path/to/magpie-today-plugin    # 本地目录（开发时）
```

装完 `magpie plugin list` 应看到：

```
/…/magpie-today-plugin  on
  today (Today AI, 3 models)  signed in as <你的名字>
```

> 本地目录装的插件，`magpie plugin on/off` 认的是**路径**，不是 `today`：
> `magpie plugin on /path/to/magpie-today-plugin`。改完代码用这对命令重载。

---

## 登录

```
magpie plugin login today
  1. Today 手机号验证码登录
  2. 粘贴 Today 的 Cookie 或 Bearer
```

两种方式都**不跳浏览器**（`authorize()` 返回的 `url` 是空的，magpie 只在非空时才开页面）。

**① 手机号验证码**：填大陆手机号（自动补 `+86`），插件发码，再在 magpie 的输入框里填收到的验证码：

```http
POST https://auth.todayai.cn/api/auth/phone-number/send-otp   {"phoneNumber":"+861…"}
POST https://auth.todayai.cn/api/auth/phone-number/verify     {"phoneNumber":"+861…","code":"123456"}
```

⚠ 校验字段是 **`code`**，不是 `otp` —— 写成 `otp` 只会得到
`VALIDATION_ERROR: [body.code] Invalid input`，而 magpie 那边显示的是「授权失败」。
`npm run probe` 里有一条语义探针专门盯这件事。

**② 粘贴 Cookie**：登录 todayai.cn 后从开发者工具复制
`better-auth.session_token=…` 那一行。cookie 方式能自动续期 —— 账号记录里 `refresh`
存的就是这份 cookie，插件拿它打 `POST /api/token` 换新的 1 小时 Bearer。

也可以粘 `POST /api/token` 拿到的 JWT，但它只活 1 小时、不会自动续 —— 长期使用走 Cookie 方式。

---

## 模型：按账号现拉，不写死

Today 的「档位」是**账号级**设置，服务端替你挑具体模型。不同账号 / 套餐下发的 id 不一样，
所以目录一律从 `GET /v1/pricing/status` 的 `modelOptions` 现读：

| 账号（实测） | 下发的 optionId | magpie 里的模型 |
| --- | --- | --- |
| Pro（2026-11） | `model.deepseek-v4.1-flash`(1×)、`model.minimax-m31-flash`(1×)、`model.glm-5.3`(4×) | `today/deepseek-v4.1-flash`、`today/minimax-m31-flash`、`today/glm-5.3` |
| web 构建的 mock | `mode.fast`、`mode.balanced`、`mode.power` | `today/fast`、`today/balanced`、`today/power` |

magpie 的模型 id = optionId 去掉分组前缀（`mode.` / `model.`）；显示名带「消耗倍数」。
未登录时只有一个兜底模型 `today`（走账号当前档位）—— 账号名下有哪些档位，只有登录后才知道。

选中某个模型后，插件在**发消息前** `PUT /v1/pricing/model-option` 切到那个档位，同一档位只打一次。
档位是账号级开关，所以 `maxConcurrency` 是 2 —— 同时跑两个不同档位的请求会互相踩。
切档失败（例如给了这个账号没有的 optionId，服务端回 403 `auth.forbidden`）**只记一条警告，
不影响这一轮对话**。

---

## 额度卡片

`GET /v1/pricing/status` → magpie 的 `usage`：

```
用量        26%（剩余 74%，2026-11-24 03:03 重置）   ← 参与路由
复杂任务    11% · 定时任务 0% · 每日简报 10%         ← aside，只展示
记忆更新     4% · 云电脑 1%
```

- 主窗口用 `usage.progress`（**已用**百分比）与 `usage.resetAt`，它是路由依据；
- `usage.breakdown.items[]` 是同一份额度的拆分，一律 `aside: true`。让它们参与路由会把同一个号算两遍，
  额度一刷就整个号被摘掉；
- `usage.freeServices` 不画（日常对话、简单任务本来不计费）；
- 套餐到期用 `entitlementEndsAt`（不是 `currentPeriodEndAt`，那只是本期账单周期）。

---

## 已知边界

- **不支持工具调用。** Today 的工具（浏览器、日历、Slack、Notion…）在服务端那侧跑，
  不能把 `tool_calls` 交回给 agent，所以 `capabilities.toolcall = false`。
- **不支持附件 / 图片。** 需要先 `POST /v1/files` 拿 `fileRef` 再塞进 parts，v1 没做。
- **上下文按 1 MiB 截断。** Today 单条 canonical 消息上限 1 MiB（schema 写死），插件取最后一条
  user 消息，超过 18 万字符留头 60% + 尾 40%。
- **只在主会话里跑。** 用 `isMainChat:true`，历史由服务端维护 —— 好处是永不 404，
  代价是多个 agent 会话共用 Today 的同一个主对话；回复靠 `originClientMessageId` 认领，不会串。
- **token 数是估的。** Today 不回 usage，SSE 末尾的 `usage` 按字符估算（中文 1.6 字符/token，
  英文 4 字符/token）。真实额度看卡片，别看这里。
- **context 窗口是保守值 200K。** 没有逐个实测；填大只会让 agent 晚压缩。

---

## 验证到哪一步

| 判据 | 证据 |
| --- | --- |
| 协议形状 | 从 `app.asar` 与 `todayai.cn/_next` chunks 提取，端点与字段记在 `src/*.mjs` 顶部注释 |
| 请求头 | `X-App-Version / X-Client-Capabilities / X-Client-Platform / X-Device-Id / Accept-Language / X-Timezone` |
| 鉴权链 | `POST /api/token {audience:"https://api.todayai.cn",expiresIn:3600}` → JWT；web 与 auth 两个域都实测存在（未登录 401） |
| 登录端点 | `phone-number/send-otp` / `verify` 实测可用；`sign-in/email` 在本区域 403 关闭 |
| 验证码字段名 | 活体探针：`{phoneNumber,code}` → `OTP not found.`；`{phoneNumber,otp}` → `VALIDATION_ERROR` |
| 设备注册 | 不注册就握手 → `{"type":"error","message":"Device not found or inactive"}` + 4003 |
| 端到端（假服务端） | `npm test` 49 条：含最小 WebSocket 实现、设备注册、真实事件形状；WS 出字、轮询兜底、档位、401、额度、目录、单帧 error 不断流 |
| 真账号直连插件 | `provider.models` 读到 3 档；`loader.fetch` 出字（`pong`，4.3s，WS 直连）；`auth.usage` 读到 Pro / 用量 26% / 五条拆分 |
| 真账号过 magpie 网关 | `POST /v1/chat/completions` 两个档位都回 `pong`；`/v1/magpie/quotas` 里 `today` 卡片是 plan Pro、用量 26% + 五条拆分 |

---

## 开发

```sh
npm test               # 单元 + 契约 + 端到端，全部离线（假服务端，见 tests/mock-today.mjs）
npm run probe          # 对真 API 探端点与验证码字段名（不需要账号）
node ../magpie-plugin-scaffold/scripts/check.mjs .   # 社区合规检查
```

基址可用环境变量顶掉（测试与网关调试）：`TODAY_API_BASE`、`TODAY_WEB_BASE`、`TODAY_AUTH_BASE`。

```
index.mjs          插件入口：config / auth（登录 + 续期 + loader）/ usage / models / chat.headers
src/constants.mjs  端点、请求头常量、超时
src/identity.mjs   provider id、显示名、图标（data URI，唯一来源）
src/http.mjs       API 客户端：token 交换、设备注册、发消息、历史、票、套餐
src/auth.mjs       凭据分类与校验、token 缓存、设备注册
src/catalog.mjs    按账号的档位目录（optionId ↔ magpie 模型 id）
src/stream.mjs     WebSocket（hello / 心跳 / ack）+ 轮询兜底 → 文本增量
src/chat.mjs       OpenAI Chat Completions ↔ Today canonical
src/usage.mjs      pricing/status → magpie 的 usage windows
src/pure.mjs       纯函数（文本提取、增量、截断、Cookie、SSE 帧、token 估算）
tests/             假 Today 服务端 + 契约 / 端到端 / 错误码 / 纯函数 / 活体探针
```

图标：`assets/icon.png` 是 `Today.app/Contents/Resources/icon.png`（1024×1024，取自 dmg）；
256px 版本以 data URI 同时用于 `auth.icon` 与 `magpie.icon`。

## 许可

MIT。