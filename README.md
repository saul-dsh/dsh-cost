# dsh-cost

dsh（DeepSeek Harness）会话费用统计插件：每次模型调用按 DeepSeek 官方价格实时入账（峰谷分档），账本按日 / 按模型 / 按会话聚合，提供本会话费用 chip、侧栏今日费用与设置页费用分节。

架构借鉴 [Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)（v1.9.39）：`ctx.on('llm/stream', …, { global: true })` 瀑布监听为唯一计量通道，逐 chunk 透传不改流协议；金额恒以美元存储、展示层换币；峰谷规则、历史档位与计费数学与其 lib/pricing.js 同口径。

## 功能

- **实时计量**：llm/stream 链尾旁路捕获 usage 五桶（输入 / 输出 / 缓存读 / 缓存写 / 推理），按官方价格计费；AsyncLocalStorage 深度标记防包装路由嵌套重复入账。
- **峰谷分档**：峰窗 UTC 01–04 / 06–10 点（北京 09–12 / 14–18），北京周六日与法定节假日全天谷价；历史流量按当时档位（2026-09-10 Flash 调价、2026-08-16 峰谷时代前均有历史价）。
- **账本**：`~/.dsh/storages/dsh-cost/ledger.json`，按日聚合（总量 / 按模型 / 按会话），临时文件原子重命名 + 防抖写盘，默认保留 180 天。
- **界面**：输入区上方本会话费用 chip（hover 明细、点击刷新）；侧栏底部今日费用；设置 → 费用：今日 / 本月 / 累计卡片、近 7 天、最近会话列表、峰谷状态与未匹配模型提示。
- **自定义单价**：设置里 `customPrices` 按 模型 id 覆盖（USD / 1M tokens）；未内置价格的第三方模型按默认档计费并在日志留痕。

## 安装

```powershell
dsh plugin --profile web add <本目录绝对路径>
# Desktop 用应用自带 CLI，装完完全退出并重启
```

装完必须完整重启 dsh。排障日志：`~/.dsh/cost-debug.log`（boot / 首个 llm/stream 帧 / 入账采样 / 未匹配模型）。

## 配置（Schema）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `exchangeRate` | `7.2` | 展示汇率（USD → CNY） |
| `customPrices` | `{}` | 自定义单价 `{ "模型id": { cacheHit, cacheMiss, output } }` |
| `retentionDays` | `180` | 账本保留天数 |

## 边界（v0.1.0）

- 不回填插件安装前的历史会话（cost-meter 有完整回填，后续版本考虑）。
- 不做 Coding Plan 额度 / 官方余额 / 汇率自动拉取；汇率为固定配置值。
- 未匹配模型按默认档（Flash 现行谷价）估算，可能与实际账单有差。

## License

MIT
