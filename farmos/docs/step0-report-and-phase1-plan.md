# Farm OS — Step 0 Report & Phase 1 Plan

## Context

The request is the Farm OS build prompt: a self-hosted, all-in-one farm management platform for row-crop operations, shipped as an Umbrel app on Raspberry Pi 5, for Iowa corn/soy farmers (beachhead: Bitcorn Lightning node operators). The spec explicitly asks for **no feature code yet** — instead: Step 0 orientation findings, a fork recommendation on Bitcorn, a stack proposal, Phase 1 module structure + core DDL, an API cost estimate, USDA research (CP-782 / CART / GART / farmers.gov / §1619), Pi 5 feasibility, backup design, a decisions list, and pushback. This document is that report plus the Phase 1 implementation plan, to be executed on branch `claude/farm-os-platform-dwg85i` after approval.

---

## 1. Step 0 Findings

### 1a. This repo (`isa-umbrel-apps`)

- It is an **Umbrel Community App Store** (store id `isa`, root `umbrel-app-store.yml`) that also hosts the full source of one app: **Bean Brief** (`isa-polibrief`, Node.js ESM, no framework, SQLite via better-sqlite3, in-process 30s-tick scheduler, port 8484).
- Umbrel packaging pattern confirmed: app folder `isa-polibrief/` holds `umbrel-app.yml` (manifestVersion 1, store-prefixed id, single `port`) + `docker-compose.yml` (Umbrel injects `app_proxy`; you set `APP_HOST: <appid>_<service>_1` and `APP_PORT`; one volume `${APP_DATA_DIR}/data:/data`; image pulled from GHCR).
- Multi-arch build: `.github/workflows/build-image.yml` — buildx `linux/arm64,linux/amd64`, pushed to GHCR on `v*` tags with the automatic `GITHUB_TOKEN`.
- **No Farm OS code exists anywhere.** Branch `claude/farm-os-platform-dwg85i` is identical to `main`. Greenfield.
- Reusable (by copying, per Hard Requirement #1): the Umbrel manifest/compose pattern, GHCR workflow, Dockerfile shape, data-dir seeding pattern, the token-usage cost-meter concept (`src/store.js` `recordUsage`), and adapter patterns for USDA NASS (`src/adapters/usda_nass.js`), Open-Meteo weather, USDA AMS cash grain — useful later for the market-data adapter (Phase 4) and weather auto-attach.

### 1b. Bitcorn Lightning app — license is proprietary; we have permission

- **LICENSE is proprietary**: "Copyright (c) 2026 Bitcorn Labs, Inc. All rights reserved." It permits personal/internal use of the app only and prohibits copying, modifying, distributing, and derivative/competing products (https://github.com/ethancail/bitcorn-lightning-application/blob/main/LICENSE). **The user has received written agreement from Bitcorn Labs (via text message) permitting us to build on it.** One housekeeping item, not a blocker: before we *publicly redistribute* anything derived from their code (a public fork, GHCR images containing their code), get the permission restated over email with scope ("fork, modify, redistribute") so it's durable and unambiguous — a text thread is thin paper for a public artifact.
- Stack (for integration planning only): Node/TypeScript API + React web, SQLite at `/data/db/bitcorn.sqlite`, LND via `ln-service` gRPC (`lightning_lnd_1:10009`), joins `umbrel_main_network`, reads LND creds from `${APP_LIGHTNING_NODE_DATA_DIR}` (ro mount).
- API surface: ~58 documented HTTP endpoints on port **3101** (JWT auth) — health, node/balances, channels, contacts, invoices (`POST /api/network/invoice`), pay (`POST /api/pay`, member-gated, forced through treasury channel), liquidity status, treasury-only ops. Port 3200 = web UI, 3109 = unbound node-to-node stub.
- Topology: hub-and-spoke — treasury node (pubkey-matched) provisions channels and earns forwarding fees; member nodes (farmers Loop Out, merchants Loop In) route outbound through the treasury. 15s LND→SQLite sync loop.
- No documented regtest/signet/mock harness; only a `BITCOIN_NETWORK` env var (default mainnet).

**Recommendation (answering "fork or vendor?"): fork for the Lightning work, but do not build Farm OS *on* the fork.** Two separate questions with two answers:

1. **Farm OS core (Phases 1–5): standalone, no Bitcorn code.** This is a stack-gap conclusion, not a license one — Bitcorn is Node/TypeScript + SQLite; Farm OS wants Python + Postgres/PostGIS. If we used the fork as the foundation, what survives is Umbrel packaging (we already have a better-fitting copy from Bean Brief), and literally nothing agronomic/financial (it never existed there). A fork-as-foundation means rewriting ~everything inside someone else's repo history. Wrong move regardless of permission.
2. **Phase 6 Lightning module: fork Bitcorn as the spec asked**, keeping `upstream` as a git remote so we track their changes rather than orphan-drift. What survives the fork: the **Umbrel packaging + LND integration (`ln-service` gRPC, credential mounts) + the hub-and-spoke LSP topology and its API implementation**. What we add *in the fork*: a **regtest/signet + mock-treasury harness** (their code has only a `BITCOIN_NETWORK` env var, mainnet default, no documented test harness) — which is exactly the working proof-of-concept artifact to hand the Bitcorn team, and a natural upstream contribution. What gets replaced/ignored: SQLite persistence and all member-app UI concerns.
3. **At runtime, Farm OS still integrates via Bitcorn's HTTP API** (auto-discover `bitcorn-lightning_api_1:3101` on `umbrel_main_network`; dormant if absent). Farm OS's Payments service (Python, caps + allowlist, sole LND/Bitcorn talker) calls that API whether the sibling app is upstream Bitcorn or our fork. The fork gives us the test harness and a contribution channel; the API boundary keeps the two products decoupled.

Good-manners item stands: tell the Bitcorn team what we're doing with the fork and offer the regtest harness back.

### 1c. Pi 5 feasibility (8 GB, NVMe, Bitcoin Core + LND resident)

RAM budget (published-benchmark sizing; measure on real hardware in Phase 1):

| Component | Steady RAM |
|---|---|
| OS + Docker + Umbrel | ~0.5–1 GB |
| Bitcoin Core | ~1.5–3 GB (spikes 5 GB+) |
| LND | ~0.3–0.6 GB |
| Postgres + PostGIS (tuned: shared_buffers 256 MB, low work_mem) | ~0.5–1 GB |
| Farm OS API + frontend | ~0.3–0.5 GB |
| whisper.cpp base.en (transient, per job) | ~0.8 GB |

Verdict: **fits with discipline.** whisper.cpp `base.en` transcribes a 45 s clip in roughly **45–90 s on an idle Pi 5** (RTF ≈ 1–2×), worse under bitcoind contention; `small.en` (~2 GB RAM, RTF 2–4×+) is **not viable** alongside a live node. Mitigations, in order: (1) transcription is already async — capture never waits on it, so 1–3 min server-side latency on `base.en` is acceptable for v1; run it `nice -19`, ≤2 threads, one job at a time; (2) ship **browser-side whisper WASM (tiny/base)** as an optional fast path — moves the CPU off the Pi entirely; (3) Phase 7 native app does on-device transcription and the Pi never sees audio. Postgres lives on NVMe via `${APP_DATA_DIR}` (Umbrel data dir is on the node's SSD/NVMe by construction on Bitcorn-class hardware).

### 1d. USDA research (spec ask #6)

- **CP-782**: exists (https://www.fsa.usda.gov/Internet/FSA_Notice/cp_782.pdf — PDF, not machine-extractable in this environment). Framework confirmed via RMA ACRSI FAQ + secondary sources: third parties submit into the RMA/FSA ACRSI Clearinghouse; onboarding is an **Interconnection Security Agreement + MOU** federal system-interconnection process (per RMA bulletin 18-019 attachments), not a developer API. Entity-type / FedRAMP / cost / timeline specifics: **unverified — no public source states them.** In 12+ years, exactly **one** independent third party has been credentialed.
- **CART/GART schemas: publicly available.** USDA data-standards site (https://usda.github.io/data-standards/data-exchange.html), NIEM-conformant XML/JSON, ~50+ elements incl. `CropYear`, `FarmNumber`, `TractNumber`, `FieldNumber`, `OriginalReportedAcreage`, `FinalReportedAcreage`, `OriginalPlantedDate`, `FinalPlantedDate`, plus GART boundary geometry. We can name our schema columns to this standard from day one (Hard Requirement #15) without any USDA relationship.
- **farmers.gov shapefile export: confirmed.** Login.gov-linked producers can export CLU/field boundaries as **ESRI shapefile or GeoJSON** and import the same (plus GART) back. Key attributes: state/county code, farm number, tract number, field/CLU number, acres. No published .dbf column dictionary — Phase 1 CLU importer must be written defensively against a real export sample (Lazy H's own export is the test fixture).
- **Section 1619 (7 U.S.C. §8791)**: restricts **USDA and its contractors/cooperators** from disclosing producer data; it does **not** bind a vendor receiving data directly from the farmer. Constraint attaches through the integration relationship: becoming a clearinghouse submitter likely makes us a "cooperator" and pulls us inside §1619 obligations. Staying farmer-side keeps us out.
- **MyAgData** remains the only independent third party authorized to submit to both FSA and RMA (AIPs are a separate lane).
- **One Farmer One File**: announced at 2026 Commodity Classic; 2028 target is trade-press-attested, not primary-source-confirmed. **June 29, 2026 FSA modernization pilot: 9 single counties + all of Maryland and North Dakota. Iowa is not included** (confirmed against the FSA release).

**§7c recommendation: Option 2 — generate-and-hand-off.** Emit CART-aligned data + GART/shapefile/GeoJSON boundary files the farmer submits via farmers.gov import, his AIP/agent, or MyAgData; plus the print-ready county-office packet. Direct submission (option 1, a non-retaining relay) requires an ISA+MOU federal interconnection an open-source, per-farm-instance project cannot realistically hold, and would likely make us a §1619 "cooperator" — the exact data-intermediary posture Principle 1 forbids. Option 3 (per-instance credentialing) contradicts how the clearinghouse works. Cost in principle terms of option 2: none — the farmer keeps custody end-to-end. One phone call worth making anyway: RMA ACRSI team / `enterprise.architecture@ocio.usda.gov` to get the exact CP-782 text and confirm GART export column expectations.

### 1e. Annual API cost estimate (spec ask #5)

Assumptions: ~1,200 voice captures/yr (in-season ~8/day), ~400 photos, ~300 documents, ~150 chat/reasoning queries, daily brief. Routing: Haiku 4.5 ($1/$5 per MTok) for extraction/classification/OCR-structuring; Sonnet ($3/$15) for stacking analysis, chat, brief synthesis; local whisper + local embeddings = $0.

| Workload | Model | Est./yr |
|---|---|---|
| Voice parse (1,200 × ~2k in / 500 out) | Haiku | ~$6 |
| Photo classify + doc structuring (700 × ~2.5k in / 400 out) | Haiku | ~$4 |
| Spreadsheet mapping proposals (~20 × 15k in / 2k out) | Sonnet | ~$1.50 |
| Chat + stacking + program reasoning (150 × 12k in / 1.5k out) | Sonnet | ~$9 |
| Daily brief (365 × 6k in / 800 out, cached prompts) | Haiku→Sonnet mix | ~$8 |
| Headroom / retries / vision-heavy months | — | ~$10 |
| **Total** | | **~$25–40/farm/yr** |

**The $30–60 target is achievable** with the router + prompt caching + batch-overnight discipline, and the spend meter keeps it honest. The risk case is chat-heavy users on the expensive model — the per-month hard cap covers that.

---

## 2. Stack proposal (spec ask #3)

**Backend: Python 3.12 + FastAPI.** Justification: spreadsheet ingestion (openpyxl incl. cell-format signals for the blue-input/black-formula convention), geospatial tooling (shapely/pyogrio/fiona for CLU shapefiles, GeoAlchemy2 for PostGIS), agronomic/financial computation, and OpenTimestamps (`opentimestamps-client` is Python-native) are all materially better in Python. Bean Brief's Node code is a pattern reference, not a dependency (HR #1), so language continuity buys nothing at runtime.
- SQLAlchemy 2 + Alembic; PostgreSQL 16 + PostGIS 3.4 + pgvector (second compose service, tuned small, data on NVMe via `${APP_DATA_DIR}`).
- **Jobs: Procrastinate** (Postgres-backed queue + cron-style scheduling) — no Redis, one fewer always-on service on a RAM-constrained box, satisfies HR #13 (job queue, no agent runtime).
- whisper.cpp `base.en` as a nice'd subprocess, single-flight queue; optional browser-WASM path.
- Local embeddings via a small ONNX/sentence-transformers model (CPU, batch overnight) for vault search.
- LLM: farmer's own Anthropic key; explicit `ModelRouter` (haiku tier / sonnet tier), every call metered into `api_spend` with a hard monthly cap.

**Frontend: React 18 + Vite PWA** (installable, offline-first: IndexedDB capture queue + service worker background sync, visible pending/sync indicator). Served as static files by the API container. React so logic ports to React Native in Phase 7. **API-first is enforced structurally**: the PWA consumes only `/api/v1/*`; no server-rendered pages, no endpoint used only by templates (HR #14).

**Auth: device pairing.** Owner sets up via Umbrel app_proxy (LAN-trusted first run); each phone/laptop pairs with a short-lived code → long-lived scoped device token (roles: owner/operator/advisor/read-only). No browser sessions (HR #14). Remote access: document/detect Tailscale (beachhead already has it); mDNS on LAN.

**Placement: new isolated top-level source dir + sibling store folder in this repo** (`farmos/` source, `isa-farmos/` store manifest folder), zero imports from Bean Brief `src/`. Same store, new app id `isa-farmos`, new port **8585** (8484 = Bean Brief; 3101/3109/3200 = Bitcorn), images `ghcr.io/mherman1990/farmos` + `farmos-db`.

---

## 3. Phase 1 design

### 3a. Directory / module structure

```
isa-umbrel-apps/
├── umbrel-app-store.yml            # existing store manifest — unchanged
├── isa-polibrief/                  # existing app — untouched
├── isa-farmos/                     # NEW Umbrel app folder
│   ├── umbrel-app.yml              # manifestVersion 1, id isa-farmos, port 8585
│   ├── docker-compose.yml          # app_proxy + web + worker + db
│   └── icon.png
├── farmos/                         # NEW: all Farm OS source; never imports ../src
│   ├── backend/
│   │   ├── pyproject.toml          # fastapi, sqlalchemy2, geoalchemy2, alembic, procrastinate,
│   │   │                           #   anthropic, fiona, shapely, pyproj, pydantic-settings
│   │   ├── alembic/versions/       # migrations, auto-run on container start
│   │   └── app/
│   │       ├── main.py             # app factory, PWA static mount, /healthz
│   │       ├── config.py           # env: DATABASE_URL, FARMOS_DATA_DIR=/data, spend cap
│   │       ├── auth/               # device_tokens.py (hash-at-rest), pairing.py (6-digit, 10-min TTL)
│   │       ├── api/v1/             # onboarding, farms, fields, crop_years, operations, inventory,
│   │       │                       #   captures, sync, inbox, documents, programs, spend, system
│   │       ├── models/ schemas/    # SQLAlchemy aggregates / Pydantic IO
│   │       ├── services/           # clu_import.py, program_finder.py, spend.py (cap gate), backup.py (restic)
│   │       ├── capture/            # pipeline.py (state machine), transcribe.py (whisper subprocess),
│   │       │                       #   parse.py (LLM extraction → N results), route.py, prompts/ (versioned)
│   │       ├── llm/                # client.py (metered anthropic wrapper), router.py (haiku/sonnet map)
│   │       ├── jobs/               # worker.py entrypoint, tasks.py, periodic.py (backup 02:30, staleness scan)
│   │       └── region_packs/       # loader.py, schema.py, packs/ia-2026.1.yaml
│   ├── frontend/                   # React+Vite PWA: app/ (shell, API client, token store),
│   │   │                           #   offline/ (Dexie queue + sync engine), sw.ts (Workbox)
│   │   └── src/features/           # onboarding, capture, inbox, fields (Leaflet), operations,
│   │                               #   programs, settings (key, spend meter, backup, devices)
│   ├── docker/
│   │   ├── Dockerfile              # multi-stage: node builds PWA → cmake builds whisper.cpp + base.en → py slim
│   │   ├── db.Dockerfile           # postgis/postgis:16-3.4 + pgvector, tuned conf (shared_buffers 256MB)
│   │   └── entrypoint.sh           # wait-for-db → alembic upgrade → uvicorn | worker
│   ├── scripts/                    # farmos-restore CLI, restore-drill.sh (CI), dev.sh
│   └── tests/                      # unit/, api/ (real PG in CI), eval/ (transcripts/ expected/ recorded/ run_eval.py)
└── .github/workflows/
    ├── build-farmos-image.yml      # NEW: tags `farmos-v*` (namespaced so Bean Brief's `v*` never collides)
    └── farmos-ci.yml               # NEW: pytest + eval replay + restore drill
```

### 3b. Core data model (key DDL decisions)

Conventions: UUID PKs, `created_at/updated_at` everywhere, `client_id UUID UNIQUE` on client-creatable rows (offline idempotency), geometry SRID 4326, FSA-578 columns named to CART/NIEM (`farm_number`, `tract_number`, `field_number`, `crop_year`, `original_planted_date`, `intended_use_code`, `irrigation_practice_code`).

- **Identity**: `app_user` (role owner/member for v1), `device_token` (sha256 hash-at-rest, revocable, last_seen), `pairing_code` (single-use, TTL).
- **Farm structure**: `farm_profile` (singleton; county ANSI, entity type, spend cap; **Anthropic key lives in `/data/secrets/`, DB stores only a flag**) → `farm` (FSA farm number) → `field` (MultiPolygon + GIST index, `clu_identifier`, tract/field numbers, `clu_calculated_acres` vs recomputed `gis_acres` sanity pair, source = clu_import/manual) → `lease`.
- **FSA-578 first-class**: `crop_year` — crop code/name, type code, variety, `intended_use_code` (default GR), `reported_acres`, subfield planting `boundary`, `original_planted_date`/`final_planted_date`, `planting_pattern`, `producer_share`, `irrigation_practice_code` (I/N/O), `prevented_planted`, `failed_acres`. UNIQUE (field, year, crop, use).
- **Operations**: `product` (with `epa_reg_number` for restricted-use), `input_inventory` (running balance), `field_operation` (op_type enum, `occurred_at`, `details jsonb` for op-specific rate/wind/yield, **`source_capture_event_id` provenance**), `operation_product` join (tank mixes).
- **Capture pipeline**: `capture_event` — append-only, artifact path + sha256, `captured_at` (device clock) vs `uploaded_at`, `device_gps Point`, **`timestamp_proof jsonb` nullable (populated by the Phase 2 OpenTimestamps nightly batch; column exists from day one)**, status enum recorded→transcribing→transcribed→parsing→parsed→queued→confirmed/rejected/failed, transcript. → `parse_result` (seq, `target_type`, `extracted jsonb`, `confidence`, `model_used`, **`prompt_version`** for eval reproducibility, `ambiguities jsonb`) → `confirmation_queue_item` (pending/confirmed/edited/rejected, `final_payload` after farmer edits, `created_record_type/id` back-pointer). `document` for routed receipts/leases/FSA forms.
- **Programs**: `region_pack` (region, version, content sha) → `program` (agency, payment_rate text, signup_deadline) → `eligibility_rule` (machine-checkable `predicate jsonb` where possible, `description`, **`citation`, `source_url`, `last_verified`, `verify_by`** — nightly job flags past-due rules STALE).
- **Metering/audit**: `api_spend` (purpose, model, tokens, cost, month index), `audit_log` (append-only identity PK).

Multi-record shape: one `capture_event` → N `parse_result` (seq 0..N) → N `confirmation_queue_item` → on confirm, each writes its real row with provenance back to the never-deleted raw artifact.

### 3c. API surface (`/api/v1`, bearer device tokens)

- **Pairing**: `POST /auth/pairing-codes` (desktop shows code/QR) → `POST /auth/pair {code, device_name}` (unauthed, single-use) → token shown once, stored hashed. `GET/DELETE /auth/devices`. `POST /auth/bootstrap` works only while `app_user` is empty (app_proxy gates LAN). Identical flow for a future native client — nothing browser-specific.
- **Profile/onboarding**: `GET|PUT /profile`, `POST /profile/complete` (runs Program Finder once).
- **Fields**: CRUD + GeoJSON; `POST /fields/import` (zipped shapefile/GeoJSON → preview rows with dedupe verdicts) → `POST /fields/import/{id}/apply`.
- **Records**: `GET|POST|PATCH /crop-years` (incl. `?format=fsa578` view), `/operations`, `/products`, `/inventory`.
- **Capture/sync (core protocol)**: `POST /captures` (multipart, idempotent on `client_id`); `POST /sync/batch` (array of queued items, per-item created/duplicate/error response — client clears IndexedDB only on success, safe to retry forever); `GET /sync/status?since=` (cursor delta + badge counts: pending, inbox, backup age, spend); `GET /captures/{id}` (+ `/artifact` stream).
- **Inbox**: `GET /inbox?state=pending`; `POST /inbox/{id}/confirm {final_payload?}` (transactional record write); `/reject`.
- **Programs/spend/system**: `GET /programs/matches` (per-rule pass/fail/unknown + citation + last_verified + stale flag), `GET /spend` (+ `/spend/events`), `GET|POST /system/backup`, `GET /healthz`.

### 3d. Capture pipeline

- Ingest is fast (no CPU work in request path): write artifact, hash, insert, enqueue.
- **Transcribe** on the worker: `nice -n 15 whisper-cli -m base.en -t 2`, ffmpeg → 16 kHz wav first, Procrastinate queue `cpu_heavy` concurrency **1** (never two whisper runs; never >2 of bitcoind's 4 cores). UI says "transcribing…" honestly (45–90 s per clip).
- **Parse** on haiku via the router with a context pack (field nicknames, product catalog, recent crops so "North 80" resolves to a UUID); returns JSON array of typed records with per-record confidence + ambiguities. Spend gate checked pre-call; over-cap parks the capture as "needs budget" — capture itself never blocked.
- **Phase 1 rule: nothing writes a farm record without human confirmation.** Confidence only affects inbox sort and one-tap-vs-question rendering; ambiguities render as pickers. Auto-commit thresholds revisited in Phase 2 with eval data.
- **Eval harness**: ≥25 transcript fixtures (single-op, multi-record, tank mix, ambiguity, inventory, junk audio) with typed expected JSON. **Replay mode** in CI (injected LLM transport replays committed model outputs — deterministic, LLM-free, exercises real post-processing) with a **0.90 record-level F1 gate**; **live mode** re-records outputs whenever prompt_version or model pin changes.

### 3e. Backup / restore

- **restic** (single static binary, native encryption + S3/local repos, built-in check/prune). Nightly 02:30: `pg_dump -Fc` + `/data/artifacts/` + `/data/secrets/` + config (excluding the restic key itself); then `forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune`; weekly `restic check`.
- Destinations: USB pass-through mount and/or the farmer's own S3-compatible bucket (client-side encrypted — provider sees ciphertext). **S3 is the reliable default; USB is best-effort** (Umbrel has no first-class external-mount API — packaging risk).
- Key ceremony: 32-byte repo password generated on box, rendered **once** as a BIP39-style recovery phrase with mandatory "I wrote it down" — the mental model the node-runner audience already has.
- `farmos-restore` CLI (in-image): prompts for phrase, `pg_restore --clean`, artifact/secret sync, `alembic upgrade head`.
- Backup-age badge: amber >36 h, red >7 days or failed check. **Restore drill runs in CI** (seed → backup → wipe → restore → assert row counts + artifact sha256s) and manually on real Pi+USB for Phase 1 sign-off.

### 3f. Umbrel packaging

Compose: `app_proxy` (APP_HOST `isa-farmos_web_1`, APP_PORT 8585) + `web` (768 MB limit) + `worker` (same image, `command: ["worker"]`, 1 GB limit for whisper transients) + `db` (`ghcr.io/mherman1990/farmos-db` = postgis:16-3.4 + pgvector + tuned conf, 768 MB limit, `${APP_DATA_DIR}/postgres` volume, password from Umbrel's `${APP_SEED}`). Worst-case ≈ 2.5 GB, inside the Pi envelope. Build workflow copied from Bean Brief's, triggered on `farmos-v*` tags, builds both images `linux/arm64,linux/amd64`.

### 3g. Build order (dependency-ordered)

1. Scaffold `farmos/` (FastAPI skeleton, Vite PWA shell, both Dockerfiles, dev.sh) + `farmos-ci.yml` (pytest vs PG+PostGIS service container).
2. Alembic baseline migration = full §3b schema + Procrastinate schema.
3. Auth: bootstrap, device tokens, pairing + devices UI.
4. Umbrel packaging: `isa-farmos/` folder, build workflow, first `farmos-v0.0.x` tag → installs on real Pi 5.
5. Field registry + CLU import (fiona parse, preview/apply, Leaflet map).
6. Onboarding wizard (profile → API key → CLU import → backup key ceremony), timed <30 min.
7. Capture ingest + worker + whisper.cpp transcription (test on Pi with bitcoind under load **early, here — not at acceptance**).
8. LLM router + spend meter + hard cap.
9. Parse → inbox: extraction prompt, multi-record fan-out, confirm→record writes with provenance.
10. Offline queue + sync: Dexie, service worker, `/sync/batch`, badges.
11. Crop years (578 columns), field operations log, products/inventory.
12. Iowa region pack `ia-2026.1.yaml` (≥5 real programs: e.g. EQIP, CSP, CRP, IDALS cover-crop cost-share, IDALS/RMA insurance discount, SWOF — rates, deadlines, citations, verify_by) + loader + Program Finder + staleness job.
13. Backup: restic wrapper, key ceremony, nightly job, `farmos-restore`, CI drill.
14. Eval set (25+ transcripts, replay mode in CI, F1 ≥ 0.90 gate).
15. Acceptance pass on hardware with Bitcoin Core + LND running (criteria in §7).

Parallel lanes after task 4: (5,6) fields/onboarding · (7–9) capture · (12) region pack · (13) backup.

### 3h. Phase 1 risks

1. Whisper latency UX (inbox minutes behind in bursts) — set expectation in UI or farmers re-record.
2. `postgis/postgis` arm64 tag drift — owning our db image mitigates; verify base tag in task 1.
3. USB backup mounting isn't a first-class Umbrel API — S3 default, USB best-effort.
4. iOS PWA storage eviction (see Pushback #3).
5. Compose memory limits vs Umbrel OOM behavior — test whisper under bitcoind load at task 7.

---

## 4. Decisions needed from the user

1. **Region-pack verification owner** (§8): who re-verifies Iowa pack rules annually — user, ISA staff, or community? Engine enforces `verify_by` staleness either way; someone must do the editorial pass.
2. **Bitcorn permission scope**: written agreement received (text message). Before the fork goes public / images ship, get it restated over email with explicit scope (fork, modify, redistribute). Timing: needed by Phase 6, not Phase 1.
3. **Repo placement confirmation**: Farm OS lives in this repo as `farmos/` + `isa-farmos/` (dictated by the assigned branch). If a separate repo was intended, say so before scaffolding.
4. **App name**: "Farm OS" is a working name and collides with the existing open-source project **farmOS** (farmos.org, Drupal-based). Ship name needed before the store manifest is written; suggest deciding by end of Phase 1.
5. **Phase 4 framing decision** (already flagged in spec): education vs advice posture for store-vs-sell — not needed until Phase 4.

## 5. Assumptions

- Lazy H can produce a real farmers.gov shapefile export + the three reference workbooks as test fixtures (needed mid-Phase-1).
- Farmer brings an Anthropic API key (Claude models); router is provider-abstracted enough to add others later but v1 ships Anthropic-only.
- Umbrel `${APP_DATA_DIR}` sits on NVMe on Bitcorn-class hardware.
- OpenTimestamps public calendar servers are acceptable outbound traffic (hash-only, no farm data) under Principle 1 — will be listed in the "what leaves this box" settings screen.

## 6. Pushback / scope flags (spec ask #10)

1. **The license check mattered.** Bitcorn is proprietary; the user's written agreement with Bitcorn Labs unblocks the fork, but the stack gap still means the fork serves only the Phase 6 Lightning module, not the Farm OS foundation. Recommendation in §1b. No Phase 1 schedule impact.
2. **Phase 1 as specced is large.** Voice+photo+file capture, CLU import, offline sync, backups+restore drill, Program Finder, cost meter, eval harness — realistically weeks of work even at full speed. Recommend an internal 1a/1b split: 1a = scaffold+deploy+capture(voice)+inbox+field ops+cost meter; 1b = CLU import, photo/file capture, Program Finder, backup/restore drill. Acceptance criteria unchanged, just sequenced.
3. **PWA offline on iOS is the weakest link** in "never lose a record": Safari can evict IndexedDB/service workers under storage pressure, and background sync is unreliable. v1 mitigations (persistent-storage request, foreground sync on open, visible pending counter) are honest but imperfect; the real fix is the Phase 7 native client. Flagging now so nobody is surprised in the field.
4. **Email/SMS forward inbox** (§1) quietly implies either farm-side IMAP polling of a farmer-owned mailbox or a hosted inbox (which would violate Principle 1). Recommend: farmer-owned mailbox via IMAP (Bean Brief has this pattern), Phase 2+, never a hosted relay.
5. **CI score estimator (GREET-lite)** is a deceptively deep model; recommend it ships as "directional estimate" with visible methodology version, not a number a farmer takes to an ethanol plant unlabeled.
6. **45Z/program seed data churns annually** — the pack format's `verify_by` auto-degrade (already in spec) is the right call; budget an afternoon per season for re-verification, per Decision 1.

## 7. Verification (Phase 1 acceptance, from spec)

- Fresh Umbrel install → onboarded farm with CLU boundaries in <30 min.
- 45 s multi-topic voice log captured in airplane mode syncs later → N separate confirmation-inbox items.
- Program Finder shows ≥5 relevant Iowa programs for the Lazy H profile, each with citation + `last_verified`.
- Restore drill: fresh hardware, restore from encrypted backup, all records/artifacts/proofs intact.
- Month-to-date API spend visible in UI; hard cap enforceable.
- Voice-parser eval set (≥25 transcripts) green in CI.
