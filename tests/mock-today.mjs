// 一个假 Today 服务端：把判据从「读代码猜」变成「跑起来看」。
//
// 它实现的是本插件真正用到的那几个端点（全部来自逆向得到的形状）：
//   POST /v1/messages                     canonical 消息追加
//   GET  /v1/conversations/messages       ?conversationId&after&limit
//   POST /ws-ticket                       → {ticket}
//   WS   /ws                              device.hello → cloud.hello_ack → event.push
//   POST /api/token                       cookie → {token, expiresAt}
//   GET  /v1/pricing/status               plan + usage.items + modelOptions
//   PUT  /v1/pricing/model-option         记录档位
//   GET  /v1/users/me、/protocol-capabilities
//
// WebSocket 是手写的（没有 ws 依赖）：握手 + 文本帧收发，够用就行。

import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

export async function startMockToday({
  withWebSocket = true,
  replyText = ["你好", "，这是", " Today。"],
  failAuth = false,
  cookieStyle = "cookie",
  modeForbidden = false,
  midStreamErrorFrame = false,
} = {}) {
  const state = {
    deviceId: "mock_device_1",
    registeredMachines: [],
    sentOtps: [],
    expectedOtp: "123456",
    cookieStyle: "cookie",
    appended: [], // POST /v1/messages 的请求体
    history: [], // 会话里的消息（含我们推回去的助手消息）
    modes: [], // PUT model-option 的 optionId
    sockets: new Set(),
    wsConnections: 0,
    hellos: [],
    acks: [],
    clientStatusFrames: 0,
    notices: [],
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    const body = await readBody(req)
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
      return
    }

    if (failAuth) {
      return json(401, { error: "Unauthorized" })
    }

    // ── 手机号验证码 ─────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/auth/phone-number/send-otp") {
      const phone = String(body?.phoneNumber ?? "")
      if (!/^\+861[3-9]\d{9}$/.test(phone)) {
        return json(400, { code: "INVALID_PHONE_NUMBER", message: "Some request fields are invalid." })
      }
      state.sentOtps.push(phone)
      return json(200, { message: "code sent" })
    }

    if (req.method === "POST" && url.pathname === "/api/auth/phone-number/verify") {
      // 真服务端要的字段是 code（不是 otp）—— 漏了就在这里复现
      if (typeof body?.code !== "string") {
        return json(400, {
          code: "VALIDATION_ERROR",
          message: "[body.code] Invalid input: expected string, received undefined",
        })
      }
      if (body.code !== (state.expectedOtp ?? "123456")) {
        return json(400, { code: "INVALID_OTP", message: "Invalid or expired code" })
      }
      if (state.cookieStyle === "token") {
        return json(200, { token: "mock_session_token", user: { id: "user_mock" } })
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "better-auth.session_token=mock_session; Path=/; Domain=.todayai.cn; HttpOnly; SameSite=Lax",
      })
      res.end(JSON.stringify({ user: { id: "user_mock", phone: body.phoneNumber } }))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/token") {
      return json(200, { token: "mock-jwt-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    }

    if (req.method === "GET" && url.pathname === "/v1/users/me") {
      return json(200, {
        success: true,
        code: "common.ok",
        data: { id: "user_mock", preferredName: "Mock User", account: { email: "mock@example.com" } },
      })
    }

    if (req.method === "GET" && url.pathname === "/v1/users/me/protocol-capabilities") {
      return json(200, {
        success: true,
        code: "common.ok",
        data: {
          architecture: "canonical",
          messageCapabilities: {
            messageProtocolVersion: "canonical-v1",
            mainConversationId: "conv_main",
            authSubject: "mock:user_mock",
            supportsTypedBody: true,
            supportsSequencePull: true,
            supportsLongPoll: true,
            longPollWaitMaxMs: 25000,
          },
        },
      })
    }

    if (req.method === "GET" && url.pathname === "/v1/pricing/status") {
      return json(200, {
        success: true,
        code: "common.ok",
        data: {
          status: {
            schemaVersion: 1,
            plan: "pro",
            subscriptionState: "none",
            accessPhase: "normal",
            serviceState: "normal",
            entitlementEndsAt: "2027-01-24T03:03:42.636Z",
            currentPeriodEndAt: "2026-11-24T03:03:42.636Z",
            display: { title: "Pro", subtitle: "expires 2027.01.24" },
            usage: {
              schemaVersion: 1,
              period: "monthly",
              title: "用量",
              progress: 26,
              progressText: "剩余 74%",
              resetAt: "2026-11-24T03:03:42.636Z",
              breakdown: {
                schemaVersion: 1,
                display: { remainingPercentText: "74%" },
                items: [
                  { key: "tasks", usedPercent: 11, display: { title: "复杂任务", percentText: "11%" } },
                  { key: "daily_brief", usedPercent: 10, display: { title: "每日简报", percentText: "10%" } },
                ],
              },
              freeServices: { schemaVersion: 1, items: [{ key: "chat", display: { title: "日常对话", tagText: "Free" } }] },
            },
            modelOptions: {
              schemaVersion: 1,
              display: { title: "Model", description: "", tailNote: "multipliers" },
              selectedOptionId: "model.deepseek-v4.1-flash",
              options: [
                {
                  id: "model.deepseek-v4.1-flash",
                  disabled: false,
                  display: { title: "DeepSeek V4.1 Flash", subtitle: "Usage multiplier: 1×" },
                },
                {
                  id: "model.minimax-m31-flash",
                  disabled: false,
                  display: { title: "MiniMax M3.1 Flash", subtitle: "Usage multiplier: 1×" },
                },
                {
                  id: "model.glm-5.3",
                  disabled: false,
                  display: { title: "GLM 5.3", subtitle: "Usage multiplier: 4×" },
                },
                {
                  id: "model.retired-x",
                  disabled: true,
                  display: { title: "Retired", subtitle: "" },
                },
              ],
            },
          },
        },
      })
    }

    if (req.method === "POST" && url.pathname === "/registry/devices") {
      if (!body?.clientMachineId) return json(400, { code: "invalid_request", message: "clientMachineId required" })
      state.registeredMachines.push(body.clientMachineId)
      const id = state.deviceId
      return json(200, { device: { id }, created: state.registeredMachines.length === 1 })
    }

    if (req.method === "PUT" && url.pathname === "/v1/pricing/model-option") {
      if (state.modeForbidden) {
        return json(403, { success: false, code: "auth.forbidden", message: "你没有权限执行此操作。", data: null })
      }
      state.modes.push(body?.optionId)
      return json(200, { success: true, code: "common.ok", data: { modelOptions: { selectedOptionId: body?.optionId } } })
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const clientMessageId = body?.clientMessageId
      if (body?.isMainChat !== true || !Array.isArray(body?.body?.parts) || !clientMessageId) {
        return json(400, { code: "invalid_request", message: "bad canonical body" })
      }
      state.appended.push(body)
      const conversationId = body?.conversationId ?? "conv_main"
      const userMessage = {
        id: `u_${randomUUID()}`,
        conversationId,
        threadId: "th_main",
        cursor: `cu_${state.history.length}`,
        role: "user",
        state: "completed",
        isFinal: true,
        clientMessageId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        body: {
          parts: body.body.parts.map((p) => ({ messageType: p.type === "text" ? "turn" : "text", content: { text: [p.text ?? ""] } })),
        },
      }
      state.history.push(userMessage)

      const assistantId = `a_${randomUUID()}`
      // 先推 ws（如果连上了），否则靠轮询把历史补齐
      if (state.sockets.size > 0 && withWebSocket) {
        streamReplyOverSockets(state, { assistantId, clientMessageId, conversationId, replyText })
      } else {
        streamReplyOverHistory(state, { assistantId, clientMessageId, conversationId, replyText })
      }
      return json(200, { success: true, code: "common.ok", data: { canonicalMessage: userMessage } })
    }

    if (req.method === "GET" && url.pathname === "/v1/conversations/messages") {
      const after = url.searchParams.get("after")
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200)
      let items = state.history
      if (after) {
        const idx = items.findIndex((m) => m.cursor === after)
        items = idx >= 0 ? items.slice(idx + 1) : items
      }
      const page = items.slice(0, limit)
      return json(200, {
        success: true,
        code: "common.ok",
        data: {
          items: page,
          paging: { nextCursor: page.at(-1)?.cursor ?? after ?? null, hasMore: items.length > page.length },
        },
      })
    }

    if (req.method === "POST" && url.pathname === "/ws-ticket") {
      if (!withWebSocket) return json(503, { message: "realtime disabled" })
      return json(200, { ticket: `tck_${randomUUID().slice(0, 8)}` })
    }

    return json(404, { code: "NOT_FOUND", message: "Not found" })
  })

  // ── WebSocket 升级 ────────────────────────────────────────────────
  server.on("upgrade", (req, socket) => {
    if (!withWebSocket) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n")
      return
    }
    const key = req.headers["sec-websocket-key"]
    if (!key) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      return
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    state.wsConnections += 1
    state.sockets.add(socket)

    let buffer = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const frame = decodeFrame(buffer)
        if (!frame) break
        buffer = buffer.subarray(frame.size)
        if (frame.opcode === 0x8) {
          socket.end()
          state.sockets.delete(socket)
          return
        }
        if (frame.opcode === 0x1) {
          let message = null
          try {
            message = JSON.parse(frame.payload.toString("utf8"))
          } catch {
            continue
          }
          if (message?.type === "device.hello") {
            state.hellos.push(message)
            if (message.deviceId !== state.deviceId) {
              // 没注册设备就来握手：真服务端就是这么拒的
              sendJson(socket, {
                id: `srv_${randomUUID()}`,
                timestamp: new Date().toISOString(),
                type: "error",
                message: "Device not found or inactive",
              })
              socket.end()
              state.sockets.delete(socket)
              return
            }
            sendJson(socket, {
              id: `srv_${randomUUID()}`,
              timestamp: new Date().toISOString(),
              type: "cloud.hello_ack",
              sessionId: "sess_mock",
              heartbeatIntervalMs: 30_000,
              messageProtocolVersion: "canonical-v1",
            })
          } else if (message?.type === "client.received") {
            state.acks.push(message)
          } else if (message?.type === "client.status") {
            state.clientStatusFrames += 1
          }
        }
      }
    })
    socket.on("close", () => state.sockets.delete(socket))
    socket.on("error", () => state.sockets.delete(socket))
  })

  state.cookieStyle = cookieStyle
  state.modeForbidden = modeForbidden
  state.midStreamErrorFrame = midStreamErrorFrame
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    state,
    async close() {
      for (const s of state.sockets) {
        try {
          s.destroy()
        } catch {
          // ignore
        }
      }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ── 推送助手消息的快照 ────────────────────────────────────────────────

async function streamReplyOverSockets(state, { assistantId, clientMessageId, conversationId, replyText }) {
  const message = baseAssistant({ assistantId, clientMessageId, conversationId, replyText })
  let seq = 0
  const push = (event, data) => {
    for (const socket of state.sockets) {
      sendJson(socket, {
        type: "event.push",
        id: `evt_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        seq: ++seq,
        payload: { event, data },
      })
    }
  }
  // 逐段推：每帧都是**整条快照**（和真服务端一致），客户端自己算增量
  for (let i = 0; i < replyText.length; i++) {
    if (i === 1 && state.midStreamErrorFrame) {
      for (const socket of state.sockets) {
        sendJson(socket, {
          type: "error",
          id: `evt_err_${randomUUID()}`,
          timestamp: new Date().toISOString(),
          message: "Invalid input",
        })
      }
    }
    const final = i === replyText.length - 1
    const snapshot = withParts(message, [replyText.slice(0, i + 1).join("")], final)
    push(i === 0 ? "chat.message_ready.v2" : "chat.message_updated.v2", {
      messageProtocolVersion: "canonical-v1",
      conversationId,
      messageId: assistantId,
      needPull: false,
      message: snapshot,
    })
    if (final) state.history.push(snapshot)
    else await sleep(20)
  }
}

async function streamReplyOverHistory(state, { assistantId, clientMessageId, conversationId, replyText }) {
  const message = baseAssistant({ assistantId, clientMessageId, conversationId, replyText })
  for (let i = 0; i < replyText.length; i++) {
    const final = i === replyText.length - 1
    state.history.push(withParts(message, [replyText.slice(0, i + 1).join("")], final))
    if (!final) await sleep(20)
  }
}

function baseAssistant({ assistantId, clientMessageId, conversationId }) {
  return {
    id: assistantId,
    conversationId,
    threadId: "th_main",
    role: "assistant",
    originClientMessageId: clientMessageId,
    createdAt: new Date().toISOString(),
  }
}

function withParts(message, texts, final) {
  const text = texts.join("")
  return {
    ...message,
    cursor: `ca_${Math.random().toString(36).slice(2, 8)}`,
    state: final ? "completed" : "in_progress",
    isFinal: final,
    updatedAt: new Date().toISOString(),
    body: { parts: [{ messageType: "turn", content: { text, presentation: "bubble" } }] },
  }
}

// ── WebSocket 帧 ──────────────────────────────────────────────────────

function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const opcode = first & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskOffset = offset
  if (masked) offset += 4
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4)
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  }
  return { opcode, payload, size: offset + length }
}

function sendJson(socket, payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf8")
  let header
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  try {
    socket.write(Buffer.concat([header, data]))
  } catch {
    // 对端先断了
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      if (!text) return resolve(null)
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(null)
      }
    })
    req.on("error", () => resolve(null))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}