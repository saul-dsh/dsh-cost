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
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'cost'

const DIAG_LOG = join(homedir(), '.dsh', 'cost-debug.log')
const STORE_DIR = join(homedir(), '.dsh', 'storages', 'dsh-cost')
const LEDGER_PATH = join(STORE_DIR, 'ledger.json')
const JOURNAL_PATH = join(STORE_DIR, 'journal.jsonl')

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
/* 用量指纹去重（cost-meter issue #70/#76 同款兜底）                     */
/* ------------------------------------------------------------------ */

/** 桶名 → 价格键（costOfBuckets 同款映射；cacheWrite 缺价按 cacheHit）。 */
const BUCKET_PRICE_KEYS = { input: 'cacheMiss', output: 'output', cacheRead: 'cacheHit', cacheWrite: 'cacheWrite', reasoning: 'reasoning' }

/** 一次调用的分桶计价行（cost-meter costFromSamples 同形状），供回合明细。 */
function bucketRows(buckets, tier) {
  const rows = []
  for (const [bucket, priceKey] of Object.entries(BUCKET_PRICE_KEYS)) {
    const tokens = Number(buckets[bucket]) > 0 ? Number(buckets[bucket]) : 0
    if (!tokens) continue
    const rate = Number(tier[priceKey] ?? (priceKey === 'cacheWrite' ? tier.cacheHit : 0))
    rows.push({ bucket, tokens, rate, cost: tokens * rate / 1_000_000 })
  }
  return rows
}

/**
 * (model, 五桶指纹) 10s 窗互斥：包装路由插件在 ALS 标记逃逸的异步上下文里
 * 发起上游调用时，同一请求的两份 usage 都会到达这里——五桶逐位相同即判重，
 * 无论到达顺序只记第一次。正常独立调用五桶逐位相同的概率可忽略。
 */
function createUsageDeduper(windowMs = 10_000) {
  const seen = new Map()
  return (model, buckets, atMs) => {
    const fingerprint = `${normalizeModelId(model)}|${buckets.input}|${buckets.output}|${buckets.cacheRead}|${buckets.cacheWrite}|${buckets.reasoning}`
    const last = seen.get(fingerprint)
    if (last !== undefined && atMs - last < windowMs) return false
    seen.set(fingerprint, atMs)
    if (seen.size > 512) {
      const cutoff = atMs - windowMs
      for (const [key, seenAt] of seen) if (seenAt < cutoff) seen.delete(key)
    }
    return true
  }
}

/* ------------------------------------------------------------------ */
/* 调用明细 journal（JSONL 追加；rotate 保留最近 3 卷）                  */
/* ------------------------------------------------------------------ */

const JOURNAL_MAX_BYTES = 8 * 1024 * 1024
const JOURNAL_KEEP = 3

function createJournal() {
  let lines = 0
  return {
    /** 明细纯记录，写失败绝不影响聚合账本。 */
    async write(record) {
      try {
        lines += 1
        if (lines % 500 === 0) {
          const info = await stat(JOURNAL_PATH).catch(() => null)
          if (info && info.size > JOURNAL_MAX_BYTES) {
            await rename(JOURNAL_PATH, join(STORE_DIR, `journal-${Date.now()}.jsonl`)).catch(() => {})
            try {
              const entries = await readdir(STORE_DIR)
              const archives = entries.filter((name) => /^journal-\d+\.jsonl$/.test(name)).sort()
              while (archives.length > JOURNAL_KEEP) {
                await unlink(join(STORE_DIR, archives.shift())).catch(() => {})
              }
            } catch { /* ignore */ }
          }
        }
        await appendFile(JOURNAL_PATH, `${JSON.stringify(record)}\n`, 'utf8')
      } catch { /* ignore */ }
    },
    /** 读当前卷的倒序明细（归档卷不参与，最近 UI 只看当下）。 */
    async recent({ sessionId = '', day = '', limit = 20 } = {}) {
      let text = ''
      try { text = await readFile(JOURNAL_PATH, 'utf8') } catch { return [] }
      const rows = []
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const row = JSON.parse(line)
          if (sessionId && row.session !== sessionId) continue
          if (day && row.day !== day) continue
          rows.push(row)
        } catch { /* 半行跳过 */ }
      }
      rows.reverse()
      return rows.slice(0, Math.min(200, Math.max(1, limit)))
    },
    /**
     * 增量读取：从字节偏移起新增的完整行（字节级，避免多字节字符错位；
     * 轮转后新文件比偏移小 → 从头读新卷，天然不会重放旧卷）。
     * 供锁持有者把 journal 折叠进 ledger（跨进程单写者模型）。
     */
    async recordsAfter(offset = 0) {
      try {
        const info = await stat(JOURNAL_PATH)
        if (info.size === offset) return { rows: [], offset }
        if (info.size < offset) offset = 0
        const buf = await readFile(JOURNAL_PATH)
        let start = offset
        if (offset > 0) {
          // 偏移已在行边界（前一字节是换行）则直接用；落在行中间才跳到下一行。
          if (buf[offset - 1] !== 10) {
            const nl = buf.indexOf(10, offset)
            if (nl < 0) return { rows: [], offset: buf.length }
            start = nl + 1
          }
        }
        const rows = []
        for (const line of buf.slice(start).toString('utf8').split('\n')) {
          if (!line) continue
          try { rows.push(JSON.parse(line)) } catch { /* 半行跳过 */ }
        }
        return { rows, offset: buf.length }
      } catch { return { rows: [], offset } }
    },

    /**
     * 回合费用：会话在 [from,to] 时间窗内的调用聚合（客户端 turnTail 槽位
     * 传宿主 turn/start~turn/end 事件时间）。journal 只保当前卷——轮转掉的
     * 旧回合查不到，金额对 UI 恒标「≈」估算口径。
     */    async range({ sessionId = '', from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
      let text = ''
      try { text = await readFile(JOURNAL_PATH, 'utf8') } catch { return { found: false, cost: 0, rows: [], calls: [] } }
      const calls = []
      const parts = new Map()
      for (const line of text.split('\n')) {
        if (!line) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (row.session !== sessionId || !(row.at >= from && row.at <= to)) continue
        calls.push({ model: row.model, provider: row.provider, at: row.at, cost: row.cost })
        for (const item of Array.isArray(row.rows) ? row.rows : []) {
          const key = JSON.stringify([row.provider, row.model, item.bucket])
          const part = parts.get(key) ?? { provider: row.provider, model: row.model, bucket: item.bucket, tokens: 0, rate: item.rate, cost: 0 }
          part.tokens += item.tokens
          part.cost += item.cost
          parts.set(key, part)
        }
      }
      calls.sort((a, b) => a.at - b.at)
      const rows = [...parts.values()].sort((a, b) => b.cost - a.cost)
      return { found: calls.length > 0, cost: calls.reduce((sum, call) => sum + call.cost, 0), rows, calls }
    },
  }
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
  let state = { version: 1, days: {}, imported: {} }
  let dirty = false
  let flushTimer = null
  /** 最近调用明细（内存，重启清空）：费用弹卡按时间倒序展示。 */
  const RECENT_CALLS_MAX = 200
  const recentCalls = []

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
    /** 回填游标：该会话日志已覆盖到的事件时刻（实时记账同样推进，幂等切割）。 */
    importedAt(sessionKey) {
      return state.imported?.[sessionKey] ?? 0
    },
    markImported(sessionKey, atMs) {
      if (!state.imported) state.imported = {}
      const current = state.imported[sessionKey] ?? 0
      if (atMs <= current) return false
      state.imported[sessionKey] = atMs
      // 裁剪：只保留最近 500 个会话的游标。
      const keys = Object.keys(state.imported)
      if (keys.length > 500) {
        for (const key of keys.slice(0, keys.length - 500)) delete state.imported[key]
      }
      scheduleFlush()
      return true
    },
    /** journal 折叠进度（字节偏移，随 ledger 一起落盘 → 崩溃安全，不重不漏）。 */
    journalOffset() { return state.journalOffset ?? 0 },
    setJournalOffset(offset) {
      if (!Number.isFinite(offset) || offset <= (state.journalOffset ?? 0)) return
      state.journalOffset = offset
      scheduleFlush()
    },
    /** 官方同步的现行价格（flash/pro 峰谷档）与汇率——覆盖内置表，历史档不动。 */
    livePrices() { return state.live?.prices ?? null },
    setLivePrices(tiers) {
      state.live = { ...(state.live ?? {}), prices: tiers }
      scheduleFlush()
    },
    liveExchangeRate() { return state.live?.exchangeRate ?? null },
    setExchangeRate(rate, fetchedAt) {
      state.live = { ...(state.live ?? {}), exchangeRate: { rate, fetchedAt } }
      scheduleFlush()
    },
    /** 最近调用明细，时间倒序（费用弹卡用）。 */
    recentCalls(limit = 50) {
      return recentCalls.slice(-Math.max(1, limit)).reverse()
    },
    /** 累加一次模型调用的用量与费用。source 区分对话 / 增强 / 建议生成。 */
    account({ sessionId, model, buckets, cost, atMs, source }) {
      const day = dayOf(atMs)
      const src = typeof source === 'string' && source ? source : 'chat'
      const addTo = (target) => {
        for (const key of Object.keys(zeroBuckets())) target[key] += buckets[key] ?? 0
        target.calls += 1
        target.cost += cost
      }
      addTo(day)
      // 按来源分账，费用弹卡才能把「增强」和「对话」分开显示。
      const bySource = day.bySource ?? (day.bySource = {})
      const srcEntry = bySource[src] ?? (bySource[src] = { ...zeroBuckets(), calls: 0, cost: 0 })
      addTo(srcEntry)
      // 最近调用明细（内存环形缓冲，重启清空；历史总额仍走 days）。
      recentCalls.push({
        at: atMs, session: sessionId || '', model: model || '', source: src,
        tokens: (buckets.input ?? 0) + (buckets.output ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0),
        input: buckets.input ?? 0, output: buckets.output ?? 0,
        cacheRead: buckets.cacheRead ?? 0, cost,
      })
      if (recentCalls.length > RECENT_CALLS_MAX) recentCalls.splice(0, recentCalls.length - RECENT_CALLS_MAX)
      if (model) {
        const entry = day.byModel[model] ?? (day.byModel[model] = { ...zeroBuckets(), calls: 0, cost: 0 })
        addTo(entry)
      }
      if (sessionId) {
        const session = day.sessions[sessionId] ?? (day.sessions[sessionId] = { ...zeroBuckets(), calls: 0, cost: 0, at: 0 })
        addTo(session)
        const sessionBySource = session.bySource ?? (session.bySource = {})
        const sessionSrc = sessionBySource[src] ?? (sessionBySource[src] = { ...zeroBuckets(), calls: 0, cost: 0 })
        addTo(sessionSrc)
        session.at = Math.max(session.at, atMs)
        // 回填切割游标同步推进：回填只补「游标之后」的日志事件，幂等不重复。
        if (!state.imported) state.imported = {}
        if (atMs > (state.imported[sessionId] ?? 0)) state.imported[sessionId] = atMs
      }
      scheduleFlush()
    },
    snapshot() { return state },
  }
}

/* ------------------------------------------------------------------ */
/* 历史回填（cost-meter backfill 同思路：重放会话日志的 usage 事件）      */
/* ------------------------------------------------------------------ */

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')
/** 单日志解压上限（大会话整串解压占内存，超限跳过并留痕）。 */
const BACKFILL_MAX_LOG_BYTES = 64 * 1024 * 1024
const num = (value) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0 }

/** 多帧 zstd（追加写每帧独立）：按魔数切段逐帧解压，坏帧跳过。 */
async function decompressSessionLog(file) {
  const info = await stat(file).catch(() => null)
  if (!info || info.size > BACKFILL_MAX_LOG_BYTES) return null
  if (file.endsWith('.zstd')) {
    const zlib = await import('node:zlib')
    if (typeof zlib.zstdDecompressSync !== 'function') return null
    const buf = await readFile(file)
    const idxs = [0]
    for (let i = 4; i <= buf.length - 4; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) idxs.push(i)
    }
    let out = ''
    for (let k = 0; k < idxs.length; k += 1) {
      try { out += zlib.zstdDecompressSync(buf.subarray(idxs[k], idxs[k + 1] ?? buf.length)).toString('utf8') } catch { /* 截断/坏帧跳过 */ }
    }
    return out
  }
  return readFile(file, 'utf8')
}

/** 目录内最新的会话日志（版本号最大、zstd 优先）。 */
async function pickSessionLog(dir) {
  const entries = await readdir(dir).catch(() => [])
  const logs = entries.filter((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
  if (logs.length === 0) return null
  logs.sort((a, b) => {
    const versionOf = (name) => Number((name.match(/\.v(\d+)\./) ?? [])[1] ?? 0)
    const zstdOf = (name) => (name.endsWith('.zstd') ? 1 : 0)
    return (versionOf(a) - versionOf(b)) || (zstdOf(a) - zstdOf(b))
  })
  return join(dir, logs[logs.length - 1])
}

/**
 * 重放会话事件流 → 用量样本（cost-meter replaySessionRecords 核心子集）：
 * request/header 切换当前路由；usage 取自 assistant/chunk(usage 块) /
 * assistant/message(data.usage) / compaction/summary，按「回合位置 + 五桶
 * 指纹」去重（同一步的 chunk 与 message 双份只记一次，retry 用量不同照记）；
 * 只取游标之后的事件（与实时计量幂等切割）。
 */
function samplesFromEvents(events, cursorAtMs) {
  let provider = 'deepseek'
  let model = 'default'
  let sessionId = ''
  const seen = new Set()
  const samples = []
  for (const event of events) {
    if (event.type === 'request/header') {
      const header = event.data?.header?.config
      if (typeof header?.model === 'string' && header.model) model = header.model
      if (typeof header?.provider === 'string' && header.provider) provider = header.provider
      continue
    }
    if (event.type === 'session' && typeof event.id === 'string' && !sessionId) sessionId = event.id
    let usage = null
    let positionKey = ''
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage' && event.data.chunk.usage != null) {
      usage = event.data.chunk.usage
      positionKey = `s:${num(event.data?.turn)}:${num(event.data?.step)}`
    } else if (event.type === 'assistant/message' && event.data?.usage != null) {
      usage = event.data.usage
      positionKey = `s:${num(event.data?.turn)}:${num(event.data?.step)}`
      const source = event.data?.message?.source
      if (typeof source?.model === 'string' && source.model) model = source.model
      if (typeof source?.provider === 'string' && source.provider) provider = source.provider
    } else if (event.type === 'compaction/summary' && event.data?.usage != null) {
      usage = event.data.usage
      positionKey = `c:${event.seq ?? ''}`
    } else {
      continue
    }
    const atMs = Number(event.time)
    if (!Number.isFinite(atMs) || atMs <= 0 || atMs <= cursorAtMs) continue
    const buckets = {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens),
      cacheWrite: num(usage.cacheWriteTokens),
      reasoning: num(usage.reasoningTokens),
    }
    const fingerprint = `${positionKey}|${buckets.input}|${buckets.output}|${buckets.cacheRead}|${buckets.cacheWrite}|${buckets.reasoning}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    samples.push({ provider, model, buckets, atMs })
  }
  return { sessionId, samples }
}

/**
 * 扫描全部会话日志回填历史（仅锁持有者，boot 后延迟触发；游标幂等）。
 * 0.7.0 起回填样本写 journal（与实时计量同源），由 ingest 统一折叠——
 * 回填与实时对同一调用的重叠由 ingest 的指纹去重互斥，永不双计。
 */
async function runBackfill(journal, ledger, priceEntryFor) {
  const workspaces = await readdir(SESSIONS_ROOT, { withFileTypes: true }).catch(() => [])
  let touchedSessions = 0
  let importedCalls = 0
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(SESSIONS_ROOT, workspace.name)
    const sessionDirs = await readdir(workspaceDir, { withFileTypes: true }).catch(() => [])
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const logFile = await pickSessionLog(join(workspaceDir, sessionDir.name))
      if (!logFile) continue
      try {
        const text = await decompressSessionLog(logFile)
        if (text === null) continue
        const events = []
        for (const line of text.split('\n')) {
          if (!line) continue
          try { events.push(JSON.parse(line)) } catch { /* 半行跳过 */ }
        }
        const probe = samplesFromEvents(events, 0)
        const sessionId = probe.sessionId
        const { samples } = samplesFromEvents(events, sessionId ? ledger.importedAt(sessionId) : 0)
        let maxAt = 0
        for (const sample of samples) {
          const entry = priceEntryFor(sample.model)
          if (!entry) continue
          const peak = isPeakAt(sample.atMs)
          const tier = tierFor(entry, sample.atMs, peak)
          const cost = costOfBuckets(sample.buckets, tier)
          await journal.write({
            at: sample.atMs,
            day: localDayKey(sample.atMs),
            session: sessionId || '',
            model: sample.model,
            provider: sample.provider,
            ...sample.buckets,
            rows: bucketRows(sample.buckets, tier),
            cost,
            peak,
          })
          maxAt = Math.max(maxAt, sample.atMs)
          importedCalls += 1
        }
        if (sessionId && maxAt > 0 && ledger.markImported(sessionId, maxAt)) touchedSessions += 1
        // 让出事件循环：几百个会话的解压不能卡住宿主启动。
        await new Promise((resolve) => setImmediate(resolve))
      } catch (error) {
        void report(`backfill ${sessionDir.name} failed: ${String(error?.message ?? error).slice(0, 160)}`)
      }
    }
  }
  if (importedCalls > 0) void report(`backfill appended ${importedCalls} journal rows across ${touchedSessions} sessions`)
  else void report('backfill done: nothing new')
}

/** 下一次峰谷状态翻转时刻（48h 内逐分钟扫描；周末/节假日边界自然覆盖）。 */
function nextPeakSwitch(now) {
  const current = isPeakAt(now)
  const start = Math.floor(now / 60_000) * 60_000 + 60_000
  for (let ms = start; ms <= now + 48 * 3_600_000; ms += 60_000) {
    if (isPeakAt(ms) !== current) return { atMs: ms, isPeak: isPeakAt(ms) }
  }
  return null
}

/** 官方定价页（预渲染 SSR）解析 → flash/pro 峰谷八字段（USD/1M）。 */
const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'

function parseOfficialPricing(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ')
  const startIdx = text.indexOf('PRICING')
  const endIdx = text.indexOf('Concurrency Limit', startIdx)
  if (startIdx < 0 || endIdx < 0) throw new Error('pricing section not found')
  const section = text.slice(startIdx, endIdx)
  const nums = [...section.matchAll(/\$([0-9.]+)/g)].map((m) => Number(m[1]))
  if (nums.length < 12) throw new Error(`pricing layout changed: expected 12 rates, got ${nums.length}`)
  // 页面顺序（deepseek-flash | deepseek-v4-pro 两列）：
  // CACHE HIT off(a,b) peak(c,d) · CACHE MISS off(e,f) peak(g,h) · OUTPUT off(i,j) peak(k,l)
  const [fhOff, phOff, fhPk, phPk, fmOff, pmOff, fmPk, pmPk, foOff, poOff, foPk, poPk] = nums
  const pair = (flash, pro, label) => {
    if (!(flash > 0 && pro > 0)) throw new Error(`pricing layout changed: invalid ${label}`)
    return { flash, pro }
  }
  return {
    fetchedAt: Date.now(),
    currency: 'USD',
    cacheHit: { offPeak: pair(fhOff, phOff, 'cacheHit.offPeak'), peak: pair(fhPk, phPk, 'cacheHit.peak') },
    cacheMiss: { offPeak: pair(fmOff, pmOff, 'cacheMiss.offPeak'), peak: pair(fmPk, pmPk, 'cacheMiss.peak') },
    output: { offPeak: pair(foOff, poOff, 'output.offPeak'), peak: pair(foPk, poPk, 'output.peak') },
  }
}

async function fetchOfficialPricing() {
  const res = await fetch(OFFICIAL_PRICING_URL, { headers: { 'user-agent': 'dsh-cost' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`official pricing page HTTP ${res.status}`)
  return parseOfficialPricing(await res.text())
}

/** 汇率（USD→CNY），frankfurter.dev 免钥公开端点。 */
async function fetchExchangeRate() {
  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY', { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`)
  const data = await res.json()
  const rate = Number(data?.rates?.CNY)
  if (!(rate > 0)) throw new Error('frankfurter returned no CNY rate')
  return rate
}

/** 把官方解析结果折成 tier 形状（flash/pro 各一），并校验峰=谷×2（±1%）。 */
function tiersFromOfficial(parsed) {
  const build = (family) => {
    const offPeak = { cacheHit: parsed.cacheHit.offPeak[family], cacheMiss: parsed.cacheMiss.offPeak[family], output: parsed.output.offPeak[family] }
    const peak = { cacheHit: parsed.cacheHit.peak[family], cacheMiss: parsed.cacheMiss.peak[family], output: parsed.output.peak[family] }
    for (const key of Object.keys(offPeak)) {
      if (Math.abs(peak[key] - offPeak[key] * 2) > offPeak[key] * 0.011) throw new Error(`peak != 2×offPeak for ${family}.${key} (official layout changed)`)
    }
    return { offPeak, peak: double(offPeak) }
  }
  return { fetchedAt: parsed.fetchedAt, currency: parsed.currency, flash: build('flash'), pro: build('pro') }
}

/* ------------------------------------------------------------------ */
/* 跨进程单写者锁（双进程同 boot 实锤；非持有者只 append journal）        */
/* ------------------------------------------------------------------ */

const LOCK_STALE_MS = 30_000

function acquireLedgerLock(path) {
  const tryWrite = () => {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
  }
  if (tryWrite()) return { owner: true }
  try {
    const info = statSync(path)
    const holder = Number(readFileSync(path, 'utf8'))
    let alive = false
    if (Number.isSafeInteger(holder) && holder > 0) {
      try { process.kill(holder, 0); alive = true } catch (error) { alive = error?.code === 'EPERM' }
    }
    if (!alive || Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      // 持有者已死或心跳超时：抢占（万一并发抢占，后写者败走非持有者，无害）。
      try { unlinkSync(path) } catch { /* ignore */ }
      return { owner: tryWrite() }
    }
  } catch { return { owner: tryWrite() } }
  return { owner: false }
}

function touchLedgerLock(path) {
  try { utimesSync(path, new Date(), new Date()) } catch { /* ignore */ }
}

function releaseLedgerLock(path) {
  try {
    if (Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path)
  } catch { /* ignore */ }
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
  customPrices: Schema.object({}).default({}).description('自定义模型单价（USD/1M tokens）'),
  /** 账本保留天数。 */
  retentionDays: Schema.number().default(180).description('历史保留天数'),
  budgetEnabled: Schema.boolean().default(false).description('启用预算'),
  budgetAmount: Schema.number().default(50).description('预算金额（CNY）'),
  budgetPeriod: Schema.union(['day', 'month', 'all']).default('month').description('预算周期'),
  backfillEnabled: Schema.boolean().default(true).description('启动时回填历史会话费用'),
  peakAlertEnabled: Schema.boolean().default(false).description('峰谷切换前提醒'),
  peakAlertLeadMinutes: Schema.number().default(2).description('峰谷切换提前量（分钟，1-30）'),
  peakAlertNotify: Schema.boolean().default(false).description('同时发送系统通知'),
})

export function apply(ctx, config) {
  if (!config.enabled) return

  const lockPath = join(STORE_DIR, 'ledger.lock')
  const lock = acquireLedgerLock(lockPath)
  void report(`server boot v0.7.0 pid=${process.pid} ledgerOwner=${lock.owner} retention=${config.retentionDays} rate=${config.exchangeRate} budget=${config.budgetEnabled ? `${config.budgetAmount}/${config.budgetPeriod}` : 'off'} backfill=${config.backfillEnabled && lock.owner ? 'on' : 'off'}`)

  const ledger = createLedger(config.retentionDays)
  if (lock.owner) ledger.load()
  ctx.effect(() => { ledger.dispose(); if (lock.owner) releaseLedgerLock(lockPath) }, 'dsh-cost: ledger flush + lock release')

  const admitUsage = createUsageDeduper()
  const journal = createJournal()

  /**
   * 锁持有者把 journal 增量折叠进 ledger（0.7.0 单写者模型）：
   * 两个进程都会 boot 并各听各的 llm/stream——都只 append journal（O_APPEND
   * 单行跨进程安全）；只有锁持有者写 ledger.json，彻底消除整文件互踩。
   * 指纹去重兜底：同一事件被两进程捕获 / 回填与实时重叠，10s 窗内互斥。
   */
  const ingestDedup = createUsageDeduper()
  let ingestedCount = 0
  let ingestBusy = false
  async function ingestJournal() {
    if (!lock.owner || ingestBusy) return
    ingestBusy = true
    try {
      const { rows, offset } = await journal.recordsAfter(ledger.journalOffset())
      for (const row of rows) {
        if (!row || !Number.isFinite(row.at) || !Number.isFinite(row.cost) || !row.model) continue
        const buckets = { input: row.input ?? 0, output: row.output ?? 0, cacheRead: row.cacheRead ?? 0, cacheWrite: row.cacheWrite ?? 0, reasoning: row.reasoning ?? 0 }
        if (!ingestDedup(`${row.session ?? ''}|${row.model}`, buckets, row.at)) continue
        ledger.account({ sessionId: row.session, model: row.model, buckets, cost: row.cost, atMs: row.at, source: row.source })
        // +60s 余量：日志事件记的是消息完成时刻，晚于实时流发起时刻；
        // 游标盖住整个调用时长，防回填重放同一条。
        if (row.session) ledger.markImported(row.session, row.at + 60_000)
        ingestedCount += 1
      }
      ledger.setJournalOffset(offset)
      if (rows.length > 0) touchLedgerLock(lockPath)
    } catch (error) {
      void report(`ingest failed: ${String(error?.message ?? error).slice(0, 160)}`)
    } finally {
      ingestBusy = false
    }
  }

  if (lock.owner) {
    const ingestTimer = setInterval(() => { void ingestJournal() }, 5000)
    ingestTimer.unref?.()
    ctx.effect(() => () => clearInterval(ingestTimer), 'dsh-cost: journal ingest timer')
  }

  // 历史回填：仅锁持有者执行（boot 后 3s，避开宿主启动高峰）；0.7.0 起
  // 改写 journal（与实时同源），由 ingest 统一折叠 + 指纹去重，天然不重。
  if (config.backfillEnabled && lock.owner) {
    const backfillTimer = setTimeout(() => { void runBackfill(journal, ledger, priceEntryFor).catch((error) => { void report(`backfill crashed: ${String(error?.message ?? error).slice(0, 200)}`) }) }, 3000)
    backfillTimer.unref?.()
    ctx.effect(() => () => clearTimeout(backfillTimer), 'dsh-cost: backfill timer')
  }

  /** 深度标记：存在即「已知会、不需要再入账」的 llm 流（嵌套排除）。 */
  const llmDepth = new AsyncLocalStorage()

  /**
   * 跨插件的调用来源标记。prompt-enhancer / followup 在发起自己的
   * llm.stream 前写 globalThis.__dshPluginCall，这里按 5 秒窗口读回：
   * 落在窗口内算它们的调用，否则一律算对话。读一次就清，避免串到下一次。
   */
  const CALL_SOURCE_TTL_MS = 5000
  function callSource() {
    const marker = globalThis.__dshPluginCall
    if (marker && typeof marker.at === 'number' && Date.now() - marker.at < CALL_SOURCE_TTL_MS) {
      const source = typeof marker.source === 'string' && marker.source ? marker.source : 'chat'
      globalThis.__dshPluginCall = undefined
      return source
    }
    return 'chat'
  }

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
              // 指纹去重兜底：本进程内 ALS 逃逸/同流双 usage 互斥（10s 窗）。
              if (admitUsage(model, buckets, startedAtMs)) {
                const peak = isPeakAt(startedAtMs)
                const tier = tierFor(entry, startedAtMs, peak)
                const cost = costOfBuckets(buckets, tier)
                // 0.7.0 单写者模型：所有进程只 append journal（跨进程安全），
                // ledger 由锁持有者的 ingest 统一折叠。
                void journal.write({
                  at: startedAtMs,
                  day: localDayKey(startedAtMs),
                  session: sessionId || '',
                  model,
                  provider,
                  ...buckets,
                  rows: bucketRows(buckets, tier),
                  cost,
                  peak,
                  source: callSource(),
                })
                accountCount += 1
                // 采样留痕（前 10 条全记，之后 1/20），足以判定通路与发现异常。
                if (accountCount <= 10 || accountCount % 20 === 0) {
                  void report(`journaled #${accountCount} pid=${process.pid} owner=${lock.owner ? 1 : 0} model=${model} provider=${provider} session=${sessionId ? sessionId.slice(0, 40) : '(none)'} peak=${peak ? 1 : 0} buckets=${JSON.stringify(buckets)} cost=$${cost.toFixed(6)}`)
                }
              } else {
                void report(`dedup skip model=${model} buckets=${JSON.stringify(buckets)}`)
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
    /** /state、/export 共用：锁持有者先折叠+落盘再读文件；非持有者直读
     （持有者 5s ingest + 800ms 防抖，两个进程的 UI 数据都足够新鲜）。 */
    async function ledgerSnapshotFresh() {
      if (lock.owner) {
        await ingestJournal()
        ledger.flushSync()
      }
      try { return JSON.parse(await readFile(LEDGER_PATH, 'utf8')) } catch { return { days: {} } }
    }
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
          const snap = await ledgerSnapshotFresh()
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
          // 预算：以展示币种（CNY）计，used 由对应周期的账本金额换算。
          const budgetReady = config.budgetEnabled && Number(config.budgetAmount) > 0
          const budgetUsd = budgetReady
            ? (config.budgetPeriod === 'day'
              ? (snap.days[todayKey]?.cost ?? 0)
              : config.budgetPeriod === 'month'
                ? (month?.cost ?? 0)
                : total.cost)
            : 0
          send(200, {
            serverNow: now,
            display: { currency: 'CNY', rate: config.exchangeRate },
            peak: { isPeak: isPeakAt(now), windows: PEAK_WINDOWS, nextSwitchAtMs: nextPeakSwitch(now)?.atMs ?? null, nextIsPeak: nextPeakSwitch(now)?.isPeak ?? null },
            today: todayKey in snap.days ? summarize(snap.days[todayKey]) : null,
            month,
            total: summarize(total),
            budget: budgetReady
              ? { amount: config.budgetAmount, period: config.budgetPeriod, used: budgetUsd * config.exchangeRate, usedPct: budgetUsd * config.exchangeRate / config.budgetAmount }
              : null,
            recent,
            sessions: sessions.slice(0, 20),
            unmatched: [...unmatchedModels],
            streamAlive: streamArmed,
            alerts: {
              peakEnabled: config.peakAlertEnabled === true,
              leadMinutes: Math.min(30, Math.max(1, Math.round(config.peakAlertLeadMinutes ?? 2))),
              notify: config.peakAlertNotify === true,
            },
          })
          return
        }

        if (path === '/calls' && req.method === 'GET') {
          const url = new URL(req.url ?? '/api/dsh-cost/calls', 'http://localhost')
          const sessionId = url.searchParams.get('session') ?? ''
          const day = url.searchParams.get('day') ?? ''
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
          // 全量按来源汇总（对话 / 增强 / 建议生成），供状态行费用弹卡分组显示。
          const snap = await ledgerSnapshotFresh()
          const bySource = {}
          let totalCost = 0
          let totalCalls = 0
          for (const key of Object.keys(snap.days)) {
            const d = snap.days[key]
            totalCost += d.cost ?? 0
            totalCalls += d.calls ?? 0
            for (const [src, entry] of Object.entries(d.bySource ?? {})) {
              const t = bySource[src] ?? (bySource[src] = { cost: 0, calls: 0 })
              t.cost += entry.cost ?? 0
              t.calls += entry.calls ?? 0
            }
          }
          send(200, { total: { cost: totalCost, calls: totalCalls, bySource }, calls: await journal.recent({ sessionId, day, limit }) })
          return
        }

        // 本对话累计费用：跨所有日期聚合 day.sessions[sessionId]，含来源分组。
        if (path === '/session' && req.method === 'GET') {
          const url = new URL(req.url ?? '/api/dsh-cost/session', 'http://localhost')
          const sessionId = url.searchParams.get('session') ?? ''
          if (!sessionId) { send(400, { error: 'missing session' }); return }
          const snap = await ledgerSnapshotFresh()
          const total = { ...zeroBuckets(), calls: 0, cost: 0, bySource: {} }
          for (const key of Object.keys(snap.days)) {
            const entry = snap.days[key].sessions?.[sessionId]
            if (!entry) continue
            for (const bucketKey of Object.keys(zeroBuckets())) total[bucketKey] += entry[bucketKey] ?? 0
            total.calls += entry.calls ?? 0
            total.cost += entry.cost ?? 0
            for (const [src, sub] of Object.entries(entry.bySource ?? {})) {
              const target = total.bySource[src] ?? (total.bySource[src] = { cost: 0, calls: 0 })
              target.cost += sub.cost ?? 0
              target.calls += sub.calls ?? 0
            }
          }
          send(200, {
            session: sessionId,
            total,
            calls: ledger.recentCalls(100).filter((call) => call.session === sessionId),
          })
          return
        }

        // 回合费用：turnTail 槽位传宿主 turn/start~turn/end 事件时间窗。
        if (path === '/turn' && req.method === 'GET') {
          const url = new URL(req.url ?? '/api/dsh-cost/turn', 'http://localhost')
          const sessionId = url.searchParams.get('session') ?? ''
          const from = Number(url.searchParams.get('from') ?? 0)
          const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER)
          if (!sessionId || !Number.isFinite(from) || !Number.isFinite(to)) { send(400, { error: 'missing session/from/to' }); return }
          send(200, await journal.range({ sessionId, from, to }))
          return
        }

        // 客户端调试上报：锚定/装配事件落 debug log（真机取证）。
        if (path === '/client-debug' && req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += chunk
          let message = ''
          try { message = String(JSON.parse(body).message ?? '').slice(0, 300) } catch { message = '' }
          if (message) void report(`client: ${message}`)
          send(200, { ok: true })
          return
        }

        // 导出：全量 JSON（含日/模型/会话聚合）或日汇总 CSV。
        if (path === '/export' && req.method === 'GET') {
          const url = new URL(req.url ?? '/api/dsh-cost/export', 'http://localhost')
          const snap = await ledgerSnapshotFresh()
          if ((url.searchParams.get('format') ?? 'json') === 'csv') {
            const lines = ['date,input,output,cache_read,cache_write,reasoning,calls,cost_usd']
            for (const key of Object.keys(snap.days).sort()) {
              const day = snap.days[key]
              lines.push([key, day.input ?? 0, day.output ?? 0, day.cacheRead ?? 0, day.cacheWrite ?? 0, day.reasoning ?? 0, day.calls ?? 0, (day.cost ?? 0).toFixed(6)].join(','))
            }
            res.statusCode = 200
            res.setHeader('content-type', 'text/csv; charset=utf-8')
            res.setHeader('content-disposition', 'attachment; filename="dsh-cost-days.csv"')
            res.end(lines.join('\n'))
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.setHeader('content-disposition', 'attachment; filename="dsh-cost-ledger.json"')
          res.end(JSON.stringify({ exportedAt: Date.now(), display: { currency: 'CNY', rate: config.exchangeRate }, days: snap.days }))
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
