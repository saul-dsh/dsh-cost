/**
 * dsh-cost 的 web 客户端。
 *
 * 三个界面（借鉴 dsh-cost-meter 的槽位布局，样式走 --dsw-* 官方令牌）：
 *  - conversation.input.dock：本会话累计费用 chip（hover 明细，点击刷新）
 *  - sidebar.footer.action：今日费用行
 *  - settings.section「费用」：今日/本月/累计概览卡 + 近 7 天 + 会话列表
 *
 * 数据通道：GET /api/dsh-cost/state（服务端 ledger 聚合）。
 * 轮询：全局 15s 共享 poller；回合落定（生成键从停止翻回发送）立即 poke。
 * 槽位注册复用 dsh-followup 已验证的模式（ctx.slots.inject + register）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cost',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const STYLE_ID = 'dsh-cost-style'
    const ENDPOINT = '/api/dsh-cost'
    const POLL_MS = 15000

    /** 客户端调试通道：关键锚定/装配事件上报服务端 debug log（真机取证）。 */
    function clientDebug(message) {
      try {
        void fetch(`${ENDPOINT}/client-debug`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: String(message).slice(0, 300) }),
        }).catch(() => {})
      } catch { /* ignore */ }
    }

    /* 官方 token 配色（compaction-control / cost-meter 同基准），无自创色。 */
    const CSS = `
.dsh-cost-inline {
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, rgba(232, 238, 250, 0.72));
  white-space: nowrap;
}
.dsh-cost-statusrow {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: 2px;
  font-size: 12px;
  line-height: 20px;
}
.dsh-cost-sidebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin-top: 8px;
  padding: 7px 12px;
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l3, transparent);
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(232, 238, 250, 0.72));
  font-size: 12px;
  line-height: 20px;
  cursor: default;
  user-select: none;
}
.dsh-cost-sidebar:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-cost-sidebar:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); outline: none; }
.dsh-cost-sidebar .dsh-cost-sidebar-value {
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.dsh-cost-sidebar.warn .dsh-cost-sidebar-value { color: var(--dsw-alias-state-warn-primary); }
.dsh-cost-alert {
  position: fixed;
  top: calc(var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px)) + 16px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border: 1px solid var(--dsw-alias-border-l1, transparent);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #1d232e);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.dsh-cost-alert button { border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; padding: 0; }
.dsh-cost-alert button:hover { color: var(--dsw-alias-label-primary); }
.dsh-cost-badge.action { cursor: pointer; user-select: none; border: none; }
.dsh-cost-badge.action:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
/* 动作行费用按钮：对齐官方「用量」按钮（tertiary 纯文字、无底色；
   !important 用于压过宿主动作行对 button 元素的默认底色/文字色）。 */
.dsh-cost-usage-anchor {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none !important;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--dsw-alias-label-tertiary, rgba(232, 238, 250, 0.55)) !important;
  font-size: 12px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
  border-radius: 4px;
  cursor: default;
  user-select: none;
}
.dsh-cost-usage-anchor:hover {
  color: var(--dsw-alias-label-secondary, rgba(232, 238, 250, 0.72)) !important;
  background: var(--dsw-alias-interactive-bg-hover) !important;
}
/* 官方弹卡基准。底色照 dsh 的 macOS 档写死 0.94，不用 --dsw-specific-menu：
   Windows 默认是 rgba(67,69,74,.45)，那是给带 MenuSurface 底衬的官方菜单用的；
   插件直接 portal 到 body 没有底衬，0.45 一旦 backdrop-filter 失效就发灰糊在背景上。 */
.dsh-cost-pop {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  border: 0;
  border-radius: 12px;
  background: rgba(248, 249, 250, 0.94);
  backdrop-filter: blur(40px) saturate(150%);
  -webkit-backdrop-filter: blur(40px) saturate(150%);
  width: min(300px, 100vw - 24px);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.07),
    0 3px 8px 0 rgba(0, 0, 0, 0.04),
    0 0 20px 0 rgba(0, 0, 0, 0.05);
  color: rgba(28, 30, 34, 0.86);
  cursor: default;
  padding: 12px;
  font-size: 12px;
  line-height: 20px;
}
body[data-ds-dark-theme] .dsh-cost-pop {
  background: rgba(48, 49, 54, 0.94);
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.10),
    0 3px 8px 0 rgba(0, 0, 0, 0.04),
    0 0 20px 0 rgba(0, 0, 0, 0.05);
  color: rgba(232, 238, 250, 0.72);
}
.dsh-cost-pop-head { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 6px; margin-bottom: 4px; border-bottom: 1px solid var(--dsw-alias-border-l3, transparent); font-weight: 500; }
.dsh-cost-pop-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-cost-pop-num { flex: none; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-cost-section { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px 24px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsh-cost-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 1023px) { .dsh-cost-cards { grid-template-columns: 1fr; } }
.dsh-cost-card { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dsh-cost-card .dsh-cost-card-title { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-card .dsh-cost-card-value { font-size: 20px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dsh-cost-card .dsh-cost-card-sub { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsh-cost-table { display: flex; flex-direction: column; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); overflow: hidden; }
.dsh-cost-row { display: flex; align-items: center; gap: 12px; min-height: 30px; padding: 4px 14px; font-size: 12px; line-height: 20px; font-variant-numeric: tabular-nums; }
.dsh-cost-row + .dsh-cost-row { border-top: 1px solid var(--dsw-alias-border-l3, transparent); }
.dsh-cost-row .dsh-cost-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.dsh-cost-row .dsh-cost-num { flex: none; color: var(--dsw-alias-label-primary); }
.dsh-cost-row .dsh-cost-dim { flex: none; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-empty { padding: 12px 14px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, transparent); font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-cost-budget { display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dsh-cost-budget-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-cost-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-interactive-bg-hover); overflow: hidden; }
.dsh-cost-fill { height: 100%; border-radius: 3px; background: var(--dsw-alias-brand-primary); }
.dsh-cost-fill.warn { background: var(--dsw-alias-state-warn-primary); }
.dsh-cost-fill.over { background: var(--dsw-alias-state-error-primary); }
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* -- 共享 poller：一个请求喂三个界面 ------------------------------ */

    const listeners = new Set()
    let latestState = null
    let timer = 0

    async function pollOnce() {
      try {
        const res = await fetch(`${ENDPOINT}/state`, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        if (!data || typeof data !== 'object') return
        latestState = data
        for (const listener of listeners) {
          try { listener(latestState) } catch { /* 单订阅者异常不断链 */ }
        }
        renderSessionAnchor()
      } catch { /* 服务端未就绪：静默，下轮再试 */ }
    }

    function startPoller() {
      if (timer) return
      void pollOnce()
      timer = setInterval(() => { void pollOnce() }, POLL_MS)
    }

    function useCostState() {
      const [state, setState] = React.useState(latestState)
      React.useEffect(() => {
        const listener = (value) => setState(value)
        listeners.add(listener)
        startPoller()
        return () => { listeners.delete(listener) }
      }, [])
      return state
    }

    /* -- 回合落定感知（followup 同款：生成键从停止翻回发送） ---------- */

    function composerRoot() {
      const dock = document.querySelector('[data-composer-dock]')
      return dock ? dock.parentElement : null
    }
    function composerBusy(root) {
      if (!root) return false
      const buttons = root.querySelectorAll('button[aria-label]')
      for (const button of buttons) {
        if (button.offsetParent === null) continue
        const label = button.getAttribute('aria-label') ?? ''
        if (/停止|stop/i.test(label)) return true
      }
      return false
    }
    function useTurnEnd(onTurnEnd) {
      const callbackRef = React.useRef(onTurnEnd)
      callbackRef.current = onTurnEnd
      React.useEffect(() => {
        let wasBusy = composerBusy(composerRoot())
        const timerId = setInterval(() => {
          const root = composerRoot()
          const busy = composerBusy(root)
          if (wasBusy && !busy) callbackRef.current()
          wasBusy = busy
        }, 500)
        return () => { clearInterval(timerId) }
      }, [])
    }

    /* -- 展示辅助 ------------------------------------------------------ */

    function moneyOf(state, cost) {
      if (!state || !Number.isFinite(cost)) return '—'
      const value = cost * (state.display?.rate ?? 7.2)
      const unit = state.display?.currency === 'CNY' ? '¥' : '$'
      return value > 0 && value < 0.01 ? `${unit}${value.toFixed(4)}` : `${unit}${value.toFixed(2)}`
    }
    function tokensOf(row) {
      if (!row) return 0
      return (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0) + (row.reasoning ?? 0)
    }

    /* -- 界面一：宿主状态行末尾的会话费用 ------------------------------ */

    /**
     * 会话 id 感知器：input.dock 槽位组件只用来拿标准 props 里的 sessionId
     * （渲染 null），写进模块级变量供锚定 span 读取；切会话即时更新。
     */
    let currentSessionId = ''
    const sessionWatchers = new Set()

    function SessionIdSensor({ sessionId }) {
      React.useEffect(() => {
        currentSessionId = typeof sessionId === 'string' ? sessionId : ''
        for (const notify of sessionWatchers) {
          try { notify() } catch { /* 单订阅者异常不断链 */ }
        }
      }, [sessionId])
      return null
    }

    /**
     * 锚定进宿主会话指标行（「5 轮 31 步 · 207 tok/s · … 缓存命中 88%」）。
     * compaction-control 0.1.7 同款思路：React/宿主都不管理我们的 span 位置，
     * span 断线（宿主整行重建）时 MutationObserver 重挂；找不到特征行就不渲染
     * （宁缺毋滥，不在官方容器外悬空）。
     */
    const sessionAnchor = { span: null, host: null, observer: null, state: null }

    function sessionCostText() {
      const state = latestState
      if (!state || !currentSessionId || !Array.isArray(state.sessions)) return ''
      const session = state.sessions.find((item) => item.id === currentSessionId)
      if (!session) return ''
      return ` · ${moneyOf(state, session.cost)}`
    }

    function renderSessionAnchor() {
      const span = sessionAnchor.span
      if (!span || !span.isConnected) return
      const text = sessionCostText()
      span.textContent = text
      sessionAnchor.host.style.display = text ? '' : 'none'
    }

    /** 找宿主状态行容器：可见文本含「缓存命中」/「tok/s」，向上爬到含 ≥2 个
     * 直接 button 子女的层——状态行由「5轮68步」「8M tok」「上下文 16%」等
     * 多个指标按钮组成，锚要插在这一层之后才是整行末尾。 */
    function findStatusRow() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        if (!text.includes('缓存命中') && !text.includes('tok/s')) continue
        let el = node.parentElement
        if (!el || el.offsetParent === null) continue
        let row = el
        for (let depth = 0; depth < 6 && row.parentElement; depth += 1) {
          const directButtons = [...row.children].filter((child) => child.tagName === 'BUTTON')
          if (directButtons.length >= 2) break
          row = row.parentElement
        }
        if (row.offsetParent === null) continue
        return row
      }
      return null
    }

    function mountSessionAnchor() {
      // 已挂且仍在文档中：不重复锚。
      if (sessionAnchor.host?.isConnected) return
      const row = findStatusRow()
      if (!row) {
        void clientDebug('anchor: status row not found (no visible tok/s text)')
        return
      }
      // 插到状态行的**兄弟位置**（compaction-control 0.1.7 教训：append 进
      // React 管理的容器会被重渲染清掉，兄弟位置宿主不管、重锚不打架）。
      const host = document.createElement('div')
      host.className = 'dsh-cost-statusrow'
      const span = document.createElement('span')
      span.className = 'dsh-cost-inline'
      span.textContent = sessionCostText()
      host.appendChild(span)
      host.style.display = span.textContent ? '' : 'none'
      row.insertAdjacentElement('afterend', host)
      sessionAnchor.host = host
      sessionAnchor.span = span
      void clientDebug('anchor: mounted after status row')
    }

    function startSessionAnchor() {
      mountSessionAnchor()
      sessionAnchor.observer = new MutationObserver(() => {
        // 只处理我们 host 断线或脱离状态行的情况，防自触发循环。
        const host = sessionAnchor.host
        if (host?.isConnected) {
          const prev = host.previousElementSibling
          const text = prev?.textContent ?? ''
          if (prev && (text.includes('缓存命中') || text.includes('tok/s'))) return
        }
        sessionAnchor.host = null
        sessionAnchor.span = null
        mountSessionAnchor()
      })
      sessionAnchor.observer.observe(document.body, { childList: true, subtree: true })
    }

    /* -- 界面二：侧栏今日费用（分隔线 + 左右对齐行） -------------------- */

    function TodayCost() {
      const state = useCostState()
      if (!state) return null
      const today = state.today
      const title = today
        ? `${today.calls} 次调用 · token ${(tokensOf(today) / 1000).toFixed(1)}k · ${state.peak?.isPeak ? '峰时' : '谷时'}`
        : '今日暂无调用'
      const overBudget = state.budget && state.budget.usedPct >= 0.8
      return h('button', {
        type: 'button',
        className: 'dsh-cost-sidebar' + (overBudget ? ' warn' : ''),
        title,
        onClick: () => { void pollOnce() },
      },
      h('span', null, '今日'),
      h('span', { className: 'dsh-cost-sidebar-value' }, moneyOf(state, today?.cost ?? 0)))
    }

    /* -- 回合边界感知（turnTail 槽位，隐形数据载体） -------------------- */

    const TURN_BUCKET_NAMES = { input: '输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入', reasoning: '推理' }

    /**
     * 用户要求去掉回合尾部的可见费用行（0.6.1）；此组件退化为隐形载体：
     * 每回合渲染一个 display:none 的节点，把宿主给的回合时间边界写到
     * dataset——动作行的「费用」按钮（用量旁）靠它把弹卡对到正确的回合。
     */
    function TurnCost(props) {
      const turn = props.turn
      const start = turn?.start?.time
      const end = turn?.end?.time
      if (start == null || end == null) return null
      return h('span', {
        className: 'dsh-cost-turn-data',
        'data-turn-from': String(start),
        'data-turn-to': String(end),
        style: { display: 'none' },
      })
    }

    /* -- 峰谷切换提醒（fixed 覆盖层 portal 到 body，防祖先链裁剪） ------ */

    let lastAlertedSwitch = 0

    function PeakAlert() {
      const state = useCostState()
      const [visible, setVisible] = React.useState(false)
      const [message, setMessage] = React.useState('')
      React.useEffect(() => {
        const alerts = state?.alerts
        const nextSwitchAtMs = state?.peak?.nextSwitchAtMs
        if (!alerts?.peakEnabled || !nextSwitchAtMs) return
        const lead = (alerts.leadMinutes ?? 2) * 60_000
        const remaining = nextSwitchAtMs - Date.now()
        if (remaining > lead || remaining < 0) return
        if (lastAlertedSwitch === nextSwitchAtMs) return
        lastAlertedSwitch = nextSwitchAtMs
        const time = new Date(nextSwitchAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const text = state.peak.nextIsPeak ? `即将进入峰时计价（${time}）` : `即将进入谷时计价（${time}）`
        setMessage(text)
        setVisible(true)
        if (alerts.notify) {
          try { new Notification('dsh-cost 峰谷计价', { body: text }) } catch { /* 权限未授予则忽略 */ }
        }
      }, [state])
      if (!visible) return null
      return createPortal(h('div', { className: 'dsh-cost-alert' },
        h('span', null, message),
        h('button', { type: 'button', onClick: () => setVisible(false) }, '知道了')), document.body)
    }

    /* -- 动作行费用按钮：锚定在官方「用量」按钮旁，弹卡同官方样式 ------- */

    const usageAnchors = { observer: null, scanning: false, pop: null, anchor: null }

    /** 从「用量」按钮向上找同回合的隐形边界载体（限深，宁缺毋错）。 */
    function findTurnDetails(usageButton) {
      let level = usageButton.parentElement
      for (let depth = 0; depth < 6 && level; depth += 1) {
        const marker = level.querySelector?.('.dsh-cost-turn-data[data-turn-from]')
        if (marker) return marker
        level = level.parentElement
      }
      return null
    }

    function closeTurnCostPop(event) {
      // 点在费用按钮上不在这里关：capture 阶段比按钮自己的 click 先跑，
      // 这里关了按钮又会重新打开，永远关不掉。toggle 交给按钮自己做。
      if (event?.target instanceof Node) {
        if (event.target.closest?.('.dsh-cost-usage-anchor')) return
        // 点弹卡内部（文字、数字）也不该收起，只有点外面才关。
        if (usageAnchors.pop?.contains(event.target)) return
      }
      usageAnchors.pop?.remove()
      usageAnchors.pop = null
      usageAnchors.anchor = null
      document.removeEventListener('click', closeTurnCostPop, true)
    }

    function openTurnCostPop(anchor) {
      closeTurnCostPop()
      const from = anchor.dataset.turnFrom
      const to = anchor.dataset.turnTo
      if (!from || !to) return
      const pop = document.createElement('div')
      pop.className = 'dsh-cost-pop'
      pop.textContent = '加载中…'
      document.body.appendChild(pop)
      usageAnchors.pop = pop
      usageAnchors.anchor = anchor
      // 动作行贴近窗口底部：按官方弹卡惯例向上展开（compaction-control 教训）。
      const rect = anchor.getBoundingClientRect()
      pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 280))}px`
      pop.style.top = `${rect.top - 8}px`
      pop.style.transform = 'translateY(-100%)'
      document.addEventListener('click', closeTurnCostPop, true)
      fetch(`${ENDPOINT}/turn?session=${encodeURIComponent(currentSessionId)}&from=${from}&to=${to}`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((value) => {
          if (!usageAnchors.pop || !value) return
          while (pop.firstChild) pop.removeChild(pop.firstChild)
          const head = document.createElement('div')
          head.className = 'dsh-cost-pop-head'
          const title = document.createElement('span')
          title.textContent = '本轮费用'
          const total = document.createElement('span')
          total.className = 'dsh-cost-pop-num'
          total.textContent = value.found ? moneyOf(latestState, value.cost) : '—'
          head.appendChild(title)
          head.appendChild(total)
          pop.appendChild(head)
          for (const row of value.rows ?? []) {
            const line = document.createElement('div')
            line.className = 'dsh-cost-pop-row'
            const label = document.createElement('span')
            label.textContent = `${String(row.model ?? '').replace(/^deepseek-/, '')} · ${TURN_BUCKET_NAMES[row.bucket] ?? row.bucket}`
            const numEl = document.createElement('span')
            numEl.className = 'dsh-cost-pop-num'
            numEl.textContent = `${Number(row.tokens).toLocaleString()} tok · ${moneyOf(latestState, row.cost)}`
            line.appendChild(label)
            line.appendChild(numEl)
            pop.appendChild(line)
          }
          if (!value.found) {
            const empty = document.createElement('div')
            empty.className = 'dsh-cost-pop-row'
            empty.textContent = '该回合暂无用量记录'
            pop.appendChild(empty)
          }
        })
        .catch(() => closeTurnCostPop())
    }

    /** 扫描官方「用量 X tok」按钮，在其后插入同款费用按钮（按钮自身打标记防重复）。 */
    function mountUsageAnchors() {
      const buttons = document.querySelectorAll('button')
      for (const button of buttons) {
        if (button.offsetParent === null) continue
        // 标记挂在用量按钮自身：兄弟检查在 afterend 插入后会漏判导致无限堆叠。
        if (button.dataset.dshCostAnchor === '1') continue
        const text = (button.textContent ?? '').trim()
        if (!text.startsWith('用量') || !text.includes('tok')) continue
        const details = findTurnDetails(button)
        if (!details) continue
        button.dataset.dshCostAnchor = '1'
        const anchor = document.createElement('button')
        anchor.className = 'dsh-cost-usage-anchor'
        anchor.type = 'button'
        anchor.textContent = '费用 —'
        const from = details.getAttribute('data-turn-from') ?? ''
        const to = details.getAttribute('data-turn-to') ?? ''
        anchor.dataset.turnFrom = from
        anchor.dataset.turnTo = to
        anchor.addEventListener('click', (event) => {
          event.stopPropagation()
          // 再点同一个按钮 = 收起；点另一个回合的按钮 = 切过去。
          if (usageAnchors.pop && usageAnchors.anchor === anchor) {
            closeTurnCostPop()
            return
          }
          openTurnCostPop(anchor)
        })
        // 插到「用量」按钮右侧（用户指定：用量在左、费用在右）。
        button.insertAdjacentElement('afterend', anchor)
        // 金额异步补：同回合 /turn 已被 turnTail 查过，这里独立补一次。
        fetch(`${ENDPOINT}/turn?session=${encodeURIComponent(currentSessionId)}&from=${from}&to=${to}`, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((value) => {
            if (value?.found && anchor.isConnected) {
              anchor.textContent = `费用 ${moneyOf(latestState, value.cost)}`
              anchor.title = '本轮费用明细'
            } else if (anchor.isConnected) {
              anchor.textContent = '费用 —'
            }
          })
          .catch(() => {})
      }
    }

    function startUsageAnchors() {
      let timer = 0
      const scan = () => {
        timer = 0
        usageAnchors.scanning = false
        try { mountUsageAnchors() } catch { /* 扫描失败下轮再试 */ }
      }
      const scheduleScan = () => {
        if (usageAnchors.scanning || timer) return
        usageAnchors.scanning = true
        timer = setTimeout(scan, 400)
      }
      scheduleScan()
      usageAnchors.observer = new MutationObserver(scheduleScan)
      usageAnchors.observer.observe(document.body, { childList: true, subtree: true })
    }

    /* -- 界面四：设置页「费用」分节 ------------------------------------ */

    function BudgetCard({ state }) {
      const budget = state?.budget
      if (!budget) return null
      const pct = Math.min(100, Math.max(0, budget.usedPct * 100))
      const tier = budget.usedPct >= 1 ? 'over' : budget.usedPct >= 0.8 ? 'warn' : ''
      const periodLabel = budget.period === 'day' ? '今日' : budget.period === 'month' ? '本月' : '累计'
      return h('div', { className: 'dsh-cost-budget' },
        h('div', { className: 'dsh-cost-budget-head' },
          h('span', null, `预算（${periodLabel}）`),
          h('span', null, `¥${Number(budget.used).toFixed(2)} / ¥${Number(budget.amount).toFixed(2)} · ${(budget.usedPct * 100).toFixed(0)}%`)),
        h('div', { className: 'dsh-cost-bar' }, h('div', { className: `dsh-cost-fill ${tier}`, style: { width: `${pct}%` } })))
    }

    function RecentCalls({ state }) {
      const [calls, setCalls] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch(`${ENDPOINT}/calls?limit=10`, { cache: 'no-store' })
            if (!res.ok) return
            const data = await res.json()
            if (alive && Array.isArray(data.calls)) setCalls(data.calls)
          } catch { /* ignore */ }
        }
        void load()
        const timerId = setInterval(load, POLL_MS * 2)
        return () => { alive = false; clearInterval(timerId) }
      }, [])
      if (!calls) return null
      if (calls.length === 0) return null
      return h('div', { className: 'dsh-cost-table' },
        calls.map((call, index) => h('div', { className: 'dsh-cost-row', key: `${call.at}-${index}` },
          h('span', { className: 'dsh-cost-dim' }, new Date(call.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
          h('span', { className: 'dsh-cost-grow' }, String(call.model ?? '').replace(/^deepseek-/, '')),
          h('span', { className: 'dsh-cost-dim' }, `${((call.input ?? 0) + (call.output ?? 0) + (call.cacheRead ?? 0) + (call.cacheWrite ?? 0)).toLocaleString()} tok`),
          h('span', { className: 'dsh-cost-num' }, moneyOf(state, call.cost)))))
    }

    function CostCard({ title, row, state }) {
      return h('div', { className: 'dsh-cost-card' },
        h('div', { className: 'dsh-cost-card-title' }, title),
        h('div', { className: 'dsh-cost-card-value' }, moneyOf(state, row?.cost ?? 0)),
        h('div', { className: 'dsh-cost-card-sub' },
          `${row?.calls ?? 0} 次调用 · token ${(tokensOf(row) / 1000).toFixed(1)}k`))
    }

    function CostSection() {
      const state = useCostState()
      const cards = h('div', { className: 'dsh-cost-cards' },
        h(CostCard, { title: '今日', row: state?.today, state }),
        h(CostCard, { title: '本月', row: state?.month, state }),
        h(CostCard, { title: '累计', row: state?.total, state }))
      const recent = Array.isArray(state?.recent) && state.recent.length > 0
        ? h('div', { className: 'dsh-cost-table' },
          state.recent.slice().reverse().map((day) => h('div', { className: 'dsh-cost-row', key: day.date },
            h('span', { className: 'dsh-cost-dim' }, day.date.slice(5)),
            h('span', { className: 'dsh-cost-grow' }, `${day.calls} 次调用`),
            h('span', { className: 'dsh-cost-num' }, moneyOf(state, day.cost)))))
        : h('div', { className: 'dsh-cost-table' }, h('div', { className: 'dsh-cost-empty' }, '暂无记录'))
      const sessions = Array.isArray(state?.sessions) && state.sessions.length > 0
        ? h('div', { className: 'dsh-cost-table' },
          state.sessions.slice(0, 10).map((session) => h('div', { className: 'dsh-cost-row', key: `${session.date}-${session.id}` },
            h('span', { className: 'dsh-cost-dim' }, new Date(session.at || session.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
            h('span', { className: 'dsh-cost-grow' }, String(session.id).replace(/^session-/, '').slice(0, 8)),
            h('span', { className: 'dsh-cost-grow' }, `${session.calls} 次`),
            h('span', { className: 'dsh-cost-num' }, moneyOf(state, session.cost)))))
        : null
      const footerBits = []
      if (state?.peak) {
        footerBits.push(h('span', { className: 'dsh-cost-badge', key: 'peak' }, state.peak.isPeak ? '峰时计价' : '谷时计价'))
      }
      if (Array.isArray(state?.unmatched) && state.unmatched.length > 0) {
        footerBits.push(h('span', { className: 'dsh-cost-badge', key: 'unmatched', title: state.unmatched.join(', ') }, `${state.unmatched.length} 个模型按默认档计费`))
      }
      const downloadExport = (format) => {
        const link = document.createElement('a')
        link.href = `${ENDPOINT}/export?format=${format}`
        link.download = ''
        document.body.appendChild(link)
        link.click()
        link.remove()
      }
      footerBits.push(h('button', { className: 'dsh-cost-badge action', key: 'export-json', title: '导出全部费用记录（JSON）', onClick: () => downloadExport('json') }, '导出 JSON'))
      footerBits.push(h('button', { className: 'dsh-cost-badge action', key: 'export-csv', title: '导出日汇总（CSV）', onClick: () => downloadExport('csv') }, '导出 CSV'))
      return h('div', { className: 'dsh-cost-section' },
        h(BudgetCard, { state }),
        cards,
        recent,
        sessions,
        h(RecentCalls, { state }),
        h('div', { style: { display: 'flex', gap: '6px' } }, footerBits))
    }

    /* -- 装配 ---------------------------------------------------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        startPoller()
        startSessionAnchor()
        startUsageAnchors()
        sessionWatchers.add(renderSessionAnchor)
        console.info('[dsh-cost] client 0.6.0 active')
        // 只当 sessionId 感知器（渲染 null），费用本体锚定在宿主状态行末尾。
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-cost-session',
          order: 90,
        }, SessionIdSensor))
        // 隐形回合边界载体：动作行「费用」按钮的弹卡按回合对齐靠它（0.6.1 起不再渲染可见费用行）。
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'dsh-cost-turn',
          order: 10,
        }, TurnCost))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-cost-today',
          order: 3,
        }, TodayCost))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-cost-peak-alert',
          order: 2,
        }, PeakAlert))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-cost',
          order: 30,
          label: '费用',
        }, CostSection))
      },
    }
  },
})
