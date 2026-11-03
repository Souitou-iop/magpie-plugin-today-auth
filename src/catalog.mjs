// Today AI · 档位目录（按账号，不硬编码）
//
// ⚠ 不要按 web 构建里的 mock 去写死档位：那是 `mode.fast / mode.balanced / mode.power`。
// **真账号**（Pro）下发的是完全另一组：
//
//   model.deepseek-v4.1-flash   1×   (selected)
//   model.minimax-m31-flash     1×
//   model.glm-5.3               4×
//
// 所以这张表**不能写死**：每个账号、每个套餐、每个地区都可能不一样。
// 本模块只做两件事 —— 记住这个账号最近一次下发的 options，把 magpie 的模型 id
// 翻回 Today 的 optionId。
//
// optionId 的形状是 `<group>.<slug>`（mode.* / model.*）。magpie 侧只留 slug，
// 这样 `today/deepseek-v4.1-flash` 比 `today/model.deepseek-v4.1-flash` 好读。

const TTL_MS = 10 * 60_000

/** accountKey → { fetchedAt, selected, options:[{id, optionId, name, title, subtitle, disabled}] } */
const registry = new Map()

/** 去掉 optionId 的分组前缀：model.glm-5.3 → glm-5.3 */
export function slugOfOption(optionId) {
  const s = String(optionId ?? "").trim()
  if (!s) return ""
  const dot = s.indexOf(".")
  return dot > 0 ? s.slice(dot + 1) : s
}

/** 把 `/v1/pricing/status` 的 modelOptions 折成目录（任何 id 都收，不猜） */
export function optionsFromStatus(payload) {
  const data = payload?.data ?? payload
  const opts = data?.status?.modelOptions ?? data?.modelOptions
  if (!opts || !Array.isArray(opts.options)) return null
  const options = []
  for (const o of opts.options) {
    const optionId = String(o?.id ?? "").trim()
    if (!optionId) continue
    const id = slugOfOption(optionId)
    if (!id) continue
    const title = String(o?.display?.title ?? "").trim()
    const subtitle = String(o?.display?.subtitle ?? "").trim()
    options.push({
      id,
      optionId,
      name: title ? `${title}${subtitle ? `（${subtitle}）` : ""}` : id,
      title,
      subtitle,
      disabled: o?.disabled === true,
    })
  }
  if (options.length === 0) return null
  return { selected: String(opts.selectedOptionId ?? ""), options }
}

export function rememberOptions(accountKey, parsed) {
  if (!accountKey || !parsed) return
  registry.set(String(accountKey), { fetchedAt: Date.now(), ...parsed })
}

export function optionsFor(accountKey) {
  const hit = registry.get(String(accountKey ?? ""))
  if (!hit) return null
  return hit
}

/** 是否还用不着重新拉（10 分钟内） */
export function isFresh(accountKey) {
  const hit = registry.get(String(accountKey ?? ""))
  return Boolean(hit && Date.now() - hit.fetchedAt < TTL_MS)
}

/**
 * magpie 的模型 id → Today 的 optionId。
 *
 * 认三种写法：
 *   · 目录里的 slug（deepseek-v4.1-flash）
 *   · 目录里的 optionId 原样（model.deepseek-v4.1-flash）
 *   · 带 provider 前缀（today/glm-5.3）
 *
 * 都不认就返回 null —— **不要瞎猜一个 optionId 发出去**：猜错要么 403，
 * 要么把账号档位悄悄改到别的模型上。
 */
export function optionIdForModel(model, accountKey) {
  const raw = String(model ?? "").trim()
  if (!raw) return null
  const slash = raw.lastIndexOf("/")
  const bare = (slash >= 0 ? raw.slice(slash + 1) : raw).trim().toLowerCase()
  const hit = optionsFor(accountKey)
  if (hit) {
    for (const o of hit.options) {
      if (o.id.toLowerCase() === bare || o.optionId.toLowerCase() === bare) return o.optionId
    }
    // 别名：magpie 侧的旧名字仍然认（balanced → 当前选中的档位）
    if (bare === "default" || bare === "balanced") return hit.selected || null
  }
  // 形状本身就是 optionId：直接交给服务端判
  if (/^(mode|model)\.[a-z0-9._-]+$/i.test(raw)) return raw
  return null
}

/** 测试/调试用：清空目录缓存 */
export function resetCatalog() {
  registry.clear()
}