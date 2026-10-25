# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
