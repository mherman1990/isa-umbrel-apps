# Farm OS — START HERE

> Read this first to get grounded in the product and the codebase. For *current
> deploy state, open decisions, and what to do next*, read **HANDOFF.md**. For the
> full original spec + Step-0 research, see `docs/step0-report-and-phase1-plan.md`.
>
> **Using this doc for prompt engineering:** paste this file (and/or HANDOFF.md)
> plus a focused ask — e.g. *"expand the accounting functions"* or *"deepen the
> GIS/geospatial features"* — and jump to **§8 Extending by domain**, which maps
> each area to its files, data model, conventions, and the expertise to bring.

---

## 1. What Farm OS is

A self-hosted, all-in-one farm-records platform for row-crop (Iowa corn/soybean)
operations, shipped as an **Umbrel app** that runs on the farmer's own Raspberry
Pi 5 — often alongside a Bitcoin/Lightning node. It is a **separate product from
Bean Brief** (the other app in this repo): separate app id (`isa-farmos`),
database, auth, runtime, images. We borrowed *patterns* from Bean Brief but share
**zero runtime code** (Hard Requirement #1).

Three claims, in order of conviction:
1. **His data stays his.** No telemetry, no phoning home. The one honest
   exception: transcript *text* (never audio) goes to the farmer's *own* LLM
   provider under his *own* key. Surfaced plainly in Settings → "what leaves this
   box" (`GET /api/v1/system/privacy`).
2. **Nearly free to run.** Local Whisper transcription ($0), cheap-model routing
   for extraction, expensive model only for reasoning, every call metered, hard
   monthly cap. Target **$30–60/farm/year**.
3. **It finds money.** The conservation/program engine maps *what you did on
   which acre* → *the programs that will pay you*, encodes the stacking rules,
   and never asserts eligibility without a citation + `last_verified` date.

## 2. Principles that govern every decision (don't violate these)

- **Capture friction is the whole game.** Press-talk-release, one hand, gloves
  on, no menus. Everything else bends to make logging effortless.
- **Never fabricate a farm record.** Uncertainty → the confirmation inbox. The
  assistant says "I don't have that recorded."
- **Never assert program eligibility without a citation + `last_verified`.**
- **Farm data stays on the farm.** Outbound only to the farmer's own LLM key and
  feeds he explicitly enables.
- **Offline-first.** Capture queues locally and syncs later; never lose a record
  to no signal.
- **API-first.** Every capability is a `/api/v1` endpoint a future native client
  could call; the PWA is just one client. Auth is device-paired, not sessions.
- **Region packs are DATA, not code.** Program rules, agronomic models, legal
  recordkeeping ship as versioned YAML with `source_url` + `verify_by`.
- **No agent-gateway runtime.** Plain job queue only (prompt-injection safety).
- **Records outlive the hardware.** Nightly client-side-encrypted backup + a
  tested restore path.

## 3. Stack & architecture

- **Backend:** Python 3.12 · FastAPI · SQLAlchemy 2 · **PostgreSQL 16 + PostGIS**
  (spatial) · Alembic migrations · **Procrastinate** job queue (Postgres-backed,
  no Redis).
- **Frontend:** React 18 + Vite **PWA**, offline-first (Dexie/IndexedDB queue +
  service worker), served as static files by the API container.
- **Transcription:** `whisper.cpp` base.en as a nice'd subprocess on the worker
  (single-flight; the Pi shares 4 cores with bitcoind).
- **LLM:** farmer's own Anthropic key; an explicit **router** (cheap Haiku tier
  for extraction/classification, Sonnet tier for reasoning/chat); every call
  metered with a hard cap.
- **Timestamping:** OpenTimestamps (standard `.ots` proofs) makes records
  tamper-evident — invisible plumbing, never says "Bitcoin" in the UI.
- **Deploy:** Umbrel app `isa-farmos` (port **8585**), 3 services (`web`,
  `worker`, `db`) + Umbrel's injected `app_proxy`. Multi-arch images
  (`linux/arm64` + `amd64`) on GHCR.

Container startup (`docker/entrypoint.sh`): wait-for-db → `alembic upgrade head`
→ `manage procrastinate-schema` → `manage load-pack` → uvicorn (web) or worker.

## 4. Repo map

```
farmos/
├── START.md, HANDOFF.md, README.md, CHANGELOG.md
├── docs/step0-report-and-phase1-plan.md      # the original spec + research
├── backend/
│   ├── pyproject.toml                         # deps (all ship arm64 wheels — see HANDOFF gotchas)
│   ├── alembic/versions/0001..0007_*.py       # migrations; ALTER migrations must be idempotent
│   └── app/
│       ├── main.py            # app factory, lifespan (opens job queue), PWA mount, /healthz
│       ├── config.py          # Settings: env FARMOS_*, model tiers, whisper, spend cap, dev_fake_llm
│       ├── db.py              # engine/session + Procrastinate job_app
│       ├── models.py          # ALL SQLAlchemy models (see §5)
│       ├── auth.py            # device tokens (hash-at-rest) + 6-digit pairing codes
│       ├── llm.py             # ModelRouter (ROUTES), complete() = the ONLY metered LLM entry, transports
│       ├── manage.py          # CLI: load-pack | procrastinate-schema | seed-demo
│       ├── seed_demo.py       # demo farm (6 fields, ops, money, contracts, practices, inbox item)
│       ├── api/v1/            # routers, one per resource (see §6)
│       ├── capture/           # pipeline.py (state machine) · transcribe.py · parse.py · route.py · prompts/
│       ├── services/          # business logic (see §8) — clu_import, program_finder, stacking, mrv,
│       │                      #   compliance, financials, grain, weather, backup, records,
│       │                      #   timestamping, workbook_import, assistant
│       ├── region_packs/      # loader.py · schema.py · packs/ia-2026.5.yaml  (DATA, not code)
│       └── jobs/              # worker.py · tasks.py · periodic.py (nightly backup/timestamp/brief/weather)
├── frontend/src/
│   ├── app/App.tsx            # tab shell: Log · Inbox · Farm · Money · Programs · Settings
│   ├── app/api.ts             # device-token API client
│   ├── offline/queue.ts       # Dexie capture queue + sync engine
│   └── features/              # capture · inbox · fields (+PracticesSection) · documents · money ·
│                              #   programs · onboarding · settings
├── docker/                    # Dockerfile (PWA+whisper+py) · db.Dockerfile · entrypoint.sh
├── scripts/                   # farmos-restore · restore_drill.py · dev.sh
└── tests/                     # unit/ · api/ (real PostGIS) · eval/ (voice-parser F1 gate)
isa-farmos/                    # Umbrel app folder at repo root: umbrel-app.yml · docker-compose.yml · icon.png
.github/workflows/             # build-farmos-image.yml (farmos-v* tags) · farmos-ci.yml
```

## 5. Core data model (entities in `models.py`)

Identity: `AppUser` · `DeviceToken` · `PairingCode`
Farm structure: `FarmProfile` (singleton config) · `Farm` (FSA) · `Field` (PostGIS
polygon, CLU id, tract/field #) · `Lease` · `CropYear` (**FSA-578/CART-named
columns** — a CropYear that can't emit a valid 578 is incomplete)
Operations/inputs: `FieldOperation` (+`OperationProduct` tank mixes, `weather`
auto-attached) · `Product` · `InputInventory` · `SoilTest`
Capture (append-only, never deleted): `CaptureEvent` (`timestamp_proof` nullable)
→ `ParseResult` (N per capture, confidence, `prompt_version`) →
`ConfirmationQueueItem` → real records. `Document` = the vault.
Conservation: `Practice` (+`PracticeEvidence`) · `Program` · `EligibilityRule` ·
`EvidenceRequirement` · `StackingRule` · `ProgramEnrollment` · `RegionPackRow`
Money/marketing: `MoneyTransaction` · `BudgetLine` · `GrainContract`
Assistant/meter: `DailyBrief` · `ApiSpend` · `AuditLog` · `WorkbookMapping`

**The capture loop** (the product's spine): one `CaptureEvent` → whisper transcript
→ cheap-model parse → **N** `ParseResult` (multi-record: a 45s voice note is a
field op *plus* an equipment issue *plus* an inventory note) → each becomes a
`ConfirmationQueueItem` in the inbox → farmer confirms/fixes/discards → real rows
written **with provenance back to the never-deleted artifact**. Nothing writes a
farm record without human confirmation; unresolved ambiguities block confirm
server-side.

## 6. API surface (`/api/v1`, bearer device token)

auth (bootstrap/pair/devices) · profile · farms/fields (+`/fields/import`,
`/fields/export`) · crop-years (`?format=fsa578`) · rotation · operations ·
products/inventory · captures (+`/sync/batch`, `/sync/status`) · inbox · documents ·
programs/matches · **programs/stacking** · programs/{key}/readiness · practices ·
enrollments · compliance/rup · transactions · budget · **financials/summary** ·
grain/contracts · grain/position · workbooks (mapping-assisted import) · nudges ·
assistant/chat · spend · system/backup · brief/latest · system/privacy.

## 7. Conventions you must keep

- **Every LLM call goes through `llm.complete(purpose=...)`** — routes to a model
  tier, checks the spend cap, meters to `ApiSpend`. There is no other path to the
  SDK; that's what makes the meter trustworthy. Transport is injectable
  (`llm.set_transport`) for tests/eval and the `dev_fake_llm` sandbox stub.
- **`client_id` UUID** on client-creatable rows → offline sync is idempotent.
- **New rules/programs = edit a region-pack YAML** (bump the version; the loader
  retires older versions), never engine code.
- **ALTER-based migrations must be idempotent** (`ADD COLUMN IF NOT EXISTS`) — the
  0001 baseline creates tables from current metadata, so fresh DBs already have
  later columns. (See HANDOFF — this bit us once.)
- **All deps must ship arm64 wheels** (no source builds on the Pi). We dropped
  GDAL/fiona for pure-Python `pyshp` for exactly this reason.
- Match surrounding code style. Update `CHANGELOG.md`.

## 8. Extending by domain — point me here

When the ask is domain-specific, this is where the code lives, the model
entities involved, the current state, and the expertise to bring:

| Domain | Files | Entities | State / good next moves |
|---|---|---|---|
| **Accounting / financials** | `services/financials.py`, `api/v1/financials.py`, `frontend/.../money/` | `MoneyTransaction`, `BudgetLine`, `CropYear`, `FieldOperation` (harvest) | Have: budget-vs-actual per crop, per-field breakeven $/bu with prorated shared costs + honest "insufficient data". Next: Schedule F / lender packet exports, cash-flow + operating-line projection, operating-mode scenarios (cash-rent vs crop-share vs self-farm — net **and** cash outlay), enterprise allocation UI, QuickBooks adapter. *Bring: farm accounting / ag lending expertise.* Rule: never invent a number — surface gaps. |
| **GIS / geospatial** | `services/clu_import.py`, `api/v1/fields.py`, `frontend/.../fields/`, PostGIS in `models.py` (`Field.boundary`, `CropYear.boundary`, `CaptureEvent.device_gps`) | `Field`, `Farm`, `CropYear` | Have: farmers.gov CLU shapefile/GeoJSON import (pure-Python pyshp), shapefile export, nearest-field GPS attach (`ST_Distance`), acreage recompute (EPSG:5070). Next: Leaflet boundary editor, yield/zone layers, planted-vs-FSA acre reconciliation, GART export, subfield planting boundaries. *Bring: GIS / shapefile / CRS expertise.* Keep pure-Python (no GDAL — arm64). |
| **Agronomy / conservation** | `services/stacking.py`, `mrv.py`, `program_finder.py`, `compliance.py`, `region_packs/` | `Practice`, `PracticeEvidence`, `Program`, `EligibilityRule`, `StackingRule`, `EvidenceRequirement` | Have: program finder, stacking/additionality checker (crown jewel), MRV readiness, RUP compliance, Iowa pack. Next: CI-score estimator (GREET-lite), N-rate/MRTN + fungicide-ROI decision support, more region packs, practice economics. *Bring: agronomy / conservation-program / NRCS-FSA expertise.* Rule: citations + `verify_by` on everything. |
| **Marketing / grain** | `services/grain.py`, `api/v1/grain.py` | `GrainContract`, `FieldOperation` (harvest), `Document` (scale tickets), `FarmProfile.crops[].storage_bu` | Have: position ledger (produced/in-bin/contracted/priced/unpriced from records), contract tracker. **Deferred pending a framing decision** (education-not-advice, see HANDOFF): store-vs-sell analysis, marketing scorecard. *Bring: grain-marketing expertise + read the framing decision first.* |
| **Capture / NLP** | `capture/parse.py`, `route.py`, `pipeline.py`, `prompts/`, `tests/eval/` | `CaptureEvent`, `ParseResult`, `ConfirmationQueueItem` | Have: voice→N-records, photo/doc vision routing, 26-case eval with F1≥0.90 CI gate. Next: more transcript coverage, document-type extractors, spreadsheet-mapping polish. *Bring: prompt-engineering / eval-harness rigor.* Add cases to `tests/eval/cases.yaml`; keep the replay-mode gate. |
| **Assistant / LLM** | `services/assistant.py`, `brief.py`, `llm.py` | `DailyBrief`, `ApiSpend` | Have: chat over farm snapshot (cites records, "I don't have that"), daily brief, nudges. Next: RAG over the document vault (pgvector — column reserved), better nudges. *Bring: RAG / LLM-app expertise.* Rule: answer only from records; no marketing advice; every call metered. |
| **Lightning (Phase 6)** | not built; `docs/step0` §10 | `LightningNode`, `PeerSettlement`, `EscrowContract`, `PaymentPolicy` (planned) | Off by default behind a flag. Integrates against a **forked Bitcorn**'s HTTP API on regtest/mock. Payments service holds the only key (caps + allowlist); the agent never touches a wallet. *Bring: Lightning/LND expertise.* |
| **Frontend / PWA** | `frontend/src/` | — | Have: offline queue, 6-tab shell, gloves-on UI. Next: better sync UX, PWA install polish; Phase 7 = React Native reusing `/api/v1`. *Bring: React/PWA/offline-first expertise.* |
| **Deploy / infra** | `docker/`, `isa-farmos/`, `.github/workflows/` | — | See HANDOFF for the full release runbook and the multi-arch/Umbrel gotchas. *Bring: Docker/buildx/Umbrel expertise.* |

## 9. Run & test locally

```
farmos/scripts/dev.sh db          # PostGIS in docker on :5433
cd farmos/backend && python -m alembic upgrade head
python -m app.manage procrastinate-schema && python -m app.manage load-pack
farmos/scripts/dev.sh api         # uvicorn :8585    (dev.sh web = Vite dev server)

pytest farmos/tests/unit                                   # pure-logic
python farmos/tests/eval/run_eval.py                       # voice-parser F1 gate (no API calls)
FARMOS_TEST_DATABASE_URL=postgresql+psycopg://... pytest farmos/tests/api   # real PostGIS
python farmos/scripts/restore_drill.py                     # backup→wipe→restore→verify
```

**Sandbox with no API key:** set `FARMOS_DEV_FAKE_LLM=1` (labeled `[sandbox model]`,
$0) and `python -m app.manage seed-demo` (a full demo farm). The whole
capture→inbox→chat loop runs offline. Sample upload files for a running instance:
`FarmOS_Sample_Fields.geojson` (6 fields) and `FarmOS_Sample_Data_2024-2026.xlsx`
(rotation/money/budget). CI (`farmos-ci.yml`) runs unit + eval + PostGIS API tests
+ the restore drill on every push touching `farmos/**`.

## 10. Phase status (detail in HANDOFF)

1 Foundation ✅ · 2 Timestamping+Agronomy+Accounting ✅ · 3 FSA packet + Conservation
engine ✅ (core) · 4 Grain position (records slice) ✅ / advice features **deferred** ·
5 Assistant ✅ · 6 Lightning ⬜ (fork ready) · 7 Native app ⬜.
