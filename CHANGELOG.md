# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-10-25

### 新增：每轮对话尾部的回合费用（搬运 dsh-cost-meter TurnCost）

cost-meter 的做法：`conversation.chat.turnTail` 槽位（宿主给每个完成的回合
渲染一次，props 自带 `turn.start/.end` 宿主事件与 `sessionId`）+ 服务端按
回合范围聚合。搬 ours：

- **journal 行新增分桶计价 rows**（bucket/tokens/rate/cost，cost-meter
  `costFromSamples` 同形状）——入账时按档位单价算好，聚合不再反推。
- **服务端 `GET /api/dsh-cost/turn?session=&from=&to=`**：journal 按会话 +
  时间窗聚合出 `{found, cost, rows(按 provider×model×bucket 累加), calls}`。
- **客户端 `conversation.chat.turnTail` 槽位**（order 10，cost-meter 同位）：
  每个回合尾部一行小字「本轮费用 ≈ ¥0.05」，点击展开分桶明细（模型 · 桶 ·
  tokens · 金额）；回合未结束（turn.end 缺）不显示；journal 轮转掉的旧回合
  无记录时只显示标题。金额口径为 journal 估算（与侧栏/账本的入账制一致来源）。
- **需完整重启 dsh**（改了服务端端点）。

## [0.3.0] - 2026-10-25

### UI 重构：费用信息隐入官方布局（真机截图反馈）

- **本会话费用锚定进宿主会话指标行**：`5 轮 31 步 · 207 tok/s · … 缓存命中
  88%` 行末尾追加 `· ¥0.12`（ContextMeter 圆环按钮之前），官方 tabular-nums
  小字样式，零新增容器。compaction-control 0.1.7 同款自锚定：span 断线
  （宿主整行重建）由 MutationObserver 重挂；找不到特征行（「缓存命中」/
  「tok/s」文案）就不渲染，不在官方容器外悬空。
- sessionId 由隐形槽位感知器提供（input.dock 槽组件渲染 null 只拿标准
  props），切会话即时刷新金额。
- **侧栏今日费用重做**：细分隔线 + `今日 ……… ¥0.12` 左右对齐行（与侧栏
  条目同宽、label-secondary/primary、tabular-nums），hover 出调用数/token/
  峰谷明细，点击立即刷新，预算超阈金额变警告色。
- 移除旧的 input.dock 费用 chip 与侧栏居中小字样式。
- 纯客户端改动：Ctrl+R 刷新窗口即生效。

## [0.2.0] - 2026-10-25

### 正确性与数据完整性（对照 dsh-cost-meter 差距分析第一层）

- **用量指纹去重**（cost-meter issue #70/#76 同款兜底）：(model, 五桶指纹)
  10 秒窗互斥，ALS 标记逃逸的包装路由双份 usage 无论到达顺序只记一次；
  拒绝时 debug log 留 `dedup skip` 便于排查误杀。
- **调用明细 journal**：每次入账同步追加 `journal.jsonl`（at/day/session/
  model/provider/五桶/cost/peak），8 MiB 自动轮转保留最近 3 卷；写失败绝不
  影响聚合账本。新增 `GET /api/dsh-cost/calls?session=&day=&limit=` 倒序查询。
- **预算**：配置 `budgetEnabled/budgetAmount(CNY)/budgetPeriod(day|month|all)`；
  `/state` 下发 `budget{amount,used,usedPct}`；设置页预算卡（进度条，
  ≥80% warn 色、≥100% over 色），侧栏今日费用同步超阈变色。
- 设置页新增「最近调用」表（时间/模型/token/金额，2×轮询）。

## [0.1.0] - 2026-10-25

### 首个版本：借鉴 dsh-cost-meter 的最小可用费用统计

调研 [Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)
（v1.9.39，2.7 万行）后取其核心模式做 MVP 落地：

- 计量通道：`ctx.on('llm/stream', …, { global: true })` 瀑布监听（cost-meter
  主通路同款），链尾旁路逐 chunk 透传，捕获 usage 五桶入账；ALS 深度标记
  防包装路由嵌套重复入账。
- 价格：DeepSeek 官方现行档（Flash 谷 $0.003/$0.15/$0.60、Pro 谷
  $0.022/$0.66/$1.98，峰时 ×2）+ 峰谷窗口（UTC 01–04 / 06–10，北京周末与
  节假日全天谷）+ 历史档位（2026-09-10 Flash 调价、2026-08-16 峰谷时代前
  legacyBase、已下架旧模型历史价）；`customPrices` 可覆盖。
- 账本：`~/.dsh/storages/dsh-cost/ledger.json` 按日聚合（总/按模型/按会话），
  金额恒存美元，原子写盘 + 防抖，保留 180 天。
- 界面：输入区上方本会话费用 chip、侧栏今日费用、设置 → 费用分节
  （今日/本月/累计卡 + 近 7 天 + 会话列表 + 峰谷徽标）。
- 排障：`~/.dsh/cost-debug.log` 记 boot/首帧/入账采样（带 pid，用于判定
  新架构进程分裂下 llm/stream 的归属进程）。
