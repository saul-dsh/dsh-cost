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

/** 官方余额查询：host 白名单（安全约束——只允许官方域名，内网/环回不可能出现）。 */
const BALANCE_HOST = 'api.deepseek.com'

/* ------------------------------------------------------------------ */
/* Coding Plan 订阅配额（对标 dsh-cost-meter lib/coding-plans.js 的      */
/* Bearer 子集：端点/解析/降级链照抄上游，全部官方域名硬编码白名单）      */
/* ------------------------------------------------------------------ */

/** 0-100 已用百分比（保留 1 位）。 */
const clampPct = (p) => Math.max(0, Math.min(100, Math.round(p * 10) / 10))

/** 归一化百分比：0-1 视为小数，>=1 视为已是百分数；非法 → null。 */
function normalizePercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return clampPct(n <= 1 ? n * 100 : n)
}

/** 归一化重置时刻：unix 秒 / 毫秒 / ISO 字符串 → ISO 字符串；非法 → ''。 */
function normalizeResetAt(value) {
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
    const asNum = Number(value)
    if (Number.isFinite(asNum) && asNum > 0) return new Date(asNum > 1e12 ? asNum : asNum * 1000).toISOString()
    return ''
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

/** 组装文本窗口（余额等无百分比的量）：text 空 → null。 */
const textWindowOf = (text) => {
  const s = String(text ?? '').trim()
  return s.length > 0 ? { resetsAt: '', text: s } : null
}

/** 单窗口：utilization（0-100 或 0-1）+ resets（unix 秒/毫秒/ISO）。 */
function windowOf(utilization, resetsAt) {
  const percent = normalizePercent(utilization)
  return percent === null ? null : { percent, resetsAt: normalizeResetAt(resetsAt) }
}

/** Anthropic：{ five_hour: { utilization, resets_at }, seven_day: {...}, ... }；子配额窗口丢弃。 */
function parseAnthropicUsage(data) {
  if (data === null || typeof data !== 'object') return null
  const windows = {}
  for (const [name, raw] of Object.entries(data)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (/^(five[_ -]?hour|seven[_ -]?day)[_ -]/i.test(name)) continue
    if (name === 'iguana_necktie') continue
    const win = windowOf(raw.utilization ?? raw.used_percentage, raw.resets_at ?? raw.reset_at)
    if (win !== null) windows[name] = win
  }
  return Object.keys(windows).length > 0 ? windows : null
}

/** Z.ai / 智谱 GLM：monitor 端点 limits 数组（unit 3=小时档/6=周档）→ plans 数组 → 扁平窗口。 */
function parseZaiUsage(data) {
  if (data === null || typeof data !== 'object') return null
  const windows = {}
  const limits = data.data !== null && typeof data.data === 'object' && Array.isArray(data.data.limits)
    ? data.data.limits : null
  if (limits !== null) {
    const monWindows = {}
    const rest = []
    for (const limit of limits) {
      if (limit === null || typeof limit !== 'object' || (limit.type !== 'TOKENS_LIMIT' && limit.type !== 'CREDIT_LIMIT')) continue
      const pct = limit.percentage !== undefined ? clampPct(Number(limit.percentage))
        : Number.isFinite(Number(limit.usage)) && Number(limit.usage) > 0 && Number.isFinite(Number(limit.currentValue))
          ? clampPct((Number(limit.currentValue) / Number(limit.usage)) * 100)
          : null
      if (pct === null) continue
      const resetsAt = normalizeResetAt(limit.nextResetTime)
      const unit = Number(limit.unit)
      if (unit === 3 && monWindows.fiveHour === undefined) monWindows.fiveHour = { percent: pct, resetsAt }
      else if (unit === 6 && monWindows.weekly === undefined) monWindows.weekly = { percent: pct, resetsAt }
      else if (!Number.isFinite(unit)) rest.push({ pct, resetsAt, resetMs: Number(limit.nextResetTime) })
    }
    if (rest.length > 0) {
      rest.sort((a, b) => {
        const av = Number.isFinite(a.resetMs) && a.resetMs > 0 ? a.resetMs : 0
        const bv = Number.isFinite(b.resetMs) && b.resetMs > 0 ? b.resetMs : 0
        return av - bv
      })
      for (const item of rest) {
        if (monWindows.fiveHour === undefined) monWindows.fiveHour = { percent: item.pct, resetsAt: item.resetsAt }
        else if (monWindows.weekly === undefined) monWindows.weekly = { percent: item.pct, resetsAt: item.resetsAt }
      }
    }
    if (Object.keys(monWindows).length > 0) return monWindows
  }
  if (Array.isArray(data.plans)) {
    for (const plan of data.plans) {
      if (plan === null || typeof plan !== 'object') continue
      const total = Number(plan.total_units)
      const used = Number(plan.used_units)
      const pct = Number.isFinite(total) && total > 0 && Number.isFinite(used)
        ? clampPct((used / total) * 100)
        : normalizePercent(plan.utilization ?? plan.percent ?? plan.used_percentage)
      if (pct === null) continue
      const spanMs = Number(plan.period_end) * 1000 - Date.now()
      const key = Number.isFinite(spanMs) && spanMs > 24 * 3600_000 ? 'weekly' : 'fiveHour'
      windows[key] = { percent: pct, resetsAt: normalizeResetAt(plan.period_end) }
    }
  }
  for (const [name, raw] of Object.entries(data)) {
    if (name === 'plans' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const win = windowOf(raw.utilization ?? raw.percent ?? raw.used_percentage, raw.resets_at ?? raw.reset_at ?? raw.resetsAt)
    if (win !== null) windows[name] = win
  }
  return Object.keys(windows).length > 0 ? windows : null
}

/** MiniMax 单条记录的剩余百分比（优先 *_remaining_percent，total 常为 0）。 */
function remainingPercentOf(row, remainPctKey, totalKey, usedKey, remainKey) {
  if (row === null || typeof row !== 'object') return null
  const numeric = (key) => (row[key] == null || row[key] === '' ? NaN : Number(row[key]))
  const rp = numeric(remainPctKey)
  if (Number.isFinite(rp)) return Math.min(100, Math.max(0, rp <= 1 ? rp * 100 : rp))
  const total = numeric(totalKey)
  const used = numeric(usedKey)
  const remain = numeric(remainKey)
  if (Number.isFinite(total) && total > 0) {
    if (Number.isFinite(remain)) return (remain / total) * 100
    if (Number.isFinite(used)) return ((total - used) / total) * 100
  }
  return null
}

/** MiniMax 单条记录 → 5h/7d 窗口；status=3 为不限量，保留显式 ∞。 */
function windowsFromMiniMaxRecord(row) {
  if (row === null || typeof row !== 'object') return {}
  const windows = {}
  if (Number(row.current_interval_status) === 3) {
    windows['5h'] = { unlimited: true, text: '∞', resetsAt: '' }
  } else {
    const remain = remainingPercentOf(row, 'current_interval_remaining_percent', 'current_interval_total_count', 'current_interval_usage_count', 'current_interval_remain_count')
    if (remain !== null) {
      windows['5h'] = { percent: clampPct(100 - remain), resetsAt: normalizeResetAt(row.end_time ?? row.reset_time ?? row.next_reset_time) }
    }
  }
  if (Number(row.current_weekly_status) === 3) {
    windows['7d'] = { unlimited: true, text: '∞', resetsAt: '' }
  } else {
    const remain = remainingPercentOf(row, 'current_weekly_remaining_percent', 'current_weekly_total_count', 'current_weekly_usage_count', 'current_weekly_remain_count')
    if (remain !== null) {
      windows['7d'] = { percent: clampPct(100 - remain), resetsAt: normalizeResetAt(row.weekly_end_time) }
    }
  }
  return windows
}

/** 选 MiniMax 通用额度行：general → MiniMax-M* → 第一条可解析行。 */
function pickMiniMaxModelRow(rows) {
  const list = rows.filter((row) => row !== null && typeof row === 'object' && !/^(video|speech|audio|image)(?:$|[-_])/i.test(String(row.model_name ?? '')))
  const byName = (name) => list.find((row) => String(row.model_name ?? '').toLowerCase() === name)
  return byName('general')
    ?? list.find((row) => /^minimax-m/i.test(String(row.model_name ?? '')))
    ?? list.find((row) => Object.keys(windowsFromMiniMaxRecord(row)).length > 0)
    ?? list[0]
    ?? null
}

/** MiniMax：token_plan/remains（现行 model_remains）→ 平铺 → 旧数组形态。 */
function parseMiniMaxRemains(data) {
  if (data === null || typeof data !== 'object') return null
  const payload = data.data !== null && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data
  const pickArray = (...keys) => {
    for (const key of keys) {
      if (Array.isArray(data?.[key])) return data[key]
      if (Array.isArray(data?.data?.[key])) return data.data[key]
    }
    return null
  }
  const modelRows = pickArray('model_remains')
  if (modelRows !== null) {
    const fromRow = windowsFromMiniMaxRecord(pickMiniMaxModelRow(modelRows))
    if (Object.keys(fromRow).length > 0) return fromRow
    // 旧计数制：无 remaining_percent、靠 total>0 汇总。
    let total = 0
    let used = 0
    let found = false
    for (const item of modelRows) {
      if (item === null || typeof item !== 'object') continue
      const t = Number(item.current_interval_total_count ?? item.total)
      const u = Number(item.current_interval_usage_count ?? item.used)
      if (!Number.isFinite(t) || t <= 0) continue
      found = true
      total += t
      used += Number.isFinite(u) ? u : 0
    }
    if (found && total > 0) return { current: { percent: clampPct((used / total) * 100), resetsAt: '' } }
  }
  const flat = windowsFromMiniMaxRecord(payload)
  if (Object.keys(flat).length > 0) return flat
  const windows = {}
  const planRows = pickArray('token_plan_remains', 'plan_remains', 'remains', 'windows')
  if (planRows !== null) {
    planRows.forEach((row, index) => {
      if (row === null || typeof row !== 'object') return
      const total = Number(row.current_interval_total_count ?? row.total_count ?? row.total ?? row.limit)
      const used = Number(row.current_interval_usage_count ?? row.used_count ?? row.usage_count ?? row.used)
      const remain = Number(row.current_interval_remain_count ?? row.remain_count ?? row.remain ?? row.remaining)
      let pct = null
      if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) pct = (used / total) * 100
      else if (Number.isFinite(total) && total > 0 && Number.isFinite(remain)) pct = ((total - remain) / total) * 100
      else pct = normalizePercent(row.utilization ?? row.percent ?? row.used_percentage)
      if (pct === null) return
      const labelRaw = row.interval ?? row.interval_type ?? row.window_type ?? row.type ?? row.name
      const label = typeof labelRaw === 'string' && labelRaw.length > 0 ? labelRaw : `window${index + 1}`
      windows[label] = { percent: clampPct(pct), resetsAt: normalizeResetAt(row.reset_time ?? row.resets_at ?? row.next_reset_time ?? row.reset_at) }
    })
  }
  return Object.keys(windows).length > 0 ? windows : null
}

/** Kimi Code 订阅配额（api.kimi.com/coding/v1/usages，Kimi CLI 同款接口）。 */
function parseKimiCodingUsage(data) {
  if (data === null || typeof data !== 'object') return null
  const payload = data.data && typeof data.data === 'object' ? data.data : data
  const quota = payload.quota && typeof payload.quota === 'object' ? payload.quota : payload
  const windows = {}
  const numeric = (value) => (value == null || typeof value === 'boolean' || String(value).trim() === '' ? NaN : Number(value))
  const counter = (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null
    const total = numeric(row.limit)
    const used = numeric(row.used)
    const remaining = numeric(row.remaining)
    const pct = total > 0 && Number.isFinite(total)
      ? Number.isFinite(used) && used >= 0 ? (used / total) * 100
        : Number.isFinite(remaining) && remaining >= 0 ? ((total - remaining) / total) * 100 : NaN
      : NaN
    return Number.isFinite(pct) ? { percent: clampPct(pct), resetsAt: normalizeResetAt(row.resetTime ?? row.reset_time ?? row.resetAt ?? row.resetsAt) } : null
  }
  const usages = quota.usages ?? {}
  const shapes = [['5h', ['limit_5h', 'limit5h']], ['weekly', ['limit_7d', 'limit7d']], ['monthly', ['limit_month_total', 'limitMonthTotal']]]
  for (const [name, aliases] of shapes) {
    const raw = aliases.map((key) => usages[key]).find((row) => row && typeof row === 'object' && !Array.isArray(row))
    if (!raw) continue
    const counted = counter(raw)
    const ratio = numeric(raw.usedRatio ?? raw.used_ratio)
    if (counted) windows[name] = counted
    else if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
      windows[name] = { percent: clampPct(ratio * 100), resetsAt: normalizeResetAt(raw.resetTime ?? raw.reset_time ?? raw.resetAt) }
    }
  }
  const usage = counter(quota.usage)
  if (usage && (!Object.keys(usages).length || usages.limit_7d || usages.limit7d)) windows.weekly = usage
  const limits = Array.isArray(quota.limits) ? quota.limits : []
  limits.forEach((row, index) => {
    const parsed = counter(row?.detail)
    if (!parsed) return
    const duration = numeric(row.window?.duration)
    const unitRaw = String(row.window?.timeUnit ?? '').toLowerCase().replace(/^time_unit_/, '')
    const unit = unitRaw.startsWith('hour') ? 'h' : unitRaw.startsWith('day') ? 'd'
      : unitRaw.startsWith('week') ? 'w' : unitRaw.startsWith('minute') ? 'm'
        : unitRaw.startsWith('month') ? 'mo' : unitRaw.slice(0, 4)
    const name = unit === 'm' && duration === 300 ? '5h'
      : Number.isFinite(duration) && duration > 0 && unit.length > 0 ? `${duration}${unit}` : `window${index + 1}`
    windows[name] = parsed
  })
  return Object.keys(windows).length > 0 ? windows : null
}

/** Kimi / Moonshot PAYG 余额（人民币分；<100 视为已是元）。 */
function parseKimiBalance(data) {
  if (data === null || typeof data !== 'object') return null
  const raw = data.available_balance ?? data.balance ?? data.cash_balance ?? data.data?.available_balance
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  const cny = n >= 100 ? n / 100 : n
  const win = textWindowOf(`¥${(Math.round(cny * 100) / 100).toFixed(2)}`)
  return win === null ? null : { balance: win }
}

/** OpenRouter：{ data: { total_credits, total_usage } }（美元）→ 已用%。 */
function parseOpenRouterCredits(data) {
  if (data === null || typeof data !== 'object') return null
  const d = data.data !== null && typeof data.data === 'object' ? data.data : data
  const total = Number(d.total_credits ?? d.credits)
  const used = Number(d.total_usage ?? d.usage)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) return null
  return { credits: { percent: clampPct((used / total) * 100), resetsAt: normalizeResetAt(d.resets_at ?? d.next_reset_time) } }
}

/** SiliconFlow：balance/amount/remain（人民币）→ 文本窗口。 */
function parseSiliconFlowInfo(data) {
  if (data === null || typeof data !== 'object') return null
  const d = data.data !== null && typeof data.data === 'object' ? data.data : data
  const n = Number(d.balance ?? d.amount ?? d.remain ?? d.remaining)
  if (!Number.isFinite(n) || n < 0) return null
  const win = textWindowOf(`¥${(Math.round(n * 100) / 100).toFixed(2)}`)
  return win === null ? null : { balance: win }
}

/** CommandCode：windowLimits（used/cap）+ 月度 Credits 余额文本。 */
function parseCommandCodeCredits(data) {
  if (data === null || typeof data !== 'object') return null
  const windows = {}
  const limits = data.windowLimits
  if (limits !== null && typeof limits === 'object' && !Array.isArray(limits)) {
    for (const [name, raw] of Object.entries(limits)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const used = Number(raw.used)
      const cap = Number(raw.cap)
      if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0 || used < 0) continue
      windows[name] = { percent: clampPct((used / cap) * 100), resetsAt: normalizeResetAt(raw.resetAt) }
    }
  }
  const monthly = Number(data.credits !== null && typeof data.credits === 'object' ? data.credits.monthlyCredits : undefined)
  if (Number.isFinite(monthly) && monthly >= 0) {
    const win = textWindowOf(`$${(Math.round(monthly * 100) / 100).toFixed(2)}`)
    if (win !== null) windows.monthly = win
  }
  return Object.keys(windows).length > 0 ? windows : null
}

/** Cline Pass：limits[].percentUsed 已是 0-100 已用百分比，不走 0-1 猜测。 */
function parseClinePassUsage(data) {
  if (data === null || typeof data !== 'object') return null
  const limits = data.data !== null && typeof data.data === 'object' ? data.data.limits : undefined
  if (!Array.isArray(limits)) return null
  const names = new Map([['five_hour', 'fiveHour'], ['weekly', 'weekly'], ['monthly', 'monthly']])
  const windows = {}
  for (const entry of limits) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const name = names.get(entry.type)
    const raw = entry.percentUsed
    const percent = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN
    if (name === undefined || !Number.isFinite(percent) || percent < 0) continue
    windows[name] = { percent: clampPct(percent), resetsAt: normalizeResetAt(entry.resetsAt) }
  }
  return Object.keys(windows).length > 0 ? windows : null
}

const CODING_PLAN_PARSERS = {
  anthropic: parseAnthropicUsage,
  zai: parseZaiUsage,
  minimax: parseMiniMaxRemains,
  openrouter: parseOpenRouterCredits,
  siliconflow: parseSiliconFlowInfo,
  commandcode: parseCommandCodeCredits,
  clinepass: parseClinePassUsage,
}

/**
 * 官方端点白名单（硬编码，配置不可改；MiniMax 是唯一例外——允许显式 HTTPS
 * origin 覆盖，且经 normalizeMiniMaxOrigin 校验为公网域名）。顺序即降级链：
 * 认证失败(401/403)与解析成功立即返回，其余错误换下一端点。
 */
const CODING_PLAN_ENDPOINTS = {
  anthropic: ['https://api.anthropic.com/api/oauth/usage'],
  zai: [
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    'https://api.z.ai/api/monitor/usage/quota/limit',
    'https://api.z.ai/api/coding/paas/v3/dashboard/billing/coding_plan/usage',
    'https://open.bigmodel.cn/api/coding/paas/v3/dashboard/billing/coding_plan/usage',
  ],
  minimax: [
    'https://www.minimax.cn/v1/token_plan/remains',
    'https://www.minimax.io/v1/token_plan/remains',
    'https://www.minimaxi.com/v1/token_plan/remains',
  ],
  kimi: [
    'https://api.kimi.com/coding/v1/usages',
    'https://api.kimi.com/coding/v1/usage',
    'https://api.moonshot.cn/v1/users/me/balance',
  ],
  openrouter: ['https://openrouter.ai/api/v1/credits'],
  siliconflow: ['https://api.siliconflow.cn/v1/user/info'],
  commandcode: ['https://api.commandcode.ai/alpha/billing/credits'],
  clinepass: ['https://api.cline.bot/api/v1/users/me/plan/usage-limits'],
}

const CODING_PLAN_IDS = Object.keys(CODING_PLAN_ENDPOINTS)

/**
 * MiniMax 自定源归一化：只接受 HTTPS origin（无路径/凭据/空白），并拒绝
 * 环回/内网/链路本地/裸 IP —— SSRF 硬化比上游更严（上游只查 HTTPS origin）。
 */
function normalizeMiniMaxOrigin(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > 2048) return null
  const text = value.trim()
  if (!text) return ''
  if (!/^https:\/\/[^/?#]+\/?$/i.test(text) || /[\s\\@?#]/.test(text)) return null
  let url
  try { url = new URL(text) } catch { return null }
  const host = url.hostname.toLowerCase()
  if (!host || url.username || url.password || url.pathname !== '/') return null
  if (host === '::1' || host.endsWith('.local') || host.endsWith('.internal')) return null
  if (/^(localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null
  if (/^\[?[0-9a-f:]+\]?$/i.test(host) && host.includes(':')) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null
  return url.origin
}

/** 单端点抓取：Bearer 鉴权；Kimi 订阅端点须带官方 CLI 的 UA（上游实测约束）。 */
async function fetchPlanJson(url, key, { kimiCoding = false, redirect } = {}) {
  const headers = {
    authorization: `Bearer ${key.trim()}`,
    accept: 'application/json',
    'user-agent': 'dsh-cost (DeepSeek Harness plugin)',
  }
  if (kimiCoding) headers['user-agent'] = 'KimiCLI/1.6'
  return fetch(url, { headers, redirect, signal: AbortSignal.timeout(15_000) })
}

/** 响应体有界 JSON（256KiB 上限，防异常端点拖内存）。 */
async function readJsonBounded(res, cap = 262_144) {
  const text = await res.text()
  if (text.length > cap) throw new Error('response too large')
  return JSON.parse(text)
}

/**
 * 查询单家 Coding Plan 额度：按白名单端点顺序尝试。401/403 与解析成功立即
 * 定论，其余错误换下一端点；zai/minimax 双域 Key 不互通、kimi 订阅端点 401
 * 视为「非订阅 Key」继续降级到 PAYG 余额端点（上游 issue #42/#53 同语义）。
 * 全部错误均为 soft（未订阅/Key 无效属预期场景，面板中性提示）。
 */
async function queryCodingPlan(provider, key, origin) {
  const urls = provider === 'minimax'
    ? (() => {
      const base = normalizeMiniMaxOrigin(origin)
      if (base === null) throw Object.assign(new Error('minimax: invalid HTTPS origin'), { soft: true })
      return base ? [`${base}/v1/token_plan/remains`, `${base}/v1/api/openplatform/coding_plan/remains`] : CODING_PLAN_ENDPOINTS.minimax
    })()
    : CODING_PLAN_ENDPOINTS[provider]
  let lastError = 'HTTP error'
  for (const url of urls) {
    const kimiCoding = provider === 'kimi' && new URL(url).hostname === 'api.kimi.com'
    let res
    try {
      res = await fetchPlanJson(url, key, {
        kimiCoding,
        redirect: provider === 'minimax' ? 'error' : provider === 'zai' ? 'manual' : undefined,
      })
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 120)
      continue
    }
    if (res.status === 401 || res.status === 403) {
      lastError = `HTTP ${res.status}`
      if (provider === 'zai' || provider === 'minimax' || kimiCoding) continue
      throw Object.assign(new Error(lastError), { soft: true })
    }
    if (!res.ok) { lastError = `HTTP ${res.status}`; continue }
    let data = null
    try { data = await readJsonBounded(res) } catch { lastError = 'invalid JSON response'; continue }
    const windows = (kimiCoding ? parseKimiCodingUsage(data) : CODING_PLAN_PARSERS[provider](data))
    if (windows) return { windows, endpoint: url }
    lastError = 'no usage windows in response'
  }
  throw Object.assign(new Error(lastError), { soft: true })
}


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
  /** DeepSeek 开放平台 API Key（选填）：配置后费用弹卡显示官方账户余额。 */
  apiKey: Schema.string().default('').description('DeepSeek 开放平台 API Key（查官方余额用，可选）'),
  /** Coding Plan 订阅配额：{ 厂商: { key, origin? } }，Key 在费用设置页配置、不回显。 */
  codingPlans: Schema.object({}).default({}).description('Coding Plan 订阅配额（在费用设置页配置）'),
})

export function apply(ctx, config) {
  // 运行时可变副本：POST /settings 改这里，立即生效；显式改过的键持久化
  // 到 storages、启动时回放（没改过的键继续跟随宿主配置）。
  const live = { ...config }
  // 官方余额缓存：10 分钟内直接回缓存；换 key 即失效。
  let balanceCache = null
  if (!live.enabled) return

  // 设置持久化：只落与 config 不同的键，防抖 400ms 原子写。
  const SETTINGS_KEYS = ['budgetEnabled', 'budgetAmount', 'budgetPeriod', 'peakAlertEnabled', 'peakAlertNotify', 'peakAlertLeadMinutes', 'exchangeRate', 'apiKey', 'codingPlans']
  const SETTINGS_PATH = join(homedir(), '.dsh', 'storages', 'dsh-cost', 'settings.json')
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    for (const key of SETTINGS_KEYS) if (saved?.[key] !== undefined) live[key] = saved[key]
  } catch { /* 无存档：全部跟随配置 */ }
  let settingsTimer = null
  const persistSettings = () => {
    if (settingsTimer) return
    settingsTimer = setTimeout(() => {
      settingsTimer = null
      try {
        mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
        const out = {}
        for (const key of SETTINGS_KEYS) if (live[key] !== config[key]) out[key] = live[key]
        const tmp = `${SETTINGS_PATH}.tmp`
        writeFileSync(tmp, JSON.stringify(out, null, 2))
        renameSync(tmp, SETTINGS_PATH)
      } catch { /* ignore */ }
    }, 400)
  }

  /* -- Coding Plan 配额缓存与查询编排 -------------------------------- */

  const PLAN_TTL_MS = 600_000
  const planCache = new Map() // provider → { at, result }
  const planKeyOf = (id) => {
    const entry = live.codingPlans?.[id]
    const key = typeof entry?.key === 'string' ? entry.key.trim() : ''
    return key.length > 0 && key.length <= 4096 ? key : ''
  }
  async function refreshCodingPlan(id, force = false) {
    const key = planKeyOf(id)
    if (!key) return { hasKey: false }
    const cached = planCache.get(id)
    if (!force && cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.result
    let result
    try {
      const { windows } = await queryCodingPlan(id, key, live.codingPlans?.[id]?.origin)
      result = { hasKey: true, windows, at: Date.now() }
      void report(`coding plan ${id} refreshed: ${Object.keys(windows).join(',')}`)
    } catch (error) {
      result = { hasKey: true, error: String(error?.message ?? error).slice(0, 160), at: Date.now() }
      void report(`coding plan ${id} refresh failed: ${result.error}`)
    }
    planCache.set(id, { at: Date.now(), result })
    return result
  }

  const lockPath = join(STORE_DIR, 'ledger.lock')
  // 存储目录可能不存在（全新安装）：锁文件 openSync(wx) 要求父目录已建。
  try { mkdirSync(STORE_DIR, { recursive: true }) } catch { /* ignore */ }
  const lock = acquireLedgerLock(lockPath)
  void report(`server boot v0.10.0 pid=${process.pid} ledgerOwner=${lock.owner} retention=${live.retentionDays} rate=${live.exchangeRate} budget=${live.budgetEnabled ? `${live.budgetAmount}/${live.budgetPeriod}` : 'off'} backfill=${live.backfillEnabled && lock.owner ? 'on' : 'off'} plans=${CODING_PLAN_IDS.filter((id) => planKeyOf(id)).length}`)

  const ledger = createLedger(live.retentionDays)
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
  if (live.backfillEnabled && lock.owner) {
    const backfillTimer = setTimeout(() => { void runBackfill(journal, ledger, priceEntryFor).catch((error) => { void report(`backfill crashed: ${String(error?.message ?? error).slice(0, 200)}`) }) }, 3000)
    backfillTimer.unref?.()
    ctx.effect(() => () => clearTimeout(backfillTimer), 'dsh-cost: backfill timer')
  }

  // 汇率自动刷新：仅锁持有者，启动 5s 后首刷，之后每小时。失败静默（用旧值）。
  if (lock.owner) {
    const refreshRate = async () => {
      try {
        const rate = await fetchExchangeRate()
        ledger.setExchangeRate(rate, Date.now())
        void report(`exchange rate auto: ${rate}`)
      } catch (error) {
        void report(`exchange rate auto failed: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    const rateStart = setTimeout(() => { void refreshRate() }, 5000)
    rateStart.unref?.()
    const rateTimer = setInterval(() => { void refreshRate() }, 3_600_000)
    rateTimer.unref?.()
    ctx.effect(() => () => { clearTimeout(rateStart); clearInterval(rateTimer) }, 'dsh-cost: exchange rate timers')
  }

  /** 深度标记：存在即「已知会、不需要再入账」的 llm 流（嵌套排除）。 */
  const llmDepth = new AsyncLocalStorage()

  /**
   * 跨插件的调用来源标记。prompt-enhancer / followup 在发起自己的
   * llm.stream 前写 globalThis.__dshPluginCall，这里按 5 秒窗口读回：
   * 落在窗口内算它们的调用，否则一律算对话。读一次就清，避免串到下一次。
   */
  const CALL_SOURCE_TTL_MS = 5000

  /** 各插件自己的 prompt 特征：跨进程时 globalThis 不共享，只能看内容。 */
  const SOURCE_SIGNATURES = [
    { source: 'followup', needle: 'You generate follow-up suggestions' },
    { source: 'enhance', needle: "You are a Prompt Engineering Expert" },
  ]

  function callSource(options) {
    // 1) 同进程时的显式标记（prompt-enhancer / followup 调用前写入）
    const marker = globalThis.__dshPluginCall
    if (marker && typeof marker.at === 'number' && Date.now() - marker.at < CALL_SOURCE_TTL_MS) {
      const source = typeof marker.source === 'string' && marker.source ? marker.source : 'chat'
      globalThis.__dshPluginCall = undefined
      return source
    }
    // 2) 兜底：按 prompt 特征识别，插件跑在别的进程时也能分开记
    try {
      const messages = options?.messages
      if (messages) {
        const text = JSON.stringify(messages)
        for (const entry of SOURCE_SIGNATURES) {
          if (text.includes(entry.needle)) return entry.source
        }
      }
    } catch { /* 序列化失败就当普通对话 */ }
    return 'chat'
  }

  const unmatchedModels = new Set()
  let streamArmed = false
  let accountCount = 0

  function priceEntryFor(model) {
    if (model && live.customPrices && live.customPrices[model]) return { custom: true, ...live.customPrices[model] }
    const norm = normalizeModelId(model)
    if (legacyOnlyModels[norm]) return legacyOnlyModels[norm]
    if (norm.includes('deepseek')) {
      // 官方同步的现行价优先（fetch-prices 成功后覆盖内置表；历史档不变）。
      const live = ledger.livePrices()
      if (live && live.currency === 'USD') {
        const family = norm.includes('pro') ? 'pro' : 'flash'
        const t = live[family]
        return { legacyBase: (norm.includes('pro') ? deepseekPro : deepseekFlash).legacyBase, august: undefined, offPeak: t.offPeak, peak: t.peak, live: true }
      }
      return norm.includes('pro') ? deepseekPro : deepseekFlash
    }
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
                  source: callSource(options),
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
        if (path === '/settings' && req.method === 'GET') {
          send(200, {
            enabled: live.enabled,
            exchangeRate: live.exchangeRate,
            budgetEnabled: live.budgetEnabled,
            budgetAmount: live.budgetAmount,
            budgetPeriod: live.budgetPeriod,
            peakAlertEnabled: live.peakAlertEnabled,
            peakAlertLeadMinutes: live.peakAlertLeadMinutes,
            peakAlertNotify: live.peakAlertNotify,
            retentionDays: live.retentionDays,
          })
          return
        }
        // 运行时改参数：retentionDays 与 customPrices 不在白名单——前者启动时
        // 已传给 createLedger，后者是对象结构，运行时改要么无效要么要重建缓存。
        if (path === '/settings' && req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          let body
          try { body = JSON.parse(raw) } catch { send(400, { error: 'invalid-json' }); return }
          if (body.budgetEnabled !== undefined) live.budgetEnabled = body.budgetEnabled === true
          if (body.budgetPeriod === 'day' || body.budgetPeriod === 'month') live.budgetPeriod = body.budgetPeriod
          if (body.peakAlertEnabled !== undefined) live.peakAlertEnabled = body.peakAlertEnabled === true
          if (body.peakAlertNotify !== undefined) live.peakAlertNotify = body.peakAlertNotify === true
          if (body.budgetAmount !== undefined) {
            const value = Number(body.budgetAmount)
            if (Number.isFinite(value)) live.budgetAmount = Math.min(1_000_000, Math.max(0, value))
          }
          if (body.exchangeRate !== undefined) {
            const value = Number(body.exchangeRate)
            if (Number.isFinite(value) && value > 0) live.exchangeRate = Math.min(20, Math.max(1, value))
          }
          if (body.peakAlertLeadMinutes !== undefined) {
            const value = Number(body.peakAlertLeadMinutes)
            if (Number.isFinite(value)) live.peakAlertLeadMinutes = Math.min(30, Math.max(1, Math.round(value)))
          }
          if (body.apiKey !== undefined) {
            live.apiKey = String(body.apiKey ?? '').trim()
            balanceCache = null // 换 key 立即失效缓存
          }
          persistSettings()
          send(200, { ok: true })
          return
        }


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
          const budgetReady = live.budgetEnabled && Number(live.budgetAmount) > 0
          const budgetUsd = budgetReady
            ? (live.budgetPeriod === 'day'
              ? (snap.days[todayKey]?.cost ?? 0)
              : live.budgetPeriod === 'month'
                ? (month?.cost ?? 0)
                : total.cost)
            : 0
          send(200, {
            serverNow: now,
            display: { currency: 'CNY', rate: ledger.liveExchangeRate()?.rate ?? live.exchangeRate, rateSource: ledger.liveExchangeRate() ? 'auto' : 'config', rateFetchedAt: ledger.liveExchangeRate()?.fetchedAt ?? null },
            peak: { isPeak: isPeakAt(now), windows: PEAK_WINDOWS, nextSwitchAtMs: nextPeakSwitch(now)?.atMs ?? null, nextIsPeak: nextPeakSwitch(now)?.isPeak ?? null },
            today: todayKey in snap.days ? summarize(snap.days[todayKey]) : null,
            month,
            total: summarize(total),
            budget: budgetReady
              ? { amount: live.budgetAmount, period: live.budgetPeriod, used: budgetUsd * live.exchangeRate, usedPct: budgetUsd * live.exchangeRate / live.budgetAmount }
              : null,
            recent,
            sessions: sessions.slice(0, 20),
            unmatched: [...unmatchedModels],
            streamAlive: streamArmed,
            alerts: {
              peakEnabled: live.peakAlertEnabled === true,
              leadMinutes: Math.min(30, Math.max(1, Math.round(live.peakAlertLeadMinutes ?? 2))),
              notify: live.peakAlertNotify === true,
            },
          })
          return
        }

        /**
         * GET /forecast —— 月底花费预测。
         *
         * 用最近 7 个**完整**历史日的日均推算，不用今天（半天数据会把均值拉低）。
         * 样本少于 3 天时标 basis=insufficient，前端据此提示「数据不足」而不是
         * 显示一个不可信的数字。
         */
        if (path === '/forecast' && req.method === 'GET') {
          const snap = await ledgerSnapshotFresh()
          const now = Date.now()
          const todayKey = localDayKey(now)
          const monthPrefix = todayKey.slice(0, 7)

          let monthCost = 0
          let monthCalls = 0
          const recent = []

          for (const key of Object.keys(snap.days).sort()) {
            const day = snap.days[key]
            if (key.startsWith(monthPrefix)) {
              monthCost += day.cost ?? 0
              monthCalls += day.calls ?? 0
            }
            // 只取完整历史日，今天的数据还在增长
            if (key < todayKey && key >= localDayKey(now - 7 * 86400000)) {
              recent.push({ date: key, cost: day.cost ?? 0, calls: day.calls ?? 0 })
            }
          }

          const n = recent.length
          const sumCost = recent.reduce((acc, d) => acc + d.cost, 0)
          const sumCalls = recent.reduce((acc, d) => acc + d.calls, 0)
          const avgDaily = n > 0 ? sumCost / n : 0
          const avgCalls = n > 0 ? sumCalls / n : 0

          const nowDate = new Date(now)
          const daysInMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate()
          const daysLeft = daysInMonth - nowDate.getDate()
          const projected = monthCost + avgDaily * daysLeft

          send(200, {
            monthCost,
            monthCalls,
            avgDaily,
            avgCalls,
            daysLeft,
            projected,
            avgPerCall: monthCalls > 0 ? monthCost / monthCalls : 0,
            sampleDays: n,
            basis: n >= 3 ? 'recent' : 'insufficient',
            recent,
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
          res.end(JSON.stringify({ exportedAt: Date.now(), display: { currency: 'CNY', rate: ledger.liveExchangeRate()?.rate ?? live.exchangeRate }, days: snap.days }))
          return
        }

        if (path === '/prices' && req.method === 'GET') {
          const now = Date.now()
          const peak = isPeakAt(now)
          const live = ledger.livePrices()
          send(200, {
            currency: 'USD',
            peak,
            peakWindowsUtc: PEAK_WINDOWS,
            holidays: [...PEAK_HOLIDAYS],
            source: live ? 'official-sync' : 'built-in',
            fetchedAt: live?.fetchedAt ?? null,
            models: {
              'deepseek-v4.1-flash / deepseek-flash': live ? tierFor({ offPeak: live.flash.offPeak, peak: live.flash.peak }, now, peak) : currentTier(deepseekFlash, now, peak),
              'deepseek-v4-pro': live ? tierFor({ offPeak: live.pro.offPeak, peak: live.pro.peak }, now, peak) : currentTier(deepseekPro, now, peak),
            },
            default: live ? tierFor({ offPeak: live.flash.offPeak, peak: live.flash.peak }, now, peak) : currentTier(deepseekFlash, now, peak),
          })
          return
        }

        // 官方价格同步：抓官方定价页解析，校验峰=谷×2 后覆盖现行档。
        if (path === '/fetch-prices' && req.method === 'POST') {
          try {
            const parsed = await fetchOfficialPricing()
            const tiers = tiersFromOfficial(parsed)
            ledger.setLivePrices(tiers)
            void report(`price sync ok: flash off ${JSON.stringify(tiers.flash.offPeak)} pro off ${JSON.stringify(tiers.pro.offPeak)}`)
            send(200, { ok: true, fetchedAt: tiers.fetchedAt, flash: tiers.flash, pro: tiers.pro })
          } catch (error) {
            void report(`price sync failed: ${String(error?.message ?? error).slice(0, 200)}`)
            send(502, { ok: false, error: String(error?.message ?? error).slice(0, 200) })
          }
          return
        }

        // 官方余额（选配 apiKey）：host 白名单写死官方域名，https 证书校验兜底。
        if (path === '/balance' && req.method === 'GET') {
          const key = String(live.apiKey ?? '').trim()
          if (!key) { send(200, { ok: false, reason: 'no-key' }); return }
          if (balanceCache && Date.now() - balanceCache.at < 600_000) { send(200, balanceCache.data); return }
          if (BALANCE_HOST !== 'api.deepseek.com') { send(200, { ok: false, reason: 'bad-host' }); return }
          try {
            const res = await fetch(`https://${BALANCE_HOST}/user/balance`, {
              headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'user-agent': 'dsh-cost' },
              signal: AbortSignal.timeout(8000),
            })
            if (!res.ok) throw new Error(`balance ${res.status}`)
            const data = await res.json()
            const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
            const out = info
              ? { ok: true, currency: info.currency ?? 'CNY', total: String(info.total_balance ?? ''), granted: String(info.granted_balance ?? ''), toppedUp: String(info.topped_up_balance ?? ''), at: Date.now() }
              : { ok: false, reason: 'empty' }
            balanceCache = { at: Date.now(), data: out }
            send(200, out)
          } catch (error) {
            const out = { ok: false, reason: String(error?.message ?? error).slice(0, 120) }
            balanceCache = { at: Date.now(), data: out }
            send(200, out)
          }
          return
        }

        // 汇率手动刷新（自动刷新由每小时定时器执行）。
        if (path === '/fetch-rate' && req.method === 'POST') {
          try {
            const rate = await fetchExchangeRate()
            ledger.setExchangeRate(rate, Date.now())
            void report(`exchange rate ok: ${rate}`)
            send(200, { ok: true, rate })
          } catch (error) {
            void report(`exchange rate failed: ${String(error?.message ?? error).slice(0, 200)}`)
            send(502, { ok: false, error: String(error?.message ?? error).slice(0, 200) })
          }
          return
        }

        // 热力图：近 N 天逐日 { cost, calls, tokens }（GitHub 贡献图样式）。
        if (path === '/heatmap' && req.method === 'GET') {
          const url = new URL(req.url ?? '/api/dsh-cost/heatmap', 'http://localhost')
          const days = Math.min(365, Math.max(28, Number(url.searchParams.get('days') ?? 182)))
          const snap = await ledgerSnapshotFresh()
          const since = localDayKey(Date.now() - days * 86400000)
          const rows = []
          for (const key of Object.keys(snap.days).sort()) {
            if (key < since) continue
            const day = snap.days[key]
            rows.push({
              date: key,
              cost: day.cost ?? 0,
              calls: day.calls ?? 0,
              tokens: (day.input ?? 0) + (day.output ?? 0) + (day.cacheRead ?? 0) + (day.cacheWrite ?? 0) + (day.reasoning ?? 0),
            })
          }
          send(200, { days: rows })
          return
        }

        // Coding Plan 配额：只下发窗口/错误/时间戳，Key 永不出服务端。
        const planState = () => {
          const providers = {}
          for (const id of CODING_PLAN_IDS) providers[id] = { hasKey: planKeyOf(id).length > 0 }
          for (const id of CODING_PLAN_IDS) {
            if (!providers[id].hasKey) continue
            const cached = planCache.get(id)
            if (cached) providers[id] = { ...providers[id], ...cached.result, stale: Date.now() - cached.at >= PLAN_TTL_MS }
          }
          return providers
        }
        if (path === '/coding-plans' && req.method === 'GET') {
          // 已配置且缓存过期的后台补刷：GET 不阻塞，下一轮轮询取到新值。
          for (const id of CODING_PLAN_IDS) {
            if (!planKeyOf(id)) continue
            const cached = planCache.get(id)
            if (!cached || Date.now() - cached.at >= PLAN_TTL_MS) void refreshCodingPlan(id)
          }
          send(200, { providers: planState() })
          return
        }
        if (path === '/coding-plans/refresh' && req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          let body = {}
          try { body = raw ? JSON.parse(raw) : {} } catch { send(400, { error: 'invalid-json' }); return }
          const only = typeof body.provider === 'string' ? body.provider : ''
          const ids = only ? [only] : CODING_PLAN_IDS.filter((id) => planKeyOf(id))
          for (const id of ids) await refreshCodingPlan(id, true)
          send(200, { ok: true, providers: planState() })
          return
        }
        if (path === '/coding-plans/config' && req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          let body
          try { body = JSON.parse(raw) } catch { send(400, { error: 'invalid-json' }); return }
          const id = typeof body.provider === 'string' ? body.provider : ''
          if (!CODING_PLAN_IDS.includes(id)) { send(400, { error: 'unknown-provider' }); return }
          const key = typeof body.key === 'string' ? body.key.trim().slice(0, 4096) : ''
          const merged = { ...(live.codingPlans ?? {}) }
          if (key) {
            const origin = normalizeMiniMaxOrigin(typeof body.origin === 'string' ? body.origin : undefined)
            if (origin === null) { send(400, { error: 'invalid-origin' }); return }
            merged[id] = origin ? { key, origin } : { key }
          } else {
            delete merged[id] // 空 key = 清除配置
          }
          live.codingPlans = merged
          planCache.delete(id)
          persistSettings()
          void report(`coding plan config updated: ${id} ${key ? 'set' : 'cleared'}`)
          send(200, { ok: true })
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
