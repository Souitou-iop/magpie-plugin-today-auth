// 纯函数：不碰网络，锁住「算错不会报错、但结果全歪」的那几处。

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  bodyForPrompt,
  cookieFromSetCookies,
  deltaOf,
  deviceIdFor,
  estimateTokens,
  FALLBACK_MODEL_ID,
  isMessageDone,
  isReplyTo,
  normalizeCookieInput,
  promptFromMessages,
  staticModels,
  textOfMessage,
  jwtExpiryMs,
  truncate,
} from "../src/pure.mjs"

test("兜底模型只有一个：没登录时不编造档位", () => {
  const models = staticModels()
  assert.deepEqual(Object.keys(models), [FALLBACK_MODEL_ID])
  assert.equal(models.today.capabilities.toolcall, false)
})

test("快照 → 增量：前缀不变只补尾巴；变短不重发", () => {
  assert.deepEqual(deltaOf("", "你好"), { text: "你好", total: "你好" })
  assert.deepEqual(deltaOf("你好", "你好，世界"), { text: "，世界", total: "你好，世界" })
  assert.deepEqual(deltaOf("你好，世界", "你好"), { text: "", total: "你好，世界" })
  // 前缀被改写（同长度）：这一帧不吐 —— 重发会把中间一段显示两遍，
  // 比少一次改写更糟；下一次变长时从旧长度续发。
  assert.deepEqual(deltaOf("abc", "abd"), { text: "", total: "abc" })
  assert.deepEqual(deltaOf("abc", "abdef"), { text: "ef", total: "abdef" })
})

test("canonical parts → 文本：分段数组要拼接，thinking 不算正文", () => {
  const message = {
    body: {
      parts: [
        { messageType: "turn", content: { text: ["你", "好"], presentation: "thinking" } },
        { messageType: "turn", content: { text: "这是", presentation: "bubble" } },
        { messageType: "turn", content: { text: ["答案"] } },
        { messageType: "card", content: { text: "卡片文字不该算正文" } },
      ],
    },
  }
  const { answer, thinking } = textOfMessage(message)
  assert.equal(thinking, "你好")
  assert.equal(answer, "这是答案")
})

test("回复归属：originClientMessageId / originClientMessageIds 都认", () => {
  assert.equal(isReplyTo({ role: "assistant", originClientMessageId: "m1" }, "m1"), true)
  assert.equal(isReplyTo({ role: "assistant", originClientMessageIds: ["m0", "m1"] }, "m1"), true)
  assert.equal(isReplyTo({ role: "user", originClientMessageId: "m1" }, "m1"), false)
  assert.equal(isReplyTo({ role: "assistant", originClientMessageId: "m2" }, "m1"), false)
})

test("收完的判据：isFinal 或 state=completed/interrupted", () => {
  assert.equal(isMessageDone({ isFinal: true }), true)
  assert.equal(isMessageDone({ state: "completed" }), true)
  assert.equal(isMessageDone({ state: "interrupted" }), true)
  assert.equal(isMessageDone({ state: "in_progress" }), false)
  assert.equal(isMessageDone(null), false)
})

test("OpenAI 请求 → 一条 Today 消息：只取最后一条 user，图片不进正文", () => {
  const prompt = promptFromMessages([
    { role: "system", content: "你是助手" },
    { role: "user", content: "第一句" },
    { role: "assistant", content: "回答" },
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ])
  assert.equal(prompt, "看图")
})

test("拿不到 user 消息时退化成整段对话", () => {
  const prompt = promptFromMessages([{ role: "system", content: "只有系统提示" }])
  assert.match(prompt, /system: 只有系统提示/)
})

test("截断：留头 60% 与尾 40%，并写明省略了多少", () => {
  const text = "A".repeat(1000) + "B".repeat(1000)
  const out = truncate(text, 100)
  assert.ok(out.length < 200)
  assert.match(out, /已省略/)
  assert.ok(out.startsWith("A"))
  assert.ok(out.endsWith("B"))
})

test("body 是 canonical 主聊形态：parts[0] 为 text", () => {
  const body = bodyForPrompt("hi")
  assert.equal(body.parts.length, 1)
  assert.equal(body.parts[0].type, "text")
  assert.equal(body.parts[0].text, "hi")
  assert.match(body.parts[0].id, /^[0-9a-f-]{36}$/)
})

test("Cookie 处理：同名取最后、deleted 删掉、整段头能粘", () => {
  const jar = cookieFromSetCookies([
    "better-auth.session_token=a; Path=/; Domain=.todayai.cn; HttpOnly",
    "better-auth.session_token=b; Path=/",
    "theme=dark; Path=/",
    "old=deleted; Path=/",
    "old=x; Path=/",
  ])
  assert.match(jar, /better-auth\.session_token=b/)
  assert.doesNotMatch(jar, /session_token=a/)
  assert.match(jar, /theme=dark/)
  assert.equal(normalizeCookieInput("Cookie: a=1; b=2\nc=3"), "a=1; b=2; c=3")
})

test("JWT 过期时间", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url")
  assert.equal(jwtExpiryMs(`${header}.${payload}.sig`), 1_700_000_000_000)
  assert.equal(jwtExpiryMs("not-a-jwt"), null)
})

test("设备 id 稳定且带 web_ 前缀", () => {
  const a = deviceIdFor("user_1")
  const b = deviceIdFor("user_1")
  const c = deviceIdFor("user_2")
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^web_[0-9a-f-]{36}$/)
  assert.ok(a.length <= 256)
})

test("token 数粗算：中文比英文贵", () => {
  assert.ok(estimateTokens("你好世界") > estimateTokens("abcd"))
  assert.equal(estimateTokens(""), 0)
})