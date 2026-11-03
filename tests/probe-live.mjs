// 对着真 API 探端点：不需要账号，只看「存在 / 不存在 / 要登录」。
//
// 401 说明端点存在且要 Bearer；404 说明路径不对；400 说明存在、只是参数不合法。
// 这个脚本的意义是：协议哪天变了，先在这里看出来，而不是等 agent 报错。
//
// 用法：node tests/probe-live.mjs

const targets = [
  ["POST", "https://api.todayai.cn/ws-ticket", {}],
  ["POST", "https://api.todayai.cn/v1/messages", {}],
  ["GET", "https://api.todayai.cn/v1/messages", null],
  ["GET", "https://api.todayai.cn/v1/users/me", null],
  ["GET", "https://api.todayai.cn/v1/users/me/protocol-capabilities", null],
  ["GET", "https://api.todayai.cn/v1/pricing/status", null],
  ["GET", "https://api.todayai.cn/v1/conversations/messages?conversationId=x&limit=1", null],
  ["PUT", "https://api.todayai.cn/v1/pricing/model-option", { optionId: "mode.balanced" }],
  ["POST", "https://todayai.cn/api/token", { audience: "https://api.todayai.cn", expiresIn: 3600 }],
  ["POST", "https://auth.todayai.cn/api/token", { audience: "https://api.todayai.cn", expiresIn: 3600 }],
  ["POST", "https://auth.todayai.cn/api/auth/phone-number/send-otp", { phoneNumber: "123" }],
  ["POST", "https://auth.todayai.cn/api/auth/phone-number/verify", { phoneNumber: "123", otp: "000000" }],
  ["POST", "https://auth.todayai.cn/api/auth/sign-in/email", { email: "a@b.c", password: "x" }],
  ["GET", "https://auth.todayai.cn/.well-known/openid-configuration", null],
]

const probes = targets.map(async ([method, url, body]) => {
  const started = Date.now()
  let response
  try {
    response = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    })
  } catch (error) {
    return { method, url, status: 0, note: String(error?.message ?? error), ms: Date.now() - started }
  }
  const text = (await response.text().catch(() => "")).slice(0, 160).replaceAll(/\s+/g, " ")
  return { method, url, status: response.status, note: text, ms: Date.now() - started }
})

const rows = await Promise.all(probes)
let failures = 0
for (const row of rows) {
  const verdict = verdictOf(row.status)
  if (verdict === "?") failures += 1
  console.log(`${String(row.status).padStart(3)} ${verdict}  ${row.method.padEnd(4)} ${row.url}`)
  if (row.note) console.log(`      ${row.note}`)
  console.log(`      ${row.ms}ms`)
}

function verdictOf(status) {
  if (status === 401 || status === 403) return "存在·要登录"
  if (status === 400) return "存在·参数"
  if (status === 200) return "存在·公开"
  if (status === 404) return "不存在"
  if (status === 0) return "?"
  return "?"
}

// ── 语义探针：字段名对不对，光看 400 是分不出来的 ──────────────────
//
// 同一个号码、同一个错验证码：
//   {phoneNumber, code} → "OTP not found."（schema 过了，走语义）
//   {phoneNumber, otp}  → VALIDATION_ERROR + body.code（字段名不对）
// 这两个回答就是「验证码填不进去」那类 bug 的直接判据。
const semantic = [
  ["code 字段", { phoneNumber: "+8613800000000", code: "000000" }, /OTP not found|Invalid|expired/i],
  ["otp 字段（旧写法，应当被拒）", { phoneNumber: "+8613800000000", otp: "000000" }, /body\.code|VALIDATION_ERROR/i],
]
console.log("\n=== 语义探针（验证码字段名）===")
for (const [label, body, expect] of semantic) {
  let text = ""
  try {
    const response = await fetch("https://auth.todayai.cn/api/auth/phone-number/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://todayai.cn" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    })
    text = await response.text()
  } catch (error) {
    text = String(error?.message ?? error)
  }
  const ok = expect.test(text)
  if (!ok) failures += 1
  console.log(`${ok ? "✓" : "✗"} ${label}: ${text.slice(0, 120)}`)
}

if (failures > 0) {
  console.log(`\n${failures} 个端点没按预期回答 —— 协议可能变了，先看上面的 401/400 变成 404 的那几条。`)
  process.exitCode = 1
}