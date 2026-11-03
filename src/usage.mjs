// Today AI · 额度卡片
//
// 数据来自 `GET /v1/pricing/status`（web 的「套餐」页就是这个端点）：
//
//   data.status = {
//     schemaVersion, plan, subscriptionState, accessPhase, serviceState,
//     trialEndsAt, currentPeriodEndAt,
//     display: { title, subtitle, cta },
//     usage: {
//       display: { title, subtitle, totalUsedText, remainingPercentText, remainingLabel },
//       items: [{ key, usedPercent, display:{ title, percentText }, action }],
//       breakdown, services
//     },
//     modelOptions: { selectedOptionId, options: [...] }
//   }
//
// `items[]` 就是现成的进度条：usedPercent 是 0-100，display.title 是标签。
// 这是这个插件里唯一「不用猜」的额度来源 —— 服务端算好百分比，我们只是搬运。
//
// ⚠ 三条会静默出错的规矩（scaffold/HOOKS.md 第十一节）：
//   · 缺 `used` 的窗口不进路由，会被当成满额 → 耗尽的号排到队首
//   · `aside: true` 只做展示，别给它 amount/limit 冒充真额度
//   · limit 未知时别编分母，给 display 文字就够

import { fetchPricingResets, fetchPricingStatus } from "./http.mjs"

/**
 * @returns magpie 的 usage 返回值
 */
export async function readUsage({ token, deviceId, signal, log = () => {} }) {
  let status
  try {
    status = await fetchPricingStatus({ token, deviceId, signal })
  } catch (error) {
    return { error: `读不到套餐状态：${error?.message ?? error}`, windows: [] }
  }

  const plan = planLabel(status)
  const user = ""
  // entitlementEndsAt 才是「套餐真到期」；currentPeriodEndAt 只是本期账单周期
  const until = status?.entitlementEndsAt || status?.currentPeriodEndAt || status?.trialEndsAt || undefined
  const windows = windowsFromStatus(status)

  // 重置次数是加分项：读不到就不画，别让整张卡变成错误
  let resets
  try {
    const r = await fetchPricingResets({ token, deviceId, signal })
    if (r && Number(r.remaining ?? r.count ?? NaN) >= 0) {
      resets = { count: Number(r.remaining ?? r.count) }
    }
  } catch {
    resets = undefined
  }

  return {
    plan,
    user: user || undefined,
    until,
    renew: /cancel/i.test(String(status?.subscriptionState ?? "")) ? "off" : "auto",
    windows,
    ...(resets ? { resets } : {}),
  }
}

function planLabel(status) {
  const title = String(status?.display?.title ?? "").trim()
  if (title) return title
  const plan = String(status?.plan ?? "").trim()
  if (!plan) return undefined
  return plan.replace(/^./, (c) => c.toUpperCase())
}

/**
 * status → windows[]
 *
 * **实测形状**（2026-11-03，Pro 账号）：
 *
 *   status.usage = {
 *     title: "Usage", subtitle: "Resets …", period: "monthly",
 *     progress: 26,                 ← 已用百分比（不是剩余！）
 *     progressText: "74% left",     ← 这是剩余
 *     resetAt: "2026-11-24T…",
 *     breakdown: { items: [{ key:"tasks", usedPercent:11, display:{title,percentText}, action }] },
 *     freeServices: { items: [ … ] },   ← "Free" 的那些，不算额度
 *   }
 *
 * 所以：
 *   · 参与路由的那条窗口用 `progress`（26 = 已用 26%），resetAt 做重置时间；
 *   · `breakdown.items[]` 只是同一份额度的拆分，一律 `aside: true` —— 让它们
 *     参与路由会把同一个号算两遍，额度一到就整个号被摘掉；
 *   · `freeServices` 不画（chat / 简单任务本来就不计费）。
 */
export function windowsFromStatus(status) {
  const usage = status?.usage
  const windows = []

  const progress = Number(usage?.progress)
  const hasMain = Number.isFinite(progress)
  if (hasMain) {
    windows.push({
      name: String(usage?.title ?? "").trim() || "用量",
      used: clampPercent(progress),
      ...(String(usage?.progressText ?? "").trim() ? { display: String(usage.progressText).trim() } : {}),
      ...(usage?.resetAt ? { resetsAt: usage.resetAt } : {}),
      ...(usage?.period === "monthly" ? { span: 2_592_000 } : {}),
    })
  }

  const items = Array.isArray(usage?.breakdown?.items)
    ? usage.breakdown.items
    : Array.isArray(usage?.items)
      ? usage.items
      : []
  for (const item of items) {
    const used = Number(item?.usedPercent)
    if (!Number.isFinite(used)) continue
    windows.push({
      name: String(item?.display?.title ?? item?.key ?? "").trim() || "额度",
      used: clampPercent(used),
      aside: true,
      ...(String(item?.display?.percentText ?? "").trim()
        ? { display: String(item.display.percentText).trim() }
        : {}),
    })
  }

  // 老形状（display.remainingPercentText）留着兜底
  if (windows.length === 0) {
    const label = String(usage?.display?.remainingLabel ?? "").trim()
    const remaining = String(usage?.display?.remainingPercentText ?? "").trim()
    const totalUsed = String(usage?.display?.totalUsedText ?? "").trim()
    if (remaining || totalUsed) {
      windows.push({
        name: label || "额度",
        used: usedFromRemaining(remaining),
        ...(totalUsed ? { display: totalUsed } : {}),
        aside: true,
      })
    }
  }

  if (windows.length === 0 && isExhausted(status)) {
    // 号被蹬空：必须画一条 used:100 参与路由，否则它继续排在队首
    windows.push({ name: "额度", used: 100, display: "已用尽" })
  }

  return windows
}

function clampPercent(n) {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  return Math.round(n * 10) / 10
}

/** "12%" 剩余 → used 88；认不出就 0（别乱压号） */
function usedFromRemaining(text) {
  const m = String(text ?? "").match(/(-?\d+(?:\.\d+)?)\s*%/)
  if (!m) return 0
  const remaining = Number(m[1])
  if (!Number.isFinite(remaining)) return 0
  return clampPercent(100 - remaining)
}

function isExhausted(status) {
  const state = String(status?.serviceState ?? status?.accessPhase ?? "").toLowerCase()
  if (/exhaust|limit|blocked/.test(state)) return true
  const used = Number(status?.usage?.usedPercent)
  return Number.isFinite(used) && used >= 100
}