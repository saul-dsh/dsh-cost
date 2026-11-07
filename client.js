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

    /* 客户端调试通道：关键锚定/装配事件上报服务端 debug log（真机取证）。 */
    function clientDebug(message) {
      try {
        void fetch(`${ENDPOINT}/client-debug`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: String(message).slice(0, 300) }),
        }).catch(() => {})
      } catch { /* ignore */ }
    }

    /* -- 双语（zh / en）：localStorage 持久化，默认跟随系统 ------------- */

    const LANG_KEY = 'dsh-cost-lang'
    const STRINGS = {
      zh: {
        sectionLabel: '费用',
        today: '今日', thisMonth: '本月', total: '累计',
        callsUnit: '次调用', callTimes: ' 次',
        noRecords: '暂无记录', noCallsToday: '今日暂无调用',
        peakBadge: '峰时计价', offPeakBadge: '谷时计价',
        peakNow: '峰时', offPeakNow: '谷时',
        unmatchedModels: '个模型按默认档计费',
        exportJson: '导出 JSON', exportCsv: '导出 CSV',
        exportJsonTitle: '导出全部费用记录（JSON）', exportCsvTitle: '导出日汇总（CSV）',
        syncPrices: '同步官方价格', syncPricesTitle: '从官方定价页同步现行价格（峰谷两档，历史账目不受影响）',
        refreshRate: '刷新汇率', refreshRateTitle: '立即刷新 USD→CNY 汇率（平时每小时自动刷新）',
        priceSynced: '价格已同步', rateRefreshed: '汇率已刷新', failed: '失败',
        monthForecast: '月底预计', spent: '已花', dailyAvg: '日均', daysLeft: (n) => `剩 ${n} 天`, overBudget: '超出预算',
        forecastNeedDays: (n) => `预测需要至少 3 天完整数据（当前 ${n} 天）`,
        budget: '预算', budgetPeriodDay: '今日', budgetPeriodMonth: '本月', budgetPeriodAll: '累计',
        turnCost: '费用', turnCostTitle: '本轮费用明细', turnCostPop: '本轮费用', turnEmpty: '该回合暂无用量记录',
        costDetail: '费用明细', sessionCost: '本对话费用', officialBalance: '官方余额', recentCalls: '最近调用',
        srcChat: '对话', srcEnhance: '提示词增强', srcFollowup: '跟进建议',
        todaySidebar: '今日', loading: '加载中…', readFailed: '读取失败', gotIt: '知道了',
        peakSoonPeak: (time) => `即将进入峰时计价（${time}）`, peakSoonOff: (time) => `即将进入谷时计价（${time}）`,
        budgetOverTitle: 'dsh 费用预算已超限',
        budgetOverBody: (label, used, amount, pct) => `${label}费用 ¥${used}，已达预算 ¥${amount} 的 ${pct}%。`,
        bucketInput: '输入', bucketOutput: '输出', bucketCacheRead: '缓存读取', bucketCacheWrite: '缓存写入', bucketReasoning: '推理',
        heatTitle: '用量热力图', heatCost: '费用', heatCalls: '调用', heatTokens: 'Token',
        heatLess: '少', heatMore: '多', heatEmpty: '暂无用量数据',
        plansTitle: 'Coding Plan 配额', plansHint: '粘贴各家订阅的 API Key 查询剩余额度；Key 只保存在本机 settings.json，不会回显或上传。',
        plansSave: '保存', plansSaved: '已保存', plansRefresh: '刷新', plansRefreshAll: '全部刷新',
        plansConfigured: '已配置', plansError: '查询失败',
        winFiveHour: '5 小时', winWeekly: '本周', winMonthly: '本月', winBalance: '余额',
        winCredits: '额度', winPlan: '套餐', winCompensation: '补偿', winCurrent: '当前',
        winResets: '重置', winUnlimited: '不限量',
        planAnthropic: 'Anthropic (Claude Pro/Max)', planZai: 'Z.ai / 智谱 GLM Coding Plan',
        planMinimax: 'MiniMax Token Plan', planKimi: 'Kimi Code / Moonshot',
        planOpenrouter: 'OpenRouter', planSiliconflow: 'SiliconFlow 硅基流动',
        planCommandcode: 'CommandCode', planClinepass: 'Cline Pass',
        langHint: '设置分区标题等宿主注册项在刷新窗口后生效',
      },
      en: {
        sectionLabel: 'Cost',
        today: 'Today', thisMonth: 'This month', total: 'Total',
        callsUnit: 'calls', callTimes: ' calls',
        noRecords: 'No records yet', noCallsToday: 'No calls today',
        peakBadge: 'Peak pricing', offPeakBadge: 'Off-peak pricing',
        peakNow: 'peak', offPeakNow: 'off-peak',
        unmatchedModels: ' models billed at default tier',
        exportJson: 'Export JSON', exportCsv: 'Export CSV',
        exportJsonTitle: 'Export all cost records (JSON)', exportCsvTitle: 'Export daily summary (CSV)',
        syncPrices: 'Sync official prices', syncPricesTitle: 'Sync current prices from the official pricing page (peak/off-peak; history untouched)',
        refreshRate: 'Refresh rate', refreshRateTitle: 'Refresh the USD→CNY rate now (auto hourly otherwise)',
        priceSynced: 'Prices synced', rateRefreshed: 'Rate refreshed', failed: 'Failed',
        monthForecast: 'Month-end forecast', spent: 'Spent ', dailyAvg: 'daily avg ', daysLeft: (n) => `${n} days left`, overBudget: 'over budget',
        forecastNeedDays: (n) => `Forecast needs at least 3 full days of data (currently ${n})`,
        budget: 'Budget', budgetPeriodDay: 'Daily', budgetPeriodMonth: 'Monthly', budgetPeriodAll: 'All time',
        turnCost: 'Cost', turnCostTitle: 'Turn cost details', turnCostPop: 'This turn', turnEmpty: 'No usage recorded for this turn',
        costDetail: 'Cost details', sessionCost: 'This conversation', officialBalance: 'Official balance', recentCalls: 'Recent calls',
        srcChat: 'Chat', srcEnhance: 'Prompt enhancer', srcFollowup: 'Follow-ups',
        todaySidebar: 'Today', loading: 'Loading…', readFailed: 'Failed to load', gotIt: 'Got it',
        peakSoonPeak: (time) => `Peak pricing starts at ${time}`, peakSoonOff: (time) => `Off-peak pricing starts at ${time}`,
        budgetOverTitle: 'dsh cost budget exceeded',
        budgetOverBody: (label, used, amount, pct) => `${label} cost ¥${used} — ${pct}% of the ¥${amount} budget.`,
        bucketInput: 'Input', bucketOutput: 'Output', bucketCacheRead: 'Cache read', bucketCacheWrite: 'Cache write', bucketReasoning: 'Reasoning',
        heatTitle: 'Usage heatmap', heatCost: 'Cost', heatCalls: 'Calls', heatTokens: 'Tokens',
        heatLess: 'Less', heatMore: 'More', heatEmpty: 'No usage data yet',
        plansTitle: 'Coding Plan quotas', plansHint: 'Paste an API key per subscription to query remaining quota. Keys stay in the local settings.json — never echoed, never uploaded.',
        plansSave: 'Save', plansSaved: 'Saved', plansRefresh: 'Refresh', plansRefreshAll: 'Refresh all',
        plansConfigured: 'configured', plansError: 'Query failed',
        winFiveHour: '5-hour', winWeekly: 'This week', winMonthly: 'Monthly', winBalance: 'Balance',
        winCredits: 'Credits', winPlan: 'Plan', winCompensation: 'Bonus', winCurrent: 'Current',
        winResets: 'Resets', winUnlimited: 'Unlimited',
        planAnthropic: 'Anthropic (Claude Pro/Max)', planZai: 'Z.ai / Zhipu GLM Coding Plan',
        planMinimax: 'MiniMax Token Plan', planKimi: 'Kimi Code / Moonshot',
        planOpenrouter: 'OpenRouter', planSiliconflow: 'SiliconFlow',
        planCommandcode: 'CommandCode', planClinepass: 'Cline Pass',
        langHint: 'Host-registered labels (e.g. the settings section title) apply after a window reload',
      },
    }
    let lang = 'zh'
    try {
      const saved = localStorage.getItem(LANG_KEY)
      lang = saved === 'zh' || saved === 'en'
        ? saved
        : (navigator.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    } catch { /* 无 localStorage：保持跟随系统默认 */ }
    const t = (key) => STRINGS[lang][key] ?? STRINGS.zh[key] ?? key
    /** 切语言：写 localStorage 并广播一次，让所有 useCostState 订阅组件重渲染。 */
    function setLang(value) {
      const next = value === 'en' || value === 'zh'
        ? value
        : ((navigator.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en')
      if (next === lang) return
      lang = next
      try { localStorage.setItem(LANG_KEY, lang) } catch { /* ignore */ }
      for (const listener of listeners) {
        try { listener(latestState) } catch { /* 单订阅者异常不断链 */ }
      }
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
/* 状态行费用 pill：规格对齐 dsh 自带的 token / 缓存命中 pill（padding 1/8、
   圆角 sm、12px、tabular-nums、悬停淡底）。 */
.dsh-cost-pill-anchor {
  display: inline-flex;
  min-width: 0;
  font-size: 12px;
  line-height: 20px;
}
.dsh-cost-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, rgba(232, 238, 250, 0.5));
  font: inherit;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
/* 内联写了 background/color 兜底，hover 必须 !important 才盖得住。
   值同 dsh：--dsw-alias-interactive-bg-hover / --dsw-alias-label-secondary。 */
.dsh-cost-pill:hover,
.dsh-cost-pill[aria-expanded="true"] {
  background: rgba(255, 255, 255, 0.08) !important;
  color: rgb(207, 211, 214) !important;
}
.dsh-cost-pill svg { width: 14px; height: 14px; flex: none; }

/* 弹卡里的来源分组与明细行 */
.dsh-cost-src {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 11.5px;
}
.dsh-cost-src .name { flex: 1; color: var(--dsw-alias-label-secondary, rgba(232,238,250,.72)); }
.dsh-cost-src .num { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, rgba(232,238,250,.92)); }
.dsh-cost-src .cnt { color: var(--dsw-alias-label-tertiary, rgba(232,238,250,.45)); font-variant-numeric: tabular-nums; }

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
.dsh-cost-forecast { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dsh-cost-forecast .dsh-cost-forecast-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsh-cost-forecast .dsh-cost-forecast-value { font-size: 20px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; }
.dsh-cost-forecast .dsh-cost-forecast-sub { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsh-cost-forecast[data-over="true"] .dsh-cost-forecast-value { color: #f87171; }
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
/* 用量热力图（GitHub 贡献图样式；色阶用官方品牌色 color-mix） */
.dsh-cost-heat { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dsh-cost-heat-head { display: flex; align-items: center; gap: 8px; }
.dsh-cost-heat-title { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); flex: 1; }
.dsh-cost-heat-toggle { display: flex; gap: 2px; }
.dsh-cost-heat-toggle button { border: none; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 18px; padding: 1px 8px; border-radius: 4px; cursor: pointer; }
.dsh-cost-heat-toggle button[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); color: var(--dsw-alias-label-primary); }
.dsh-cost-heat-months { display: flex; gap: 3px; margin-left: 18px; height: 11px; font-size: 10px; line-height: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-heat-months span { width: 11px; flex: none; overflow: visible; white-space: nowrap; }
.dsh-cost-heat-weeks { display: flex; flex-direction: column; width: 14px; flex: none; font-size: 10px; line-height: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-heat-grid { display: flex; gap: 3px; overflow-x: auto; height: 95px; align-items: flex-start; }
.dsh-cost-heat-col { display: flex; flex-direction: column; gap: 3px; flex: none; }
.dsh-cost-heat-cell { width: 11px; height: 11px; border-radius: 2.5px; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.22)); flex: none; }
.dsh-cost-heat-cell.blank { visibility: hidden; }
.dsh-cost-heat-legend { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-heat-legend .dsh-cost-heat-cell { width: 9px; height: 9px; }
/* Coding Plan 配额面板 */
.dsh-cost-plans { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dsh-cost-plans-head { display: flex; align-items: center; gap: 8px; }
.dsh-cost-plans-title { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-primary); flex: 1; cursor: pointer; user-select: none; }
.dsh-cost-plans-caret { font-size: 10px; color: var(--dsw-alias-label-tertiary); flex: none; width: 12px; }
.dsh-cost-plans-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-plan { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, transparent); }
.dsh-cost-plan-row { display: flex; align-items: center; gap: 8px; }
.dsh-cost-plan-name { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-primary); flex: 1 1 40%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-cost-plan-input { flex: 2 1 180px; min-width: 0; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1, transparent); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font-size: 12px; outline: none; }
.dsh-cost-plan-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-cost-plan-btn { flex: none; border: none; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 20px; padding: 0 10px; cursor: pointer; }
.dsh-cost-plan-btn:hover { color: var(--dsw-alias-label-primary); }
.dsh-cost-plan-btn[disabled] { opacity: 0.45; cursor: default; }
.dsh-cost-plan-win { display: flex; align-items: center; gap: 8px; font-size: 11.5px; line-height: 18px; font-variant-numeric: tabular-nums; }
.dsh-cost-plan-win .dsh-cost-plan-winname { flex: none; width: 68px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-cost-plan-win .dsh-cost-plan-bar { flex: 1; height: 4px; border-radius: 2px; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); overflow: hidden; }
.dsh-cost-plan-win .dsh-cost-plan-fill { height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dsh-cost-plan-win .dsh-cost-plan-fill.hot { background: var(--dsw-alias-state-warn-primary); }
.dsh-cost-plan-win .dsh-cost-plan-pct { flex: none; min-width: 88px; text-align: right; color: var(--dsw-alias-label-tertiary); }
.dsh-cost-plan-err { font-size: 11.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
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

    /** 预算超限系统通知：跨线 100% 时每周期弹一次（80% 只走 UI 变色不打扰）。 */
    let budgetNoticeKey = null
    function notifyBudgetOnce(state) {
      try {
        const budget = state?.budget
        if (!budget || !(budget.usedPct >= 1)) return
        const key = `${budget.period}:${budget.amount}`
        if (budgetNoticeKey === key) return
        budgetNoticeKey = key
        if (typeof Notification === 'undefined') return
        const periodLabel = t(budget.period === 'day' ? 'budgetPeriodDay' : budget.period === 'month' ? 'budgetPeriodMonth' : 'budgetPeriodAll')
        const fire = () => {
          try {
            const n = new Notification(t('budgetOverTitle'), {
              body: t('budgetOverBody')(periodLabel, Number(budget.used).toFixed(2), Number(budget.amount).toFixed(2), (budget.usedPct * 100).toFixed(0)),
            })
            n.onclick = () => { window.focus?.(); n.close() }
          } catch { /* 通知不可用：UI 超限变色兜底 */ }
        }
        if (Notification.permission === 'granted') fire()
        else if (Notification.permission === 'default') {
          void Notification.requestPermission?.().then((p) => { if (p === 'granted') fire() }).catch(() => {})
        }
      } catch { /* ignore */ }
    }

    async function pollOnce() {
      try {
        const res = await fetch(`${ENDPOINT}/state`, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        if (!data || typeof data !== 'object') return
        latestState = data
        notifyBudgetOnce(latestState)
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

    /** 月底预测：数据变化慢，挂载时拉一次即可，不跟 poller 每 10 秒刷。 */
    function useForecast() {
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        fetch(`${ENDPOINT}/forecast`, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((value) => { if (alive) setData(value) })
          .catch(() => {})
        return () => { alive = false }
      }, [])
      return data
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
    const sessionAnchor = { span: null, host: null, observer: null, state: null, lastFailLog: 0 }

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
      // 优先认宿主的 dock 容器：InputBar 里 <div data-composer-dock> 同时装
      // composer.dock 槽位（各 pill）和 ContextMeter。比按文本 + 按钮数猜稳。
      const dock = document.querySelector('[data-composer-dock]')
      if (dock && dock.offsetParent !== null) return dock
      // 兜底：老版本的文本扫描
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
      // 状态行费用改由 composer.dock 的 pill 负责：这里不但不再插新的一份，
      // 还要把旧版本已经插进去的 .dsh-cost-statusrow 清掉，否则会显示成两行。
      if (document.querySelector('.dsh-cost-pill-anchor')) {
        for (const stale of document.querySelectorAll('.dsh-cost-statusrow')) stale.remove()
        sessionAnchor.host = null
        sessionAnchor.span = null
        return
      }
      // 已挂且仍在文档中：不重复锚。
      if (sessionAnchor.host?.isConnected) return
      const row = findStatusRow()
      if (!row) {
        // 失败节流：MutationObserver 每次页面变动都会进到这里，不节流会
        // 每秒刷几十条 debug 日志（真机曾积累 3002 条）。首见记一条，
        // 之后每 5 分钟最多记一次。
        const now = Date.now()
        if (!sessionAnchor.lastFailLog || now - sessionAnchor.lastFailLog > 300_000) {
          sessionAnchor.lastFailLog = now
          void clientDebug('anchor: status row not found (no visible tok/s text; throttled 5m)')
        }
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
        ? `${today.calls} ${t('callsUnit')} · token ${(tokensOf(today) / 1000).toFixed(1)}k · ${state.peak?.isPeak ? t('peakNow') : t('offPeakNow')}`
        : t('noCallsToday')
      const overBudget = state.budget && state.budget.usedPct >= 0.8
      return h('button', {
        type: 'button',
        className: 'dsh-cost-sidebar' + (overBudget ? ' warn' : ''),
        title,
        onClick: () => { void pollOnce() },
      },
      h('span', null, t('todaySidebar')),
      h('span', { className: 'dsh-cost-sidebar-value' }, moneyOf(state, today?.cost ?? 0)))
    }

    /* -- 回合边界感知（turnTail 槽位，隐形数据载体） -------------------- */

    const TURN_BUCKET_KEYS = { input: 'bucketInput', output: 'bucketOutput', cacheRead: 'bucketCacheRead', cacheWrite: 'bucketCacheWrite', reasoning: 'bucketReasoning' }
    const turnBucketName = (bucket) => t(TURN_BUCKET_KEYS[bucket] ?? bucket)

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
        const text = state.peak.nextIsPeak ? t('peakSoonPeak')(time) : t('peakSoonOff')(time)
        setMessage(text)
        setVisible(true)
        if (alerts.notify) {
          try { new Notification('dsh-cost 峰谷计价', { body: text }) } catch { /* 权限未授予则忽略 */ }
        }
      }, [state])
      if (!visible) return null
      return createPortal(h('div', { className: 'dsh-cost-alert' },
        h('span', null, message),
        h('button', { type: 'button', onClick: () => setVisible(false) }, t('gotIt'))), document.body)
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
      pop.textContent = t('loading')
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
          title.textContent = t('turnCostPop')
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
            label.textContent = `${String(row.model ?? '').replace(/^deepseek-/, '')} · ${turnBucketName(row.bucket)}`
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
            empty.textContent = t('turnEmpty')
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
        anchor.textContent = `${t('turnCost')} —`
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
              anchor.textContent = `${t('turnCost')} ${moneyOf(latestState, value.cost)}`
              anchor.title = t('turnCostTitle')
            } else if (anchor.isConnected) {
              anchor.textContent = `${t('turnCost')} —`
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
      const periodLabel = t(budget.period === 'day' ? 'budgetPeriodDay' : budget.period === 'month' ? 'budgetPeriodMonth' : 'budgetPeriodAll')
      return h('div', { className: 'dsh-cost-budget' },
        h('div', { className: 'dsh-cost-budget-head' },
          h('span', null, `${t('budget')} · ${periodLabel}`),
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

    /* -- 状态行费用 pill：累计费用，点开看每笔调用（含提示词增强） ------ */

    const SOURCE_KEYS = { chat: 'srcChat', enhance: 'srcEnhance', followup: 'srcFollowup' }
    const sourceLabel = (key) => t(SOURCE_KEYS[key] ?? key)
    let overviewPop = null

    function closeOverviewPop(event) {
      // 点 pill 本身不在这里关，交给按钮做 toggle；点弹卡内部也不关。
      if (event?.target instanceof Node) {
        if (event.target.closest?.('.dsh-cost-pill-anchor')) return
        if (overviewPop?.contains(event.target)) return
      }
      overviewPop?.remove()
      overviewPop = null
      document.removeEventListener('click', closeOverviewPop, true)
    }

    function renderOverview(data) {
      const state = latestState
      const box = document.createElement('div')

      const head = document.createElement('div')
      head.className = 'dsh-cost-pop-head'
      const title = document.createElement('span')
      title.textContent = t('sessionCost')
      const sum = document.createElement('span')
      sum.textContent = moneyOf(state, data.total?.cost ?? 0)
      head.append(title, sum)
      box.appendChild(head)

      // 官方余额（选配 apiKey）：打开弹卡后异步补一行；未配置/失败整行不占位。
      const balRow = document.createElement('div')
      balRow.className = 'dsh-cost-src'
      const balName = document.createElement('span')
      balName.className = 'name'
      balName.textContent = t('officialBalance')
      const balNum = document.createElement('span')
      balNum.className = 'num'
      balNum.textContent = '…'
      balRow.append(balName, balNum)
      box.appendChild(balRow)
      void fetch(`${ENDPOINT}/balance`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((bal) => {
          if (bal?.ok && bal.total !== '') balNum.textContent = `${bal.currency} ${bal.total}`
          else balRow.remove()
        })
        .catch(() => balRow.remove())

      const bySource = data.total?.bySource ?? {}
      const order = ['chat', 'enhance', 'followup']
      const keys = [
        ...order.filter((key) => bySource[key]),
        ...Object.keys(bySource).filter((key) => !order.includes(key)),
      ]
      for (const key of keys) {
        const entry = bySource[key]
        const row = document.createElement('div')
        row.className = 'dsh-cost-src'
        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = sourceLabel(key)
        const cnt = document.createElement('span')
        cnt.className = 'cnt'
        cnt.textContent = `${entry.calls}${t('callTimes')}`
        const num = document.createElement('span')
        num.className = 'num'
        num.textContent = moneyOf(state, entry.cost)
        row.append(name, cnt, num)
        box.appendChild(row)
      }

      const sep = document.createElement('div')
      sep.className = 'dsh-cost-pop-head'
      sep.style.marginTop = '8px'
      const sepTitle = document.createElement('span')
      sepTitle.textContent = t('recentCalls')
      sep.appendChild(sepTitle)
      box.appendChild(sep)

      for (const call of (data.calls ?? []).slice(0, 20)) {
        const row = document.createElement('div')
        row.className = 'dsh-cost-src'
        const time = document.createElement('span')
        time.className = 'cnt'
        time.textContent = new Date(call.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = sourceLabel(call.source) + ' · ' + (call.model || '—')
        const num = document.createElement('span')
        num.className = 'num'
        num.textContent = moneyOf(state, call.cost)
        row.append(time, name, num)
        box.appendChild(row)
      }
      return box
    }

    /** 弹卡只负责定位与渲染；数据由 pill 从 /session 拉好传进来。 */
    function openOverviewPop(anchor, data) {
      closeOverviewPop()
      if (!anchor) return
      const pop = document.createElement('div')
      pop.className = 'dsh-cost-pop'
      document.body.appendChild(pop)
      overviewPop = pop
      const rect = anchor.getBoundingClientRect()
      pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300)) + 'px'
      pop.style.top = rect.top - 8 + 'px'
      pop.style.transform = 'translateY(-100%)'
      document.addEventListener('click', closeOverviewPop, true)
      pop.appendChild(data ? renderOverview(data) : document.createTextNode('读取失败'))
    }

    /** 状态行 pill：显示「本对话」累计费用，点开看分组与每笔调用。 */
    function CostPill() {
      // useCostState 只用来在轮询到新账本时触发重渲染，值本身不用。
      const tick = useCostState()
      const anchorRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [session, setSession] = React.useState(null)

      React.useEffect(() => {
        // pill 挂载即接管状态行费用：把旧版本锚定插入的那一份清掉。
        for (const stale of document.querySelectorAll('.dsh-cost-statusrow')) stale.remove()
        // 弹卡被点外部关掉时，把按钮的展开态同步回来。
        const timer = window.setInterval(() => { setOpen(Boolean(overviewPop)) }, 200)
        return () => window.clearInterval(timer)
      }, [])

      React.useEffect(() => {
        if (!currentSessionId) { setSession(null); return undefined }
        let alive = true
        // 优先 /session（跨所有日期折当前会话）。服务端还没热更新时它 404，
        // 退回 /state 里的 sessions（近 7 天，同 id 可能按天拆成多条，累加）。
        const fallback = () => {
          const rows = (latestState?.sessions ?? []).filter((item) => item.id === currentSessionId)
          if (rows.length === 0) { setSession(null); return }
          const total = { cost: 0, calls: 0, bySource: {} }
          for (const row of rows) {
            total.cost += row.cost ?? 0
            total.calls += row.calls ?? 0
          }
          setSession({ session: currentSessionId, total, calls: [], fallback: true })
        }
        fetch(ENDPOINT + '/session?session=' + encodeURIComponent(currentSessionId), { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((value) => {
            if (!alive) return
            if (value && value.total) setSession(value)
            else fallback()
          })
          .catch(() => { if (alive) fallback() })
        return () => { alive = false }
      }, [tick, currentSessionId])

      const state = latestState
      const amount = session ? moneyOf(state, session.total?.cost ?? 0) : '—'
      // 不用图标：宿主的 dock 对 svg 没有约束，一旦样式没跟上就撑成方块。
      // 关键排版用内联兜底，不依赖外部 CSS 是否已注入。
      return h('span', {
        className: 'dsh-cost-pill-anchor',
        ref: anchorRef,
        style: { display: 'inline-flex', alignItems: 'center' },
      },
      h('button', {
        type: 'button',
        className: 'dsh-cost-pill',
        'aria-expanded': open ? 'true' : 'false',
        title: t('costDetail'),
        // 数值全部来自 dsh 的状态行规范：font-size 12px / line-height 20px /
        // 文字色 --dsw-alias-label-tertiary(暗色 rgb(173,178,184)) /
        // padding 1px 8px / 圆角 --dsw-radius-sm(8px)。不用 inherit，宿主那层
        // 拿到的字号和色号都不是 pill 该用的。
        style: {
          display: 'inline-flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: 'auto',
          height: 'auto',
          minWidth: 0,
          padding: '1px 8px',
          border: 'none',
          borderRadius: '8px',
          background: 'transparent',
          color: 'rgb(173, 178, 184)',
          fontSize: '12px',
          lineHeight: '20px',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
        },
        onClick: () => {
          if (overviewPop) { closeOverviewPop(); setOpen(false); return }
          setOpen(true)
          openOverviewPop(anchorRef.current, session)
        },
      }, amount))
    }

    /* -- 用量热力图（GitHub 贡献图样式：周列 × 星期行，官方品牌色色阶） -- */

    const HEAT_LEVEL_MIX = [0, 28, 52, 76, 100]
    const heatLevelColor = (level) => level > 0
      ? `color-mix(in srgb, var(--dsw-alias-brand-primary) ${HEAT_LEVEL_MIX[level]}%, transparent)`
      : ''

    function HeatmapCard() {
      useCostState() // 轮询触发重渲染，让热力图跟着账本更新
      const [data, setData] = React.useState(null)
      const [metric, setMetric] = React.useState(() => {
        try { return localStorage.getItem('dsh-cost-heat-metric') === 'calls' || localStorage.getItem('dsh-cost-heat-metric') === 'tokens' ? localStorage.getItem('dsh-cost-heat-metric') : 'cost' } catch { return 'cost' }
      })
      React.useEffect(() => {
        let alive = true
        let lastAt = 0
        const load = (force) => {
          const now = Date.now()
          if (!force && now - lastAt < 60_000) return
          lastAt = now
          fetch(`${ENDPOINT}/heatmap?days=182`, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((value) => { if (alive && value && Array.isArray(value.days)) setData(value) })
            .catch(() => {})
        }
        load(true)
        const timerId = setInterval(() => load(false), POLL_MS * 4)
        return () => { alive = false; clearInterval(timerId) }
      }, [])
      const pickMetric = (value) => {
        setMetric(value)
        try { localStorage.setItem('dsh-cost-heat-metric', value) } catch { /* ignore */ }
      }
      if (!data || !Array.isArray(data.days) || data.days.length === 0) {
        return h('div', { className: 'dsh-cost-heat' },
          h('div', { className: 'dsh-cost-heat-head' }, h('span', { className: 'dsh-cost-heat-title' }, t('heatTitle'))),
          h('div', { className: 'dsh-cost-empty' }, t('heatEmpty')))
      }
      const state = latestState
      const metricOf = (day) => (metric === 'calls' ? day.calls ?? 0 : metric === 'tokens' ? day.tokens ?? 0 : day.cost ?? 0)
      const metricText = (day) => metric === 'calls'
        ? `${day.calls ?? 0} ${t('callsUnit')}`
        : metric === 'tokens' ? `${(day.tokens ?? 0).toLocaleString()} tok` : moneyOf(state, day.cost ?? 0)
      const byDate = new Map(data.days.map((day) => [day.date, day]))
      // 182 天窗口对齐周一（0=周日 → getDay()==0 时前推 6 天）。
      const end = new Date()
      end.setHours(12, 0, 0, 0)
      const start = new Date(end.getTime() - 181 * 86400000)
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
      const columns = []
      let max = 0
      const cursor = new Date(start)
      while (cursor <= end) {
        const col = []
        for (let i = 0; i < 7 && cursor <= end; i += 1) {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
          const day = byDate.get(key) ?? { date: key, cost: 0, calls: 0, tokens: 0 }
          max = Math.max(max, metricOf(day))
          col.push(day)
          cursor.setDate(cursor.getDate() + 1)
        }
        columns.push(col)
        // 补齐当前周剩余（未来日期 → 空白占位，保持 7 行对齐）。
        while (col.length < 7) col.push(null)
      }
      const levelOf = (value) => {
        if (!(value > 0) || !(max > 0)) return 0
        const ratio = value / max
        return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1
      }
      const weekLabels = lang === 'zh' ? ['一', '三', '五'] : ['M', 'W', 'F']
      const months = columns.map((col, index) => {
        const first = col.find(Boolean)
        if (!first) return ''
        const month = Number(first.date.slice(5, 7))
        const prev = index > 0 ? columns[index - 1].find(Boolean) : null
        return prev && Number(prev.date.slice(5, 7)) === month ? '' : String(month)
      })
      return h('div', { className: 'dsh-cost-heat' },
        h('div', { className: 'dsh-cost-heat-head' },
          h('span', { className: 'dsh-cost-heat-title' }, t('heatTitle')),
          h('div', { className: 'dsh-cost-heat-toggle' },
            ['cost', 'calls', 'tokens'].map((value) => h('button', {
              type: 'button',
              key: value,
              'aria-pressed': metric === value ? 'true' : 'false',
              onClick: () => pickMetric(value),
            }, value === 'cost' ? t('heatCost') : value === 'calls' ? t('heatCalls') : t('heatTokens'))))),
        h('div', { className: 'dsh-cost-heat-months' },
          months.map((label, index) => h('span', { key: index }, label))),
        h('div', { style: { display: 'flex', gap: '4px' } },
          h('div', { className: 'dsh-cost-heat-weeks' },
            [0, 2, 4].map((row, idx) => h('span', {
              key: row,
              style: { display: 'block', height: '11px', lineHeight: '11px', marginTop: idx === 0 ? '0' : '17px' },
            }, weekLabels[idx]))),
          h('div', { className: 'dsh-cost-heat-grid' },
            columns.map((col, colIndex) => h('div', { className: 'dsh-cost-heat-col', key: col[0]?.date ?? colIndex },
              col.map((day, rowIndex) => {
                if (!day) return h('div', { className: 'dsh-cost-heat-cell blank', key: `blank-${rowIndex}` })
                const level = levelOf(metricOf(day))
                return h('div', {
                  className: 'dsh-cost-heat-cell',
                  key: day.date,
                  style: level > 0 ? { background: heatLevelColor(level) } : undefined,
                  title: `${day.date} · ${metricText(day)}`,
                })
              }))))),
        h('div', { className: 'dsh-cost-heat-legend' },
          t('heatLess'),
          HEAT_LEVEL_MIX.map((_, level) => h('div', {
            className: 'dsh-cost-heat-cell',
            key: level,
            style: level > 0 ? { background: heatLevelColor(level) } : undefined,
          })),
          t('heatMore')))
    }

    /* -- Coding Plan 配额面板（订阅额度适配器，Key 只存本机） ---------- */

    const CODING_PLAN_LIST = ['anthropic', 'zai', 'kimi', 'minimax', 'openrouter', 'siliconflow', 'commandcode', 'clinepass']
    const CODING_PLAN_LABEL_KEYS = {
      anthropic: 'planAnthropic', zai: 'planZai', minimax: 'planMinimax', kimi: 'planKimi',
      openrouter: 'planOpenrouter', siliconflow: 'planSiliconflow', commandcode: 'planCommandcode', clinepass: 'planClinepass',
    }
    const PLAN_WINDOW_KEYS = {
      fiveHour: 'winFiveHour', '5h': 'winFiveHour', weekly: 'winWeekly', '7d': 'winWeekly',
      monthly: 'winMonthly', month: 'winMonthly', balance: 'winBalance', credits: 'winCredits',
      plan: 'winPlan', compensation: 'winCompensation', current: 'winCurrent',
    }
    const planWindowName = (name) => t(PLAN_WINDOW_KEYS[name] ?? name)

    function CodingPlansCard() {
      const [open, setOpen] = React.useState(() => {
        try { return localStorage.getItem('dsh-cost-plans-open') === '1' } catch { return false }
      })
      const [providers, setProviders] = React.useState(null)
      const [drafts, setDrafts] = React.useState({})
      const [notes, setNotes] = React.useState({})
      const load = React.useCallback(() => {
        fetch(`${ENDPOINT}/coding-plans`, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((value) => { if (value && typeof value.providers === 'object') setProviders(value.providers) })
          .catch(() => {})
      }, [])
      React.useEffect(() => {
        if (!open) return undefined
        load()
        const timerId = setInterval(load, 60_000)
        return () => clearInterval(timerId)
      }, [open, load])
      const toggle = () => {
        const next = !open
        setOpen(next)
        try { localStorage.setItem('dsh-cost-plans-open', next ? '1' : '0') } catch { /* ignore */ }
      }
      const save = async (id) => {
        const key = String(drafts[id] ?? '').trim()
        if (!key) return
        try {
          await fetch(`${ENDPOINT}/coding-plans/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: id, key }),
          })
          setNotes((m) => ({ ...m, [id]: t('plansSaved') }))
          setDrafts((m) => ({ ...m, [id]: '' }))
          await fetch(`${ENDPOINT}/coding-plans/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: id }),
          })
        } catch { /* 下轮轮询兜底 */ }
        load()
      }
      const refreshAll = async () => {
        try {
          await fetch(`${ENDPOINT}/coding-plans/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        } catch { /* ignore */ }
        load()
      }
      const resetAtText = (iso) => {
        const ms = Date.parse(iso)
        return Number.isFinite(ms)
          ? ` · ${t('winResets')} ${new Date(ms).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
          : ''
      }
      return h('div', { className: 'dsh-cost-plans' },
        h('div', { className: 'dsh-cost-plans-head' },
          h('span', { className: 'dsh-cost-plans-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'dsh-cost-plans-title', onClick: toggle }, t('plansTitle')),
          open && providers != null
            ? h('button', { type: 'button', className: 'dsh-cost-plan-btn', onClick: () => { void refreshAll() } }, t('plansRefreshAll'))
            : null),
        open
          ? h('div', { className: 'dsh-cost-plans-hint' }, t('plansHint'))
          : null,
        open
          ? CODING_PLAN_LIST.map((id) => {
            const info = providers?.[id] ?? { hasKey: false }
            const windows = info.windows ?? null
            return h('div', { className: 'dsh-cost-plan', key: id },
              h('div', { className: 'dsh-cost-plan-row' },
                h('span', { className: 'dsh-cost-plan-name', title: t(CODING_PLAN_LABEL_KEYS[id]) }, t(CODING_PLAN_LABEL_KEYS[id])),
                h('input', {
                  className: 'dsh-cost-plan-input',
                  type: 'password',
                  autoComplete: 'off',
                  placeholder: info.hasKey ? `••••••（${t('plansConfigured')}）` : 'API Key',
                  value: drafts[id] ?? '',
                  onChange: (event) => setDrafts((m) => ({ ...m, [id]: event.target.value })),
                  onKeyDown: (event) => { if (event.key === 'Enter') void save(id) },
                }),
                h('button', {
                  type: 'button',
                  className: 'dsh-cost-plan-btn',
                  disabled: !String(drafts[id] ?? '').trim(),
                  onClick: () => { void save(id) },
                }, t('plansSave')),
                notes[id]
                  ? h('span', { className: 'dsh-cost-plan-btn', style: { background: 'transparent', cursor: 'default' } }, notes[id])
                  : null),
              !info.hasKey
                ? null
                : info.error
                  ? h('div', { className: 'dsh-cost-plan-err' }, `${t('plansError')}: ${info.error}`)
                  : windows && Object.keys(windows).length > 0
                    ? Object.entries(windows).map(([name, win]) => {
                      const bar = win.unlimited
                        ? null
                        : h('div', { className: 'dsh-cost-plan-bar' },
                          h('div', {
                            className: 'dsh-cost-plan-fill' + (Number(win.percent) >= 80 ? ' hot' : ''),
                            style: { width: `${Math.min(100, Math.max(0, Number(win.percent) || 0))}%` },
                          }))
                      const pct = win.unlimited
                        ? t('winUnlimited')
                        : `${(Number(win.percent) || 0).toFixed(1)}%${resetAtText(win.resetsAt)}`
                      return h('div', { className: 'dsh-cost-plan-win', key: name },
                        h('span', { className: 'dsh-cost-plan-winname', title: name }, planWindowName(name)),
                        bar ?? h('span', { className: 'dsh-cost-plan-winname', style: { flex: 1 } }, String(win.text ?? '')),
                        h('span', { className: 'dsh-cost-plan-pct' }, pct))
                    })
                    : h('div', { className: 'dsh-cost-plan-err' }, '…'))
          })
          : null)
    }

    function CostSection() {
      const state = useCostState()
      const forecast = useForecast()
      const budgetAmount = state?.budget?.amount
      const rate = state?.display?.rate ?? 7.2
      const overBudget = forecast && forecast.basis === 'recent'
        && Number.isFinite(budgetAmount) && budgetAmount > 0
        && forecast.projected * rate > budgetAmount
      const forecastCard = forecast && forecast.basis === 'recent'
        ? h('div', { className: 'dsh-cost-forecast', 'data-over': String(!!overBudget) },
          h('div', { className: 'dsh-cost-forecast-head' },
            h('span', { className: 'dsh-cost-card-title' }, t('monthForecast')),
            h('span', { className: 'dsh-cost-forecast-value' }, moneyOf(state, forecast.projected))),
          h('div', { className: 'dsh-cost-forecast-sub' },
            `${t('spent')}${moneyOf(state, forecast.monthCost)} · ${t('dailyAvg')}${moneyOf(state, forecast.avgDaily)} · ${t('daysLeft')(forecast.daysLeft)}${overBudget ? ` · ${t('overBudget')}` : ''}`))
        : forecast && forecast.basis === 'insufficient'
          ? h('div', { className: 'dsh-cost-forecast' },
            h('div', { className: 'dsh-cost-forecast-sub' },
              t('forecastNeedDays')(forecast.sampleDays ?? 0)))
          : null
      const cards = h('div', { className: 'dsh-cost-cards' },
        h(CostCard, { title: t('today'), row: state?.today, state }),
        h(CostCard, { title: t('thisMonth'), row: state?.month, state }),
        h(CostCard, { title: t('total'), row: state?.total, state }))
      const recent = Array.isArray(state?.recent) && state.recent.length > 0
        ? h('div', { className: 'dsh-cost-table' },
          state.recent.slice().reverse().map((day) => h('div', { className: 'dsh-cost-row', key: day.date },
            h('span', { className: 'dsh-cost-dim' }, day.date.slice(5)),
            h('span', { className: 'dsh-cost-grow' }, `${day.calls} ${t('callsUnit')}`),
            h('span', { className: 'dsh-cost-num' }, moneyOf(state, day.cost)))))
        : h('div', { className: 'dsh-cost-table' }, h('div', { className: 'dsh-cost-empty' }, t('noRecords')))
      const sessions = Array.isArray(state?.sessions) && state.sessions.length > 0
        ? h('div', { className: 'dsh-cost-table' },
          state.sessions.slice(0, 10).map((session) => h('div', { className: 'dsh-cost-row', key: `${session.date}-${session.id}` },
            h('span', { className: 'dsh-cost-dim' }, new Date(session.at || session.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
            h('span', { className: 'dsh-cost-grow' }, String(session.id).replace(/^session-/, '').slice(0, 8)),
            h('span', { className: 'dsh-cost-grow' }, `${session.calls}${t('callTimes')}`),
            h('span', { className: 'dsh-cost-num' }, moneyOf(state, session.cost)))))
        : null
      const footerBits = []
      if (state?.peak) {
        footerBits.push(h('span', { className: 'dsh-cost-badge', key: 'peak' }, state.peak.isPeak ? t('peakBadge') : t('offPeakBadge')))
      }
      if (Array.isArray(state?.unmatched) && state.unmatched.length > 0) {
        footerBits.push(h('span', { className: 'dsh-cost-badge', key: 'unmatched', title: state.unmatched.join(', ') }, `${state.unmatched.length} ${t('unmatchedModels')}`))
      }
      const downloadExport = (format) => {
        const link = document.createElement('a')
        link.href = `${ENDPOINT}/export?format=${format}`
        link.download = ''
        document.body.appendChild(link)
        link.click()
        link.remove()
      }
      footerBits.push(h('button', { className: 'dsh-cost-badge action', key: 'export-json', title: t('exportJsonTitle'), onClick: () => downloadExport('json') }, t('exportJson')))
      footerBits.push(h('button', { className: 'dsh-cost-badge action', key: 'export-csv', title: t('exportCsvTitle'), onClick: () => downloadExport('csv') }, t('exportCsv')))
      // 官方价格同步 + 汇率刷新（点击后按钮短暂显示结果，再自动复原）。
      const [syncNote, setSyncNote] = React.useState('')
      React.useEffect(() => {
        if (!syncNote) return
        const timerId = setTimeout(() => setSyncNote(''), 4000)
        return () => clearTimeout(timerId)
      }, [syncNote])
      const postSync = async (endpoint, okLabel) => {
        try {
          const res = await fetch(`${ENDPOINT}/${endpoint}`, { method: 'POST' })
          const data = await res.json().catch(() => null)
          if (res.ok && data?.ok) setSyncNote(okLabel)
          else setSyncNote(`${t('failed')}: ${data?.error ?? res.status}`)
          if (res.ok) void pollOnce()
        } catch (error) { setSyncNote(`${t('failed')}: ${String(error?.message ?? error).slice(0, 60)}`) }
      }
      footerBits.push(h('button', {
        className: 'dsh-cost-badge action',
        key: 'sync-prices',
        title: t('syncPricesTitle'),
        onClick: () => { void postSync('fetch-prices', t('priceSynced')) },
      }, t('syncPrices')))
      footerBits.push(h('button', {
        className: 'dsh-cost-badge action',
        key: 'sync-rate',
        title: t('refreshRateTitle'),
        onClick: () => { void postSync('fetch-rate', t('rateRefreshed')) },
      }, t('refreshRate')))
      // 界面语言：中文 / English 两枚徽标按钮，立即生效（宿主注册项刷新后生效）。
      const langButtons = [
        ['zh', '中文'],
        ['en', 'English'],
      ].map(([value, label]) => h('button', {
        className: 'dsh-cost-badge action',
        key: `lang-${value}`,
        'aria-pressed': lang === value ? 'true' : 'false',
        title: t('langHint'),
        style: lang === value ? { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 } : undefined,
        onClick: () => setLang(value),
      }, label))
      footerBits.push(h('span', { className: 'dsh-cost-badge', key: 'lang-group', style: { gap: '6px' } }, langButtons))
      if (syncNote) {
        footerBits.push(h('span', { className: 'dsh-cost-badge', key: 'sync-note' }, syncNote))
      }
      return h('div', { className: 'dsh-cost-section' },
        h(BudgetCard, { state }),
        cards,
        forecastCard,
        h(HeatmapCard, null),
        recent,
        sessions,
        h(RecentCalls, { state }),
        h(CodingPlansCard, null),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, footerBits))
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
        console.info('[dsh-cost] client 0.10.0 active')
        // 只当 sessionId 感知器（渲染 null），费用本体锚定在宿主状态行末尾。
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-cost-session',
          order: 90,
        }, SessionIdSensor))
        // 隐形回合边界载体：动作行「费用」按钮的弹卡按回合对齐靠它（0.6.1 起不再渲染可见费用行）。
        // 状态行费用 pill：order 2 排在 dsh 的 activity(0) / usage(1) 之后。
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cost',
          order: 2,
        }, CostPill))
        // order 5：dsh-followup 也注册了这个槽位且用 10，同序可能互相挤掉。
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'dsh-cost-turn',
          order: 5,
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
          label: t('sectionLabel'),
        }, CostSection))
      },
    }
  },
})
