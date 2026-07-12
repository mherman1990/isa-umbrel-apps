# Farm OS

Self-hosted, all-in-one farm management for row-crop operations. Runs as an
Umbrel app (`isa-farmos/` in this repo) on a Raspberry Pi 5 — including
boxes already running Bitcoin Core + LND, where Farm OS behaves as a
resource-disciplined guest. **Zero runtime coupling to Bean Brief** (the
other app in this repo): patterns were copied, nothing is imported.

## Why

1. **His data stays his.** No telemetry, no phoning home. The one honest
   exception: transcript *text* (never audio) goes to the farmer's own LLM
   provider under his own key, and the UI says so plainly
   (`/api/v1/system/privacy` → Settings → "What leaves this box").
2. **Nearly free to run.** Local Whisper transcription, cheap-model routing
   for extraction, expensive model only for reasoning, every call metered,
   hard monthly cap. Target $30–60/farm/year.
3. **It finds money.** The Program Finder maps the farm profile to Iowa
   conservation programs — every line cited, every rule carrying
   `last_verified`/`verify_by`, staleness enforced by the engine.

## Layout

```
farmos/backend    FastAPI + SQLAlchemy 2 + PostGIS + Procrastinate (job queue)
farmos/frontend   React + Vite PWA (offline-first: Dexie queue + service worker)
farmos/docker     app image (whisper.cpp + PWA + API) and db image (PostGIS+pgvector)
farmos/scripts    farmos-restore CLI, restore_drill.py, dev.sh
farmos/tests      unit/, api/ (real PostGIS), eval/ (voice-parser gate, F1 ≥ 0.90)
isa-farmos/       Umbrel app folder (manifest + compose), at the repo root
```

## The capture pipeline (the product's core loop)

```
hold-to-talk (≤45s, offline-safe, queued in IndexedDB)
  → POST /captures (idempotent by client-generated UUID)
  → whisper.cpp base.en on the worker (nice -15, 2 threads, single-flight)
  → cheap-model parse: ONE capture → N typed records + honest ambiguities
  → confirmation inbox: Confirm / Fix / Discard
  → real records with provenance back to the never-deleted raw artifact
```

Nothing writes a farm record without human confirmation. Uncertainty is
shown, never guessed away. A spend-cap hit parks parsing; capture never
blocks.

## Dev

```
farmos/scripts/dev.sh db       # PostGIS in docker on :5433
farmos/scripts/dev.sh api      # migrate + serve on :8585
farmos/scripts/dev.sh web      # Vite dev server, proxies /api
pytest farmos/tests/unit       # pure-logic tests
python farmos/tests/eval/run_eval.py            # parser eval gate (no API calls)
FARMOS_TEST_DATABASE_URL=... pytest farmos/tests/api    # integration tests
python farmos/scripts/restore_drill.py          # backup/restore drill
```

CI (`.github/workflows/farmos-ci.yml`) runs all of the above on every
push touching `farmos/**`. Images build multi-arch on `farmos-v*` tags
(`.github/workflows/build-farmos-image.yml`) — namespaced so Bean Brief's
`v*` releases never cross-fire.

## Backups (Hard Requirement: records outlive the hardware)

Nightly restic snapshot (02:30) of the pg_dump + raw artifacts + secrets +
config, client-side encrypted with a key generated on the box. The recovery
phrase is shown once. Restore on fresh hardware:

```
docker exec -it isa-farmos_web_1 farmos-restore --repo /backup-usb/farmos
```

The restore drill (seed → backup → wipe → restore → verify byte-identical)
runs in CI and must pass on real hardware before Phase 1 sign-off.

## Status

**Phase 1 complete (code-side)**: capture — voice AND photo/file with
vision routing to the document vault or nearest field — offline queue,
confirmation inbox, device-pair auth, onboarding wizard, field registry +
farmers.gov CLU import AND shapefile export (round-trip tested), field
operations log, products/inventory with automatic draw-down, crop years
with FSA-578/CART columns + printable 578 worksheet with completeness
flags, Iowa region pack (2026.2) + Program Finder + deadline nudges,
spend meter + hard cap, encrypted backup + CI-tested restore, 26-case
parser eval gate.

**Phase 2 shipped**: OpenTimestamps anchoring (standard .ots proofs,
nightly batch + attestation upgrade), mapping-assisted spreadsheet
importer, transactions/budget/breakeven with honest insufficient-data
handling, weather auto-attach (Open-Meteo), soil-test records, rotation
matrix.

**Still ahead**: hardware acceptance on a real Pi 5 (first `farmos-v*`
tag → install → whisper-under-bitcoind test → restore drill on USB),
document vault semantic search (pgvector), full conservation engine +
stacking checker (Phase 3), grain position (Phase 4), assistant
(Phase 5), Lightning module (Phase 6 — builds against the Bitcorn fork's
HTTP API with a regtest/mock-treasury harness).
