# Changelog

## 1.27.0 — Read the document, count the action once

One theme: **stop losing information between fetching it and reasoning about it.** Collection and the
market layer were fine; the losses were all in the middle. Three findings, each measured on the real
stored feed before anything was written — see `docs/EVIDENCE_AND_EVENTS.md` for the full workings.

**Three official adapters supplied no document text at all.** `regulations_gov`, `iowa_admin_rules`
and `eurlex_oj` each hard-coded `summary: ""`, and `summary` is the field that becomes
`seen_items.body` — the only document text the local scorer, the triager and every prompt ever saw.
So for the comment-docket stream, the most actionable source an advocacy organisation has, every
judgement in the system was made from a headline. The stored verdicts said so out loud: *"Submission
for OMB review with insufficient detail to assess relevance to soybeans."* The substance was
available the whole time — the Federal Register notice behind one of those rows carries a 740-character
abstract and 9,200 characters of text.

**One government action was arriving as many items.** 19% of the "relevant" feed was an exact-title
repeat of a row already in it; six of the eight entries in the homepage "Upcoming" list were the same
three EPA notices; the comment-deadline panel showed nine "Aug 6" rows. Resolved against the API,
those nine rows are **three** Federal Register notices — `2026-13557`, `2026-13552` and `2026-13553` —
each cross-filed into two to four EPA dockets. Every copy got its own Haiku one-liner, its own
calendar entry and its own deadline; the titles were byte-identical and the abstracts were `""`, so
nothing distinguished them. To a synthesising model, ten near-identical entries read as ten
independent corroborating signals of one claim.

**The Ask box could not reach this domain's vocabulary.** Retrieval kept only words longer than three
characters, so 45Z, RFS, RIN, EPA, SAF and EU were silently dropped; what survived were stopwords,
which match most of the table, ordered by date. Asking "What's happening with 45Z?" returned
"IL SB0315: BUSINESS-TECH", an OMB comment request, and a feature about virtual cattle fencing.

### Added
- **Document enrichment** (`src/enrich.js`) — runs after collect and **before** scoring. One
  Regulations.gov detail call yields the document text *and* `frDocNum`, the Federal Register document
  number; one Federal Register lookup **per distinct document number** then supplies the real abstract,
  action line and agency. Three docket copies therefore cost three detail calls and **one** FR call.
  Live on 2026-07-30: **0/19 → 17/19 items grounded** with real document text, 17 linked to an FR
  number. Running before scoring matters — a docket whose title is generic but whose abstract says
  "soybean" used to score zero and never reach triage; one item went from 1 matched focus area to 3.
  No Anthropic tokens; every fetch individually fail-soft; capped at 40 fetches/run.
- **Event identity** (`src/eventkey.js`) — one government action, one identity, keyed on identifiers
  the publisher assigns: `fr:<docnum>` (collapses docket copies *and* the Federal Register original,
  across sources), `bill:<juris>:<id>` (a bill across every status change — LegiScan's uid embeds
  `change_hash`, so a bill that moved four times was four unrelated feed rows), `case:<court>:<no>`,
  and a normalized-title **exact** match as the last resort for re-syndicated news. New
  `seen_items.event_key` column, indexed, additive, backfilled on boot so existing history groups too.
- **An evaluation harness** (`test/eval-intelligence.test.js` + `test/fixtures/eval-corpus.js`) that
  prints a scorecard on `npm test`: redundancy rate, **false-merge rate**, thread fragmentation,
  grounding rate, retrieval precision@5 measured against the old behaviour, repetition-as-evidence,
  recall preservation, stale-context suppression. Fixtures carry recorded provenance (real docket ids,
  real document numbers, the real abstract) and need no network or model. 16 tests → 37.

### Changed
- **Triage is document-level and runs once per action.** The per-item budget went from 600 characters
  to 2,500 (600 truncates a Federal Register abstract mid-sentence), the field is named `document`,
  and the prompt now says to base the verdict on what the document says rather than what the title
  implies — and to write a one-line that *distinguishes* this filing, naming the active ingredient or
  commodity or country, since filings sharing a title must not get interchangeable summaries. Copies
  of one action inherit the representative's verdict instead of each paying for their own.
- **Every prompt now sees the document.** `compactItems` — used by the Ask box, the Analyst Note and
  the weekly/monthly memos — projected rows to title + `one_line`, so the deepest model in the system
  reasoned about a federal rule from its title and a sentence Haiku wrote about that title. It now
  emits one entry per action carrying a `document` excerpt (1,200 chars), the priority tier, the
  deadline, and `alsoFiledAs`. Prompts are told that `document` is sourced fact, `why` is someone
  else's summary, and that an entry with `alsoFiledAs` is **one** action filed in several places —
  never repetition as corroboration.
- **Ranked retrieval** (`store.parseQuery` / `store.searchItemsRanked`). Quoted phrases survive as
  phrases; alphanumeric and ALL-CAPS tokens are kept at any length; ordinary words are de-stopworded
  at ≥4 chars; `body` is searched at last; scoring is field-weighted (title 6 / one_line 3 / body 2)
  with recency as the tie-break rather than the sort key. A query of nothing but stopwords now returns
  nothing instead of the newest rows. Measured on the eval set: **precision@5 57% → 100%**.
- **Laws, Rules & Decisions, the homepage calendar and the deadline panel show one row per action**,
  with "also filed in N other dockets — same action" disclosing the rest and the help text stating how
  many rows were folded. On the stored feed the first thirteen rows became five distinct actions and
  the nine "Aug 6" deadlines became three. Nothing is hidden: the archive view stays un-collapsed, and
  "🔍 Did we see this?" still shows every copy — that panel's whole job is showing what the filters did.
- **Cached model output states its age, and stale output is withheld from prompts.** The Markets page
  was rendering a card written 22 days earlier, expanded by default, quoting managed money at "38,149
  contracts (39th percentile)" directly beneath a live board reading 130,505 at the 79th — and
  injecting the same text into the Analyst Note with no age attached. Panels now carry a freshness
  badge in the summary line, stale ones start collapsed with an explicit warning, and
  `marketIntelText()` dates what it injects and withholds it past 4 days.

### Fixed
- **A latent false merge in the source data.** Two of eleven sampled EPA records had their citation
  fields shifted by one position, putting a page *range* in `frDocNum` (`"46594 - 46594"`) with the
  real document number in `startEndPage`. Trusting the field produced the key `fr:46594 - 46594`; a
  page range repeats across volumes, so it would eventually merge two unrelated notices — and a false
  merge silently deletes a real action from the feed. `frDocNumOf()` scans the candidate fields for the
  canonical `YYYY-NNNNN` shape and refuses anything else. Locked by test.
- `triageItems` returns its verdict map, so one representative's judgement can be applied to the other
  filings; a batch that never reached the model leaves its copies unseen so the next run retries them,
  rather than recording them as judged.

### Pi go-live
**Code-only.** `event_key` and its index auto-create on boot, and the backfill runs once on start
(NULLs only, idempotent). No new API keys — enrichment uses the existing
`REGULATIONS_GOV_API_KEY`/`CONGRESS_GOV_API_KEY`, and without one it logs a skip and changes nothing.
No watchlist merge. Enrichment adds ≤40 keyless-or-existing-key HTTP calls per run and no model spend;
triage spend goes *down*. The visible change is immediate on the first run after Update; existing
history groups as soon as the container starts.

## 1.26.0 — Graded relevance, exclusion terms, per-report delivery, signal cards that show their work

Two themes. **Narrowing the net**: until now the filter could only ever say *yes* — there was no way
to express "this word means I don't care", and relevance was a single boolean, so a rule ISA would
comment on and a notice that merely mentioned soybeans arrived in the same flat list. **Closing the
delivery gap**: on-demand reports were never delivered anywhere, so the market-education brief only
existed if someone opened the web UI and clicked.

### Added
- **Exclusion terms** — the missing half of the filter, which did not exist anywhere in the codebase
  before now. `output.excludeTerms` (global) drops an item before triage however well it scored;
  per-focus-area `excludeTerms` cancel *that area's* weight only, so a bill that hits "pesticide" in a
  school-lunch context stops claiming crop-protection weight but can still qualify elsewhere. Managed
  on the Watchlist page as struck-through chips; word-boundary matched like the include terms, and the
  run log reports how many items each pass removed (a filter that swallows things silently is one
  nobody can debug).
- **Graded triage tiers.** Triage now returns `must_read` / `worth_knowing` / `background` alongside
  the boolean, with a strict rubric ("if an item is only relevant because a keyword appeared in it,
  that is background"). Laws/Rules/Decisions defaults to hiding **only** `background`, with a
  priority dropdown for must-read-only or everything, and a chip per row. Nothing is discarded — the
  quiet stuff is one click away. Items triaged before this release have no tier and are **kept** in
  the default view: the regression test for that NULL case is deliberate, because writing the filter
  the obvious way would have emptied the entire existing feed on update, silently, only on the Pi.
- **"🔍 Did we see this?"** on Laws/Rules/Decisions — paste a phrase you heard about elsewhere and it
  searches the *whole* firehose (every verdict, both archives, titles and bodies, a year back),
  including items the local score dropped before triage. It then says which of the four things
  happened — never collected / dropped before triage / triaged out / it's in your feed — because each
  one has a different fix, and names the fix. This is the answer to "there's stuff I know you're
  missing": it turns a hunch into a diagnosis.
- **Per-report delivery routing.** Each report can have its own recipient, which is how the
  market-education brief lands in its own Teams channel (channel email addresses are the delivery
  mechanism). Set per report in Logs & Settings, or via `BRIEF_EMAIL_TO_EDUCATION`-style env vars;
  falls back to `BRIEF_EMAIL_TO`. A routing table shows exactly where every report goes and on what
  schedule, and there's a **test send** per report — worth using after changing the sender, since a
  Teams channel can be set to reject outside senders.
- **Schedules for the education brief, monthly review and Analyst Note.** Previously only am/pm and
  the Friday weekly could be scheduled; the education brief had no cadence at all. A scheduled
  Analyst Note also keeps the forecast ledger fed, since Analyst is the only preset that files claims.
- **Signal cards flip.** Every card on the Markets signal board turns over to show the series behind
  it: a sparkline of the recent trail over a faint p10–p90 normal-range band from the series' full
  history, the latest value with its percentile, year-over-year, the 1.24.0 momentum fields (so "high
  and still climbing" reads differently from "high but rolling over"), the weighted **factor** the
  signal belongs to — which is what explains why five agreeing crop-stress reads don't swing the tilt
  five times — and a link to the full chart. Click, Enter/Space, or Escape; on a phone the flipped
  card takes the full width, which restores the detail the compact board hides.
- **📌 Tracked rules now appear on the homepage calendar** as their own kind, so the things you've
  explicitly flagged stand out from the generic USDA dates.
- **Calendar events can be dropped.** × on any event in the day panel hides it for good (server-side,
  so it sticks across browsers and restarts, with a restore-all control), plus per-kind filter chips
  and a "hide routine weeklies" toggle remembered per browser — which is what actually de-clutters
  the month, since the recurring export-sales/crop-progress/CFTC entries are most of the noise.
- An optional `docTypes` allowlist for the Federal Register (e.g. `["rule","proposed-rule"]` to drop
  the notice flood). **Ships permissive** — narrowing coverage should be a deliberate choice.
- `test/filter-tiers.test.js` — 10 zero-dependency tests over the exclusion logic, the tier defaults
  (including the NULL-history case), the lifecycle age-out, the coverage diagnostic, and the
  newsletter chrome pass. One of them caught a real bug: dropping an image URL glued the alt text to
  the following tracker (`Facebook` + `https://…` → `Facebookhttps://…`), which then failed the
  word-boundary test and printed the tracking URL as visible text.

### Fixed
- **Rules with no comment deadline never retired.** The 1.22.0 lifecycle retirement only knew how to
  expire a deadline or a hearing date, so a proposed rule whose deadline we failed to parse sat in the
  active feed forever. One with no deadline and no movement for 120 days now retires into the same 🗂
  Closed view — long enough that a live rulemaking is never hidden mid-comment-period.
- 👍/👎 feedback reaches the triage prompt with more signal: 12 examples instead of 8, each carrying
  its source and document type, so "Federal Register notices are never relevant" is visible as a
  pattern rather than as three unrelated titles.

## 1.25.0 — Usability: visible controls, a working copy button, a phone-shaped UI, readable newsletters

A use-it-every-day release rather than an analytical one. Every item here came from actually using
the tool: a control that was invisible, a button that silently did nothing, an inbox that showed
tracking URLs instead of the story, and a layout that assumed a desktop. It also tags four fixes
that had landed on `main` untagged (`df560b2`, `2188909`, `38af049`, `f2683e9` — .env loading in the
feed checker, an AMS `skipBackfill` option for diagnostics, prompt-context corrections found by the
first live Analyst Note, and forecast-ledger claim/series alignment).

### Fixed
- **The calendar's month arrows were invisible until hovered.** `.bbcal-nav` set
  `background:none` but inherited `color:#fff` from the global button rule — a white glyph on white
  paper. Hover repainted the background dark, which is why they appeared only on mouse-over. The ink
  is now explicit and hover is a gold tint rather than an inversion, so the control never disappears.
- **"📋 Copy markdown" copied nothing, silently.** `navigator.clipboard` exists only in a *secure
  context*; the Pi is reached over plain `http://` on a Tailscale IP, so the API is `undefined` there
  and the old one-line handler threw inside an un-caught promise chain — no copy, no error, no
  feedback. Now three tiers: the async Clipboard API where it's available, a `document.execCommand`
  fallback that works over plain http, and finally a pre-selected textarea with a "press Ctrl+C"
  prompt. Every path ends in visible feedback; it can no longer fail in silence.
- **Setting a hearing aside didn't remove it from the calendar.** `store.upcomingHearings` ignored
  the `archived` flag, so a hearing dismissed in Laws/Rules/Decisions kept its calendar dot forever.
- **The News inbox previewed tracking URLs instead of the story.** News items are never triaged, so
  `one_line` is empty and the snippet falls back to the body — through `emailBodyToText`, whose job
  is to *inline every href* for LLM prompts. A Morning Ag Clips item previewed as 180 characters of
  `securetrack.morningagclips.com`. New `emailBodyToPreview` strips URLs and ESP chrome and starts at
  the first real sentence. Verified across 56 stored items: no URLs, no stray entities.
- **Newsletter bodies rendered the publisher's plumbing.** An ESP's text/plain alternative encodes
  every image and link as a bracketed URL after its alt text, and the old renderer escaped and
  linkified all of it. A chrome pass now drops image URLs, reduces a bare link to a compact ↗ next to
  the prose that already labels it, and removes boilerplate ("Images not showing up?", view-in-browser,
  unsubscribe/footer rows, social-icon strips — detected by link *density*, so it generalizes past
  the publishers we've seen). Because bodies are re-sanitized at render time, this cleans mail that
  was already stored. Guarded against over-stripping: prose carrying three real links is untouched.
- **`npm test` was broken on Node 24** — `node --test test/` no longer accepts a bare directory and
  died with MODULE_NOT_FOUND. Now globs `test/*.test.js`; all 6 tests pass.
- The Federal Register whitelist was **missing the Army Corps of Engineers**, which co-issues the
  Clean Water Act / WOTUS §404 dredge-and-fill rules with EPA — so an agricultural-drainage (tile)
  rule can publish under the Corps alone and was invisible. Added, with Fish & Wildlife (ESA
  consultation on pesticide registrations) and CEQ (NEPA). *(A `/data/watchlist.json` merge is
  needed on the Pi for this one — everything else in this release is code-only.)*

### Added
- **Mobile pass**, all of it scoped to `max-width:640px` / `pointer:coarse` so the desktop layout is
  untouched:
  - The **ten-tab nav wrapped into three or four rows** and pushed content below the fold; it's now a
    single horizontal strip that scrolls the current tab into view.
  - **Laws/Rules/Decisions becomes cards on a phone.** A four-column table inside `overflow-x:auto`
    meant side-scrolling every row to reach its buttons; each row is now a labelled block, and the
    row actions get real tap targets.
  - **Charts respond to touch.** uPlot 1.6.32 ships no touch handlers at all, so on a phone the
    charts were inert — no legend, no zoom, nothing to do but pinch the page. Touch is translated
    into the mouse events uPlot already listens for (finger-drag scrubs the live legend), plus
    pinch-to-zoom on the time axis, one-finger pan once zoomed, and double-tap to reset to the
    range the toolbar has selected.
  - **⤢ expand** on every chart — full-viewport view (turn the phone landscape), Esc or tap-outside
    to close. A 12-point series in a 330px column is unreadable however good the interaction is.
  - Shorter chart heights and fewer x-axis ticks on narrow screens; the range control's custom-date
    block no longer gets squeezed off the edge; bigger day cells on the calendar; the Iowa map sizes
    to the viewport instead of a fixed 620px.
- **Brief emails are now sent as HTML as well as text.** Delivery to Teams is by channel email, so
  the mail's formatting *is* the Teams post's formatting — headings and links arrived as literal
  `##` and `**`. Inline-styled (Teams and Outlook strip `<style>`).
- `SMTP_FROM` support for a sender display name, e.g. `"The Bean Brief <beanbrief@gmail.com>"`.
  Gmail only accepts a `from` matching the authenticated account, so it is ignored unless its address
  matches `SMTP_USER`; **switching the sender is an SMTP_USER/SMTP_PASS change on the Pi, not a code
  change.**
- A **"Today"** button on the calendar (shown only when you've navigated away from the current
  month) and a **roll-up** on the Upcoming panel, which remembers its state and titles itself with
  the selected day and event count when collapsed.

## 1.24.0 — Daily price & basis, crush utilization, forecast ledger, surprise scoring

The largest analytical change since the market layer was built. Until now the tool could monitor and
synthesize but not really *forecast*: it issued a bull/bear read twice a day against a price it could
only observe monthly and six weeks late, several of its signals were computed in ways that produced
confidently wrong answers, and nothing it predicted was ever recorded or scored. This release fixes
the measurement layer and closes the feedback loop.

### Added
- **`cbot_futures` markets adapter** (keyless, via Yahoo's chart endpoint). Daily front-month CBOT
  settles for soybeans, meal, oil and corn — ~1,256 points each over 5 years — plus a derived **board
  crush margin** and a daily soy:corn ratio. This is the first sub-monthly price series in the system
  and the prerequisite for scoring any signal against a subsequent price move. Keyless interim ahead
  of Barchart; series are namespaced `cbot:*` so both can coexist and be compared.
- **`usda_ams` rewritten** — two MARS reports on the one existing key. Report 2850 now yields daily
  Iowa cash price, nearby basis, and a separate **processor basis** (what crush plants themselves bid,
  ~1,478 days back to 2020-08); report 3511 yields weekly Iowa cash meal, oil and hulls (loose +
  pellets, ~223 weeks back to 2022-02). Derived: an **Iowa cash crush margin** — the Gordon Denny
  workbook's "Cash Margin" tab as a multi-year series. Deep history backfills once in ~6-month chunks,
  then a 45-day rolling window.
- **`crush.js` — capacity-utilization engine.** New `src/data/crush_capacity.json` (69 plants,
  8,557,000 bu/day, generated from the Denny workbook; both its current-plant and capacity-addition
  totals tie exactly to the source sheet) drives a **time-varying** nameplate denominator, so
  utilization is measured against the plant base that actually existed at the time. Falls back to a
  trailing-12-month-max proxy when the table lacks coverage. Cross-checks against crush margin and
  names the divergence when margin and utilization disagree.
- **Forecast ledger.** A new `forecasts` table plus extract → resolve → feed-back loop. Each Analyst
  Note's falsifiable claims are extracted via **structured outputs** into typed, dated rows with the
  series and date that settle them and the series value at the time. A resolver scores them
  three-way, and the scored record is fed back into later Analyst/Ask prompts as a track record. New
  `forecasts` CLI command.
- **Report expectations & surprise scoring.** A new `report_expectations` table, extraction of
  pre-report trade consensus from news bodies, and settlement against the published actual with the
  miss scaled by the analyst range. Markets move on surprise, not level, and the tool previously
  stored only actuals. New `expectations` CLI command.
- **`leadlag.js`** — measures which series actually lead the daily price and by how long, with a
  Bonferroni-corrected significance bar across the whole scan and price-derived series excluded as
  untestable. Currently reports **zero** significant leads, states so explicitly, and will populate as
  daily history accumulates.
- **Momentum on every series** — `changeSigma`, `changeZ` and `slopePerSigma` on the market snapshot,
  so "high and still climbing" is distinguishable from "high but rolling over".
- New charts: daily CBOT board, crush margin (board vs. Iowa cash), Iowa basis (all bids vs.
  processors); daily Iowa cash joins the existing price chart.
- `scripts/check-market-feeds.mjs` — 30 live checks over the new feeds, including a cross-check of the
  board margin against the Denny workbook (ties to within $0.01).

### Fixed
- **Crush signal was anti-informative.** It ranked crush *volume* against full history and fired
  bullish above the 80th percentile. Capacity grew ~1.06M bu/day between March 2023 and May 2026, so
  volume ratchets to a fresh record most years regardless of demand: the board printed "record-strong
  domestic demand" for **eight consecutive months while crush fell ~10%**. Now measured as capacity
  utilization vs. the same calendar month in prior years. The retired scorer is kept in place as a
  documented cautionary example.
- **Seasonal norms could be built from a single year.** The guard was a bare count of same-month
  observations, so four points from July 2026 formed a "seasonal norm" for July 2026 — and on a
  monotonically drying series that construction *guarantees* a negative anomaly, i.e. a manufactured
  bullish bias. It affected both satellite feeds shipped in 1.22/1.23. Now requires ≥3 distinct years;
  `seasonalYears` is exposed so a 3-year norm can be weighed differently from a 10-year one.
- **Percent change on zero-crossing series.** Iowa basis produced a `seasonalDeltaPct` of −394.91%,
  which fed straight into the LLM prompt. Percent deltas are now suppressed when the denominator is
  small relative to the series' own spread; the absolute move is reported instead.
- **The tilt double-counted correlated signals.** It was a raw bullish-minus-bearish headcount, so in
  season five of ~13 slots — crop condition, VCI, soil moisture, drought, U.S. crop weather — all read
  the same variable (belt moisture stress) and could swing the headline by five votes while the
  balance sheet contributed one. Signals are now grouped into weighted factors and averaged within a
  factor. Per-signal board display is unchanged.
- **Alert threshold was a flat ±20% across every series** — ordinary noise on barge freight, and
  unreachable for stocks-to-use, which moves a few percent and matters enormously. Now a 3σ move
  measured in each series' own volatility.
- `usda_ams` previously had **no `fetchSeries` at all**: "Iowa cash & basis" existed only as a headline
  string parsed out of a report narrative and was never stored as a series.
- `generateStorylines` no longer hand-parses JSON by slicing between the first `[` and last `]` inside
  a try/catch that silently yielded zero threads; it uses structured outputs, so a quiet news window
  is now distinguishable from a formatting failure.
- `refreshMarketSeries` now passes each adapter its watchlist entry (`sourceConfig`), matching what
  collect already did for `fetchItems`.

## 1.23.0 — Crop-CASMA root-zone soil moisture (satellite)

Adds a cause-side crop-stress feed to complement the VegScape VCI shipped in 1.22.0: NASA SMAP
root-zone (and Iowa surface) soil moisture over cropland, via Crop-CASMA's open, keyless WPS
zonal-statistics service. It measures the water actually available to the crop's roots, so it leads
both the vegetation response (VCI) and the NASS condition rating.

### Added
- **`cropcasma` markets adapter** (keyless). Weekly root-zone volumetric soil moisture (m³/m³) for
  Iowa + IL/MN/IN/NE, plus Iowa surface moisture, from the Crop-CASMA `GetStatByFips` WPS process
  (returns a histogram CSV → pixel-weighted mean; no raster parsing). Backfills ~30 weeks on a cold
  start and thereafter fetches only new weeks. Same Mon–Sun week numbering as VegScape.
- **`Root-Zone Soil Moisture` signal** on the Markets board (and in the Analyst/Pulse/Ask context):
  growing-season-gated, reads the in-app seasonal anomaly (falls back to the recent multi-week
  trajectory until a seasonal baseline exists). Drying in-season supports price; a charged profile
  weighs on it.
- **"Root-zone soil moisture (satellite)"** Markets chart.

### Pi go-live
Code-only Umbrel Update, then merge `sources.cropcasma` into `/data/watchlist.json` and run one
`market-refresh` (a one-time ~30-week backfill of small CSVs; no large downloads). No new keys.

## 1.22.0 — Congressional hearings + homepage calendar + LRD overhaul + VegScape crop VCI

Release 2 of the Bean Brief review (hearings, homepage calendar, LRD overhaul), shipped together with
the new VegScape satellite crop-vegetation adapter.

### Added
- **VegScape satellite crop VCI** (`src/adapters/vegscape.js`, class `markets`; `src/signals.js`
  `vegCondition`; `src/util.js` `fetchBuffer`). Keyless USDA/NASS VegScape Vegetation Condition Index
  (0–100 vs. each pixel's 2000-present range) for Iowa + IL/MN/IN/NE cropland, averaged from
  FIPS-clipped GeoTIFFs by a zero-dependency TIFF reader. Published ~4 days after each week closes, so
  it front-runs the Monday NASS condition rating — a leading crop-vigor signal on the board (Apr–Oct)
  and a `veg_condition` chart. First `market-refresh` does a one-time ~12-week × 5-state backfill
  (~180 MB of tiles); steady state is ~5 small fetches/week. No key.
- **Congressional hearing tracker** (`src/adapters/congress_hearings.js`, class `official`). Pulls
  committee hearings & markups from the Congress.gov `committee-meeting` endpoint (reuses
  `CONGRESS_GOV_API_KEY`), fetching each meeting's detail for committee, date, status, witnesses, and
  linked bills. Volume is controlled by a **two-tier committee whitelist** matched on the systemCode
  prefix: Tier A keeps every meeting from House Ag, Senate Ag, both Ag-Appropriations subcommittees,
  and Senate EPW; Tier B keeps a hearing from Ways & Means, Senate Finance, House Energy & Commerce,
  House T&I, or Senate Commerce **only** when its title or a linked bill matches a Focus-Area keyword.
  Each hearing is tagged Federal, flags any Iowa delegation member on the committee, carries the
  meeting date, and links to the meeting page. Register on the Pi by adding `congress_hearings` to
  `watchlist.json`.
- **Homepage calendar** (`src/server.js` `homeCalendar`). A month-grid calendar on Home merging four
  dated streams — USDA/market report releases, public-comment deadlines, congressional hearings, and
  political/policy dates — color-coded, with month navigation and click-a-day detail.
- **Political/policy calendar data** (`src/data/policy_events.2026.json`, `src/calendar.js`
  `upcomingPolicyEvents`/`…Text`). Seeded with 2026 elections + Iowa filing deadlines, the Sept 30
  farm bill deadline, the Dec 4 FY2027 funding deadline, and the 2027 Iowa session — extend the
  regulatory category over time. Upcoming policy deadlines are also injected into the Analyst Note /
  Market Pulse prompts.
- `.ics` calendar (`/calendar.ics`) now includes hearings alongside comment deadlines; a Subscribe
  link sits on the LRD tab.

### Changed
- **Laws, Rules & Decisions overhaul** (`src/server.js` `itemsBody`, `src/store.js` `listItems`).
  Group the feed by **state vs. federal** (normalized from the inconsistent per-adapter jurisdiction
  strings via `jurisdictionLevel`), by **topic**, or by **source**; **sort** by newest or by comment
  deadline; and every rule shows an **at-a-glance status chip** — "open · Nd left" / "closing · Nd
  left" / "comment closed" (and "in Nd" / "held" for hearings). Rules **auto-retire** from the active
  view once their comment period closes (+3-day grace), and past hearings likewise — non-destructive,
  surfaced under a new **🗂 Closed** view. New indexes on `comment_deadline` and `doc_type`.

## 1.21.0 — News inbox redesign + newsletter market-intel extraction + one-box map

Three improvements. The News collector reads like a real second inbox, the market intelligence inside
those newsletters now informs the model's reasoning, and the Iowa map shows one info box at a time.

### Added
- **Market-intel extraction** (`src/pipeline.js`, `src/emailhtml.js`). Newsletters/press in the collector
  inbox carry real market intelligence (cash bids, basis, crush margins, China demand, freight, biofuel/
  policy signals) that previously died on the News tab — every reasoning path runs items through
  `compactItems`, which drops the body, so the Ask box, Analyst Note, and Market Pulse only ever saw
  subject lines. New `extractMarketIntel()` distils the last few days of news **bodies** into a compact,
  cited intel block (cheap Haiku call, cached in `kv_state`), which is now injected into `answerQuery`
  and `generateMemo` (Analyst/Pulse/weekly/monthly) alongside the signal board. Refreshed with the news
  digest (twice-daily run, the News "Refresh" button, and `news-digest`); also a standalone
  `market-intel` CLI command. A collapsed **"Market intel from the inbox"** panel on the News tab shows
  staff exactly what the model is being fed.

### Changed
- **News "What's flowing in" now reads like a real inbox** (`src/adapters/email_intake.js`,
  `src/emailhtml.js`, `src/server.js`). Root cause of the old wall-of-text: email ingest stripped every
  HTML tag (discarding hyperlink hrefs) and collapsed all whitespace before storage. Ingest now keeps a
  **safe, structure-preserving HTML subset** via a new whitelist sanitizer (`sanitizeEmailHtml` —
  paragraphs, lists, headings, and working `<a href>`; scripts/styles/images/trackers and all other
  attributes dropped). The inbox renders each message with its real sender (the resolved registry
  entity), a proper preview snippet, and the formatted body — re-sanitized at render time as defence in
  depth for every source. Stored-body cap raised 4000 → 8000 chars so structure survives.

### Fixed
- **Iowa map showed two info boxes at once** (`src/assets/bbmap.js`, `src/server.js`). Districts (and
  facility markers) bind both a sticky hover tooltip and a click popup with no "pinned" state, so
  clicking left both on screen. The map now marks its container `bb-pinned` while a popup is open and
  CSS hides hover tooltips (`#ia-map.bb-pinned .leaflet-tooltip { display:none }`) — reliable where
  `closeTooltip()` was not, and it also suppresses tooltips on *other* districts while one is pinned.

## 1.20.1 — Reliability: crash-safe collection + config writes (code review)

Two fixes from Ethan Cail's review (PRs #5 and #6), each with a zero-dependency regression test that
fails on the previous code and passes with the fix.

### Fixed
- **Silent data loss on interrupted runs** (`src/collect.js`, `src/pipeline.js`; PR #5). Collection
  advanced each source's `last_success_at` watermark the moment its fetch succeeded — but items only
  become durable later, at `markSeen` during triage. A run that died in between (missing/invalid
  `ANTHROPIC_API_KEY`, an Anthropic 429/5xx, a crash) left the watermark past items that were never
  recorded, and `getSince` never re-fetched them: silent, permanent loss. Collection is now read-only
  with respect to watermarks — it returns pending advances that are applied once, after every fetched
  item is durably in `seen_items`. Die earlier and nothing advances; the next run re-fetches and dedupes.
- **Non-atomic config write** (`src/pipeline.js`, `src/server.js`; PR #6). `saveWatchlist` wrote straight
  onto the live `watchlist.json` (truncate-then-write), so a crash mid-write could corrupt the whole
  config — including the quota-critical `sourceTerms` / `maxQueriesPerRun` / `fullTextStates` added in
  1.20.0 — and the app won't boot without it. It now writes a temp file and atomically renames it into
  place. The settings handler also range-checks schedule times, so `25:00` / `12:99` are rejected instead
  of being accepted and then silently never firing.

## 1.20.0 — LegiScan quota fix: 19× fewer API queries, complete session coverage

On 2026-07-16 the LegiScan key hit its 30,000/month free-tier cap. It was structural, not a spike: the
adapter ran one `getSearch` per (term × state) on every run — 103 watchlist terms × 7 states = **721
queries per run**, so the twice-daily schedule alone burned ~45,000/month. LegiScan's coverage log
showed 97.5% duplicate queries (39.7:1 repeat ratio).

It also failed backwards. `maxItemsPerRun` capped items *kept*, not queries *spent*, and the loop only
exited once that many bills cleared the `last_action_date` filter — so out of session, when nothing
clears it, every run fired all 721 queries and returned nothing. Spend was inversely proportional to
activity, which is why the quietest month of the year is the one that blew the cap.

### Changed
- **LegiScan adapter rewritten as two passes** (`src/adapters/legiscan.js`):
  - **Pass 1 — `getMasterList` per state.** One query returns every bill in that state's current
    session with title, description, `change_hash` and last action; keywords are matched **locally**
    (free). Cost is fixed per state no matter how long the term list grows, and coverage is now the
    **whole session** instead of page 1 of each search.
  - **Pass 2 — `getSearch` over a curated term list**, for `fullTextStates` only (default: `IA`). This
    is the only way to reach a bill whose *text* mentions a term but whose title doesn't — `score.js`
    leans on that explicitly (state bill titles are often generic). Kept where it pays instead of paid
    for seven times over.
  - **Spend is now decoupled from item count** — the failure mode above is structurally impossible.
    **~38 queries/run → ~2,356/month** against the 30,000 cap (was 721/run → ~44,702).
  - `maxQueriesPerRun` (default 120) is a hard backstop; calls are throttled to ~4/s (LegiScan logged
    the old adapter at 27/s average, 50/s peak — the crash course warns that earns a suspension).
  - Over-quota now fails with a plain-English message that names the reset date and warns against
    registering a second key (LegiScan revokes **all** keys for that).
- **Focus areas take an optional `sourceTerms: { [sourceId]: string[] }` override** (`pipeline.js`
  `deriveEngineTopics`) narrowing what a *metered* source searches for. Scoring still uses the full
  flat `terms` list — matching is free, searching is not. Shipped config: 31 curated LegiScan search
  terms (from 103), with the federal-only areas (farm bill, trade, USDA-FPAC) set to `[]` — they still
  match locally, so a state resolution urging Congress is still caught, at zero query cost.
- `keywordRegex` moved to `util.js` so the adapter and `score.js` share one matcher and can't drift.
- Removing a term in the Watchlist UI now also prunes it from any `sourceTerms` override.

### Added
- `scripts/verify-legiscan.mjs` — offline verification (stubs `globalThis.fetch`, drives the adapter
  against fixtures). Asserts the budget, the decoupling regression, `change_hash` uid behaviour, the
  masterlist/search field-name drift, the backstop, and the throttle. Re-run against the live API once
  the quota resets.

### Pi go-live
**The Update alone fixes the blowout** — `/data/watchlist.json` is persisted and not shipped in the
image, but the code defaults carry an un-merged watchlist to ~110 queries/run (~6,820/month), safely
under the cap and under the backstop. Merging the new `sources.legiscan` keys (`maxQueriesPerRun`,
`fullTextStates`) and the per-area `sourceTerms` then takes it the rest of the way to ~38/run
(~2,356/month). Both paths are covered by `scripts/verify-legiscan.mjs`. No new keys.

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
