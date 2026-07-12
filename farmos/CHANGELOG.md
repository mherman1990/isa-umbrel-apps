# Farm OS Changelog

(Separate from the repo-root CHANGELOG.md, which tracks Bean Brief.
Farm OS releases use `farmos-v*` git tags.)

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
