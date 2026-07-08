# Overnight build log — 2026-07-06 night

Append-only. Each entry: item · result · files · test evidence · follow-up.
The loop reads `docs/overnight-queue.md` for the next `[ ]` item and its rules.

---

**23:1x — Session start (anchor + setup).** Deep trend retrieval done + committed `0200cfd`
(marketSnapshot now computes YoY / range+percentile / seasonal over full history; verified via a
real "is crush seasonally normal" query — model taught 100th-pctile-for-May, +4.6% YoY, 92nd
pctile of 113 obs). Memories saved (Pi hardware, education engine, source registry). Queue +
this log written. Loop armed. Next: Q1 (Drought Monitor).

<!-- loop appends below this line -->

**Wake 1 — Q1 U.S. Drought Monitor — ✅ DONE.** Keyless adapter `src/adapters/drought_monitor.js`
(USDM data services, percent-area endpoint; needed `aoi=19` FIPS + M/D/YYYY dates, rows newest-first,
d0..d4 cumulative). Two Iowa series: `drought_monitor:ia:d1` (% in drought, D1+) and `:ia:d0` (% dry+,
D0+), category `drought`. Wired: adapters/index.js (import+map+SOURCE_CLASS markets), watchlist.json
(enabled), server.js (drought chart). **Test:** fetchItems → "Iowa drought — 12% in drought (D1+), 33%
abnormally dry+ (week of 2026-06-30)"; fetchSeries → 2×601 weekly pts (2014-12-30→2026-06-30, d1=12.15
d0=33.34); market-refresh → 20 series; Markets page renders chart_drought (8 charts total), both series
in the blob, 0 server errors. Files committed: drought_monitor.js, adapters/index.js, watchlist.json,
server.js, + queue/log. Next: Q2 (NASS corn price + soy:corn ratio).

**Wake 2 — Q2 NASS corn price + soy:corn ratio — ✅ DONE.** Extended `usda_nass.js` fetchSeries:
added U.S. + Iowa **corn price received** (`nass:us:corn-price`, `nass:ia:corn-price`, category
`corn_price`) mirroring the soy price queries; added a **computed** `nass:ia:soy-corn-ratio`
(Iowa soy ÷ corn by shared month, category `soy_corn_ratio`, no extra API call). Two new charts
in server.js. **Test:** corn IA $4.45 / US $4.48 (2026-05, 113 pts each); ratio 2.56 (2026-05,
113 pts — above the ~2.5 beans/corn pivot); market-refresh → 23 series; Markets page = **10 chart
boxes**, corn_price + soy_corn_ratio present, 0 errors. Files: usda_nass.js, server.js, + queue/log.
**GOTCHA for future wakes:** the background verify server can linger and hold its port (MSYS `kill`
doesn't always reap node.exe) → a stale server serves OLD code and the check looks like a fail. FIX
used: kill by port via `netstat -ano | grep LISTENING | grep :PORT` → `taskkill //F //PID`, then
verify on a FRESH port (8488). NEVER blanket-kill node (would hit the other chat's 8485). Next: Q3
(curriculum + glossary store scaffold — no API).

**Wake 3 — Q3 curriculum + glossary store — ✅ DONE.** Education-engine scaffold, no API. Added
`concepts` + `glossary` SQLite tables in store.js with `upsertConcept` (preserves last_used on
re-seed), `listConcepts`, **`pickConcept(month)`** (season-aware least-recently-used rotation for
the daily teaching thread), `getGlossary`/`getTerm`/`upsertGlossaryTerm`. New `src/curriculum.js`
= 10 starter concepts (~130-word plain, "teach don't tell" bodies: basis, stocks-to-use, balance
sheet, WASDE, board-vs-cash, managed money, crush, condition ratings, Brazil, soy:corn ratio) +
15 glossary terms, each with a `season_window`. CLI `seed-curriculum`. **Test:** seeded 10+15;
`pickConcept(7)` (July) returned two DIFFERENT July-eligible concepts on successive calls (wasde-101
→ futures-vs-cash) confirming season-aware LRU. Files: store.js, curriculum.js, index.js, + queue/log.
**PUNCH-LIST:** run `node src/index.js seed-curriculum` on the Pi (and locally) — Q6's education
brief mode depends on it; polibrief.db is gitignored so the seed doesn't ship in the image. Next:
Q4 (ag-news RSS additions).

**Wake 4 — Q4 ag-news RSS additions — ✅ DONE.** Probed 8 candidate feeds with the adapter's UA.
**Kept 4** (200 + real items, non-dupe): **farmdoc daily** (illinois.edu/feed — Matt high-signal),
**Farm Policy News**, **No-Till Farmer**, **Feedstuffs**. **Dropped:** AgWeb (403), Successful
Farming/agriculture.com (403), DTN Progressive Farmer (404) — commercial bot-block/retired RSS, as
the roadmap predicted; Brownfield already in registry (dupe, skipped). Added 4 `news_source` feed
entities to `registry.json` (registry.json was git-clean → safe to edit + commit only my diff).
**Test:** JSON valid (14 feed entities); registry-sync → 44 entities/80 channels (+4); rss adapter
`parseFeed` live: Feedstuffs 50 items, Farm Policy News 10 items ("USDA releases June 2026 Acreage
Report") — one farmdoc call hit a transient undici connect-timeout but retried fine (https.get probe
had 200; the feed is good). Files: registry.json + queue/log. Punch-list updated (pull new
registry.json → Pi /data). Next: Q5 (Brazil IBGE SIDRA adapter).

**Wake 5 — Q5 Brazil IBGE SIDRA — ✅ DONE (scoped).** Keyless `src/adapters/ibge_brazil.js`. API
mechanics resolved in 3 probes: direct guess 500'd → pulled aggregate **1618** metadata (var **35**
Produção/t, **216** Área colhida/ha; Produto Soja = class **48[39443]**; the time axis is crop year,
class **49**) → corrected query 200. Series `ibge_brazil:soy-production` (brazil_soy) + `:soy-area`
(brazil_soy_area). **Test:** item "Brazil soybean production (2026 crop): 174.6M metric tons"; series
production 2025=166.1M / 2026=174.6M t (record), area 2025=47.7M / 2026=48.3M ha; market-refresh → 25
series. **SCOPING CALL:** LSPA 1618 only exposes ~2 crop years, so I shipped it as **queryable series +
items (no chart)** per "charts are secondary" rather than a thin 2-point chart — the Ask box/education
engine now has Brazil's competitor crop size + YoY. A real multi-year Brazil production trend chart
needs PAM aggregate 1612 (added to Punch-list). Files: ibge_brazil.js, adapters/index.js, watchlist.json,
+ queue/log. Next: Q6 (education brief mode — depends on Q3 curriculum).

**Wake 6 — Q6 education brief mode (Mode A) — ✅ DONE.** The BeanBrief "teach, don't tell" daily
market-education brief, as a memo preset. Added `EDUCATION_SYSTEM_PROMPT` (§1 identity + 6 hard
guardrails) to curriculum.js; `MEMO_PRESETS.education` (scopeDays 3, injectCurriculum) with the §3
daily-brief structure; generateMemo now injects a season-aware `pickConcept()` + glossary block
(auto-seeds the bank if empty). Wired: server.js SAFE_BRIEF_NAME + triggerRun + /run allow-list +
homepage 🎓 button + label; CLI `memo education` works via the generic runMemo. **Test:** `memo
education` produced a genuinely strong brief — pulled from TONIGHT'S new adapters (drought 12.15% D1+
+47%/wk; agtransport export inspections 93rd pctile vs new sales 9th pctile using the deep trend
stats; crop condition), each cited with source+date; taught the "managed money/COT" concept AND
correctly REFUSED to invent a COT number it didn't have ("the data provided here does not include
the current COT positioning") = guardrail #2 holding; no advice, nonpartisan, Today's-Terms from the
glossary. Homepage button present, /brief/…education.md renders, 0 errors. Files: pipeline.js,
curriculum.js, server.js, + queue/log. Next: Q7 (CME settlements — flaky, keyless).

**Wake 7 — Q7 CME settlements — 🚫 BLOCKED [!].** CME's public CmeWS JSON endpoint
(`cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements/{320|300}/FUT`) returns HTTP 403
"This IP address is blocked due to suspected web scraping activity" — Akamai IP-level block for both
soybeans (320) and corn (300), independent of UA/headers. A 2nd attempt from the same IP is futile
(the block is on the IP, not the request). Marked `[!]`; Punch-list has the retry path (from the Pi's
IP, or Barchart OnDemand for the durable futures feed). No code committed for Q7 (nothing built).
Proceeding to Q8 (WASDE) in the same wake.

**Wake 7 (cont.) — Q8 WASDE — 🚫 DEFERRED [!].** Cornell ESMIS migrated to `esmis.nal.usda.gov`
(Drupal 11); the old Samvera/Hyrax `.json` API (`/concern/publications/3t945q76s.json`) now 301s to
the new host and then 404s — the machine-readable file URLs aren't reachable via a quick probe. WASDE
Excel/XML parsing is heavy regardless. Marked `[!]`; Punch-list has retry paths (USDA OCE direct
XML/Excel, or the new ESMIS Drupal download) + note that it needs a dedicated parser. No code committed.

---

## 🌙 OVERNIGHT RUN COMPLETE — final summary

**Shipped 6 of 8 queued items + the anchor build**, all as **unpushed commits on `main`** for Matt's
review. No pushes, no deploys, other chat's files never touched.

| # | Item | Result | Commit |
|---|------|--------|--------|
| 0 | Deep trend retrieval (anchor) | ✅ | `0200cfd` |
| Q1 | U.S. Drought Monitor adapter | ✅ | `cf65b79` |
| Q2 | NASS corn price + soy:corn ratio | ✅ | `76a45af` |
| Q3 | Curriculum + glossary store | ✅ | `ef9dd2a` |
| Q4 | 4 ag-news RSS feeds | ✅ | `83c65e4` |
| Q5 | Brazil IBGE SIDRA | ✅ (no chart) | `a0bc5e8` |
| Q6 | Education brief mode (Mode A) | ✅ | `77ade77` |
| Q7 | CME settlements | 🚫 blocked (Akamai IP 403) | — |
| Q8 | WASDE series | 🚫 deferred (ESMIS migration) | — |

**Net new for the platform:** 25 market series (was 18) across 3 new keyless adapters (drought,
Brazil) + NASS corn/ratio; **10 interactive Markets charts** (added corn price, soy:corn ratio,
drought); 4 ag-news feeds (farmdoc daily etc.); the **education engine's Mode A daily brief** running
"teach, don't tell" on the whole stack; and the curriculum/glossary knowledge base behind it. The
deep trend retrieval (YoY/seasonal/percentile) is the through-line — the education brief demonstrably
uses it.

**MORNING PUNCH-LIST (see queue doc for full detail):**
1. **Register free keys** → then I build/test those adapters: **FRED** (macro: dollar/rates/PPI),
   **FAS Open Data** retry (PSD global S&D).
2. **Review the night's commits** (`git log origin/main..main` — 8 commits) + eyeball the new charts
   and the education brief.
3. **Ship v1.7.0** (bump `package.json` + store manifest → tag → GHCR → Umbrel Update). Then the Pi
   `/data` steps: new `registry.json` (4 feeds), merge `agtransport`+`drought_monitor`+`ibge_brazil`
   into `/data/watchlist.json`, run `seed-curriculum` + `market-refresh` in the container.
4. **Decide on the two `[!]` items:** CME futures (retry from the Pi's IP, or buy Barchart) and WASDE
   (build the OCE/ESMIS parser). Both are optional; the free stack covers most of the signal.
5. Optional: Brazil production **trend** chart via PAM 1612 (Q5 shipped only ~2 crop-year points).

Loop ending — not rescheduling. 🌱
