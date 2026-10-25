# dsh-cost

Session cost tracking plugin for the DeepSeek Harness (dsh): every model call is billed in real time at official DeepSeek rates (peak/off-peak aware); the ledger aggregates per day / per model / per session; UI includes a per-session cost chip, today's cost in the sidebar and a Cost section in settings.

Architecture borrows from [Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) (v1.9.39): the `ctx.on('llm/stream', …, { global: true })` waterfall listener is the sole metering channel, passing chunks through untouched; amounts are always stored in USD with display-layer conversion; peak/off-peak rules, historical tiers and billing math follow its lib/pricing.js.

## Features

- **Real-time metering**: tail listener on the llm/stream waterfall captures the five usage buckets (input / output / cache-read / cache-write / reasoning); AsyncLocalStorage depth marker prevents double-billing through wrapper-router plugins.
- **Peak/off-peak tiers**: peak windows UTC 01–04 and 06–10 (Beijing 09–12 / 14–18); all-day off-peak on Beijing weekends and public holidays; historical traffic billed at the tier of its time (Flash repricing of 2026-09-10 and the pre-peak-era base before 2026-08-16 included).
- **Ledger**: `~/.dsh/storages/dsh-cost/ledger.json`, aggregated per day (totals / per model / per session), atomic temp-file rename + debounced writes, 180-day retention by default.
- **UI**: per-session cost chip above the composer (hover detail, click to refresh); today's cost at the sidebar bottom; Settings → Cost with today / month / total cards, last 7 days, recent sessions, peak status and unmatched-model notice.
- **Custom prices**: override any model id via the `customPrices` setting (USD / 1M tokens); unknown third-party models fall back to the default tier and are logged once.

## Install

```powershell
dsh plugin --profile web add <absolute path to this directory>
# Desktop: use the app's own CLI; fully quit and restart afterwards
```

A full restart of dsh is required. Debug log: `~/.dsh/cost-debug.log` (boot / first llm/stream frame / sampled accounting / unmatched models).

## Configuration (Schema)

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | master switch |
| `exchangeRate` | `7.2` | display rate (USD → CNY) |
| `customPrices` | `{}` | per-model overrides `{ "model-id": { cacheHit, cacheMiss, output } }` |
| `retentionDays` | `180` | ledger retention |

## Boundaries (v0.1.0)

- No backfill of conversations from before the plugin was installed.
- No coding-plan quotas / official balance / automatic exchange rates; the rate is a fixed setting.
- Unmatched models are estimated at the default tier and may differ from the actual bill.

## License

MIT
