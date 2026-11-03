# CHANGELOG

## 0.1.3

- 供应商显示名回到原名 **Today AI**（不再写「今日」）；`registry-entry.json` 与
  `package.json` 的 `magpie.name` 同步。
- README 重写：按「协议映射 → 装 → 登录 → 模型 → 额度 → 边界 → 验证 → 开发」重排，
  去掉过程中的试错叙述，只留可复现的事实。
- 仓库独立成 git 项目（`/Volumes/SanDisk/Projects/magpie-today-plugin`）。

## 0.1.2

真账号跑通之后修的五个问题（每个都是实测出来的，不是推测）：

- **模型测试不通过**：两个原因叠在一起。
  ① 设备没注册就握手，服务端回 `{"type":"error","message":"Device not found or inactive"}` 并 4003 断开 ——
     现在先 `POST /registry/devices`（body 见 `src/http.mjs`），用服务端给的 `device.id` 握手；
  ② 切档用了这个账号没有的 optionId（`mode.power`），服务端回 403，而旧代码把 403 当登录失效
     → 整个请求 401。现在切档失败只记一条警告，对话照常。
- **额度读不到**：真形状是 `status.usage.progress`（已用%）+ `breakdown.items[]`，
  不是 `usage.items[]`。现在主窗口用 `progress`（参与路由），`breakdown.items` 一律 `aside`
  （只展示，否则同一个号被算两遍）。
- **主会话 id 永远为空**：`mainConversationId` 在 `data.messageCapabilities` 下面，不在 `data` 上。
  读错导致轮询兜底全废。
- **档位表不写死**：不同账号下发的是不同 id —— 我的 Pro 账号是
  `model.deepseek-v4.1-flash / model.minimax-m31-flash / model.glm-5.3`（倍数 1×/1×/4×），
  没有 `mode.*`。现在目录从 `/v1/pricing/status` 现拉，模型 id 去掉 `model.` 前缀，
  名字带「消耗倍数」；未登录只给一个诚实的兜底模型 `today`。
- **WS 上多发的 `client.status` 帧被服务端拒**（`Invalid input`），而旧代码把单帧 error 当成断流
  → 白退到轮询。现在不发这个帧，且单帧 error 只记日志。
- **SSE 之前先判失败**：第一个事件拿到手才决定 200；登录失效这类还没出字的失败直接回 401，
  而不是 200 + 错误帧。
- **图标换成官方图标**：`Today.app/Contents/Resources/icon.png`（1024×1024，取自 dmg），
  256px 版本以 data URI 同时用于 `auth.icon` 与 `magpie.icon`。

## 0.1.1

修两个登录问题：

- **验证码填了报「授权失败」**：`POST /api/auth/phone-number/verify` 的字段名是
  **`code`**，不是 `otp`。写错时服务端回的是 `VALIDATION_ERROR: [body.code] Invalid
  input`，magpie 只显示「授权失败」，完全看不出原因。
  实测判据（`npm run probe` 的语义探针）：
  `{phoneNumber, code}` → `OTP not found.`（schema 过了）；`{phoneNumber, otp}` →
  `VALIDATION_ERROR`。
- **登录不再跳浏览器**：`authorize()` 返回的 `url` 改为空 —— magpie 只在 `url` 非空时
  才 `open`，所以现在只显示输入框。
- 失败时把服务端原话带回 `error` 并写进 magpie 日志（`service=today`），不再是干巴巴的
  「授权失败」。号码格式不对也直说，不再让人以为是验证码错。
- 校验请求补 `Origin`/`Referer`（better-auth 的 CSRF 检查看这两个）；服务端只回
  body `token` 而不给 Set-Cookie 时，自己拼 `better-auth.session_token=…`。

## 0.1.0

首个版本。Today AI（todayai.cn）作为 magpie 供应商。

- **登录**：手机号验证码（`/api/auth/phone-number/send-otp` → `verify`）；粘贴
  `better-auth.session_token` cookie 或 `POST /api/token` 拿到的 JWT。cookie 方式自动续期。
- **对话**：canonical 消息协议 → OpenAI Chat Completions。`POST /v1/messages` 之后从
  `wss://api.todayai.cn/ws` 收整条快照并按增量吐 SSE；实时通道不可用时退回
  `GET /v1/conversations/messages?after=` 轮询（web 客户端自己的 catch-up 路径）。
- **档位**：`mode.fast` / `mode.balanced` / `mode.power` / `model.deepseek-v4.1-flash` /
  `model.glm-5.3`，按请求的 model 用 `PUT /v1/pricing/model-option` 切档，变了才打。
- **额度**：`GET /v1/pricing/status` 的 `usage.items[]` → 卡片窗口；读不到时退回
  `usage.display`，耗尽时补一条 `used:100` 让这个号沉底。
- **错误**：按 magpie-community ERROR-CODES v1 出口（401 `session_expired`、
  504 `upstream_timeout`、501 `not_implemented` …），流式错误帧带 `status`。
