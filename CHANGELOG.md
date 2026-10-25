# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.8.0] - 2026-10-25

### 新增

- **状态行费用 pill**：挂在 `conversation.composer.dock`，`id: cost`、`order: 2`，排在 dsh 自带的 `activity`(0) 和 `usage`(1) 之后，样式完全对齐原生 pill（padding 1/8、`--dsw-radius-sm`、12px、tabular-nums、悬停淡底）。
- **费用按来源分账**：`account()` 增加 `source` 字段，journal 落盘时带上，`day.bySource` 累计。弹卡分三组显示：对话 / 提示词增强 / 跟进建议。
- **`/calls` 增强**：在原 `journal.recent()` 明细之外，额外返回全量 `total`（含 `bySource` 汇总），供弹卡头部展示。

### 跨插件约定

- 其它插件在发起自己的 `llm.stream` 前写 `globalThis.__dshPluginCall = { source, at }`，本插件按 5 秒窗口读回并清除。已接入：`dsh-prompt-enhancer`（`enhance`）、`dsh-followup`（`followup`）；没有标记的调用一律算 `chat`。

## [0.7.0] - 2026-10-25

### 重构：跨进程单写者账本（双进程同 boot 实锤后的正确性修复）

真机 debug log 证实插件服务端在**两个进程**同时 boot、各听各的 llm/stream、
各自持有内存账本整文件覆写 ledger.json——互相踩踏只是时间问题。重构为
cost-meter 同思路的单写者模型：

- **journal 成为唯一事实源**：llm/stream 监听器只做指纹去重 + 计价 +
  append journal（O_APPEND 单行写跨进程安全，两个进程都写）。
- **跨进程锁**（`storages/dsh-cost/ledger.lock`，O_EXCL + 持有者 pid +
  30s 心跳，持有者死亡/心跳超时可抢占）：只有锁持有者加载并写 ledger.json。
- **持有者 5s 周期 ingest**：按字节偏移增量读 journal 折叠进账本（偏移随
  ledger 同一事务落盘 → 崩溃不重不漏；轮转后从头读新卷天然不重放），
  折叠时 (session|model|五桶指纹) 10s 窗去重——同一事件被两进程捕获、
  回填与实时重叠，均互斥。单测验证多字节字符偏移不错位。
- **回填改写 journal**（不再直接入账）：与实时同源，由 ingest 统一折叠；
  游标改按会话 id（与实时同键空间），ingest 推进游标带 60s 余量盖住
  「日志完成时刻晚于流发起时刻」的偏差，杜绝重启后回放重放。
- **/state、/export 改读盘**：持有者先 ingest+flush 再读；非持有者直读
  文件——无论 UI 连到哪个进程，数据一致（最大滞后 ~6s）。
- boot 行新增 `ledgerOwner=` 字段，真机可直接判定两进程的锁归属。

## [0.6.2] - 2026-10-25

### 修复：费用弹卡透明穿帮（反代官方完整弹卡样式）

弹卡此前只抄了 `--dsw-specific-menu` 底色——官方菜单底是**半透明色**
（暗色 #43454a73），必须搭配 `--dsw-menu-backdrop-filter: blur(40px)
saturate(150%)` 的毛玻璃才是官方观感，缺了就整个透出下层文字。

- 从已装 app.asar 提取官方弹卡（ContextMeter `A6Bq1a_panel` / 统计
  `xXe6ja_panel`）的完整编译规则，整理为
  **`packages/dsh-cost/official-popover.template.css`** 模板（token 字面
  值 + 组件组装规则 + 使用注意），后续一切弹卡 UI 以它为准。
- `.dsh-cost-pop` 改用官方规则原样：specific-menu 底 + menu-backdrop-
  filter 毛玻璃 + radius-lg + elevation-prominent（stroke l1）+
  label-secondary 文字，宽度 min(300px, 100vw-24px)。

## [0.6.1] - 2026-10-25

### 移除：回合尾部的可见费用行

按用户要求去掉每轮回复尾部的「▶ 本轮费用 ≈ ¥x」折叠行（0.4.0 引入）。
turnTail 槽位组件退化为**隐形数据载体**：每回合渲染一个 display:none 的
节点，仅保留宿主给的回合时间边界（dataset），供动作行「费用」按钮
（官方用量按钮旁）把弹卡对到正确的回合——回合费用的查看入口统一收敛到
该按钮的弹卡。顺带清理 turn-row 相关样式。

## [0.6.0] - 2026-10-25

### 新增：官方「用量」按钮旁的回合费用按钮 + 明细弹卡

官方的「用量 6.8M tok」按钮（回复动作行，token-meter 的
deriveTurnTokenUsage）只显示 token 不显示钱——在它旁边加同款「费用 ¥x」：

- **锚定**：扫描动作行里官方「用量」按钮（文本以「用量」开头且含 tok、
  可见），在它前面插兄弟位置的费用按钮（React 不管兄弟， MutationObserver
  400ms 节流重锚）；回合边界从同回合的 turnTail details（data-turn-from/to）
  读回——向上爬限深 6 级，找不到就显示「费用 —」，宁缺毋错。
- **弹卡**：点击按官方弹卡基准（--dsw-specific-menu 底、--dsw-radius-lg、
  --dsw-elevation-prominent、向上展开防窗口底部裁剪）渲染本轮费用 + 分桶
  明细（模型 · 桶 · tokens · 金额），数据走 /turn 端点；点击外部关闭。
- 按钮样式仿官方动作行规格（12px tertiary、hover 淡底、tabular-nums）。

## [0.5.0] - 2026-10-25

### 历史回填 + 峰谷提醒 + 导出（cost-meter 批量搬运第二批）

- **历史回填**（cost-meter backfill 同思路）：boot 后 3s 扫描
  `~/.dsh/sessions/<工作区>/<会话>/session[.vN].jsonl[.zstd]`，多帧 zstd
  解压后重放用量事件（`request/header` 切路由；`assistant/chunk` 的 usage
  块、`assistant/message` 的 data.usage、`compaction/summary` 三类来源；
  「回合位置 + 五桶指纹」去重——同一步的 chunk 与 message 双份只记一次），
  按事件时刻走历史档位计价入账。**游标幂等**：ledger.imported 按会话记录
  已覆盖时刻，实时记账同步推进，回填只补游标之后的事件，永不重复入账。
  回填只进聚合账本不写 journal；64MB 以上日志跳过；配置 `backfillEnabled`
  可关。
- **峰谷切换提醒**（cost-meter peak-alert 简化版）：配置
  `peakAlertEnabled` / `peakAlertLeadMinutes`(1-30，默认 2) /
  `peakAlertNotify`；`/state` 下发下一次切换时刻（48h 逐分钟扫描，周末与
  节假日边界自然覆盖，单测验证工作日/跨周末两例）；进入提前量窗口时顶部
  居中弹卡（portal 到 body 防祖先链裁剪），可同时发系统通知；每个切换点
  只提醒一次。
- **导出**：设置 → 费用新增「导出 JSON」（全量日/模型/会话聚合）与
  「导出 CSV」（日汇总），`GET /api/dsh-cost/export` 下载。
- `/state.peak` 新增 `nextSwitchAtMs` / `nextIsPeak` 与 `alerts` 配置下发。

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
