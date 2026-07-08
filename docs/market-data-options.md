# Market-data feed options — for the Markets tab (futures price, basis, weather)

Context: the free USDA/CFTC data covers most of the 8 signals ported from the co-work app.
Only three data types need a feed the co-work prototype faked with mock data: **futures price/curve**,
**cash basis**, and **weather**. This is the buy-guide for those. Pricing for the pro feeds is
**quote-based** (none publish rates) — figures below are industry ballparks; get a quote to confirm.

## The free stack lights up ~6 of 8 signals at $0

| Signal | Free source | Notes |
|---|---|---|
| Export Sales Pace | USDA FAS ESR | needs free `FAS_API_KEY` |
| Crop Progress | USDA NASS QuickStats | needs free `NASS_API_KEY` |
| Fund Positioning | CFTC Commitments of Traders | no key |
| Seasonal Pattern | computed | — |
| Cash Basis (regional) | **USDA AMS Market News API** | official regional cash grain bids/basis, free |
| S. American Weather | **Open-Meteo** | free global forecast+historical, no key |

Only **live CBOT futures price + curve** (and elevator-level basis) genuinely require a paid feed.

## Futures price & curve (CBOT: ZS soybeans, ZM meal, ZL oil)

| Service | Tier / access | Ballpark cost | Value |
|---|---|---|---|
| **Barchart OnDemand API** | Free eval + delayed; commercial real-time by entitlement | ~$100–$500+/mo (quote) | **Best ag API.** One vendor covers futures *and* cash grain bids (`getGrainBids`, `getUSDAGrainPrices`). REST/JSON — easy to wire into an adapter. Recommended if we only need data, not a terminal. |
| **DTN ProphetX** | Per-user terminal + web services | ~$100–$400/mo per user (quote) | **All-in-one ag analyst terminal** — futures + basis + the strongest ag **weather** in one subscription. Best if a human also wants to *watch* markets, not just pipe data. |
| **CME Group** (direct or via vendor) | Real-time exchange data | CBOT non-pro ~$85/mo/exchange + vendor fees | Authoritative real-time, but licensing overhead + cost; overkill unless you need pro real-time. |
| **Free/delayed** (Yahoo `ZS=F`, Barchart widgets, investing.com) | Scrape/unofficial | $0 | Delayed 10–15 min, unofficial, **not licensed for redistribution** — fine for a private glance, risky to build on or show members. |

## Cash bids & basis (Iowa elevators)

| Service | Cost | Value |
|---|---|---|
| **USDA AMS Market News API** | **Free** | Official **regional** cash grain prices + basis. Good enough for the Basis Trend signal at a regional level. Start here. |
| Barchart `getGrainBids` / `getUSDAGrainPrices` | Quote (part of Barchart) | **Elevator-level** bids within a ZIP radius — granular, but `getUSDAGrainPrices` is just USDA data you can get free. Pay only for the ZIP-level `getGrainBids`. |
| DTN | Quote (bundled) | Local/elevator basis inside the ProphetX bundle. |

**Member-facing "basis vs. CME at a glance":** basis = local cash bid − nearby CME futures.
- **Free / now:** USDA AMS Market News publishes Iowa *regional* cash prices and often the basis directly (so you don't even need your own CME feed for the regional view). Good for "here's your area's basis this week." Buildable as a free Markets adapter.
- **Elevator-specific:** **Barchart `getGrainBids`** returns bids for the ~30 elevators nearest a member's ZIP — the cleanest "your local elevator" data, and Barchart also carries CME futures, so **one Barchart subscription gives futures + local cash bids + computed basis in a single vendor.** That materially strengthens the Barchart case over DTN for this specific feature.
- **Free but fragile:** scrape specific co-op cash-bid pages (Landus, Heartland Co-op, NEW Cooperative, etc. — many run on Bushel/DTN widgets). Only worth it if members use a known short list of elevators.

## Weather (S. American crop stress)

| Service | Cost | Value |
|---|---|---|
| **Open-Meteo** | **Free** (non-commercial); ~€29/mo commercial | Global forecast + historical, no key. Build the SA-weather stress index on this — covers what the prototype wanted from Tomorrow.io, near-free. Recommended. |
| NOAA / NWS | Free | US-focused; weaker for South America. |
| Tomorrow.io (prototype's pick) | Freemium; paid ~$100s/mo | Polished API, but Open-Meteo covers our need for far less. |

## Bottom line / recommendation

1. **Build the free stack now** (USDA FAS/NASS/AMS + CFTC + Open-Meteo) → ~6 of 8 signals live at **$0**.
2. **When you want live futures price/curve:** **Barchart OnDemand API** is the best value — ag-native, one vendor for futures + cash bids, a free eval tier to prototype against. Budget a low-hundreds/month once commercial.
3. **If a human also wants a market terminal** (watch + data in one): **DTN ProphetX** — pricier per user but bundles futures + basis + weather.
4. Skip CME-direct and Tomorrow.io — more cost/overhead than we need.
