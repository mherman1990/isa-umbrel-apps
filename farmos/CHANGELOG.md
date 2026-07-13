# Farm OS Changelog

(Separate from the repo-root CHANGELOG.md, which tracks Bean Brief.
Farm OS releases use `farmos-v*` git tags.)

## 0.2.1 — Re-release of 0.2.0 (accounting + agronomy + boundary editor)

Same feature set as 0.2.0, rebuilt from the correct commit. The original
`farmos-v0.2.0` tag was created against a 0.1.3-era commit and its image
build workflow was cancelled, so no `0.2.0` images were ever pushed to GHCR
and the Umbrel install failed with an image-pull / manifest-unknown error.
0.2.1 cuts a fresh tag from `main` (which carries all the 0.2.0 code) so the
multi-arch `farmos:0.2.1` and `farmos-db:0.2.1` images actually get built and
published. No feature-code changes versus 0.2.0 — version bump only
(umbrel-app.yml, docker-compose.yml image tags, backend pyproject.toml).

## 0.2.0 — Accounting + Agronomy expansion

### Added — Accounting
- **Schedule F classification** (`GET /financials/schedule-f?year=`): whole-farm
  income/expense rolled up to IRS Schedule F (Form 1040) lines from a new
  **versioned tax pack** (`tax_packs/schedule-f-2025.yaml`) carrying
  `source_url` + `last_verified` + `verify_by` — the same data-not-code
  discipline as region packs. Only recognized categories land on a line;
  unknown categories and the default `other` are surfaced as `uncategorized`
  and **left out of the totals** — the app never guesses a dollar onto a tax
  line (the financial cousin of "insufficient data"). Money-tab card shows net
  farm profit, the line detail, and the uncategorized gap.
- **Lender packet export** (`GET /financials/lender-packet?year=&format=json|html`):
  a printable income statement (Schedule F basis) + budget-vs-actual +
  per-field breakeven + grain position, assembled entirely from records. It
  discloses what it **cannot** show — no balance sheet, because Farm OS holds
  no asset/debt records — and flags the income statement as incomplete when
  uncategorized money exists. The `html` format is a self-contained,
  dependency-free printable page (every dynamic value HTML-escaped) that the
  PWA opens and prints to PDF; Money-tab "Export lender packet" button.
- **Cash-flow projection** (`GET /financials/cash-flow?year=`): month-by-month
  planned cash position — outflow spreads the farmer's OWN budget total across
  the year by a new **cited timing pack** (`cashflow_packs/ia-cashflow-2026.yaml`,
  ISU Ag Decision Maker, `verify_by`); inflow counts ONLY priced grain
  contracts placed in their delivery window. The deepest cumulative deficit is
  the **peak operating need**. Everything unprojectable — unpriced contracts,
  uncontracted production, budgeted crops with no acres — is listed as a gap,
  never estimated. Money-tab card with the monthly table + gaps.
- **Operating-line tracking** (`GET/POST /operating-loans`,
  `POST /operating-loans/{id}/events`): a draw / paydown / interest ledger per
  line of credit; the outstanding balance and available credit are **derived
  from the ledger, never entered** (`client_id` idempotent, over-limit
  flagged). Surfaced in the cash-flow view and Money-tab card; demo seed ships
  a sample line. Migration 0008 (new tables); restore drill re-verified.
- **Enterprise allocation / transaction edit** (`PATCH /transactions/{id}`):
  re-assign a transaction's category, crop, field, and crop-year after the
  fact (audited; explicit `null` clears an allocation, unknown field → 422).
  Closes the half-built gap where allocation could only be set at create
  time. Money-tab transactions are now tap-to-allocate — recategorizing a
  transaction moves it off the Schedule F "uncategorized" list onto its line,
  and field-tagging feeds per-field breakeven.
- **Operating-mode scenarios** (`POST /financials/scenarios`): compare the
  producer's net income AND cash outlay under own / cash-rent / crop-share for
  a set of assumptions (acres, yield, price, operating cost, rent, share). Every
  figure is arithmetic on the entered inputs — a structure whose parameter is
  missing is omitted with a gap, never fabricated. Includes a plain comparative
  verdict (per the owner's decision that this app has no education-not-advice
  limit; see HANDOFF §6). Money-tab "Compare tenure" card.
- **Lease entity wired** (`GET/POST/PATCH/DELETE /leases`): the previously
  orphaned tenure record is now usable — owned / cash-rent / crop-share / flex,
  landlord, producer share, rent (`client_id` idempotent; migration 0009 adds
  it, restore drill re-verified). Money-tab tenure list + add form; demo seed
  ships a cash-rent and a crop-share lease.

### Added — Agronomy
- **N-rate / MRTN decision support** (`GET /agronomy/n-rate`): the economically
  optimal corn nitrogen rate for the entered corn & N prices and rotation
  (Iowa State Maximum Return To Nitrogen approach), with the profitable range,
  agronomic maximum, and net return. Optionally compares to the N actually
  applied (passed in, or read from a `nutrient_mgmt` practice) and shows the
  dollars left on the table. Response coefficients ship as a **new cited
  region-pack `mrtn` section** read at compute time (no DB/migration), flagged
  `unverified: true` — the output links the ISU calculator and says "confirm
  before applying." Programs-tab card.
- **Fungicide-ROI decision support** (`POST /agronomy/fungicide-roi`):
  expected-value return on a foliar fungicide pass from grain price, product +
  application cost, and cited yield-response ranges by disease-pressure
  scenario (low/moderate/high), with the break-even response and a
  pays-for-itself flag per scenario. Response ranges ship as a new cited
  region-pack `fungicide_roi` section (`unverified: true`); the tool refuses to
  massage a losing pass into a winner. Programs-tab card.
- **Practice economics** (`GET /agronomy/practice-economics`): net $/ac of a
  conservation practice = **best verified program payment (via the stacking
  engine)** − typical practice cost. Paying programs are auto-discovered from
  their evidence specs (or passed explicitly); costs ship as a new cited
  region-pack `practice_costs` section. Structural/cost-shared practices with no
  clean per-acre cost (buffers, terraces, waterways) return "no cost basis"
  rather than a fabricated number. Programs-tab card.

### Added — GIS / fields
- **Leaflet boundary editor** (Farm tab): a map of every field boundary you can
  edit by dragging vertices, or draw a new field with the polygon tool. Backed
  by `PUT /fields/{id}/boundary` (edit) and `POST /fields` (create-by-draw),
  both validating the drawn GeoJSON (rejecting self-intersecting/out-of-range/
  degenerate outlines — never silently repaired) and recomputing acres on the
  equal-area EPSG:5070 projection; an edited field becomes `source='manual'`.
  The **aerial-imagery basemap is opt-in and OFF by default** — the editor works
  fully offline on a blank canvas, and turning on Esri imagery (external tiles
  that reveal the field location) is disclosed in Settings → "what leaves this
  box". Verified end-to-end in a headless browser against the demo farm.
## Also unreleased — Phase 5 assistant + sandbox

- **Assistant chat** (`POST /assistant/chat` + Ask box on the capture
  screen): one metered reasoning-tier call per question over a structured
  snapshot of the farm's actual records; cites record ids; instructed to
  say "I don't have that recorded" rather than fabricate; marketing
  questions get data, never recommendations. Client holds history
  (stateless server, native-client-ready).
- **Sandbox mode**: `FARMOS_DEV_FAKE_LLM=1` swaps in a $0 local stub
  (every output labeled "[sandbox model]") and `python -m app.manage
  seed-demo` builds a full demo farm — 6 fields, rotation, operations,
  inventory, money, contracts, scale tickets, practices with tamper-
  evident evidence, an enrollment, and a 3-record voice capture waiting
  in the inbox — so the whole product is exercisable with zero real data
  and no API key.
- **Two production bugs found by sandboxing**: the web process never
  opened the job-queue connector (deferred jobs failed until the nightly
  retry) — now opened in the FastAPI lifespan; and the worker crashed at
  boot because run_worker needs an async connector — now swapped in via
  replace_connector. Captures degraded safely in both cases, as designed.

## Unreleased — Phase 3: conservation engine

### Added
- **Practice inventory** with evidence links (captures / documents /
  operations; tamper-evident status per item) and program enrollments.
- **Stacking/additionality checker** (`GET /programs/stacking` + Programs
  UI): pairwise relations from region-pack data (6 Iowa rules incl. the
  IDALS-discount exclusions, SWOF additionality, WQI+EQIP stackable),
  exhaustive combination enumeration, best-verified-combo ranking that
  never names an uncited or stale relation. 7-test rule matrix (HR #18b).
- **MRV readiness** (`GET /programs/{key}/readiness?crop_year=`):
  per-requirement, per-practice met / partial / missing with windows,
  days-left countdown, window-closed flags, and verifier-grade checks
  (in-app provenance + timestamp proof). Evidence specs are region-pack
  data (`EvidenceRequirement`); Iowa pack 2026.4 ships SWOF photo
  requirements and IDALS WQI documentation requirements.
- Representative `payment_per_acre` on computable programs; migrations
  0004–0005; restore drill re-verified.

## Earlier unreleased — capture complete + Phase 2 core

### Added
- **Photo/document routing** — capture layer complete: vision classify
  (document / scouting / equipment / field photo), documents land in the
  vault immediately with type-specific extraction (receipt, scale ticket,
  seed tag, applicator record, soil test) confirmed via the inbox; field
  photos attach to the nearest field by GPS; Docs vault UI; camera-roll
  HEIC re-encodes client-side.
- **OpenTimestamps anchoring** (spec §2): nightly nonced Merkle batch to
  public calendars, standard `.ots` proofs (stock client verifies),
  6-hourly upgrade to Bitcoin-attested, `GET /captures/{id}/proof`,
  privacy disclosure lists the nightly hash. UI says "tamper-evident".
- **Mapping-assisted spreadsheet importer**: model proposes tab/column
  mapping (blue-font input convention as a signal), farmer confirms once,
  mapping persists by content hash; rotation matrix → crop years,
  transactions/budget tabs → money records; warnings never guesses.
- **Accounting seed**: transactions (offline-idempotent), budget lines,
  `GET /financials/summary` — budget vs actual per crop and per-field
  breakeven $/bu with prorated crop-level costs; "insufficient data"
  with reasons instead of estimates. Money tab UI.
- **Weather auto-attach**: Open-Meteo nearest-hour conditions at the field
  centroid on operation confirm (async; degrades to nothing; nightly
  backfill) — the wind/temp line an RUP record needs.
- **Soil tests**: a confirmed soil-test document with a field becomes a
  `soil_test` row.
- **Nudges** (`GET /nudges`, shown on Programs): program deadlines within
  45 days (machine-readable pack dates, Iowa pack → 2026.2 with loader
  version supersession), failed captures, spend-cap parked items, backup
  staleness.
- Migrations 0002 (money/workbooks/soil tests) + 0003 (deadline dates);
  restore drill re-verified across both. API test suite now 20 tests.

## Also unreleased — compliance, grain, brief

- **RUP compliance** (`GET /compliance/rup`): spray operations using
  EPA-registered products graded against the pack's legal required-field
  list (7 U.S.C. 136i-1; pack 2026.5), missing fields named per record.
- **Grain position ledger** (`GET /grain/position` + Money card) derived
  from harvest records, confirmed scale tickets, and contracts, with
  storage posture from the profile and named gaps; offline-idempotent
  contract tracker with delivery application. No advice — deferred per
  the framing decision.
- **Daily brief** (05:30 job + `GET /brief/latest` + capture-screen card):
  reasoning-model summary composed ONLY from stored facts (inputs saved
  beside the output for traceability); skips cleanly without a key or at
  the spend cap. Migrations 0006–0007.

## 0.1.0 — Phase 1 foundation: capture, fields, programs, backups

### Added
- **Capture layer**: hold-to-talk voice (≤45s, MediaRecorder), photo and
  file drop; every capture queues in IndexedDB first and drains through the
  idempotent `POST /captures` / `POST /sync/batch` protocol — a record is
  never lost to a dead zone. Raw artifacts are append-only and never deleted.
- **Pipeline**: local whisper.cpp `base.en` transcription on a single-flight
  job queue (nice -15, 2 threads — polite to a co-resident Bitcoin node),
  cheap-model multi-record extraction (one capture → N typed records with
  per-record confidence and explicit ambiguities), confirmation inbox with
  Confirm / Fix / Discard. Unresolved ambiguities block confirmation
  server-side; nothing writes a farm record without a human.
- **Field registry** with farmers.gov CLU import (zipped shapefile or
  GeoJSON, defensive attribute matching, preview → apply), equal-area
  acreage recompute cross-checked against the export's acres attribute.
- **FSA-578-ready schema**: crop years carry first-class CART/NIEM-named
  columns (FarmNumber/TractNumber/FieldNumber, intended use, planting
  dates, producer share, irrigation practice, prevented planted, failed
  acres).
- **Iowa region pack 2026.1** (9 programs: EQIP, CSP, CRP-continuous,
  IDALS WQI cover-crop cost-share, IDALS/RMA insurance discount incl. the
  stacking exclusion, IA beginning-farmer tax credit, SWOF, Bayer
  ForGround, PFI) + thin Program Finder — citations and
  `last_verified`/`verify_by` on every claim; staleness auto-labeled.
- **Cost engineering**: farmer's own Anthropic key (stored on-box in
  `/data/secrets`, never in the DB), explicit cheap/reasoning model router,
  every call metered to `api_spend`, hard monthly cap that parks parsing
  without ever blocking capture, spend meter UI.
- **Auth**: device tokens (hash-at-rest) + 6-digit single-use pairing codes;
  bootstrap only while the user table is empty. No browser sessions — a
  native client pairs the same way.
- **Backups**: nightly restic snapshot (pg_dump + artifacts + secrets +
  config) to USB path and/or the farmer's own S3 bucket, client-side
  encrypted; recovery phrase shown once; `farmos-restore` CLI; restore
  drill (seed → backup → wipe → restore → verify) in CI.
- **Tests**: 26-case voice-parser eval set with an F1 ≥ 0.90 CI gate
  (replay mode, zero API calls), unit tests on the rule engine and spend
  math, API tests against real PostGIS covering the full
  capture→inbox→record flow, sync idempotency, CLU import, and spend-cap
  parking.
- **Umbrel packaging**: `isa-farmos` app (port 8585) with web/worker/db
  services, memory limits sized for an 8GB Pi 5 sharing RAM with Bitcoin
  Core + LND; multi-arch images on `farmos-v*` tags.
