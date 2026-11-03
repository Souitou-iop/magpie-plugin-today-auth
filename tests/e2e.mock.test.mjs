// 端到端：用假 Today 服务端跑真请求。
//
// 锁住的是「协议理解」而不是「代码能编译」：
//   · WS 路线：hello 握手 → event.push 快照 → 增量 → [DONE]
//   · 轮询路线：ws-ticket 挂掉时改用 /v1/conversations/messages?after=
//   · 档位：PUT /v1/pricing/model-option 只在变化时打一次
//   · 401：带 x-magpie-sign-in: expired 交回 magpie
//   · 额度：usage.items[] → windows[]
//
// 跑法：node --test tests/e2e.mock.test.mjs

import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { startMockToday } from "./mock-today.mjs"

let mock

before(async () => {
  mock = await startMockToday({ withWebSocket: true })
  // 常量在 import 时读环境变量，所以先起服务再 import
  process.env.TODAY_API_BASE = mock.base
  process.env.TODAY_WEB_BASE = mock.base
  process.env.TODAY_AUTH_BASE = mock.base
})

after(async () => {
  await mock?.close()
})

function sseText(chunks) {
  const out = []
  for (const line of chunks.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (payload === "[DONE]") continue
    try {
      const frame = JSON.parse(payload)
      const piece = frame?.choices?.[0]?.delta?.content
      if (typeof piece === "string") out.push(piece)
    } catch {
      // 忽略非 JSON 行
    }
  }
  return out.join("")
}

test("WS 路线：快照增量 → SSE 正文 → [DONE]", async () => {
  const { chatFetch } = await import("../src/chat.mjs")
  const request = new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.3",
      stream: true,
      messages: [{ role: "user", content: "在吗" }],
    }),
  })
  const response = await chatFetch({ input: request, token: "mock-jwt-token", deviceId: "web_test" })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
  const body = await response.text()
  assert.equal(sseText(body), "你好，这是 Today。")
  assert.match(body, /data: \[DONE\]/)
  // 档位：power → mode.power 只打一次
  assert.deepEqual(mock.state.modes, ["model.glm-5.3"])
  // 发出去的 canonical body 是主聊形态
  const appended = mock.state.appended.at(-1)
  assert.equal(appended.isMainChat, true)
  assert.equal(appended.body.parts[0].type, "text")
  assert.equal(appended.body.parts[0].text, "在吗")
  // 客户端回过 client.received
  assert.ok(mock.state.acks.length > 0)
})

test("同一档位第二次不再 PUT", async () => {
  const { chatFetch } = await import("../src/chat.mjs")
  const request = new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "model.glm-5.3", stream: true, messages: [{ role: "user", content: "再来一条" }] }),
  })
  const response = await chatFetch({ input: request, token: "mock-jwt-token", deviceId: "web_test" })
  await response.text()
  assert.deepEqual(mock.state.modes, ["model.glm-5.3"])
})

test("非流式：一次性 JSON", async () => {
  const { chatFetch } = await import("../src/chat.mjs")
  const request = new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "balanced", stream: false, messages: [{ role: "user", content: "一句话" }] }),
  })
  const response = await chatFetch({ input: request, token: "mock-jwt-token", deviceId: "web_test" })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.object, "chat.completion")
  assert.equal(payload.choices[0].message.content, "你好，这是 Today。")
  assert.ok(payload.usage.total_tokens >= 0)
})

test("轮询兜底：ws-ticket 挂了照样出字", async () => {
  const offline = await startMockToday({ withWebSocket: false })
  const saved = process.env.TODAY_API_BASE
  process.env.TODAY_API_BASE = offline.base
  // 常量已固化在模块里 —— 用子进程跑，保证真的换掉基址
  const { execFile } = await import("node:child_process")
  const script = `
    const { chatFetch } = await import(${JSON.stringify(new URL("../src/chat.mjs", import.meta.url).href)});
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "balanced", stream: true, messages: [{ role: "user", content: "轮询" }] }),
    });
    const response = await chatFetch({ input: request, token: "mock-jwt-token", deviceId: "web_test" });
    process.stdout.write(await response.text());
  `
  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, TODAY_API_BASE: offline.base, TODAY_WEB_BASE: offline.base } },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    )
  })
  process.env.TODAY_API_BASE = saved
  await offline.close()
  assert.ifError(child.error)
  assert.equal(sseText(child.stdout), "你好，这是 Today。", child.stderr)
  assert.equal(offline.state.wsConnections, 0)
})

test("401：交回 magpie 时带 x-magpie-sign-in: expired", async () => {
  const dead = await startMockToday({ failAuth: true })
  const { execFile } = await import("node:child_process")
  const script = `
    const { chatFetch } = await import(${JSON.stringify(new URL("../src/chat.mjs", import.meta.url).href)});
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "balanced", stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    const response = await chatFetch({ input: request, token: "dead", deviceId: "web_test" });
    process.stdout.write(JSON.stringify({ status: response.status, signIn: response.headers.get("x-magpie-sign-in") }));
  `
  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, TODAY_API_BASE: dead.base, TODAY_WEB_BASE: dead.base } },
      (error, stdout) => resolve({ error, stdout }),
    )
  })
  await dead.close()
  assert.ifError(child.error)
  const parsed = JSON.parse(child.stdout)
  assert.equal(parsed.status, 401)
  assert.equal(parsed.signIn, "expired")
})

test("额度：progress 参与路由，breakdown 只展示", async () => {
  const { readUsage } = await import("../src/usage.mjs")
  const usage = await readUsage({ token: "mock-jwt-token", deviceId: "web_test" })
  assert.equal(usage.plan, "Pro")
  assert.equal(usage.until, "2027-01-24T03:03:42.636Z")
  assert.equal(usage.windows.length, 3)
  assert.equal(usage.windows[0].used, 26)
  assert.equal(usage.windows[0].aside, undefined)
  assert.equal(usage.windows[0].display, "剩余 74%")
  assert.deepEqual(
    usage.windows.slice(1).map((w) => [w.name, w.used, w.aside]),
    [
      ["复杂任务", 11, true],
      ["每日简报", 10, true],
    ],
  )
  for (const w of usage.windows) assert.ok(Number.isFinite(w.used), "每条窗口都必须有 used")
})

test("档位表：任何 optionId 都收，带前缀的剥离", async () => {
  const { optionsFromStatus } = await import("../src/catalog.mjs")
  const live = await (await fetch(`${mock.base}/v1/pricing/status`)).json()
  const options = optionsFromStatus(live)
  assert.ok(options)
  assert.equal(options.selected, "model.deepseek-v4.1-flash")
  assert.deepEqual(
    options.options.map((o) => [o.id, o.optionId, o.disabled]),
    [
      ["deepseek-v4.1-flash", "model.deepseek-v4.1-flash", false],
      ["minimax-m31-flash", "model.minimax-m31-flash", false],
      ["glm-5.3", "model.glm-5.3", false],
      ["retired-x", "model.retired-x", true],
    ],
  )
  assert.match(options.options[0].name, /1×/)
})
test("发请求前先注册设备：web_ id 换成服务端 id，WS 才连得上", async () => {
  const fresh = await startMockToday({ withWebSocket: true })
  const { execFile } = await import("node:child_process")
  const script = `
    const { chatFetch } = await import(${JSON.stringify(new URL("../src/chat.mjs", import.meta.url).href)});
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "balanced", stream: true, messages: [{ role: "user", content: "注册" }] }),
    });
    const response = await chatFetch({ input: request, token: "mock-jwt-token", deviceId: "web_11111111-2222-4333-a444-555555555555" });
    process.stdout.write(await response.text());
  `
  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, TODAY_API_BASE: fresh.base, TODAY_WEB_BASE: fresh.base } },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    )
  })
  assert.ifError(child.error)
  assert.equal(sseText(child.stdout), "你好，这是 Today。")
  assert.equal(fresh.state.registeredMachines.length, 1, "注册了一次")
  assert.equal(fresh.state.hellos[0].deviceId, fresh.state.deviceId, "hello 用的是服务端 id")
  assert.equal(fresh.state.clientStatusFrames, 0, "不再发 client.status（服务端会回 Invalid input）")
  await fresh.close()
})

test("切档 403 不影响这轮对话", async () => {
  const strict = await startMockToday({ modeForbidden: true })
  const { execFile } = await import("node:child_process")
  const script = `
    const { chatFetch } = await import(${JSON.stringify(new URL("../src/chat.mjs", import.meta.url).href)});
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "403" }] }),
    });
    const response = await chatFetch({ input: request, token: "mock-jwt-token", deviceId: "web_test" });
    process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));
  `
  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, TODAY_API_BASE: strict.base, TODAY_WEB_BASE: strict.base } },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    )
  })
  assert.ifError(child.error)
  const out = JSON.parse(child.stdout)
  assert.equal(out.status, 200, "切档被拒也要照常出字")
  assert.equal(sseText(out.body), "你好，这是 Today。")
  await strict.close()
})

test("半途收到服务端 error 帧：不断流", async () => {
  const noisy = await startMockToday({ midStreamErrorFrame: true })
  const { execFile } = await import("node:child_process")
  const script = `
    const { chatFetch } = await import(${JSON.stringify(new URL("../src/chat.mjs", import.meta.url).href)});
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "balanced", stream: true, messages: [{ role: "user", content: "噪声" }] }),
    });
    const response = await chatFetch({ input: request, token: "mock-jwt-token", deviceId: "web_test" });
    process.stdout.write(await response.text());
  `
  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, TODAY_API_BASE: noisy.base, TODAY_WEB_BASE: noisy.base } },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    )
  })
  assert.ifError(child.error)
  assert.equal(sseText(child.stdout), "你好，这是 Today。")
  await noisy.close()
})
