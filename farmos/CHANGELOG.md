# Farm OS Changelog

(Separate from the repo-root CHANGELOG.md, which tracks Bean Brief.
Farm OS releases use `farmos-v*` git tags.)

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
