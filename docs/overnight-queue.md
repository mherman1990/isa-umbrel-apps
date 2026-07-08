# Overnight autonomous build queue — 2026-07-06 night

A self-driving build queue. A scheduled loop wakes, does the **next `[ ]` item end to end**,
verifies it, commits, logs, and reschedules — no human in the loop. Morning: Matt reviews the
unpushed commits on `main` and works the **Punch-list** below. Tonight's anchor build (deep
trend retrieval) is already done + committed (`0200cfd`).

## Operating rules for the loop (READ EVERY WAKE)
1. **Scope = keyless / already-keyed local builds only.** The NASS key is present in `.env`;
   Drought/CME/IBGE/RSS need no key. Anything needing a NEW key → leave for the Punch-list.
2. **Never push. Never deploy. Never tag.** All work stays as **unpushed commits on `main`**.
3. **Never `git checkout` / `reset` / `stash` / `rm` tracked files, never `git add -A`.** The
   working copy is **shared with another chat** — stage ONLY the exact files the item created
   (listed per item). Their untracked `*-signups.md` / `_confirm_all.mjs` must never be staged.
4. **Verify before commit:** `node --check` every file, then a live adapter test (fetchItems +
   fetchSeries) proving real data. If a source is unreachable/blocked after **2 attempts**, mark
   the item `[!]` blocked, note why in the log + Punch-list, and MOVE ON (don't loop on it).
5. **Each new market adapter:** file in `src/adapters/`, register in `adapters/index.js`
   (import + map + `SOURCE_CLASS: "markets"`), add a `watchlist.json` `sources` entry
   (`enabled:true`), and — if it has `fetchSeries` — a `chartSection(...)` on the Markets tab.
   Mirror the `cftc.js` / `agtransport.js` patterns. Then `node src/index.js market-refresh`.
6. **Log every item** to `docs/overnight-log.md` (append: item, result, files, test evidence,
   any follow-up). Update this file's checkbox. Then commit both with the item's files.
7. **Reschedule** with ScheduleWakeup (~240s) after each item while `[ ]` items remain and the
   iteration budget (≤ 14 wakes) isn't spent. When none remain, write a final summary to the log
   and **do not reschedule** — the loop ends.
8. If the same failure repeats or something looks destructive/ambiguous, **stop and leave it for
   Matt** rather than force it. Safety over completion.

## Queue (priority order)

- [x] **Q1 — U.S. Drought Monitor adapter** (`src/adapters/drought_monitor.js`, keyless).
  Endpoint `https://usdmdataservices.unl.edu/api/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent?aoi=IA&startdate=2015-01-01&enddate=<today>&statisticsType=1` → JSON weekly rows with `d0..d4`, `none`, `validStart`. Series: Iowa **% area in drought (D1–D4)** and **% D0–D4** (any dryness), weekly; category `drought`. `fetchItems` = current Iowa drought %; `fetchSeries` = history. Also pull national/Corn-Belt if easy. Add a `drought` chart. Files: adapter, `adapters/index.js`, `watchlist.json`, `server.js` (chart).
- [x] **Q2 — NASS corn price + soy:corn ratio** (extend `src/adapters/usda_nass.js`, key present).
  Add U.S. + Iowa **corn price received** series (mirror the soy price queries, `commodity_desc:CORN`), category `corn_price`; then a **computed** `soy:corn price ratio` series (Iowa soy price ÷ Iowa corn price by shared period), category `soy_corn_ratio`. Charts for each. The ratio is a classic acreage/relative-value read farmers watch. Files: `usda_nass.js`, `server.js` (2 charts).
- [x] **Q3 — Curriculum + glossary store scaffold** (education engine, no API).
  Add SQLite tables `concepts` (id,title,body,domain,season_window,last_used) + `glossary`
  (term,definition) in `store.js`, with `listConcepts/pickConcept(seasonAware)/upsertConcept`,
  `getGlossary/upsertGlossaryTerm`. Seed a starter set from `docs/beanbrief_education_engine.md`
  (§3 curriculum table + glossary_available). CLI `node src/index.js seed-curriculum`. Verify:
  tables created, seed inserts, pickConcept returns a season-appropriate LRU concept. Files:
  `store.js`, `src/index.js`, maybe `src/curriculum.js` (seed data).
- [x] **Q4 — Ag-news RSS additions** (extend `registry.json`, keyless).
  Add reliable ag RSS to the News tab: Brownfield (`brownfieldagnews.com/feed/`), AgWeb, DTN
  Progressive Farmer, Successful Farming — as `feed`-kind channels on news entities (mirror the
  existing feed-* entities). Verify each URL returns items via the rss adapter fetch; drop any
  that 403/404 (note in log). Files: `registry.json`.
- [x] **Q5 — Brazil IBGE SIDRA adapter** (`src/adapters/ibge_brazil.js`, keyless).
  IBGE SIDRA REST (`https://servicodados.ibge.gov.br/api/v3/agregados/...` LSPA soybean
  production/area). Series: Brazil soybean **production (t)** + **area (ha)**, category
  `brazil_soy`; `fetchItems` = latest. Confirm the exact aggregate/variable IDs live (LSPA =
  aggregate 6588 or similar) — if the query shape resists after 2 tries, `[!]` + Punch-list.
  Files: adapter, `adapters/index.js`, `watchlist.json`, `server.js` (chart).
- [x] **Q6 — Education brief mode (Mode A)** (extend `src/pipeline.js`, no new API).
  Add a `MEMO_PRESETS.education` preset OR a `generateEducationBrief()` that loads the §1
  "teach, don't tell" system prompt (from `docs/beanbrief_education_engine.md`) + the deep market
  snapshot + a curriculum concept (Q3) and writes the §3 daily-brief structure. Nonpartisan,
  no-advice guardrail. Homepage button + CLI `memo education`. Verify a real run reads clean +
  teaches. Files: `pipeline.js`, `server.js`, `index.js`. (Depends on Q3.)
- [!] **Q7 — CME daily settlements adapter** — BLOCKED. CME's CmeWS endpoint returns HTTP 403
  "This IP address is blocked due to suspected web scraping" (Akamai, IP-level) for both soybeans
  (320) and corn (300), regardless of headers/UA. Not solvable from this dev machine's IP. See Punch-list.
  Try `https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements/<id>/FUT` (soybeans id
  ~`320`, corn ~`300`) for daily settle/OI/volume. If Akamai-blocked/403 after 2 tries → `[!]`
  and Punch-list ("CME settlements need a vendor or the FTP bulletin; revisit"). If it works:
  ZS + ZC front-month settle series, category `futures`, chart. Files: adapter + wiring.
- [!] **Q8 — WASDE balance-sheet series** — DEFERRED. Cornell ESMIS migrated to esmis.nal.usda.gov
  (Drupal); the old machine-readable `.json` API path now 404s, so the WASDE data-file URLs aren't
  reachable in a 2-probe window, and WASDE Excel/XML parsing is heavy regardless. See Punch-list.
  Machine-readable WASDE on Cornell ESMIS (usda.library.cornell.edu / `oce` XML or Excel). Pull
  U.S. soybean **ending stocks** + **stocks-to-use** monthly. If the XML/Excel path resists after
  2 tries → `[!]` + Punch-list (it's the highest-parse-effort item; fine to defer). Files: adapter
  + wiring.

## Punch-list for Matt (morning — needs a human)
- **Register free API keys** (then I build/test the adapters that need them):
  - **FRED** — https://fredaccount.stlouisfed.org/apikeys → `FRED_API_KEY` in `/data/.env` + local `.env`. (Macro overlay: broad dollar `DTWEXBGS`, 10y `DGS10`, PPI. High value, Easy.)
  - **FAS Open Data** — retry the key at https://apps.fas.usda.gov/opendata (the ESR endpoint was 500ing; PSD Online global S&D may work independently). Existing `FAS_API_KEY` may already be valid — test.
  - **AGTRANSPORT_APP_TOKEN** (optional) — only if we hit Socrata rate limits.
  - **Trading Economics** (optional macro) — freemium key.
- **Pi /data updates for this batch** (persisted files don't auto-update from the image):
  - `registry.json` → pull the new one to `/data` (Q4 added 4 ag-news feeds: farmdoc daily, Farm
    Policy News, No-Till Farmer, Feedstuffs).
  - `watchlist.json` → merge the new market sources (`agtransport`, `drought_monitor`) — enabled.
  - Run `node src/index.js seed-curriculum` (Q3) and `market-refresh` (populates drought/corn/ratio
    + any other new series) inside the container.
- **Verify + deploy:** review the night's unpushed commits (`git log origin/main..main`), then
  ship a **v1.7.0** release (bump `package.json` + store manifest → tag → GHCR → Umbrel Update).
  New adapters need their `watchlist.json` source **merged into the Pi's `/data/watchlist.json`**
  (same `docker exec node -e` pattern as agtransport) + `market-refresh`.
- **Eyeball the new charts** on the Markets tab and the education brief for tone/quality.
- **Decide** on any `[!]` blocked items (CME/WASDE) — whether to invest the extra parsing.
- **`[!]` Q7 CME futures settlements — needs a human decision.** CME's public CmeWS JSON is Akamai
  IP-blocked from the dev PC (403 "IP blocked"). Options, best first: (a) **retry the adapter from the
  Pi** (different residential IP — the "defer to the Pi" pattern; the endpoint is
  `cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements/320/FUT` for soybeans, 300 for corn, with a
  browser UA); (b) **Barchart OnDemand API** (the recommended paid backbone — futures + cash bids in
  one, ag-native) — the durable answer for real-time-ish ZS/ZC; (c) CME FTP settlement files if still
  open. Futures price is the one piece the education data contract still lacks; agtransport/NASS/EIA
  cover the rest for free.
- **`[!]` Q8 WASDE (ending stocks + stocks-to-use) — deferred, needs a parser build.** ESMIS moved
  to `esmis.nal.usda.gov` (Drupal 11) and dropped the old Samvera `.json` API. Retry paths: (a) the
  **USDA OCE** direct machine-readable WASDE at usda.gov/oce/commodity/wasde (there's an XML/Excel data
  file alongside the PDF — find the current URL); (b) navigate the new ESMIS Drupal site for the WASDE
  publication's Excel/XML download; then build a parser for the U.S. soybean ending-stocks +
  stocks-to-use lines and trigger off the WASDE release calendar. Highest-effort item; safe to leave.
- **(Optional) Brazil production trend chart:** Q5 (IBGE) shipped as queryable series/items but with
  only ~2 crop-year points (LSPA 1618). For a real multi-year Brazil soybean production trend chart,
  add PAM aggregate **1612** (final annual production, long history) as a second IBGE series — one
  more adapter query once someone confirms 1612's product-classification id.
