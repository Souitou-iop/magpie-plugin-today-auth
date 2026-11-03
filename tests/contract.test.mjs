// 契约测试：把插件当 magpie 来调。
//
// magpie 只会做这几件事 —— config(cfg)、auth.methods[].authorize()/callback()、
// auth.refresh()、auth.loader()/fetch()、auth.usage()、provider.models()、
// "chat.headers"。这里逐个走一遍，任何一个形状不对都当场炸。
//
// 上游是 tests/mock-today.mjs：形状全部照逆向结果造，所以这里过了 ≠ 线上一定通，
// 但这里不过 = 线上一定不通。

import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { startMockToday } from "./mock-today.mjs"

// 138 0000 0000：大陆预留的示意号码，只打到假的 Today 服务端
const TEST_PHONE = "1" + "3800000000"

let mock
let plugin

before(async () => {
  mock = await startMockToday({ withWebSocket: true })
  process.env.TODAY_API_BASE = mock.base
  process.env.TODAY_WEB_BASE = mock.base
  process.env.TODAY_AUTH_BASE = mock.base
  const { TodayAuthPlugin } = await import("../index.mjs")
  plugin = await TodayAuthPlugin({ client: { app: { log() {} } } })
})

after(async () => {
  await mock?.close()
})

test("config：provider 与静态模型表", async () => {
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider.today
  assert.ok(provider, "要有 today 这个 provider")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  const models = Object.values(provider.models)
  assert.equal(models.length, 1, "未登录只给一个诚实的兜底模型")
  assert.equal(models[0].id, "today")
  for (const m of models) {
    assert.equal(m.limit.context > 0, true)
    assert.equal(typeof m.capabilities.input.image, "boolean", "五个模态键要显式写")
    assert.equal(m.capabilities.toolcall, false)
  }
})

test("config 不覆盖用户已配置的值", async () => {
  const cfg = { provider: { today: { name: "我改的", npm: "@ai-sdk/openai-compatible", api: "x", models: { a: {} } } } }
  await plugin.config(cfg)
  assert.equal(cfg.provider.today.name, "我改的")
  assert.deepEqual(Object.keys(cfg.provider.today.models), ["a"])
})

test("登录方式两条：手机验证码 + 粘贴 Cookie/Bearer", () => {
  const methods = plugin.auth.methods
  assert.equal(methods.length, 2)
  assert.deepEqual(methods.map((m) => m.type), ["oauth", "oauth"])
  assert.ok(methods[0].prompts.some((p) => p.key === "phone"))
})

test("authorize 立刻返回（不等登录）", async () => {
  const started = Date.now()
  const flow = await plugin.auth.methods[1].authorize()
  assert.ok(Date.now() - started < 2000, "authorize 不能阻塞")
  assert.equal(flow.method, "code")
  assert.ok(flow.instructions.includes("session_token"))
})

test("粘贴 Cookie：callback 验通过并给出 magpie 要的字段", async () => {
  const flow = await plugin.auth.methods[1].authorize()
  const result = await flow.callback("better-auth.session_token=mock_session")
  assert.equal(result.type, "success", result.error)
  assert.equal(result.access, "mock-jwt-token")
  assert.equal(result.refresh, "better-auth.session_token=mock_session")
  assert.ok(result.expires > Date.now())
  assert.equal(result.accountId, "mock@example.com")
  assert.equal(result.uid, "user_mock")
  assert.equal(result.mainConversationId, "conv_main")
  assert.match(result.deviceId, /^web_/)
})

test("坏凭据：callback 返回 failed 而不是抛", async () => {
  const dead = await startMockToday({ failAuth: true })
  const saved = process.env.TODAY_WEB_BASE
  // 这是同一进程里的模块常量，改用子进程验证
  const { execFile } = await import("node:child_process")
  const script = `
    const { TodayAuthPlugin } = await import(${JSON.stringify(new URL("../index.mjs", import.meta.url).href)});
    const plugin = await TodayAuthPlugin({ client: { app: { log() {} } } });
    const flow = await plugin.auth.methods[1].authorize();
    const result = await flow.callback("better-auth.session_token=dead");
    process.stdout.write(JSON.stringify(result));
  `
  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, TODAY_API_BASE: dead.base, TODAY_WEB_BASE: dead.base } },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    )
  })
  process.env.TODAY_WEB_BASE = saved
  await dead.close()
  assert.ifError(child.error)
  const result = JSON.parse(child.stdout)
  assert.equal(result.type, "failed")
})

test("refresh：cookie 换新 Bearer（合并语义，只回 access/expires）", async () => {
  const flow = await plugin.auth.methods[1].authorize()
  const account = await flow.callback("better-auth.session_token=mock_session")
  const renewed = await plugin.auth.refresh(account)
  assert.equal(renewed.access, "mock-jwt-token")
  assert.ok(renewed.expires > Date.now())
  assert.equal(renewed.refresh, undefined, "不该回 refresh，cookie 继续用")
})

test("loader：OpenAI 请求 → Today → SSE 正文", async () => {
  const flow = await plugin.auth.methods[1].authorize()
  const account = await flow.callback("better-auth.session_token=mock_session")
  const getAuth = async () => account

  const loader = await plugin.auth.loader(getAuth, {})
  assert.ok(loader?.fetch, "loader 要给 fetch")
  assert.match(loader.baseURL, /api\.todayai\.cn|127\.0\.0\.1/)

  const response = await loader.fetch(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3",
        stream: true,
        messages: [{ role: "user", content: "契约测试" }],
      }),
    }),
  )
  assert.equal(response.status, 200)
  const text = await response.text()
  const pieces = text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6))?.choices?.[0]?.delta?.content ?? ""
      } catch {
        return ""
      }
    })
    .join("")
  assert.equal(pieces, "你好，这是 Today。")
  assert.ok(mock.state.modes.includes("model.glm-5.3"), "要按模型切档")
})

test("loader：未登录时给 401，不把空请求打出去", async () => {
  const loader = await plugin.auth.loader(async () => null, {})
  assert.deepEqual(loader, {})
})

test("usage：套餐名与两条窗口", async () => {
  const flow = await plugin.auth.methods[1].authorize()
  const account = await flow.callback("better-auth.session_token=mock_session")
  const usage = await plugin.auth.usage(async () => account, {})
  assert.equal(usage.plan, "Pro")
  // 一条参与路由的主窗口（progress=26）+ 两条只展示的拆分
  assert.equal(usage.windows.length, 3)
  assert.equal(usage.windows[0].name, "用量")
  assert.equal(usage.windows[0].used, 26)
  assert.equal(usage.windows[0].aside, undefined, "主窗口必须参与路由")
  assert.equal(usage.windows[0].resetsAt, "2026-11-24T03:03:42.636Z")
  assert.equal(usage.windows[1].aside, true, "拆分项只展示")
  assert.equal(usage.windows[1].name, "复杂任务")
  assert.ok(usage.windows.every((w) => Number.isFinite(w.used)))
})

test("provider.models：按账号真实目录，禁用项不列", async () => {
  const flow = await plugin.auth.methods[1].authorize()
  const account = await flow.callback("better-auth.session_token=mock_session")
  const models = await plugin.provider.models({ models: {} }, { auth: account })
  assert.deepEqual(Object.keys(models).sort(), ["deepseek-v4.1-flash", "glm-5.3", "minimax-m31-flash"])
  assert.match(models["glm-5.3"].name, /GLM 5\.3/)
  assert.equal(models["glm-5.3"].capabilities.toolcall, false)
})

test("provider.models：没登录就回静态表", async () => {
  const models = await plugin.provider.models({ models: {} }, { auth: null })
  assert.deepEqual(Object.keys(models), ["today"])
})

test("chat.headers：只给本 provider 加头", async () => {
  const out = { headers: {} }
  await plugin["chat.headers"]({ sessionID: "sess-1", model: { providerID: "today" } }, out)
  assert.equal(out.headers["x-today-session"], "sess-1")

  const other = { headers: {} }
  await plugin["chat.headers"]({ sessionID: "sess-1", model: { providerID: "zcode" } }, other)
  assert.deepEqual(other.headers, {})
})

test("入口只导出工厂（和一个非函数对象）", async () => {
  const mod = await import("../index.mjs")
  const exported = Object.entries(mod)
  const functions = exported.filter(([, value]) => typeof value === "function").map(([name]) => name)
  assert.deepEqual(functions, ["TodayAuthPlugin"], "多导出一个函数会被 magpie 当插件工厂调用")
})
test("登录不再弹浏览器：两种方式的 url 都是空", async () => {
  const phone = await plugin.auth.methods[0].authorize({ phone: TEST_PHONE })
  assert.equal(phone.url, "", "空 url 时 magpie 不 open")
  const paste = await plugin.auth.methods[1].authorize()
  assert.equal(paste.url, "")
})

test("手机验证码：发码 → 填码 → 拿到账号", async () => {
  const flow = await plugin.auth.methods[0].authorize({ phone: TEST_PHONE })
  assert.match(flow.instructions, /验证码已发到 \+86/)
  const result = await flow.callback("123456")
  assert.equal(result.type, "success", result.error)
  assert.equal(result.access, "mock-jwt-token")
  assert.match(result.refresh, /better-auth\.session_token=mock_session/)
  assert.equal(result.uid, "user_mock")
})

test("验证码不对：把服务端的原话带回来，不是「授权失败」", async () => {
  const flow = await plugin.auth.methods[0].authorize({ phone: TEST_PHONE })
  const result = await flow.callback("000000")
  assert.equal(result.type, "failed")
  assert.match(result.error, /INVALID_OTP/)
})

test("号码不被接受：直接说清楚，别让用户以为是验证码错", async () => {
  const flow = await plugin.auth.methods[0].authorize({ phone: "1" })
  assert.match(flow.instructions, /手机号格式不对|不接受/)
})

test("服务端只给 token 不给 cookie 时，自己拼 Cookie 头", async () => {
  const tokenStyle = await startMockToday({ cookieStyle: "token" })
  const { execFile } = await import("node:child_process")
  const script = `
    const { TodayAuthPlugin } = await import(${JSON.stringify(new URL("../index.mjs", import.meta.url).href)});
    const plugin = await TodayAuthPlugin({ client: { app: { log() {} } } });
    const flow = await plugin.auth.methods[0].authorize({ phone: ${TEST_PHONE} });
    const result = await flow.callback("123456");
    process.stdout.write(JSON.stringify(result));
  `
  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, TODAY_API_BASE: tokenStyle.base, TODAY_WEB_BASE: tokenStyle.base, TODAY_AUTH_BASE: tokenStyle.base } },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    )
  })
  await tokenStyle.close()
  assert.ifError(child.error)
  const result = JSON.parse(child.stdout)
  assert.equal(result.type, "success", result.error)
  assert.equal(result.refresh, "better-auth.session_token=mock_session_token")
})
