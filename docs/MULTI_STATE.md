# Bean Brief for N states — design (Phase 3)

**Status:** design only. No refactoring has been done. Everything below waits on your approval.
**Pilot:** Illinois Soybean Association. **Design target:** any state soybean board.

**Goal:** another state board can install Bean Brief, test it and modify it without forking. Iowa keeps producing exactly what it produces today.

---

## 1. Where Iowa is wired in today

Audited 2026-10-04 across `src/`, `scripts/`, `watchlist.json`, `registry.json`, `isa-polibrief/` and the README.

### 1.1 Scale

| Pattern | Count |
|---|---|
| "Iowa" / "iowa", all in-scope files | **800 occurrences in 68 files** |
| …in `.js` / `.mjs` code | 297 in 52 files |
| …in data | 235 in `ia-candidates-2026.json`, 34 in `registry.json` |
| `:ia:` series keys | **86 in 16 files** |
| `"IA"` literals | **58 in 11 files** |
| `America/Chicago` | 23 |

Iowa is also encoded in 13 of 45 test files. Your estimate of ~235 occurrences in ~58 files was the right order of magnitude for the code alone.

### 1.2 By category

| Category | Where (representative) | Becomes |
|---|---|---|
| Identity & branding | logo + `--isa-*` palette (server.js:250-254, 497); email colours (deliver.js:22-63); RSS title; user-agent "Iowa Soybean Association" (util.js:20, summarize.js:35); Studio footer; umbrel-app.yml; README | `identity.*`, `identity.branding.*` |
| Prompt voice | "Iowa soybean farmers" / "an Iowa corn/soybean operation" in triage, newsrank, brief, packets, policycards, policy-domain/review/synthesis prompts, curriculum, 11 places in pipeline.js, memberbrief.js:543-569 | `prompts.voice`, `prompts.operation` |
| Local score boost | "Iowa" as a relevance term (score.js:20) | `identity.stateName` |
| NASS | `state_alpha:"IA"` (usda_nass.js:19, 69, 102, 108, 156); keys `nass:ia:*`; ratio built from literal keys (182-189) | `markets.nass.stateAlpha` + `seriesKey()` |
| AMS | report **2850 = Iowa Daily Cash Grain Bids** (usda_ams.js:37); 3511 filtered to `trade Loc == "Iowa"` (343); six-district grid (235-245); `ams:ia:*` keys | `markets.ams.{cashReportId, feedstuffTradeLoc, districts}` |
| Crop/drought regions | `IOWA_FIPS="19"` (drought_monitor.js:17); `IA` FIPS probe (cropcasma.js:32); AOIs (vegscape.js:32-38); Open-Meteo US regions, 52% Iowa weight (open_meteo.js:16-24); Barchart basis zips (barchart.js:29-30) | `markets.cropRegions`, `weather.usRegions`, `geo.homeFips` |
| Legislature | LegiScan defaults `["IA"]` (legiscan.js:116, 120); watchlist states / fullTextStates; OpenStates `jurisdiction="Iowa"` (seed/openstates.js:29) | `legislature.*` |
| Admin rules | `iowa_admin_rules.js`, a legis.iowa.gov scraper with Iowa-specific selectors (lines 23-61) | `adminRules.adapter` (one adapter per state) |
| Election | Socrata `data.iowa.gov` gated by Iowa Code §68B.32A(7) (seed/socrata.js:20-30); FEC `state=IA` (seed/fec.js:29); `ia-candidates-2026.json`; `ia-incumbents.json` from openstates `ia.csv` | `election.*` (off by default) |
| Geo / map | 5 Iowa GeoJSON files + `district-hucs.json`; `fetch-geo.mjs` (`GEOID LIKE '19%'`, IOWA_BBOX); map centre; facilities filtered to IA (bbmap.js:157); `canonOffice` strips "Iowa " | `geo.*` |
| Registry | 18 of 44 seed entities (delegation, statewide officers, parties, county parties, IA agency feeds) | `registry.seed` |
| Congressional delegation | committee member whitelist `iowa:` + `iowaMembers` (congress_hearings.js:33-45, 156, 180) | `delegation.byCommittee` |
| Crush | national table, but crush.js:287-290 says the home state is "the largest of any state" | `markets.crushPlants.filterState`; fix the sentence |
| Calendars | Iowa filing / primary / legislature dates in `policy_events.2026.json` | `calendars.policyEvents` |
| Provenance hosts | legis.iowa.gov, iowaagriculture.gov, iowadnr.gov, iasoybeans.com (provenance.js:52-116) | `provenance.*` |
| Focus areas | `iowa-water-land` (watchlist.json) | `focusAreas` override |
| Timezone | `America/Chicago` hard-coded in 23 places. **pipeline.js:1890, 1956, 2075 and server.js:44-46, 2118 ignore the watchlist timezone** | `identity.timezone` |
| Delivery / UI copy | "ISA Policy Brief —" subject; chart captions ("Iowa soybean basis", "Iowa drought coverage"); LRD "Iowa" bucket (server.js:2468-2481); every RSS / intake item stamped "Iowa" (rss.js:57, email_intake.js:91) | `identity.*` interpolation |
| Not Iowa-specific | river gauges (lower Mississippi), barge locations, condition triggers, the USDA report calendar | shared / `us-national` |

### 1.3 What would *break* (not just mislabel) in another state

- **Consumers that read `:ia:` keys by literal name:**
  - signals.js:34, 51, 71, 96, 238 and the `SIGNAL_SERIES` / `SIGNAL_CHART` tables
  - crush.js:173, 324
  - leadlag.js:68-71 (its exclusion list would stop matching, so another state's cash series would be wrongly tested as predictors)
  - memberbrief.js:329-330, 396
  - health.js
  - usda_ams.js:409, 486-500
  - usda_nass.js:182-189
  - vegscape.js:195, cropcasma.js:147
- **Adapters that fetch Iowa data and label it as the configured state:** AMS 2850, 3511's `/^iowa$/`, `IOWA_FIPS`, Crop-CASMA's FIPS probe, the VegScape AOIs, NASS `"IA"`, and Barchart's Iowa zip codes. Worse than missing data.
- **`iowa_admin_rules.js`:** can't be reused at all; it fails soft to `[]`.
- **Map join:** `buildMapData` (server.js:1803-1815) keys districts with **no state filter**, so two states' legislators would collide. bbmap.js:157 hides every non-IA facility.
- **Jurisdiction grouping:** a non-Iowa home state's bills land under "Other states" (server.js:2468-2481).
- **Seeders:** fec.js:29, socrata.js:20, openstates.js:29, fetch-incumbents.mjs:15 and fetch-geo.mjs are hard-coded to Iowa.

### 1.4 Iowa-only data files

| File | Size | Content |
|---|---|---|
| `geo/huc8.geojson` | 419 KB | HUC8 watersheds |
| `geo/house.geojson` | 93 KB | House districts |
| `geo/senate.geojson` | 62 KB | Senate districts |
| `geo/counties.geojson` | 38 KB | counties |
| `geo/congress.geojson` | 12 KB | congressional districts |
| `ia-candidates-2026.json` | 71 KB | 2026 candidates |
| `ia-incumbents.json` | 17 KB | incumbents |
| `district-hucs.json` | 11 KB | district ↔ watershed overlap |
| ISA logo, app icon | — | branding |

`registry.json` and `policy_events.2026.json` are mixed Iowa and federal. `crush_capacity.json` and `facilities.json` are national and stay shared.

---

## 2. State packs

### 2.1 The idea

A **state pack** is a versioned data bundle holding everything that makes the app "Iowa" today. The code reads the pack and contains **no state literals outside packs**. The pattern is the one farmOS already proves out in `farmos/backend/app/region_packs/`, and it borrows four properties from it:

- **Versioned and immutable.**
  - A pack is `packs/us-il/2026.1/`.
  - Loading the same version with different content fails ("bump the version"), via the same content-hash rule as farmOS `loader.py`.
- **Validated at load.** A schema (JSON Schema, validated with a small hand-written checker, so no new dependency) rejects a malformed pack *before* the scheduler starts. The `/freshness` page then names the field.
- **Cited and dated where it asserts a fact.**
  - Calendar dates, AMS report ids, plant capacities, river gauges and statute citations each carry `source_url`, `last_verified` and `verify_by`.
  - Past `verify_by`, the item degrades to "unverified" on `/freshness`, exactly as farmOS degrades a program rule.
- **Inherit, then override.**
  - A pack declares `extends: "us-national@2026.1"`. A state overrides only what differs.
  - The federal tier (Federal Register agencies, Congress, CFTC, WASDE, national NASS, EIA, FAS) lives once, in `us-national`.

### 2.2 Layout

```
packs/
  us-national/2026.1/pack.json        # federal sources, national series, shared focus areas, calendars
  us-ia/2026.1/pack.json              # Iowa: extends us-national
  us-ia/2026.1/prompts/voice.md       # "Iowa soybean farmers…" — the prompt voice block
  us-ia/2026.1/geo/                   # counties / districts / HUC GeoJSON (today: src/assets/geo)
  us-ia/2026.1/data/                  # candidates, incumbents, district-hucs (today: src/data/ia-*)
  us-ia/2026.1/branding/logo.png
  us-il/2026.1/…                      # the pilot
```

Packs ship inside the image (`/app/packs`). A state board selects one with `STATE_PACK=us-il` in `.env`, or with first-run setup.

A board may also drop an **overlay** at `/data/pack-overlay.json`. The overlay is deep-merged last, so local changes survive upgrades. This is the "modify without forking" path (§9).

### 2.3 Schema (abridged)

```jsonc
{
  "id": "us-il", "version": "2026.1", "extends": "us-national@2026.1",
  "identity": {
    "orgName": "Illinois Soybean Association", "orgShort": "ISA-IL",
    "stateName": "Illinois", "stateAlpha": "IL", "stateFips": "17",
    "timezone": "America/Chicago",
    "branding": { "logo": "branding/logo.png", "colors": { "primary": "#…", "accent": "#…" } },
    "emailFrom": "The Bean Brief (Illinois Soybean Association)"
  },
  "editions": {                          // the funding/compliance gate (§8)
    "dailyPolicyBrief": { "enabled": true,  "channel": "advocacy" },
    "memberBrief":      { "enabled": true,  "channel": "advocacy", "sections": ["update","policy","markets","watch"] },
    "marketsOnly":      { "enabled": false, "channel": "checkoff" }
  },
  "prompts": {
    "voice": "prompts/voice.md",         // "Illinois soybean farmers", the operation archetype, local vocabulary
    "operation": "an Illinois corn and soybean operation"
  },
  "legislature": {
    "legiscanHome": "IL", "legiscanStates": ["IL","IA","IN","MO","WI"], "fullTextStates": ["IL"],
    "openstatesJurisdiction": "il",
    "sessionCalendar": { "source_url": "https://www.ilga.gov/", "verify_by": "2027-01-15" }
  },
  "adminRules": { "adapter": "il_register", "source_url": "https://www.ilsos.gov/departments/index/register/home.html" },
  "agencies": [{ "name": "Illinois Department of Agriculture", "rss": "…", "host": "agr.illinois.gov" },
               { "name": "Illinois EPA", "rss": "…", "host": "epa.illinois.gov" }],
  "provenance": { "primaryHosts": ["ilga.gov", "ilsos.gov"], "agencyHosts": ["agr.illinois.gov", "epa.illinois.gov"],
                  "advocacyHosts": ["ilsoy.org"] },
  "markets": {
    "nass": { "stateAlpha": "IL", "seriesPrefix": "nass:il" },          // key namespace becomes state-driven
    "ams":  { "cashReportId": "TBD-probe", "processorReportId": "3511", "districts": ["…"], "verify_by": "…" },
    "cropRegions": { "vegscape": ["il","in","ia"], "cropcasma": ["il","in","ia"], "drought": "IL" },
    "barge": { "locations": ["Illinois River", "St. Louis"] },
    "rivers": { "gauges": [{ "lid": "…", "name": "Illinois River at …" }] },
    "crushPlants": { "filterState": "IL" }                              // from the national plant table
  },
  "geo": { "counties": "geo/counties.geojson", "districts": { "congress": "…", "senate": "…", "house": "…" },
           "huc8": "geo/huc8.geojson", "districtHucs": "data/district-hucs.json" },
  "registry": { "seed": "registry.json" },                              // the state's entities
  "election": {                                                         // §7.7 — off unless counsel signs off
    "campaignFinance": { "enabled": false, "useRestriction": "…statute…", "flag": "STATE_CF_INFORMATIONAL_USE" }
  },
  "focusAreas": { "inherit": true, "add": [ { "id": "illinois-water-land", "label": "…", "terms": ["…"] } ],
                  "replace": { "iowa-water-land": null } },
  "news": { "rss": ["…state ag press…"] },
  "emailIntake": { "senders": ["…"] },
  "calendars": { "policyEvents": "data/policy_events.2027.json" },
  "recipients": { "memberBriefToEnv": "MEMBER_BRIEF_TO" }               // addresses never live in a pack
}
```

**Override vs. inherit:**
- Objects deep-merge.
- Arrays replace by default.
- An explicit `{ "inherit": true, "add": [], "replace": {} }` form is available where adding to the parent is the common case: focus areas, provenance hosts, RSS.
- `null` removes an inherited entry.

### 2.4 Series keys become state-driven

**The one breaking-shaped change.** Market series keys are literal Iowa today: `nass:ia:soy-corn-ratio`, `ams:ia:basis`, `vegscape:ia:vci`, `drought_monitor:ia:d1`, `cropcasma:ia:rootzone-sm`. Consumers read them **by literal name**: `signals.js`, `crush.js`, `leadlag.js`, `triggers.js`, `memberbrief.js`.

The rule:
- Adapters write keys under `<source>:<stateAlpha-lower>:…`, driven by the pack.
- Consumers ask a single resolver for keys:
  - `seriesKey("nass", "soy-corn-ratio")` → `nass:ia:soy-corn-ratio` under the Iowa pack, `nass:il:soy-corn-ratio` under Illinois;
  - the `us` scope stays `nass:us:…`.
- Iowa's keys are therefore **unchanged**, and the Iowa database needs no migration.

---

## 3. Deployment model

| | (a) One instance per state, own hardware | (b) One multi-tenant instance ISA hosts | (c) Hybrid: shared data commons + per-state instances |
|---|---|---|---|
| Data separation | Total. Each board's DB, inbox, recipients and feedback stay on its own box | Logical only. One DB with tenant ids, so one bug can leak across boards | Total for state data. Only public-domain federal data is shared |
| Editorial control (prompts, focus areas, what gets sent) | Each board, fully | ISA hosts it, so ISA is in the loop on every change | Each board, fully |
| Who pays Anthropic | Each board, its own key | ISA, unless keys are per-tenant, which complicates billing and data handling | Each board, its own key |
| Support burden on ISA | Low per state, but N installs to help debug | One install, but ISA becomes an operator with uptime duties to other organizations | Low: ISA operates the commons only (static files, see §4) |
| Failure isolation | Perfect | One outage takes down every state | A commons outage → automatic fallback to direct fetch (§4.4) |
| Distribution | Same GHCR image + Umbrel community store as today | Not an Umbrel app; needs a real server, auth and tenancy | Same image; the commons is just a URL |
| Legal/funding separation (§8) | Per board, natural | Hard: ISA would be hosting other boards' advocacy content | Per board, natural |

**Recommendation: (c), the hybrid.**
- Each state runs its own instance of the *same* image (as (a)).
- ISA additionally publishes the public-domain federal data once a day as a signed, versioned **data commons** that instances consume.
- Multi-tenancy (b) is the wrong trade for advocacy organizations: it puts ISA in the operational and legal path of other boards' editorial decisions and their checkoff/non-checkoff separation, for a saving of one Raspberry Pi per state.

---

## 4. The shared data commons

### 4.1 What goes in

Normalized series and items from **public-domain federal sources only**:

| Group | Sources |
|---|---|
| Positioning and supply | CFTC COT, NASS national (crush, stocks, prices, condition), WASDE |
| Demand, energy, logistics | EIA, FAS export sales, AgTransport (inspections, barge by location), NOAA CPC, NWS river stages |
| Macro | FRED |
| Federal policy items | Federal Register, Congress.gov (bills and hearings), Regulations.gov (with the enrichment already done), CourtListener |

**Not** in the commons:
- **Licensed data:** Barchart, CME settlements, RIN/LCFS/carbon prices from the EcoEngineers email, any paid feed. Each state supplies its own and accepts its own terms. CME's market-data policies restrict redistribution, so re-publishing settlements from ISA's Pi to other organizations is exactly what to avoid.
- **State data:** LegiScan state bills, state admin rules, state AMS cash bids, state crop regions.
- **Anything model-written:** triage verdicts, packets, cards. Editorial judgement stays with each board.

### 4.2 Shape

- A daily directory published to a static host, e.g. GitHub Pages or an R2/S3 bucket fronted by the GitHub repo:

  ```
  commons/2026-10-04/manifest.json
  commons/2026-10-04/series/<source>.jsonl.gz
  commons/2026-10-04/items/<source>.jsonl.gz
  ```

- Each record keeps its **full provenance**: `source_id`, `source_url`, publisher, `retrieved_at`, and for series the original period.
- The `market_series_vintage` trail ships too, so revisions stay visible downstream and lead-lag stays lookahead-free.
- `manifest.json` lists every file with its SHA-256 and carries an **Ed25519 signature**. Instances pin the public key in the image and verify before importing; a bad signature is treated as "commons unavailable".
- `schemaVersion` gates compatibility: an instance refuses a manifest whose major version it doesn't know.

### 4.3 Freshness / SLA

- **Publish:** by 05:45 CT daily (before any state's 06:30 AM run), plus an afternoon refresh at 15:30 CT for the PM run and for Friday's 2:30 p.m. ET CFTC release.
- **Best effort, not contractual.** The commons is an optimization; correctness never depends on it (§4.4).
- `/freshness` shows `commons: <date> verified ✓` or `fallback: direct fetch (reason)` per source.

### 4.4 Fallback

The commons is a **source adapter**: `commons.js` implements the same `fetchItems` / `fetchSeries` interface. For each federal source the instance:
1. Tries the commons for today.
2. If the manifest is missing, older than 30 h, unsigned or fails verification, calls the original adapter directly. That needs the state's own key if one is required; missing keys are reported by first-run setup (§5).

Provenance is preserved end to end. A series imported from the commons keeps `source_id = "cftc"`, and the Member Brief's citation still says "CFTC Commitments of Traders" with the CFTC URL. The commons is plumbing, never a cited source.

---

## 5. API keys

| Key | Free? | Each state must hold? | With the commons |
|---|---|---|---|
| **Anthropic** | paid | **Yes — strictly bring-your-own.** It covers billing, the monthly budget (`budget.js`), data handling (each board's own prompts and inbox go only to its own account) and rate limits | unchanged |
| LegiScan | free (30k queries/mo) | **Yes** — state bills are per state, and the quota is per registrant | unchanged |
| OpenStates | free | Yes, if the registry seeder is used | unchanged |
| USDA AMS (MyMarketNews) | free | **Yes** — state cash/basis reports | unchanged |
| NASS Quick Stats | free | Only for state-level series | national series come from the commons |
| Congress.gov / data.gov (also Regulations.gov) | free | **No** | from the commons; key only for fallback |
| EIA, FAS, FRED | free | **No** | from the commons; key only for fallback |
| FEC | free | Only if federal candidates are seeded | — |
| Census trade | free | No | candidate for the commons |
| CME settlements, Barchart, RIN/LCFS email | licensed / per-org | Each state decides and accepts terms | **never** in the commons |
| SMTP, IMAP collector | per org | Yes | unchanged |

**First-run setup check.** This is a new `setup` page and `node src/index.js setup`, built on `src/health.js`, which already reports key presence. It prints:
1. Which pack is active and whether it validated.
2. For each source, `ready` / `degraded` / `off`, with the exact reason. Example: *"LegiScan: no LEGISCAN_API_KEY — Illinois bills will not be collected. Get a free key at legiscan.com/legiscan → API."*
3. What is degraded without each missing key. Example: *"No NASS_API_KEY: national series still arrive via the commons; Illinois prices received and the Illinois soy:corn context line will be missing."*
4. A one-line test of SMTP and of the Anthropic key, at about $0.001.

---

## 6. Email and briefs

There are three options:
- **(1)** One shared Bean Brief.
- **(2)** Fully separate per-state editions.
- **(3)** A national core plus a state insert.

**Recommendation: (2) per-state editions from one engine, with the *federal section shareable* as an opt-in.**
- **(1) is wrong for advocacy.** Each board's members need their own legislature, their own agencies and their own priorities, under their own name, and each board must decide what goes out under its letterhead.
- **(3) sounds efficient but couples editorial calendars and fact-checking across organizations.** A national core written once means one board's reviewer signs off on text another board sends.
- **Federal policy cards are already deterministic data** (event-keyed, cited, banded). A state's Member Brief simply *includes* federal actions from its own pipeline. It costs a few cents per edition, and each board's adversarial review covers everything it sends.
- **If boards later want a joint product** (e.g. a regional RFS update), it is a fourth edition with its own pack-level "co-publishers" list and an explicit sign-off step, not a change to the per-state briefs.

---

## 7. State-specific connectors

| Need | Iowa today | Generalize as | Illinois specifics |
|---|---|---|---|
| Admin-rule bulletin | `iowa_admin_rules.js` (HTML scrape, Iowa selectors) | an `adminRules` interface; one adapter per state, chosen by the pack | **Illinois Register** (Secretary of State; published weekly). New adapter `il_register.js`. The fixture-driven test harness (§9) is mandatory, because scrapers break silently |
| State agency news | registry RSS (some IA agencies) | pack `agencies[]` → registry channels | IDOA (agr.illinois.gov), Illinois EPA (epa.illinois.gov). RSS where offered, `press_page` scrape otherwise |
| Legislative hearing calendar | Congress hearings only | pack `legislature.hearings` adapter | Illinois General Assembly committee hearings (ilga.gov). Probe for a machine-readable feed first |
| State ag press RSS | registry/news | pack `news.rss[]` | the state's farm press, chosen by ILSoy staff |
| Drought / condition | `drought_monitor:ia:*`, `nass:ia:condition`, VegScape/CASMA AOIs | pack `markets.cropRegions` | `drought_monitor:il:*`, `nass:il:condition`, AOIs il/in/ia |
| Crush / processing | national plant table + Iowa map markers | filter the national table by `stateAlpha` | 6 Illinois plants already in `crush_capacity.json` (ADM Decatur and Quincy, Bunge Cairo and Gibson City, Cargill Bloomington, Incobrasa Gilman) |
| River / terminals | Mississippi gauges (Memphis → New Orleans); barge St. Louis | pack `markets.rivers.gauges`, `markets.barge.locations` | **Illinois River** barge rate (1.40.0 already stores it) and Illinois River gauges. NWPS ids to be probed and cited |
| Cash/basis | AMS 2850 (Iowa Daily Cash Grain Bids) + district field `trade_loc` (6 Iowa districts) | pack `markets.ams.cashReportId` + district field + labels | the AMS Illinois cash grain report. Id and district field to be found with a probe like `scripts/probe-ams-districts.mjs`, which is Iowa/2850-specific today and becomes report-id-parameterized; **not guessed here** |
| Election / campaign finance | IECDB via Socrata, gated by Iowa Code § 68B.32A(7) | pack `election.campaignFinance` with `enabled:false` + a required informational-use flag | Illinois campaign-finance data comes from the State Board of Elections. **Assume an analogous use restriction until counsel confirms.** Federal: FEC data carries 52 U.S.C. § 30111(a)(4) (no use for soliciting contributions or commercial purposes). Ship disabled |

---

## 8. Funding / compliance gate

**What is decided here.** Checkoff dollars generally cannot fund policy or legislative work, so a board may need advocacy content produced and distributed with non-checkoff funds, on a separate channel. Bean Brief **does not decide** which content is which. It makes the split **configurable, enforced and visible**:

- **`editions.<id>.enabled` and `editions.<id>.channel`** in the pack, where channel is a label the board defines (e.g. `checkoff`, `advocacy`).
  - Each channel can have its own recipients, SMTP sender, footer, and **Anthropic key** (`ANTHROPIC_API_KEY__ADVOCACY`), so spend is attributable to the right funding source.
- **Section-level control:** `memberBrief.sections` can drop `policy` for a markets-only edition on a checkoff channel. The renderer simply omits the section; nothing policy-related is drafted or sent on that channel.
- **Spend attribution:** `token_usage` gains a `channel` column. `/freshness` shows spend per channel so the funding split is auditable.
- **Documented:** a `FUNDING.md` template in each pack where the board records *its* determination and counsel's sign-off. The code only enforces what the board wrote.

---

## 9. Customization and contribution without forking

- **Local overlay.** A board edits `/data/pack-overlay.json`: focus areas, prompt voice additions, report schedule, extra RSS, provenance hosts. It is deep-merged over the shipped pack, survives every Update, and shows in Settings as "local changes".
- **Upgrade path.**
  - ISA ships `us-il@2026.2` inside a new image.
  - On start, the app loads the new pack version, re-applies the overlay, and **reports conflicts**: an overlay key that no longer exists in the schema is listed on `/freshness` and ignored rather than silently dropped.
  - Pack versions are recorded per run, so a brief can always be traced to the pack that produced it.
- **Prompts.**
  - The state-specific *voice block* is pack data.
  - The *rules* (citation, tokens, bands, advice) stay in code, because they are the safety contract and must not drift per state.
  - A board can add vocabulary and examples but not delete a rule.
- **Contributing an adapter back:**
  - PR conventions: one adapter per PR, with a `probe-<id>.mjs`, recorded fixtures under `test/fixtures/<id>/`, and a test using the shared **adapter test harness**.
  - The harness: given a fixture, the adapter returns well-formed items/series; failures throw (no silent `[]`); keys follow the pack's namespace; `source_health` records the outcome.
  - CODEOWNERS: ISA reviews the core; a state's pack directory is co-owned by that state's maintainers.
- **Repo / GitHub:**
  - Keep **one repo** (`mherman1990/isa-umbrel-apps`, or a neutral org such as `soybean-boards/bean-brief` if boards want shared governance).
  - Packs live in `packs/`; the image carries all packs.
  - The release flow (`auto-release.yml`) is unchanged.
  - A state that wants to run unreleased changes can use the **same** image with an overlay. A fork should never be necessary.

---

## 10. Onboarding — Illinois, under an hour

| Step | Time | What |
|---|---|---|
| 1 | 10 min | Raspberry Pi 5 / 8 GB / NVMe with umbrelOS (or any Docker host) |
| 2 | 5 min | Umbrel → App Store → Community App Stores → add the repo URL → install **The Bean Brief** |
| 3 | 10 min | Open the tile. First-run setup asks for the pack (`us-il`), then shows the key checklist (§5) |
| 4 | 15 min | Get the free keys (LegiScan, AMS, NASS; optional Congress/EIA/FAS/FRED for fallback); paste the Anthropic key; set SMTP |
| 5 | 5 min | Settings: monthly AI budget, recipients for each edition, schedule |
| 6 | 10 min | **Run a test refresh** (dry run, $0), then **Preview Member Brief**. Read it. Check `/freshness` is green |

---

## 11. Security

- **Auth per instance.** The existing per-user login (`auth.js`) is per state install. With (c) there is no cross-tenant surface.
- **Secrets never in packs or the repo.**
  - Packs are validated to contain no field matching `/key|token|pass|secret/i` with a value.
  - Recipients live in `.env`, Settings or `/data/member-list.txt`, never in a pack.
- **Logging never prints keys.** Already true of the freshness audit (tested). Extend with a log redactor in `captureConsole()` that masks any value of a known secret env var, plus a test that greps a full run's log for the key.
- **Commons integrity.** Signed manifest (§4.2), pinned public key, SHA-256 per file, and fallback on any failure. The commons can make an instance stale but never wrong.
- **Isolation if multi-tenant is ever chosen:** separate DB files per tenant, a separate Anthropic key per tenant, no shared kv/cache. This is noted for completeness; it is not recommended.

---

## 12. Recommended architecture

Hybrid (§3c):
- **Code:** one image, one repo.
- **Per state:**
  - its own instance on its own hardware;
  - a pack selected per state (`STATE_PACK`) with a local overlay;
  - bring-your-own Anthropic key and licensed feeds;
  - its own editions and channels under its own name.
- **Shared:** a signed daily commons of public-domain federal data, with automatic fallback to direct fetch.

## 13. Migration plan (Iowa-only → pack-driven)

**The rule:** every step ships behind a passing **Iowa snapshot test**. A recorded fixture DB plus a fixed clock and a stubbed model is run through the full AM run, the Member Brief preview and the `/markets` render. Each step must produce **byte-identical** prompts, series keys, rendered briefs and page HTML compared with the pre-pack baseline. The test is written **first** (step 0), against today's code.

| Step | Change | Proof |
|---|---|---|
| 0 | Record the baseline: fixture DB (anonymized), golden files for the 5 model prompts, the brief, the Member Brief, `/markets`, `/` | the snapshot test exists and passes on today's code |
| 1 | `packs/us-national` + `packs/us-ia` carry today's literals; add the loader, validator and `pack()` accessor; nothing reads them yet | snapshot unchanged; the validator test covers bad packs |
| 2 | Identity, branding, timezone, email subjects, UI copy read from the pack | snapshot unchanged |
| 3 | Prompt voice blocks read from the pack | **prompt** golden files unchanged byte-for-byte |
| 4 | `seriesKey()` resolver; adapters and consumers (signals, crush, leadlag, triggers, memberbrief) use it | series keys unchanged; the Iowa DB needs no migration |
| 5 | Legislature, admin-rules adapter selection, registry seed, geo layers, election gate from the pack | snapshot unchanged |
| 6 | Markets config (AMS report and districts, crop regions, rivers, barge locations, crush filter) from the pack | snapshot unchanged |
| 7 | Overlay + first-run setup + `/freshness` pack section | snapshot unchanged |
| 8 | **Illinois pack** + `il_register.js` + Illinois AMS probe, behind `STATE_PACK=us-il`; an Illinois fixture snapshot of its own | Iowa snapshot unchanged; Illinois snapshot reviewed by ILSoy |
| 9 | Commons publisher (GitHub Action on a schedule) + `commons.js` adapter + signature verification | Iowa snapshot unchanged with the commons on *and* off |
| 10 | Channels + per-channel keys/recipients/footers + `token_usage.channel` | snapshot unchanged with one default channel |

Each step is a separate PR and a separate minor release, so a regression is bisectable to one step.

**Status (1.41.0):** steps 0–8 are implemented, one commit per step. The Iowa snapshot stayed byte-identical throughout; the only re-record was a harness fix to the asset cache-buster scrub, and it touched no state output.
- **Steps 9–10** (commons, channels) wait on open questions 2 and 4 in §15.
- **Built beyond the table:**
  - `node src/index.js setup` and the `/setup` page;
  - the `abstract` flag on base tiers;
  - `export const state` on state-specific adapters;
  - per-state `state` / `stateNotes` on calendar events.
- **Gaps that remain:**
  - focus areas, news RSS and email-intake senders still come from the shared `watchlist.json`, not the pack;
  - pack-driven branding colours.

## 14. The Illinois pack (pilot contents)

- **Identity:** Illinois Soybean Association, IL, FIPS 17, `America/Chicago`. Branding assets from ILSoy.
- **Legislature:**
  - LegiScan home `IL`, full text `IL`, watch states chosen by ILSoy.
  - OpenStates `il`.
  - General Assembly calendar from ilga.gov, with `verify_by`.
- **Admin rules:** Illinois Register adapter (new).
- **Agencies:** IDOA and Illinois EPA (RSS / press pages); Illinois hosts added to provenance (ilga.gov, ilsos.gov primary; agr.illinois.gov, epa.illinois.gov agency; ilsoy.org interested party).
- **Markets:**
  - NASS `IL` series.
  - The AMS Illinois cash-grain report: the id is **to be probed**.
  - Crop regions il/in/ia.
  - Drought IL.
  - Barge: Illinois River + St. Louis.
  - Illinois River gauges: **to be probed and cited**.
  - Crush plants filtered to IL (6, from the existing table).
- **Geo:** Illinois counties, congressional and legislative districts, HUC8. `scripts/fetch-geo.mjs` is Iowa-specific today (Iowa bounding box, Iowa SWCD service), so it needs a FIPS/bbox parameter in step 5.
- **Focus areas:** the shared national set, plus an Illinois water/land area to be defined by ILSoy, which replaces `iowa-water-land`.
- **Election:** campaign-finance seeding **off**; counsel to confirm the Illinois State Board of Elections data-use terms.
- **Editions:** the daily policy brief and the Member Brief on an `advocacy` channel; a markets-only edition available on a `checkoff` channel if ILSoy wants one.
- **Prompts:** voice "Illinois soybean farmers", operation "an Illinois corn and soybean operation".

## 15. Open questions for you

1. **Repo home.** Keep `mherman1990/isa-umbrel-apps`, or move Bean Brief to a neutral org that participating boards co-own?
2. **Commons operator.** ISA publishes and signs the daily commons. Is ISA willing to be the operator (cost is effectively zero, but it is a public commitment), and should other boards be able to see who consumes it?
3. **Licensing.** Will each board get its own read on CME / EcoEngineers terms, or does ISA want to commission one opinion the boards can share?
4. **Funding split.** Do you want the `channel` concept (advocacy vs. checkoff) built in from step 10, or only when a board asks?
5. **Shared editions.** Is a joint regional product (e.g. RFS) something boards have asked for, or is per-state enough?
6. **Illinois counterparts.** Who at ILSoy owns editorial sign-off, keys and hardware for the pilot? The onboarding hour assumes someone who can paste keys and read a preview.
7. **Election data.** Should campaign-finance seeding exist in the multi-state product at all, or stay Iowa-only behind its current gate?
8. **Snapshot fixture.** May I build the Iowa snapshot fixture from an anonymized copy of the Pi's database? That makes the "byte-identical" proof realistic; a synthetic fixture is the fallback.
