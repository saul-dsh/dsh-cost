/**
 * dsh-cost — DeepSeek Harness (dsh) 会话费用统计插件
 *
 * 借鉴 Han-1413141/dsh-cost-meter（v1.9.39）的核心数据模式，MVP 落地：
 *   - 主通道 ctx.on('llm/stream', listener, { global: true })：llm 服务官方
 *     瀑布事件，链尾旁路观察逐 chunk 透传，捕获 usage 块（五桶
 *     input/output/cacheRead/cacheWrite/reasoning，宿主的 input 与
 *     cacheRead/cacheWrite 是互斥桶），流结束后按 DeepSeek 官方价格入账。
 *   - 计费数学与峰谷规则照抄 cost-meter lib/pricing.js：现行价（2026-09-10
 *     北京时间中午后）flash 谷 $0.003/$0.15/$0.60、pro 谷 $0.022/$0.66/$1.98，
 *     峰时 ×2；峰窗 UTC [01,04)∪[06,10)（北京 09-12 / 14-18 点），北京周六
 *     日与法定节假日全天谷价；历史流量按当时档位（rateHistory / legacyBase）。
 *   - 账本 ~/.dsh/storages/dsh-cost/ledger.json：按日聚合（总/按模型/按会话），
 *     金额恒为美元存储（与展示币种解耦，cost-meter 同款），临时文件原子
 *     重命名 + 防抖写盘。
 *   - HTTP 端点 GET /api/dsh-cost/state|prices 供客户端渲染。
 *   - 异步局部存储（ALS）深度标记防包装路由插件嵌套重复入账（cost-meter
 *     同款；本插件自己从不发起 llm 调用）。
 *
 * 已核对的 dsh API（对照 dsh-reference 与 cost-meter 源码）：
 *   - ctx.on('llm/stream', (options, next) => AsyncIterable, { global: true })
 *     监听器契约：必须调用 next() 推进瀑布并返回（包装的）流；嵌套时原样
 *     返回 next() 的下游
 *   - GenerateOptions：{ sessionId?, model, provider, messages, ... }
 *   - StreamChunk：{ type:'usage', usage:{inputTokens,outputTokens,
 *     cacheReadTokens,cacheWriteTokens,reasoningTokens} }（usage 位于 finish 前）
 *   - webServer.register({ kind:'prefix', path, handler }, label)
 */

import Schema from '@deepseek-ai/schemastery'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'cost'

const DIAG_LOG = join(homedir(), '.dsh', 'cost-debug.log')
const STORE_DIR = join(homedir(), '.dsh', 'storages', 'dsh-cost')
const LEDGER_PATH = join(STORE_DIR, 'ledger.json')

const report = async (line) => {
  try {
    await mkdir(dirname(DIAG_LOG), { recursive: true })
    await appendFile(DIAG_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 价格表（USD / 1M tokens；照抄 cost-meter lib/pricing.js 现行档）      */
/* ------------------------------------------------------------------ */

/** 峰谷时代分界（2026-08-16 16:00 UTC）：此前按历史基础价，无峰谷概念。 */
const LEGACY_BASE_BOUNDARY = Date.parse('2026-08-16T16:00:00Z')
/** Flash 调价边界（2026-09-10 北京时间中午 12:00 = UTC 04:00）；Pro 未调价。 */
const FLASH_PRICE_EFFECTIVE_AT = Date.parse('2026-09-10T04:00:00Z')
/** 周末全天谷价生效时刻（2026-08-23 北京时间零点）。 */
const WEEKEND_OFFPEAK_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z')

/** 峰时段窗口（UTC 小时，半开区间 [start,end)）= 北京 09-12 / 14-18 点。 */
const PEAK_WINDOWS = [{ start: 1, end: 4 }, { start: 6, end: 10 }]
/** 国务院办公厅 2026 年安排中峰谷规则生效后的剩余公众假期（北京日历日）。 */
const PEAK_HOLIDAYS = new Set([
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

const double = (tier) => Object.fromEntries(Object.entries(tier).map(([key, value]) => [key, value * 2]))

/** 档位形状：{ legacyBase, august, offPeak, peak }（后三者带峰谷两档）。 */
const deepseekFlash = {
  legacyBase: { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  august: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66, peak: double({ cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }) },
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  peak: double({ cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }),
}
const deepseekPro = {
  legacyBase: { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
  august: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98, peak: double({ cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }) },
  offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  peak: double({ cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }),
}
/** 已下架旧模型的唯一历史价（只可能出现在峰谷时代之前）。 */
const legacyOnlyModels = {
  deepseekchat: { legacyBase: { cacheHit: 0.07, cacheMiss: 0.27, output: 1.1 } },
  deepseekreasoner: { legacyBase: { cacheHit: 0.14, cacheMiss: 0.55, output: 2.19 } },
}

const normalizeModelId = (value) => String(value ?? '').toLowerCase().replace(/[._\-\s]/g, '')

function isPeakAt(atMs) {
  // 北京日界 = UTC+8；1970-01-01 为周四（weekday 4）。
  const day = Math.floor((atMs + 8 * 3600000) / 86400000)
  const weekday = (day + 4) % 7
  if (atMs >= WEEKEND_OFFPEAK_EFFECTIVE_AT && (weekday === 6 || weekday === 0)) return false
  const key = new Date(day * 86400000).toISOString().slice(0, 10)
  if (atMs >= WEEKEND_OFFPEAK_EFFECTIVE_AT && PEAK_HOLIDAYS.has(key)) return false
  const hour = new Date(atMs).getUTCHours()
  return PEAK_WINDOWS.some(({ start, end }) => hour >= start && hour < end)
}

/** 选档：历史时刻回落历史价（rateHistory 语义的简化实现）。 */
function tierFor(entry, atMs, peak) {
  if (entry.legacyBase && atMs < LEGACY_BASE_BOUNDARY) return entry.legacyBase
  if (entry.august && atMs < FLASH_PRICE_EFFECTIVE_AT) return entry.august
  return (peak && entry.peak) || entry.offPeak || entry.peak || entry.august || entry.legacyBase || { cacheHit: 0, cacheMiss: 0, output: 0 }
}

/**
 * 单次调用成本（USD）。数学照抄 cost-meter costOf：五桶互斥，
 * cacheWrite 缺价按 cacheHit，reasoning 缺价按 0（DeepSeek 推理并入输出）。
 */
function costOfBuckets(buckets, tier) {
  const amount = (value) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0 }
  const cost = (amount(buckets.input) * tier.cacheMiss
    + amount(buckets.output) * tier.output
    + amount(buckets.cacheRead) * tier.cacheHit
    + amount(buckets.cacheWrite) * (tier.cacheWrite ?? tier.cacheHit)
    + amount(buckets.reasoning) * (typeof tier.reasoning === 'number' ? tier.reasoning : 0)) / 1_000_000
  return Number.isFinite(cost) && cost > 0 ? cost : 0
}

/* ------------------------------------------------------------------ */
/* 账本                                                                 */
/* ------------------------------------------------------------------ */

const zeroBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
const localDayKey = (atMs) => {
  const d = new Date(atMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function createLedger(retentionDays) {
  let state = { version: 1, days: {} }
  let dirty = false
  let flushTimer = null

  const load = () => {
    try {
      const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
      if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') state = raw
    } catch { /* 首次运行或损坏：从空账本开始 */ }
  }

  const flushSync = () => {
    if (!dirty) return
    try {
      // 保留天数裁剪：超龄日直接移除（cost-meter 同口径）。
      if (Number.isFinite(retentionDays) && retentionDays > 0) {
        const cutoff = localDayKey(Date.now() - retentionDays * 86400000)
        for (const key of Object.keys(state.days)) if (key < cutoff) delete state.days[key]
      }
      mkdirSync(STORE_DIR, { recursive: true })
      const tmp = `${LEDGER_PATH}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(state), 'utf8')
      renameSync(tmp, LEDGER_PATH)
      dirty = false
    } catch (error) {
      void report(`ledger flush failed: ${String(error?.message ?? error).slice(0, 200)}`)
    }
  }

  const scheduleFlush = () => {
    dirty = true
    if (flushTimer) return
    flushTimer = setTimeout(() => { flushTimer = null; flushSync() }, 800)
    flushTimer.unref?.()
  }

  const dayOf = (atMs) => {
    const key = localDayKey(atMs)
    let day = state.days[key]
    if (!day) {
      day = { ...zeroBuckets(), calls: 0, cost: 0, byModel: {}, sessions: {} }
      state.days[key] = day
    }
    return day
  }

  return {
    load,
    flushSync,
    dispose() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null } flushSync() },
    /** 累加一次模型调用的用量与费用。 */
    account({ sessionId, model, buckets, cost, atMs }) {
      const day = dayOf(atMs)
      const addTo = (target) => {
        for (const key of Object.keys(zeroBuckets())) target[key] += buckets[key] ?? 0
        target.calls += 1
        target.cost += cost
      }
      addTo(day)
      if (model) {
        const entry = day.byModel[model] ?? (day.byModel[model] = { ...zeroBuckets(), calls: 0, cost: 0 })
        addTo(entry)
      }
      if (sessionId) {
        const session = day.sessions[sessionId] ?? (day.sessions[sessionId] = { ...zeroBuckets(), calls: 0, cost: 0, at: 0 })
        addTo(session)
        session.at = Math.max(session.at, atMs)
      }
      scheduleFlush()
    },
    snapshot() { return state },
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                             */
/* ------------------------------------------------------------------ */

export const inject = []

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用费用统计'),
  /** 展示汇率（USD → CNY）；金额账本恒存美元，展示时换算。 */
  exchangeRate: Schema.number().default(7.2).description('展示汇率（USD→CNY）'),
  /** 自定义单价覆盖：{ "模型id": { cacheHit, cacheMiss, output } }（USD/1M）。 */
  customPrices: Schema.object().default({}).description('自定义模型单价（USD/1M tokens）'),
  /** 账本保留天数。 */
  retentionDays: Schema.number().default(180).description('历史保留天数'),
})

export function apply(ctx, config) {
  if (!config.enabled) return

  void report(`server boot v0.1.0 pid=${process.pid} retention=${config.retentionDays} rate=${config.exchangeRate}`)

  const ledger = createLedger(config.retentionDays)
  ledger.load()
  ctx.effect(() => ledger.dispose(), 'dsh-cost: ledger flush')

  /** 深度标记：存在即「已知会、不需要再入账」的 llm 流（嵌套排除）。 */
  const llmDepth = new AsyncLocalStorage()
  const unmatchedModels = new Set()
  let streamArmed = false
  let accountCount = 0

  function priceEntryFor(model) {
    if (model && config.customPrices && config.customPrices[model]) return { custom: true, ...config.customPrices[model] }
    const norm = normalizeModelId(model)
    if (legacyOnlyModels[norm]) return legacyOnlyModels[norm]
    if (norm.includes('deepseek')) return norm.includes('pro') ? deepseekPro : deepseekFlash
    return null
  }

  ctx.on('llm/stream', (options, next) => {
    // 包装路由插件在嵌套上下文里再发起的上游调用：原样透传，不重复入账。
    if (llmDepth.getStore() !== undefined) return next()
    const downstream = next()
    if (!streamArmed) {
      streamArmed = true
      void report(`llm/stream first fire pid=${process.pid} — capture channel ALIVE in this process`)
    }
    const startedAtMs = Date.now()
    const model = typeof options?.model === 'string' ? options.model : ''
    const provider = typeof options?.provider === 'string' ? options.provider : ''
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : ''
    let usage = null
    let downstreamIter = null
    let completed = false
    return (async function* costObserve() {
      try {
        downstreamIter = downstream[Symbol.asyncIterator]()
        for (;;) {
          // 深度标记内拉取：下游适配器（包装路由）在消费上下文里再发起的
          // ctx.llm.stream() 继承标记，内层监听器判定为嵌套、透传。
          const result = await llmDepth.run(1, () => downstreamIter.next())
          if (result.done) break
          const chunk = result.value
          // usage 块位于 finish 之前；多块时最后一块生效（cost-meter 同款）。
          if (chunk?.type === 'usage' && chunk.usage != null) usage = chunk.usage
          yield chunk
        }
        completed = true
      } finally {
        // 消费方提前中断也向下游传播 return()，防上游 HTTP 流悬挂。
        if (!completed) {
          try { await downstreamIter?.return?.() } catch { /* ignore */ }
        }
        try {
          if (usage) {
            const buckets = {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cacheRead: usage.cacheReadTokens ?? 0,
              cacheWrite: usage.cacheWriteTokens ?? 0,
              reasoning: usage.reasoningTokens ?? 0,
            }
            const entry = priceEntryFor(model)
            if (entry) {
              const cost = costOfBuckets(buckets, tierFor(entry, startedAtMs, isPeakAt(startedAtMs)))
              ledger.account({ sessionId, model, buckets, cost, atMs: startedAtMs })
              accountCount += 1
              // 采样留痕（前 10 条全记，之后 1/20），足以判定通路与发现异常。
              if (accountCount <= 10 || accountCount % 20 === 0) {
                void report(`accounted #${accountCount} pid=${process.pid} model=${model} provider=${provider} session=${sessionId ? sessionId.slice(0, 40) : '(none)'} peak=${isPeakAt(startedAtMs) ? 1 : 0} buckets=${JSON.stringify(buckets)} cost=$${cost.toFixed(6)}`)
              }
            } else if (model && !unmatchedModels.has(model)) {
              // 未内置价格的第三方模型按 default 档（flash 现行价）计费，
              // 首见留痕提醒用户在 customPrices 里补充精确单价。
              unmatchedModels.add(model)
              void report(`unmatched model "${model}" billed at default tier; add customPrices entry for accuracy`)
            }
          }
        } catch (error) {
          void report(`account failed: ${String(error?.message ?? error).slice(0, 200)}`)
        }
      }
    })()
  }, { global: true })

  /* -- HTTP 端点 ------------------------------------------------------ */

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/api/dsh-cost',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        const path = (req.url ?? '').split('?')[0].replace(/^\/api\/dsh-cost/, '')

        if (path === '/state' && req.method === 'GET') {
          const snap = ledger.snapshot()
          const now = Date.now()
          const todayKey = localDayKey(now)
          const monthPrefix = todayKey.slice(0, 7)
          const weekStartKey = localDayKey(now - 6 * 86400000)
          let month = null
          const total = { ...zeroBuckets(), calls: 0, cost: 0 }
          const recent = []
          const sessions = []
          for (const key of Object.keys(snap.days).sort()) {
            const day = snap.days[key]
            for (const bucketKey of Object.keys(zeroBuckets())) total[bucketKey] += day[bucketKey] ?? 0
            total.calls += day.calls ?? 0
            total.cost += day.cost ?? 0
            if (key.startsWith(monthPrefix)) month = month ? mergeDay(month, day) : summarize(day)
            if (key >= weekStartKey) {
              recent.push({ date: key, calls: day.calls ?? 0, cost: day.cost ?? 0, tokens: (day.input ?? 0) + (day.output ?? 0) + (day.cacheRead ?? 0) + (day.cacheWrite ?? 0) })
              for (const [id, session] of Object.entries(day.sessions ?? {})) {
                sessions.push({ id, date: key, calls: session.calls ?? 0, cost: session.cost ?? 0, input: session.input ?? 0, output: session.output ?? 0, at: session.at ?? 0 })
              }
            }
          }
          sessions.sort((a, b) => b.at - a.at)
          send(200, {
            serverNow: now,
            display: { currency: 'CNY', rate: config.exchangeRate },
            peak: { isPeak: isPeakAt(now), windows: PEAK_WINDOWS },
            today: todayKey in snap.days ? summarize(snap.days[todayKey]) : null,
            month,
            total: summarize(total),
            recent,
            sessions: sessions.slice(0, 20),
            unmatched: [...unmatchedModels],
            streamAlive: streamArmed,
          })
          return
        }

        if (path === '/prices' && req.method === 'GET') {
          const now = Date.now()
          const peak = isPeakAt(now)
          send(200, {
            currency: 'USD',
            peak,
            peakWindowsUtc: PEAK_WINDOWS,
            holidays: [...PEAK_HOLIDAYS],
            models: {
              'deepseek-v4.1-flash / deepseek-flash': currentTier(deepseekFlash, now, peak),
              'deepseek-v4-pro': currentTier(deepseekPro, now, peak),
            },
            default: currentTier(deepseekFlash, now, peak),
          })
          return
        }

        send(404, { error: 'not-found' })
      },
    }), 'dsh-cost: /api/dsh-cost/*')
  })

  function summarize(row) {
    return {
      input: row.input ?? 0, output: row.output ?? 0, cacheRead: row.cacheRead ?? 0,
      cacheWrite: row.cacheWrite ?? 0, reasoning: row.reasoning ?? 0,
      calls: row.calls ?? 0, cost: row.cost ?? 0,
    }
  }

  function mergeDay(a, b) {
    const merged = { ...zeroBuckets(), calls: 0, cost: 0 }
    for (const part of [a, b]) {
      for (const key of Object.keys(zeroBuckets())) merged[key] += part[key] ?? 0
      merged.calls += part.calls ?? 0
      merged.cost += part.cost ?? 0
    }
    return merged
  }

  function currentTier(entry, now, peak) {
    return tierFor(entry, now, peak)
  }
}

export default { name, Config, apply }
