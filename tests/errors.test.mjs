// 错误出口：锁住 status / code 的搭配（magpie-community ERROR-CODES §2、§3）。
//
// 分类错了不会报错，只会让宿主把号换光还失败 —— 所以这几条必须是测试。

import assert from "node:assert/strict"
import { test } from "node:test"

import { CODES, chatFetch, classifyError } from "../src/chat.mjs"

test("词表就是 §3 那 12 个，不许自造", () => {
  assert.deepEqual(Object.values(CODES).sort(), [
    "audit_blocked",
    "concurrency_conflict",
    "internal_error",
    "invalid_request",
    "model_not_found",
    "not_implemented",
    "rate_limited",
    "session_expired",
    "sign_in_required",
    "upstream_error",
    "upstream_timeout",
    "upstream_unavailable",
  ])
})

test("status → code：4xx 是请求问题，5xx 是上游问题", () => {
  assert.deepEqual(classifyError({ status: 401 }), { status: 401, code: CODES.sessionExpired })
  assert.deepEqual(classifyError({ status: 403 }), { status: 401, code: CODES.sessionExpired })
  assert.deepEqual(classifyError({ status: 400 }), { status: 400, code: CODES.invalidRequest })
  assert.deepEqual(classifyError({ status: 404 }), { status: 404, code: CODES.modelNotFound })
  assert.deepEqual(classifyError({ status: 409 }), { status: 409, code: CODES.concurrencyConflict })
  assert.deepEqual(classifyError({ status: 429 }), { status: 429, code: CODES.rateLimited })
  assert.deepEqual(classifyError({ status: 500 }), { status: 503, code: CODES.upstreamUnavailable })
  assert.deepEqual(classifyError({ status: 503 }), { status: 503, code: CODES.upstreamUnavailable })
})

test("超时 → 504（R8：不许落 502/404）", () => {
  assert.deepEqual(classifyError(Object.assign(new Error("timeout"), { name: "TimeoutError" })), {
    status: 504,
    code: CODES.upstreamTimeout,
  })
  assert.deepEqual(classifyError(new Error("实时通道 90s 无事件")), { status: 504, code: CODES.upstreamTimeout })
  assert.deepEqual(classifyError(new Error("等了 90s 没有收到回复")), { status: 504, code: CODES.upstreamTimeout })
})

test("1 MiB 上限 → 400 invalid_request，文案带「上下文」", () => {
  const { status, code } = classifyError(new Error("消息超过 Today 单条 1 MiB 上限"))
  assert.equal(status, 400)
  assert.equal(code, CODES.invalidRequest)
})

test("说不清的错误 → 502 upstream_error（默认桶）", () => {
  assert.deepEqual(classifyError(new Error("上游说了句莫名其妙的话")), {
    status: 502,
    code: CODES.upstreamError,
  })
})

test("不支持的端点 → 501 not_implemented，不是 404", async () => {
  const response = await chatFetch({
    input: new Request("http://local/v1/embeddings", { method: "POST", body: "{}" }),
    token: "x",
    deviceId: "y",
  })
  assert.equal(response.status, 501)
  const payload = await response.json()
  assert.equal(payload.error.code, CODES.notImplemented)
  assert.equal(payload.error.status, 501)
})

test("请求体不是 JSON → 400 invalid_request", async () => {
  const response = await chatFetch({
    input: new Request("http://local/v1/chat/completions", { method: "POST", body: "{oops" }),
    token: "x",
    deviceId: "y",
  })
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error.code, CODES.invalidRequest)
})