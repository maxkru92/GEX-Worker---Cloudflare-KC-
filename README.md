<img width="1024" height="559" alt="image" src="https://github.com/user-attachments/assets/62e5b70a-a671-44bb-ad08-f248fb1f0000" />


# GEX Worker — Cloudflare Worker

Gamma Exposure (GEX) computation engine deployed as Cloudflare Worker.
Fetches CBOE options chains, calculates GEX levels in real-time.

## Architecture

```
Cron (every 15 min)
    │
    ▼
┌──────────────────┐
│  GEX Worker      │
│  (Cloudflare)    │
│                  │
│  1. CBOE Spot    │──→ cboe.com/education/tools/trade-optimizer/symbol-info/
│  2. CBOE Chain   │──→ cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json
│  3. Compute GEX  │──→ Gamma × OI × Spot² / 100
│  4. Write to KV  │──→ Cloudflare KV Namespace
│  5. Alert if Δ   │──→ regime change detection
└──────────────────┘
    │
    ▼
┌──────────────────┐
│  KV Namespace    │
│  gex:SPX:latest  │
│  gex:SPX:previous│
│  gex:VIX:latest  │
│  gex:alerts      │
└──────────────────┘
    │
    ▼
┌──────────────────┐
│  HF Space        │
│  Volatility Vince│──→ Telegram @volatilityvincebot
│  /gex command    │
└──────────────────┘
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Worker status + version |
| GET | `/latest?symbol=SPX` | Latest GEX data |
| GET | `/previous?symbol=SPX` | Previous run |
| GET | `/compare?symbol=SPX` | Regime change detection |
| GET | `/symbols` | All configured symbols |
| GET | `/alerts` | Last 20 regime alerts |
| POST | `/trigger?symbol=SPX` | Manual trigger |
| POST | `/webhook` | TradingView Alert bridge |
| POST | `/subscribe` | Telegram subscription |
| POST | `/unsubscribe` | Remove subscription |

## Response Format

```json
{
  "timestamp": "2026-06-03T20:00:00.000Z",
  "symbol": "SPX",
  "spot": 7553.68,
  "spotSource": "cboe",
  "iv30": 13.16,
  "regime": "NEGATIVE_GAMMA",
  "netGex": -290600000,
  "netGexFormatted": "-290.6M",
  "callWall": {"strike": 7555, "gex": "19.9M"},
  "putSupport": {"strike": 7555, "gex": "187.3M"},
  "hvl": 7555,
  "chainSource": "cboe",
  "strikeCount": 249,
  "frontExpiry": "2026-06-03",
  "dte": 0
}
```

## GEX Formula

**Standard (institutional):** `GEX = Gamma × OI × Spot² / 100`

- Gamma: per $1 move (from CBOE or BSM approximation)
- OI: Open Interest
- Spot: Underlying price
- Result: Dollar exposure per 1% move

**Gamma approximation (when CBOE gamma=0):**
```javascript
function bsmGamma(S, K, sigma, T) {
  const d1 = (Math.log(S/K) + 0.5*sigma*sigma*T) / (sigma*Math.sqrt(T));
  return Math.exp(-0.5*d1*d1) / (Math.sqrt(2*Math*S*sigma*Math.sqrt(T));
}
```

## Data Sources (Priority Order)

1. **CBOE** — Primary for SPX, VIX, NDX, RUT (delayed 15min, no rate limit)
2. **Yahoo Finance** — Fallback for spot prices
3. **BSM Synthetic** — Last resort chain generation

## Deployment

```bash
# Requires: CLOUDFLARE_API_TOKEN env var
cd ~/Documents/gex-worker
npx wrangler deploy
```

## Configuration

`wrangler.toml`:
- KV Namespace: `GEX_KV` (id: `bb9f6786bd5242bc8c89ac3c676916f3`)
- Symbols: `SPX,VIX` (configurable via `SYMBOLS` env var)
- Cron: `*/15 * * * *`

## Files

```
gex-worker/
  wrangler.toml          -- Config + KV binding
  package.json           -- type: module, wrangler
  src/index.js           -- Main: Cron + HTTP endpoints (all phases inlined)
  pinescript/
    GEX_Levels_Regime.pine  -- TradingView PineScript indicator
  test-gex.mjs           -- Unit tests
```

**Krupp Capital Quantitative Desk** | Precision in Chaos, Alpha in Variance.

---

### ⚠️ Disclaimer
Dient ausschließlich der Unterhaltung und Bildung. Keine Anlageberatung.


