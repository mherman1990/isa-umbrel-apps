# Changelog

## 1.19.0 — Staff-focused refocus: sharper analysis, web-search Ask, Iowa plant map

The Bean Brief is now an internal staff analysis tool (a separate farmer-facing tool comes later, fed
through a compliance filter). Internal outputs are de-muzzled; `src/compliance.js` is **decoupled** —
kept intact as the future farmer-tool filter, no longer injected into any internal prompt.

### Added
- **Web search in the Ask box and the Analyst Note.** Both lean on the stored data first, then use
  Anthropic's server-side web search (`web_search_20260209`, bounded `pause_turn` loop) to fill gaps —
  latest prices, breaking news, a figure worth verifying — citing web sources distinctly. Kill-switch:
  `WEB_SEARCH=off` in `.env` falls back to stored-data-only.
- **Iowa crush & biodiesel plant map layer.** A toggleable overlay on the Map tab: soybean crush plants
  + biodiesel/renewable-diesel producers (EPA Part 80, "Renewable Fuel Producer" facilities). Two icons
  (crush circle / biodiesel square), both-sites ringed (AGP Sergeant Bluff, Cargill Iowa Falls).
  Iowa-only on the map; the full national crush list stays in `facilities.json`.

### Changed
- **Removed the Farmer update + Market Pulse reports.** The Market-education brief is re-aimed at
  non-expert ISA staff; the 🌱 trigger cards became internal **signal cards** (directional reads).
- **Ask box + reports de-muzzled** — direct, directional analysis instead of hedged briefings.
- **Markets trimmed to 10 charts** (feedstock demand, soy price, soy:corn ratio, crush, stocks-to-use,
  crop condition, drought, exports, barge freight, CFTC positions). The dropped series still feed the
  signals board + Ask/Analyst — only the charts are hidden.
- **Comment deadlines moved** off Home → the Laws, Rules & Decisions tab (below tracked items), with
  their own set-aside archive (`deadline_archived`); the `calendar.ics` link moved to Logs & Settings.

Code-only — the `deadline_archived` column auto-migrates on boot and the plant data ships in the image.
Just Update; no new keys or data steps.

## 1.18.3 — Home / News / Laws: readability & accessibility

### Fixed
- **News text no longer shows raw HTML entities.** RSS and email arrive entity-encoded (e.g. `&#8217;`,
  `&#8212;`, `&amp;`), and the display then re-escaped the `&`, so codes like "Reuters&#8217;s" showed
  verbatim. A `decodeEntities()` pass now runs **before** the HTML-escape on all News/feed text —
  decoded punctuation renders correctly, unknown entities are left untouched, and (because the escape
  still runs last) there's no XSS. Fixes already-stored items at render time.
- **News previews cut on a word boundary** instead of mid-word.
- **The Laws/Rules/Decisions table scrolls inside its own container on mobile** (`overflow-x`), so the
  page body no longer scrolls sideways (was ~8px over on a 375px viewport).
- **The 👍 / 👎 relevance buttons have accessible labels** ("Mark relevant" / "Mark not relevant") for
  screen readers, not just a hover title.
- **The homepage Ask box input** uses a responsive min-width so it can't overflow narrow phones.

Code-only — no new keys, dependencies, or data migration; live on Update.

## 1.18.2 — Markets: chart defaults, guardrail backstop, mobile & speed

### Fixed
- **Chart defaults match a farmer's question.** The Markets charts now default to the **last 12
  months** (was 6), and any chart whose window would show fewer than ~8 points **auto-widens to its
  full history** — so annual/quarterly series (e.g. Brazil production, quarterly stocks) no longer
  render as a lonely dot. A faint **normal-range band** (10th–90th percentile of the primary series)
  sits behind level charts as an at-a-glance "is this high or low?" reference.
- **Farmer-education cards can't ship advice.** The compliance scan on card output was log-only — it
  now **regenerates the cards once** if any advice-like phrasing is detected, and **withholds them
  entirely** if a second pass is still flagged (better no card than an advice card). The prior cards
  stay in place; the event is logged.
- **Mobile.** Charts reliably reflow to the viewport (a `ResizeObserver` plus an overflow guard), so a
  phone rotation or a narrowed window no longer leaves the page scrolling sideways. On a phone the
  signal board goes compact (two columns, detail hidden) and the range buttons get bigger tap targets.
- **Colour-vision safety.** The multi-line chart palette (up to 9 feedstock series) was reworked to an
  ISA-blue + Okabe-Ito set that stays distinct under the common colour-vision deficiencies.
- **Percentile labels** now use the correct ordinal ("92nd", not "92th").

### Changed
- **Responses are gzip-compressed.** The Markets page shipped ~240 KB of inline chart data uncompressed
  to every device; every text response (HTML/JS/CSS/JSON) is now gzipped when the client supports it —
  the Markets page drops to ~46 KB on the wire (~80% smaller). Binary assets pass through untouched.

Code-only — no new keys, dependencies, or data migration; live on Update.

## 1.18.1 — Studio: chart-honesty & export fixes; phase-2 removed

### Fixed
- **Axes carry units.** Both y-axes label their unit ($/bu, index, % YoY, …) instead of showing bare
  numbers, so a dual-axis chart is readable without hovering.
- **Multi-series comparisons made honest.** A chart mixing 3+ distinct units is now blocked with a
  steer to Rebase/YoY (three units can't be drawn truthfully on two axes — the old code silently piled
  the extras onto the second axis); any two-axis chart carries a "scales differ" warning; and the
  normal-range band draws on the *focused* series' own axis (it could previously paint against the
  wrong scale when the focus was the right-hand series).
- **PNG export includes the title, a colour legend (swatch · label · unit), and the compliance footer**
  instead of a bare, unlabeled chart.
- **Truthful defaults & transforms.** "Rebase to 100" indexes to the first *visible* point (not the
  first point ever), and the range auto-widens when a window would show fewer than 8 points, so annual
  series (e.g. Brazil production) no longer render as a 2–3 point stub at the 3-year default.
- **Seasonality reads at a glance** — the current year is emphasised over a 5-year average line with
  prior years faded — instead of equal-weight spaghetti.
- **Labeling & provenance.** Source attribution reads "USDA NASS" (was a raw "nass"); three catalog
  groups get real names (Biodiesel feedstocks, Brazil soy production, Brazil soy area); the footer
  shows "data through &lt;latest period&gt;" rather than today's date; and direction uses a neutral ▲/▼
  instead of green/red (up isn't "good" for a rising dollar or a worsening drought).
- **State coverage.** A failed data load shows a distinct error instead of the empty-picker state, and
  clustered report-date flags no longer overprint their labels.

### Changed
- **Phase-2 (LLM) features removed.** The natural-language prompt bar and the "Explain this chart"
  button are gone — Studio is a stored-data-only, staff-facing tool. (The "Explain" button had shipped
  wired to a route that never existed, so it failed on every click.)
- The Studio client is cache-busted per release (`/assets/studio.js?v=<version>`) so a Studio update
  reaches staff on Update instead of after the 24-hour asset cache expires.

Code-only — no new keys, dependencies, or data migration; live on Update.

## 1.18.0 — Map: drop SWCD, watersheds as a background layer

### Changed
- **Removed the Soil & Water Conservation District overlay.** Iowa's SWCDs are all-but-identical to
  county lines (which the map already draws), so the layer was redundant clutter — dropped from the
  map, its legend, the asset allowlist, and the boundary build script; `swcd.geojson` deleted.
- **HUC8 watersheds are now a passive background layer.** The overlay renders in a low, non-
  interactive pane beneath the districts, so hovering a district always shows its candidate card
  (never a watershed card).
- **The hover card lists the district's watersheds when the HUC8 overlay is on.** A district usually
  spans several HUC8s; toggling the overlay adds a "Watersheds (HUC8)" section (code + name) to each
  district's card, and removing it takes them away. The district→watershed overlap is precomputed
  from the vendored GeoJSON by `scripts/build-district-hucs.mjs` into `src/data/district-hucs.json`
  (avg ~3.5 HUC8s per House district, ~4.8 per Senate, ~21 per congressional district).

## 1.17.0 — Iowa Political Map

### Added
- **Iowa Political Map (`/map`)** — an interactive map of the registry's candidates and incumbents
  over Iowa's real district geography. A muted CARTO/OpenStreetMap basemap with always-on **county
  lines as the base**, and the chosen political boundary (100 Iowa House districts, 50 Iowa Senate
  districts, or 4 U.S. congressional districts) laid **translucently on top** so the county lines
  read through. Each district is shaded **red or blue by the party that currently holds the seat**;
  **hovering shows an info box** that names the district's **incumbent** and its 2026 **challenger(s)**,
  each labeled with party (a seat whose incumbent isn't on the 2026 ballot is marked *open*).
  Toggleable conservation overlays: the 100 Soil & Water Conservation Districts and 77 HUC8
  watersheds. Statewide races render in a side panel. The incumbent/challenger join merges the same
  registry the `/registry` page uses, the static 2026 candidate seed, and the current Iowa
  legislature roster (`src/data/ia-incumbents.json`, built by `scripts/fetch-incumbents.mjs` from
  OpenStates), with fallbacks so the map is populated even before `registry-refresh` runs.
  Boundaries are vendored GeoJSON (`src/assets/geo/`, built by `scripts/fetch-geo.mjs` from U.S.
  Census TIGER, Iowa REAP/IDALS and USGS WBD) and Leaflet is vendored (`src/assets/leaflet.*`) —
  no CDN, no build step, matching the uPlot pattern.

## 1.16.0 — Studio: a desktop chart-exploration workbench

### Added
- **Studio tab (desktop) — a chart workbench over the market timeseries.** A new tab for building
  and exporting charts from the data the app already collects, separate from the curated Markets
  view. Pick any of the ~35 market series from a grouped catalog and compare them on one chart
  (series with different units land on a second y-axis automatically); reshape with transforms —
  **rebase to 100**, **YoY %**, **ratio A ÷ B**, and a **seasonality** overlay (each year as its own
  line); shade a **historical normal-range band** (10th–90th percentile) behind the focused series;
  and drop **USDA/CME report dates and "what changed" alerts as flags on the x-axis** — the
  cross-stream read a price terminal doesn't do for beans. A side panel shows the focused series'
  trend stats (latest, Δ prior, YoY, percentile, seasonal, range) from the same `marketSnapshot` the
  Ask box uses. Export a **PNG** (with the education footer stamped on) for slides/Teams, the **CSV**,
  or a **shareable link** that reproduces the exact view (the spec is encoded in the URL). Desktop-only
  (the Markets tab still works everywhere); a natural-language prompt bar and an "Explain this chart"
  read are stubbed in the UI for a later phase. Self-contained new files (`src/studio.js`,
  `src/assets/studio.js`) + `/api/studio/*` routes; renders with the already-vendored uPlot. Code-only
  — no new keys, dependencies, or data migration; live on Update.

## 1.15.0 — Iowa 2026 candidates in the registry; paid-endpoint & summary cleanup

### Added
- **Iowa 2026 general-election candidates in the registry** — 244 entities distilled from the Iowa
  Secretary of State candidate database: the challengers and statewide candidates the OpenStates
  "current officeholders" seed doesn't include (e.g. the Secretary of Agriculture race, Naig vs
  Jones). A shipped data file (`src/data/ia-candidates-2026.json`) + a keyless seeder
  (`registry-seed ia_candidates`, also run by `registry-refresh`). Monitoring core only — name /
  party / office / district / level / incumbency; personal contact data intentionally excluded.
  166 Iowa House, 66 Iowa Senate (incl. 25 holdovers), 12 statewide across 6 offices.

### Fixed
- **Duplicate paid Claude calls** (reviewer finding). The Ask box ran a Sonnet call on every
  `GET /?q=…` render, so a refresh, an extra tab, or a shared `?q=` link re-paid on each load. It
  now caches each query's result briefly (15 min) and shares a single in-flight call for concurrent
  identical queries. `/items/summary` gained a per-item in-flight guard so concurrent requests for
  the same uncached item share one generation instead of both paying.
- **`item_summaries` expiry contradiction** (reviewer finding). `saveSummary` wrote an `expires_at`
  that `getSummary` always ignored — summaries are permanent by design (re-opening never re-pays).
  Removed the dead plumbing: dropped `expires_at` from the schema (with a guarded `DROP COLUMN`
  migration for existing databases), from the read/write paths, the API response and its client
  rendering, and deleted the now-unused `summaryExpiry()`.

## 1.14.0 — News tidy-up, marketer-focused signal board, review fixes

### Changed
- **News tab.** The 🧵 Storylines panel now defaults collapsed and moves off the homepage to the
  News tab, under the daily digest. "What's flowing in" is now a real inbox — the 20 most-recent
  items, with the rest under a collapsed "Older mail (N)", and every item expands to read its stored
  body inline (emails have no external link, so the body *is* the message; RSS items also get an
  "Open original" link). The collector now stores a larger email body slice (1000→4000 chars) so the
  inline read shows the real content, not a stub.
- **Signal board trimmed to a grain-marketer's read.** Soy-Oil Biofuel Share and the U.S. Dollar are
  pulled off the farmer-facing board — they're structural / macro-policy reads, not signals a marketer
  leads with. Their series still show on the Markets charts and still reach the Analyst/Pulse memos via
  the market-data block, so nothing is lost. Added a **Soy:Corn Ratio** card (the acreage-battle read;
  directional only in the Dec–Apr planting-decision window, context otherwise). Board goes 11→10 cards.

### Fixed
- **/run feedback** (reviewer finding). A run that fast-fails — e.g. a memo with no `ANTHROPIC_API_KEY`
  — no longer flashes "run started" over the failure: the handler waits a short grace window and
  redirects silently so only the red failure banner shows; a "run already in progress" bounce shows its
  own notice; a genuinely long run still gets the optimistic "run started". A prior failure's red banner
  is now cleared when a new run *starts*, not only on success.
- **Scheduler robustness** (reviewer finding). A hand-edited bad `briefEditions.timezone` (an invalid
  IANA zone throws `RangeError`) or a non-string `weekly` now degrades to a logged, skipped tick instead
  of an unhandled rejection that crash-looped the container (the `setInterval` tick also gets a `.catch`
  backstop). And a scheduled edition that bounces because a manual run is in flight now stays eligible
  for a later tick instead of being marked done and silently dropped.

## 1.13.0 — performance hardening

Under-the-hood speed and scalability work. No change to features, outputs, or how the app is used;
a full refresh dropped from ~35s to ~7s in local testing. No data migration or new keys required.

### Changed
- **Open-Meteo climatology is cached.** The weather engine used to re-download the full ~20-year
  ERA5 archive for all 8 soybean regions, serially, on every run — the single heaviest part of a
  refresh — just to percentile-rank the last 30 days. It now caches each region's daily history
  (re-fetched only when missing or >30 days old) and pulls only a small recent window each run,
  computing the exact same percentiles without the multi-decade download. Self-heals; the output
  series are unchanged.
- **Independent sources are fetched concurrently.** Collection (`collectAll`) and the market-series
  refresh (`refreshMarketSeries`) now run their per-source loops through a small bounded pool
  instead of one source at a time, so the network phase is the slowest source rather than the sum.
  Per-source fail-soft is preserved (one source's failure never stops the run), and Open-Meteo's
  internal per-region calls stay serial.
- **`marketSnapshot()` is memoized.** The deep market-trend snapshot — used by the signal board,
  alerts, market cards, memos, the Ask box, and every Markets render (several times per operation) —
  is now computed once and reused until the series data changes (invalidated on write) instead of
  recomputing each call.
- **The Ask box's fallback search is one scan.** When a whole-phrase search finds nothing, the
  per-word fallback now OR-combines the distinct words in a single query instead of one table scan
  per word.

### Added
- **Indexes on `seen_items`** (`first_seen_at`; `source_id`+`first_seen_at`; `triage_verdict`) so
  the item feeds, source stats, audit, and activity charts use an index rather than a full table
  scan as the archive grows. Additive and applied automatically on start.

## 1.12.0 — WASDE stocks-to-use, storylines, figure drill-down, source-value ledger

### Added
- **USDA WASDE balance sheet is live.** The soybean cell-extraction is finished (the report is
  SSRS-matrix XML — soybeans are the acreage / $-per-bushel matrix in the combined "Soybeans and
  Products" table, distinguished from meal and oil positionally). Adds a **U.S. soybean
  stocks-to-use** scorer to the Markets signal board — level-based, so it reads from a single
  release (below ~8% tight/supportive, above ~15% ample/bearish) — plus two charts (U.S. ending
  stocks in mln bu, stocks-to-use %). World ending stocks (MMT) ride in the WASDE item summary.
- **Storylines** — the monitor now auto-clusters recent items into the handful of ongoing named
  threads the news is really about (45Z, renewable diesel, China trade, EUDR…), each with a "what
  changed & why it matters" summary and a dated timeline that links out to sources. A 🧵 panel on
  the homepage, a Refresh button, and a `storylines` CLI command; threads persist and accumulate
  across runs.
- **Figure drill-down** — when an answer, brief, or education card names a market series ("U.S.
  soybean crush", "stocks-to-use"…), that name now links straight to its chart on the Markets tab.

### Changed
- **The Sources page is now a value ledger, framed by class.** Official (AI-triaged) sources show
  their relevance pass-rate; News and Markets sources — which aren't triaged — show "coverage feed"
  instead of a misleading 0% that made them look like noise. Fetched counts show last-7-days and
  all-time.

### Fixed
- **Token-budget reliability on Sonnet 5.** Sonnet 5 runs adaptive thinking by default, and thinking
  counts against a call's token budget — on tight budgets it could consume the whole allowance and
  return truncated or empty output. Thinking is now disabled where it adds nothing (storylines, item
  summaries), and the Ask box, Market Pulse, Market-education brief, and farmer cards were given
  token headroom.

## 1.11.0 — Crop-weather engine; WASDE & Barchart groundwork

### Added
- **Crop-weather engine** — an anomaly-vs-normal weather layer that reasons weather → supply →
  price. The Open-Meteo adapter now computes recent 30-day precipitation and heat as **percentiles
  against ~20 years of ERA5 history** for the U.S. soybean belt and the South American crop
  (production-weighted; free, no key — no PRISM needed). A new `weather.js` engine turns those into
  **phenology-weighted signal-board scorers** — stress in a yield-sensitive window (e.g. U.S.
  pod-fill) supports price; a benign crop weighs on it, and off-season regions drop off the board —
  plus a weather read injected into the Analyst Note, Market Pulse, and Ask box. Two new Markets
  charts (U.S. and S. America weather anomaly).

### Groundwork (ships disabled; ready to switch on)
- **USDA WASDE balance sheet** adapter — the machine-readable feed (`esmis.nal.usda.gov`), the
  release backfill, and the adapter are in place; the soybean cell-extraction (soybeans vs. meal/oil
  in the combined U.S. table) needs finishing, so it ships **disabled**. Adds U.S. stocks-to-use +
  world stocks + a stocks-to-use signal once enabled.
- **Barchart** adapter — futures / forward-curve / local-basis scaffold. No-ops without
  `BARCHART_API_KEY`; a config-flip and one live test once the key lands.

### Changed
- The market-series refresh now skips **disabled** sources — no wasted fetches.

## 1.10.0 — One daily brief, market education on the Markets tab, smarter report models

### Changed
- **The twice-daily AM/PM policy briefs are now a single "Run policy brief now"** on the homepage,
  and a quiet scan no longer saves a blank "no news" brief. The twice-daily run still refreshes
  Markets, News, alerts, and education cards on schedule — it just stays silent on days with no
  policy movement instead of cluttering Saved briefs. Each report button now carries a one-line
  description of what it does.
- **Farmer market-education cards moved from the homepage to the Markets tab** (renamed "For
  farmers: what to watch"), sitting alongside the market data they interpret. The homepage now leads
  with the Ask box and the reports.

### Models
- **The Analyst Note now runs on Claude Opus 4.8 with adaptive thinking** — the deep, forward-looking
  report gets the strongest reasoning model for its "around the corner" analysis. Override with
  `ANALYST_MODEL` in `.env`.
- **The base model moves to Claude Sonnet 5** (`BRIEF_MODEL`) — a better model at the same price for
  the daily brief, the weekly/monthly/farmer/education memos, Market Pulse, the education cards, and
  the Ask box.

## 1.9.0 — Signals, four reports, the trigger card engine, macro data & more

### Added
- **Marketing trigger card engine** — evaluates seasonal, positioning, and report-timing triggers
  and writes farmer **market-education cards** ("what's happening / what history shows / review your
  plan") on the homepage. Strictly education, never advice — a hard banned-phrasing filter, the
  standard footer, and the RP-HPO framing are built in.
- **FRED macro** — U.S. broad dollar index + 10-year Treasury yield, with a dollar signal (a strong
  dollar caps export competitiveness). **Brazil production trend** (IBGE PAM, the multi-decade rise).
- **Deeper News digest** — now reads email bodies and fetches the linked article's text, distilling
  from real content, not just headlines.
- **Set-aside archive** for the Laws/Rules/Decisions feed (recoverable), an **optional note** on 👎
  that teaches the AI triage, and the **Settings panel moved onto the Logs page**.
- The report calendar now uses the authoritative 2026 USDA dates with impact levels.

### Also in this release (from the 1.8.0 work)
- **Market signals board**, **Analyst Note** + **Market Pulse** reports, **interactive chart date
  ranges** (6-month default), **release-calendar awareness**, a **"what changed" alert feed**, a
  **freshness monitor**, and corn price + the soybean:corn ratio + CFTC positioning series.

## 1.7.0 — Trend-aware answers · market-education brief · more market data

### Added
- **Deeper trend retrieval** — the Ask box and memos now see each market series over its *full*
  history: year-over-year, the historical range with the latest value's percentile, and a seasonal
  read (vs. the same month across years). So it can answer "is this seasonally normal / how does it
  compare to years past," not just report the latest number.
- **Market-education brief** (🎓 on the homepage / `memo education`) — a plain-language, strictly
  nonpartisan "teach, don't tell" daily brief for farmers: what moved and *why*, a rotating teaching
  concept, and what to watch — grounded only in the data, with every figure cited by source + date.
  Backed by a new **curriculum + glossary** knowledge base (`seed-curriculum`).
- **New market data (Markets tab):**
  - **U.S. Drought Monitor** — Iowa area in drought (D1+) and abnormally dry+ (D0+), weekly.
  - **Corn price** (Iowa vs. U.S.) and the **soybean:corn price ratio** — the relative-value / acreage read.
  - **Brazil soybean production + area** (IBGE) — the competitor-supply signal (queryable).
- **More ag-news feeds** on the News tab: farmdoc daily, Farm Policy News, No-Till Farmer, Feedstuffs.

### Changed
- Ten interactive charts on the Markets tab now, each with hover value + date and a CSV download.

## 1.6.0 — Master query engine · on-demand memos · interactive charts · more market data

### Added
- **Ask across everything** — the homepage "Ask the Bean Brief" box now retrieves across all
  streams in one call: Laws/Rules/Decisions + News items, the **market timeseries** (price,
  crush, stocks, feedstock share, basis, fund positioning, exports, barge freight, weather),
  tracked items, comment deadlines, and recent briefs — so answers can connect a policy or
  trade development to the market numbers, with citations.
- **On-demand memos (memo mode)** — the same engine, scoped to a window and told to write a
  report: **Weekly memo**, **Monthly review**, and a plain-language, strictly nonpartisan
  **Farmer update**. Buttons on the homepage; `memo <weekly|monthly|farmer>` on the CLI.
- **Interactive Markets charts** — charts are now rendered with uPlot: **hover to read the
  exact value + date**, with real axes and gridlines. Seven charts, each with a CSV download.
- **New market data (Markets tab):**
  - **Soybean export inspections** + **net export sales** (USDA Ag Transport / Socrata) — a
    live stand-in for the FAS Export Sales report while its API is offline.
  - **Mississippi barge freight** ($/ton) — a driver of the Gulf export basis.
  - **U.S. soybean crop condition** (% good/excellent, Iowa vs. U.S.) — the in-season signal.
  - **U.S. Corn Belt weather** — a domestic crop-stress read alongside South America.

### Changed
- The **twice-daily farmer twin is retired** — the farmer update is now the on-demand `farmer`
  memo preset (generated when asked, over a chosen window), so scheduled runs never pay for it.
- The weekly memo now spans markets + news + items, not just the week's briefs.

## 1.5.0 — Markets dashboard (charts + CSV) · homepage search · more sources

### Added
- **Markets charts** — a timeseries layer feeds inline charts on the Markets tab, each with a **CSV download**:
  - **Biofuel feedstock market share** — every lipid feedstock in U.S. biodiesel + renewable diesel (soybean
    oil vs. corn oil, canola, used cooking oil, tallow, animal fats…), so you can watch soy's share vs. the competition.
  - **Soybean price received** (Iowa vs. U.S.), **U.S. crush**, **U.S. ending stocks**.
  - `market-refresh` CLI; series refresh automatically on each run.
- **USDA AMS basis** on the Markets tab (Iowa cash soybean price + basis).
- **More sources** in the registry — ag-news RSS (CFTC, USDA, EPA, Farm Progress, Agri-Pulse, ASA, RFA,
  Growth Energy, Clean Fuels, Iowa Soybean) and LCFS/Iowa agencies (CARB, Oregon DEQ, WA Ecology,
  NM Environment, Iowa DNR).

### Changed
- **Search moved to the homepage** ("Ask the Bean Brief") — the separate Search page is gone; ask questions
  right from Home. Answers still draw on stored items + briefs.

## 1.4.1 — LRD rename · in-place triage · AMS basis · RSS feeds

### Added
- **AMS basis adapter** (`usda_ams`) — Iowa state-average soybean cash price + **basis** on the Markets tab
  (your "basis vs. the board at a glance"). Free key `USDA_AMS_API_KEY`.
- **Ag-news RSS feeds** wired into the News pipeline: CFTC, USDA, EPA, Farm Progress, Agri-Pulse, ASA, RFA,
  Growth Energy, Clean Fuels, Iowa Soybean.

### Changed
- **Items → "Laws, Rules & Decisions."**
- **👍/👎 and 📌 track update in place** (AJAX) — the list no longer jumps to the top, so you can scroll
  and triage continuously.
- **AI summaries are permanent** — re-opening a panel returns the stored summary (no new AI call), and the
  🧠 icon shows **✓ stored** once one exists (doubles as a "reviewed" marker). Survives version updates.
- **All timestamps render in Central time.**

## 1.4.0 — Markets tab + demand pipeline · News/Items split

Big feature release. The portal is now organized into four tabs by *information class*,
and a new demand-side data pipeline feeds a Markets tab.

### Added
- **Four-tab portal.** A per-source class (official / news / markets) routes each item:
  - **Items** — regulatory/legal only (Federal Register, bills, dockets, court, admin rules): the clean flow.
  - **News** — collector newsletters + legislator press (kept out of the policy brief).
  - **Markets** — demand-side data (below).
- **Markets / demand pipeline — 4 new free sources:** `usda_nass` (Iowa price, US production/stocks),
  `eia` (soybean-oil → biodiesel/renewable-diesel feedstock + diesel price), `cftc` (managed-money
  fund positioning), `open_meteo` (S. American soybean-region weather stress).
- **News-source registry** — farmdoc, Punchbowl, POLITICO, RFA, Growth Energy, Brownfield,
  Agri-Pulse, Carney Appleby, Torrey — with a narrow/broad boost split so broad publishers
  surface on relevance rather than automatically.
- `scripts/subscribe.mjs inbox` — see what's landing in the collector, by tag.

### Changed
- **News + Markets items never enter the policy brief** — partitioned by class right after
  collection, so a market item that matches a policy keyword ("soybean oil → biodiesel") no
  longer leaks into the brief.

### Keys (all free; add to `/data/.env`)
- `NASS_API_KEY`, `EIA_API_KEY` light up NASS/EIA now; `USDA_AMS_API_KEY` (basis) and `FAS_API_KEY`
  (export sales) enable those when added. CFTC + Open-Meteo need none.

## 1.3.1 — packaging fix

- **Fix:** include `registry.json` (and `scripts/`) in the Docker image — they were
  missing from the Dockerfile `COPY`, so on the Pi the registry seed file never reached
  `/data` and the registry synced empty. No code changes.

## 1.3.0 — v2 foundation (Entity Registry · entity collection · two-render brief)

Additive extension of the v1 pipeline — the existing collect → score → triage →
brief → deliver flow is unchanged, and every new source/render is gated so the
running app is never broken. See `docs/V2.md` for architecture and go-live steps.

### Added
- **Entity Registry** — `entity`/`channel` tables (`src/store.js`), `src/registry.js`,
  and a hand-seeded `registry.json` (IA federal delegation, statewide execs, state +
  county parties). Deterministic attribution by plus-tag / domain / handle / external id.
- **Geo resolution** — `src/geo.js` resolves an address or venue to county + legislative
  districts via the free U.S. Census Geocoder (memoized in `geo_cache`).
- **Entity-driven collection** — `collect.js` hands registry channels to adapters:
  - `rss` — entity press/news feeds (RSS 2.0 + Atom).
  - `email_intake` — reads a dedicated collector inbox over IMAP and attributes each
    message to an entity. Disabled until a Gmail App Password is set.
- **Registry seeders** — `registry-seed openstates|fec|socrata` and `registry-refresh`.
  OpenStates (state legislators) and FEC (federal candidates) are live; Socrata/IECDB
  is compliance-gated (Iowa Code § 68B.32A(7)).
- **Two-render brief** — an optional farmer-facing, strictly nonpartisan render
  (`output.farmerBrief`), sent to `FARMER_BRIEF_TO` or saved/web like any brief.
- **Registry web page** (`/registry`) with channel-health monitoring; new CLI commands
  `registry-sync` / `registry-seed` / `registry-refresh` / `registry-health`.
- **Collector tooling** — `docs/collector-gmail.md` runbook + `scripts/subscribe.mjs`
  (subscribe worksheet + double-opt-in confirmation-link clicker).

### Changed
- Scoring boosts registry-sourced items; triage records `entityId` / `type` / `geo`.
- `seen_items` gains `entity_id` / `item_type` / `geo` columns (auto-migrated).

### Dependencies
- Added `imapflow` and `mailparser` (email-intake; lazy-loaded so they never affect
  the rest of the app until email-intake runs).

## 1.2.0
Rebrand to "The Bean Brief"; ISA theme + logo; Focus Area watchlist engine; per-item
AI summaries; split Sources/Watchlist pages; email delivery.
