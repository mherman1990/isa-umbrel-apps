# The Bean Brief — "Studio" charting tab (v1 build brief)

*A self-contained, build-ready spec for a desktop-only chart-exploration tab. Written to be
**dropped into a fresh Claude Code chat** that has access to this machine, so it can build v1
without re-deriving the project. If you are that fresh Claude: do §0 first, then build §5, then
verify §7. Do not skip §0 — a cold start that jumps straight to code will get the conventions
wrong.*

---

## ✅ AS-BUILT STATUS — v1 SHIPPED solo as v1.16.0 (2026-07-10)

v1 is implemented and verified locally: all three `/api/studio/*` endpoints return real data (20
categories, 35 series, 24 calendar events); all five transforms render; overlays, stats, CSV, PNG
export, and shareable spec-URLs work; the desktop gate works; zero console errors; server boots
clean. Originally planned as a combined release with a separately-built political-map tab, but the
map wasn't in this working tree at ship time, so **Studio shipped solo as v1.16.0** and the **map
tab follows as its own release (v1.17.0)** — its chat must take v1.17.0, not v1.16.0.

**New files (fully self-contained):**
- `src/studio.js` — server module: the `/api/studio/{catalog,series,events}` data + `studioBody()`.
- `src/assets/studio.js` — vendored client (uPlot renderer, transforms, overlays, PNG/CSV/share).

**Only shared-file seams touched — these are the merge points with the map tab:**
1. `src/server.js` import line (after the `registry.js` import).
2. `src/server.js` one nav `<a href="/studio">Studio</a>` in the `<nav>` (~L297).
3. `src/server.js` one line in the `/assets/` allowlist (`"studio.js": …`, ~L1325).
4. `src/server.js` one route block (`/studio` + `/api/studio/catalog|series|events`), **namespaced
   under `/api/studio/`** so it cannot collide with the map tab's routes.
5. `.claude/launch.json` gained a local `studio` dev config (dev-only, not shipped).

**Code-only:** no new `.env` keys, no npm deps, no watchlist/registry/DB migration. Pi go-live =
Umbrel **Update**, nothing else.

**Scope delta from the plan below:** v1 is a single main pane with **auto dual-axis by unit** rather
than stacked sub-panes — cleaner and fully shippable. Stacked sub-panes move to phase 2 alongside
the LLM prompt bar and "Explain this chart" (both stubbed/visible in the UI, tagged "phase 2").

**Paste-ready CHANGELOG entry** (add under the ONE combined release — do not bump versions twice):
> **Studio tab (desktop) — a chart-exploration workbench over the market timeseries.** Pick any
> series from a catalog; compare/overlay with auto dual-axis; transforms (rebase-to-100, YoY %,
> ratio A÷B, seasonality); a historical normal-range band; USDA/CME report + alert flags drawn on
> the x-axis (the cross-stream differentiator); per-series trend stats from `marketSnapshot`;
> export PNG (education footer stamped on), CSV, and shareable spec-URLs. Desktop-only; the phase-2
> LLM prompt bar and "Explain this chart" are stubbed. Code-only — no new keys/deps.

**Dev tip:** `/assets/*` is served `cache-control: max-age=86400`, so a browser holds the old
`studio.js` after edits — hard-reload or cache-bust (`?v=…`) when iterating.

*(The sections below are the original build brief, kept for reference / phase-2 work.)*

---

## 0. Orientation — READ THIS FIRST (do not skip)

You are working on **The Bean Brief** (`polibrief`), a policy + market intelligence app for the
**Iowa Soybean Association**, owned by **Matt Herman — a non-developer**. Plain-English notes,
copy-paste commands (label PC vs. Pi), friendly errors.

**Before writing any code, read, in order:**
1. `C:\Claude tools\polibrief\STATE.md` — where the project is, backlog, gotchas. *(Lives in the
   `polibrief` folder, not this repo.)*
2. `C:\Claude tools\polibrief\HANDOFF.md` — architecture, data model, SQLite schema, sources,
   deploy process. Especially §6 (data model) and §9 (web UI).
3. The auto-memory `project-polibrief-roadmap` (loads each session) — the running build log.

**Where the code lives:** app-code work happens in **`C:\Claude tools\isa-umbrel-apps`** (run
`npm install` there once for local dev — `node_modules` isn't committed). This is **not** a shared
checkout, so `git add -A` is fine here. *(The separate `C:\Claude tools\polibrief` folder IS shared
with another chat — don't build there.)*

**Non-negotiables (these override any instinct to do it differently):**
- **No web framework, no build step.** Plain `node:http` + template-string HTML in `src/server.js`.
  Client JS is **vendored** static files in `src/assets/` (see `bbcharts.js`). uPlot is already
  vendored. Do not add a bundler, React, npm chart libs, or a CSS framework.
- **Compliance is load-bearing.** Farmer-facing market output is **education, never advice**
  (`src/compliance.js` — `EDUCATION_FOOTER`, `scanBanned`). Any exported chart carries source +
  date + the education footer. Nonpartisan/informational; not checkoff-funded.
- **Fail-soft.** A broken series or bad spec shows a friendly message, never a 500 that takes down
  the page. Match the existing `try/catch` posture in `server.js`.
- **Charts are secondary — the data + query engine + signals are the product.** This tab does not
  violate that: it makes the *existing analytical engine* (`marketSnapshot` stats, seasonality,
  the policy calendar, signals) explorable. The chart is the interface to the engine, not
  decoration. If you catch yourself polishing gradients instead of wiring the snapshot stats and
  event overlays, stop.
- **Ship only when Matt says "ship it."** Building locally + verifying is fine anytime. Do not
  commit/tag/push unless asked. See §8.

---

## 1. What we're building (the one big idea)

A **desktop-only "Studio" tab**: a chart-exploration workbench over the market timeseries the app
already collects. The design decision that shapes everything:

> **A "chart spec" is the single source of truth.** A small JSON object describes *which series,
> what transform, what date range, what overlays*. A deterministic renderer (uPlot) draws whatever
> the spec says. The **structured selector** (pick series from a catalog — the "NASS model") writes
> a spec. Later, an **LLM prompt bar** writes the *same* spec (phase 2). The spec also serializes to
> a URL → that's share + save + export for free.

Two consequences worth internalizing:
- Both UX models (selector and prompt) target one object, so phase 2 is additive, not a rewrite.
- **The LLM (phase 2) emits specs, never data values.** It picks series + transforms from the known
  catalog; the database supplies the numbers. A chart that invents a soybean price is a real
  compliance problem. Spec-building is the safe shape. Build v1 so the LLM slot is obvious.

**Reality check to preserve in the framing:** this is **not** a live price terminal. The data is
fundamental and slow — monthly WASDE, weekly crop progress, quarterly stocks, monthly crush; the
only daily series are the dollar/10-yr (FRED), weather, barge freight. Live CBOT futures are gated
behind a paid Barchart key we don't have (phase 3). So the differentiator is **not** tick data —
it's overlaying **policy events + USDA report dates + our own bull/bear signals** onto the
fundamental series. That cross-stream overlay is the headline feature; treat it as such.

A layout mockup accompanies this doc (rendered in the chat where this plan was created): three panes
— left **series catalog + transforms**, center **chart with normal-range band + event flags + a
sub-pane sharing the crosshair**, right **"this chart" trend stats + compliance footer** — with a
(phase-2) prompt bar and PNG/CSV/Share in the toolbar.

---

## 2. Scope — v1 IN / OUT

| In (v1) | Out (later) |
|---|---|
| Desktop-only `/studio` route; friendly "open on desktop" card on mobile | LLM prompt → spec (**phase 2**) |
| Left rail: series catalog grouped by category, multi-select | "Explain this chart" LLM read (**phase 2**) |
| Transforms: rebase-to-100, YoY %, ratio A÷B, seasonality overlay, normal-range band | Live futures / basis / curve (**phase 3** — needs `BARCHART_API_KEY`) |
| Shared global date range (reuse the 6M/1Y/3Y/5Y/All + custom pattern) | Saved-views persistence in DB (v1 = URL only) |
| Multi-line chart + optional stacked sub-pane, synced crosshair | Audience "lenses" (Communicator/Analyst/Farmer) |
| **Event annotations** from the report calendar + alerts (the differentiator) | Real-time anything |
| Export: PNG (with compliance stamp), CSV (reuse existing endpoint), Share (spec→URL) | |
| Right panel: `marketSnapshot` trend stats for the focused series | |

Keep v1 tight. It's all achievable with **data the app already computes** and **zero new
dependencies**.

---

## 3. The chart-spec schema (design to this)

Client-side object; also URL-encodable (`/studio?spec=<base64url(JSON)>`).

```js
{
  v: 1,
  series: ["usda_nass:...", "eia:feedstock:soybean-oil"], // series ids from market_series_meta
  transform: "none",        // "none" | "rebase100" | "yoy" | "ratio" | "seasonal"
  ratio: ["A", "B"],        // when transform==="ratio": numerator/denominator series ids
  range: { months: 36 },    // or { from: "2023-01-01", to: "2026-07-01" } ; null = all
  overlays: {
    normalBand: true,       // shade historical percentile/range behind the (single) focused series
    events: true            // draw report/policy flags on the x-axis
  },
  panes: [                  // optional stacked sub-panes, each its own series list, shared x
    { series: ["cftc:..."], height: 90 }
  ],
  focus: "eia:feedstock:soybean-oil" // which series the right-panel stats describe
}
```

Rules: transforms are **pure client-side functions** over fetched points. `rebase100` indexes each
series to 100 at the first visible point. `yoy` = % change vs. the point ~365d earlier. `ratio` =
Aᵢ÷Bᵢ on aligned periods. `seasonal` = re-key each series' points by calendar month and split into
one line per year. `normalBand` only applies to a single focused series (a band behind many lines is
noise) — shade min–max or the 10th–90th percentile using the same math as `marketSnapshot`.

---

## 4. Data foundation (already exists — reuse, don't rebuild)

All in `src/store.js` (SQLite, WAL) unless noted. **Verify signatures by reading the file**; line
numbers below are approximate as of this writing.

- `market_series (series, period, value)` — tidy long table. `period` is `YYYY`, `YYYY-MM`, or
  `YYYY-MM-DD`. (schema ~L173)
- `market_series_meta (series, label, unit, category)` — `category` groups series into one chart.
  (~L179)
- `listSeriesMeta(category?)` → meta rows (all, or one category). (~L218)
- `getSeries(series)` → `[{period, value}]` ordered. (~L215)
- `marketSnapshot()` → **the analytical layer**: per series `{ latest, previous, changeAbs,
  changePct, yearAgo, yoyPct, min, max, avg, percentile, seasonalAvg, seasonalDeltaPct,
  seasonalPctile, count, firstPeriod, trail(12) }`. Memoized; treat read-only. This feeds the right
  panel stats and the normal-band. (~L244)
- `seriesHistory(series)` → `{series,label,unit,category, points}` for one series. (~L307)
- `seriesFreshness()` → staleness per series (already used by Markets "data health"). (~L320)

**Categories present** (from adapters): `soy_price`, `corn_price`, `soy_corn_ratio`, `soy_crush`,
`soy_stocks`, `soy_balance`, `soy_balance_stu`, `soy_condition`, `drought`, `weather_us`,
`weather_sa`, `soy_exports`, `barge_freight`, `positioning`, `macro_usd`, `macro_rates`,
`brazil_production` (+ some adapter-only ones like `brazil_soy`, `soy_futures`). The Markets page
renders a curated subset via `chartSection(...)` calls in `server.js` (~L978–995) — read those for
the human-facing labels/descriptions to reuse in the catalog.

**Existing chart stack to mirror:** `src/assets/bbcharts.js` renders uPlot from JSON `<script>`
blobs the server emits per category; one global `#bbrange` toolbar drives the visible window
(default 6 months). Palette constant is at the top of that file (ISA navy `#004A8D`, gold `#FFC425`,
…). Reuse the palette and the range-toolbar UX.

**Event sources for annotations:** `src/data/calendar_events.2026.json` (authoritative USDA report
dates + impact; loaded by `src/calendar.js`) and the `alerts` table (`src/alerts.js`
`detectChanges` — signal flips / extremes). These are what make the overlay unique.

---

## 5. What to build (concrete, in the existing files)

### 5a. JSON data API (new — Studio is client-interactive, unlike the server-rendered Markets blobs)
Add GET handlers in the `server.js` router (the flat `if (req.method === "GET" && url.pathname ===
…)` chain, ~L1306+; put them near `/markets` ~L1408). All are behind `checkAuth` (called ~L1342).
- `GET /api/catalog` → `{ categories:[{category, label, series:[{id,label,unit}]}], transforms:[…] }`
  from `listSeriesMeta()`. Drives the left rail.
- `GET /api/series?ids=a,b,c` → `{ series:[{id,label,unit,category, points:[{period,value}]}],
  stats:{ [id]: <the marketSnapshot row for that id> } }`. One call feeds a whole spec. (Reuse the
  exact data access `/markets/csv` uses at ~L1417–1420: `listSeriesMeta` + `getSeries`.)
- `GET /api/events?from=&to=` → merged `{date,label,kind}[]` from `calendar_events.2026.json` +
  recent `alerts`. Drives the x-axis flags. Keep it small (cap count).
Return `application/json`; wrap in try/catch → `{error}` with a non-500 friendly body.

### 5b. The page + route
- Add a nav link. Nav is a single `<nav>…</nav>` line at `server.js` **~L297**; add
  `<a href="/studio">Studio</a>`. Active-tab highlight is automatic (the script at ~L299).
- `GET /studio` (~near L1408): `res.end(page("The Bean Brief · studio", studioBody(url)))`. Use the
  existing `page(title, body)` shell so it gets the ISA theme + nav.
- `studioBody()`: emit the three-pane layout (rail / chart / stats), the toolbar (prompt bar shown
  but marked "phase 2" + disabled, range buttons, export buttons), and load
  `/assets/uPlot.iife.min.js`, `/assets/uPlot.min.css`, and the new `/assets/studio.js`. If a
  `?spec=` param is present, inline it so the client rehydrates.
- **Desktop gate:** server can't know viewport, so render the full page but let `studio.js` show a
  friendly "The chart studio is built for a larger screen — open The Bean Brief on a desktop."
  card when `window.innerWidth < ~1000`, hiding the workbench. (Simple + honest; no UA sniffing.)

### 5c. The client — `src/assets/studio.js` (new vendored file, sibling of `bbcharts.js`)
- **Register it in the assets allowlist:** `server.js` **~L1320** has an `ASSETS` map (explicit
  whitelist — `bbcharts.js`, uPlot, logo). Add `"studio.js": "text/javascript; charset=utf-8"` or
  it 404s.
- Responsibilities: read `/api/catalog` → build the rail; on any selection/transform/range change,
  build a spec → `GET /api/series` → apply the client-side transform (§3) → render uPlot (multi-line
  + optional sub-panes with a synced cursor; reuse bbcharts' axis/hover formatting) → draw the
  normal-band and event flags → fill the right-panel stats from the returned `stats` → update the
  `?spec=` URL (`history.replaceState`).
- Keep it vanilla ES5-ish like `bbcharts.js` (no build step). No external fetches beyond same-origin
  `/api/*`.

### 5d. Transforms — pure functions in `studio.js` (see §3). Unit-test mentally against a 3-point
series before wiring. Round every displayed number.

### 5e. Event annotations (the differentiator) — draw `/api/events` as vertical flags on the uPlot
x-axis (uPlot hooks: `drawClear`/`draw`, or a plugin). Distinct color from data lines (the mockup
uses purple). Label the nearest/most-impactful few; don't clutter. This is the feature that makes it
"not just Barchart."

### 5f. Export
- **PNG:** uPlot draws to a `<canvas>`; `canvas.toBlob()` → download. **Before export, composite a
  footer strip** onto the canvas: `Source: <adapters/labels> · <today> · Education, not advice.`
  (pull the standard line from `compliance.js` `EDUCATION_FOOTER`). This is the highest-value
  feature for Matt (charts → Teams/slides) — get it clean.
- **CSV:** reuse `GET /markets/csv?category=` / `?series=` (already builds a wide multi-series CSV,
  `server.js` ~L1414). For an arbitrary multi-series spec, either call it per series or add a small
  `?ids=` variant.
- **Share:** the `?spec=` URL already reproduces the view. "Copy link" = `navigator.clipboard`.

### 5g. Right panel — render the focused series' `marketSnapshot` row: latest + unit + period, Δ
prior, YoY, percentile ("Nth / <count>obs"), seasonal delta. Below it, a **disabled "Explain this
chart" button tagged "phase 2"** so the LLM slot is visible. Then the compliance footer line.

---

## 6. UI / layout (match the mockup)
Three panes on desktop: `grid-template-columns` ≈ `240px 1fr 220px` at full width (the mockup is
compressed to chat width — real app has more room). Left rail scrolls independently if long. Reuse
ISA theme CSS vars already in `page()` (`--isa-blue`, `--isa-gold`, `--isa-dark`, etc. — grep the
`<style>` in `server.js`). Flat, no new fonts. Toolbar: prompt bar (phase-2, disabled) · range
buttons (reuse `#bbrange` styling) · PNG/CSV/Share.

---

## 7. Verify before calling it done (don't ask Matt to check manually)
- Local dev from `C:\Claude tools\isa-umbrel-apps`: `node src/index.js serve --port 8485
  --no-schedule` (DATA_DIR falls back to repo root → local `polibrief.db`/`.env`/`watchlist.json`).
  **Port 8485 is often held by the other chat — pick a fresh port if taken.** Restart after every
  `server.js` edit (no hot-reload). Kill by port, never blanket-kill node.
- **`preview_screenshot` times out on this app** — verify with `preview_snapshot` / `preview_eval` /
  `fetch`. Check the browser console for 0 errors.
- Acceptance checklist:
  - [ ] `/studio` renders behind auth; nav tab highlights; mobile width shows the "open on desktop"
        card, desktop shows the workbench.
  - [ ] `/api/catalog`, `/api/series?ids=…`, `/api/events` return valid JSON; bad input → friendly
        error, not a 500.
  - [ ] Selecting 2 series draws a multi-line chart; the range toolbar narrows all panes; the
        crosshair is synced across panes.
  - [ ] Each transform works: rebase-to-100, YoY %, ratio A÷B, seasonality (one line/year),
        normal-range band.
  - [ ] Event flags from the calendar appear on the x-axis at the right dates.
  - [ ] PNG downloads **with** the source + date + education footer stamped on it; CSV downloads;
        "Copy link" yields a `?spec=` URL that, pasted fresh, reproduces the exact view.
  - [ ] Right panel shows correct `marketSnapshot` stats for the focused series.
  - [ ] Nothing on the existing Markets/Home tabs regressed.

---

## 8. Ship — COMBINED with the political-map tab (ONLY when Matt says "ship it")
Both tabs go out in **one release** (proposed **v1.16.0** — confirm the number once, in whichever
chat does the bump). Do the version bump **exactly once** so the two chats don't collide:
- Reconcile the working tree so BOTH features are present (Studio's new files + its 4 `server.js`
  seams; the map tab's files + its own nav/route seams). The nav `<nav>` line and the `/assets`
  allowlist are the two spots both features edit — eyeball those in the merge.
- Bump once in `isa-umbrel-apps`: `package.json` version + `CHANGELOG.md` (both features' entries) +
  `isa-polibrief/umbrel-app.yml` (version/releaseNotes) + `isa-polibrief/docker-compose.yml` (image
  tag) → commit → `git tag v1.16.0 && git push origin main && git push origin v1.16.0` → the Action
  builds the multi-arch GHCR image → Umbrel refresh store → **Update**. Verify the build is green.
- Both features are **code-only** (no `/data` keys, no watchlist/registry merge) → Pi go-live is
  just **Update**. (Confirm the map tab is also code-only; if it adds a data file or key, fold that
  into the one Pi step.)

---

## 9. Phase 2 / 3 (do NOT build now — just leave clean seams)
- **Phase 2 — LLM prompt → spec.** Constrained Anthropic tool-use: hand the model `/api/catalog` +
  a spec JSON schema; it returns a spec referencing only real series. Reuse the
  `answerQuery`/model-routing plumbing in `pipeline.js`. **The model emits a spec, never data.**
- **Phase 2 — "Explain this chart."** Send the current spec + its `marketSnapshot` stats to Sonnet
  for a written read (it's `answerQuery` pointed at one chart). Compliance-gate the output.
- **Phase 3 — live futures/basis.** When `BARCHART_API_KEY` lands, the `barchart` adapter's series
  slot into the catalog as ordinary series — no Studio changes needed if the spec is series-id based.

## 10. Open questions for Matt (confirm before/early in the build)
1. **Audience:** internal analyst tool (Matt + Grant) or member-safe from day one? Internal = move
   fast; member-facing = the compliance footer/caveats are load-bearing in v1. *(Default assumption:
   internal-first, but stamp exports regardless.)*
2. **First slice:** selector spine first (recommended — shippable, no model cost), prompt bar second.
   *(This doc builds the selector spine as v1.)*
