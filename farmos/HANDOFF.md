# Farm OS — HANDOFF

> **What this is:** the *live state* of Farm OS — where the deploy stands, how a
> release actually gets to the Pi, the gotchas that cost us build cycles, the
> decisions still open, and what to do next. Read **START.md** first for what the
> product *is* and how the code is laid out (§8 there maps each domain → files +
> the expertise to bring). This file is the "current situation" half.
>
> **Using this for prompt engineering:** paste START.md + this file + a focused
> ask. This file tells the next Claude what's already shipped, what's half-built,
> and what not to re-litigate.

---

## 1. Current deploy state (released 0.1.3; 0.2.0 accounting expansion staged, not tagged)

- **Latest released version:** `0.1.3`. **CORRECTION (verified against GitHub
  2026-07-12):** `farmos-v0.1.3` **is** tagged and released — the tag exists, the
  GitHub Release "Farm OS 0.1.3" is published (16:06 UTC), and
  `build-farmos-image.yml` run #4 on that tag went **green** (16:06→16:21 UTC).
  The earlier claim here that the tag was "not cut yet" was stale on arrival.
  Remaining manual, off-GitHub steps to confirm: both GHCR packages set
  **public** (§3 step 5 / §4), and the on-Pi Update + validation (§7).
- **`main` holds the 0.1.3 db fix** (commit `9b9842b`): multi-arch database image
  + fixed internal DB password — the fix that makes the Pi's db come up on arm64.
- **Accounting expansion (targets `0.2.0`)** is built on
  `claude/farmos-expansion-plan-qj1muj`: Schedule F classification + lender-packet
  export, cash-flow projection + operating-line tracking, enterprise allocation,
  and operating-mode scenarios (Lease wired). The 3-file version bump to `0.2.0`
  is **staged but the tag is NOT cut** (tags are manual — §3). Full local suite
  green + restore drill re-verified (migrations 0008–0009).
- **The 3 version files that must always agree:** `isa-farmos/umbrel-app.yml`
  (`version`, port 8585), `isa-farmos/docker-compose.yml` (image tags
  `ghcr.io/mherman1990/farmos[-db]:<v>`), `farmos/backend/pyproject.toml`.
- **Branch:** dev on `claude/farmos-expansion-plan-qj1muj` (this expansion);
  releases fast-forward to `main`, then a `farmos-v*` tag triggers the build.
- **Phase status:** 1 Foundation ✅ · 2 Timestamping + Agronomy + Accounting ✅
  (**Accounting deepened 0.2.0** — see §7) · 3 FSA packet + Conservation engine ✅
  (core) · 4 Grain position (records slice) ✅ / grain advice still deferred (§6,
  but the framing that blocked it is now resolved) · 5 Assistant + sandbox ✅ ·
  6 Lightning ⬜ (fork ready) · 7 Native app ⬜.

## 2. How the deploy pipeline actually works

Same shape as Bean Brief — the farmer only ever "updates" in the Umbrel store.

```
edit code on claude/farm-os-platform-dwg85i
   → bump version in the 3 files above
   → commit, push branch
   → fast-forward main so it contains isa-farmos/ + the new farmos/ code
   → cut tag farmos-v<version>  (via GitHub Releases UI — see §3)
   → .github/workflows/build-farmos-image.yml builds multi-arch
     (linux/arm64 + amd64, buildx + QEMU) and pushes to GHCR:
        ghcr.io/mherman1990/farmos:<version>       (web + worker, docker/Dockerfile)
        ghcr.io/mherman1990/farmos-db:<version>    (db, docker/db.Dockerfile)
   → make BOTH GHCR packages public (one-time per package; see §4 gotcha)
   → in Umbrel: the isa-umbrel-apps community store → Farm OS → Update
```

`isa-farmos/` (at the repo root) is the Umbrel app folder the store reads:
`umbrel-app.yml` (manifest) + `docker-compose.yml` (3 services + injected
`app_proxy`) + `icon.png`. The `farmos/` folder is the source the images are
built from. **Both must ride to `main`** for a release to work — the store reads
`isa-farmos/` from `main`, and the build reads `farmos/` from the tag.

## 3. Release runbook (the GitHub half the farmer does)

Tag pushes from the CLI hit an HTTP 403 (a GitHub **tag-protection ruleset** —
the proxy logged no failure; it's server-side). So tags are cut through the UI:

1. GitHub → **Releases** → *Draft a new release*.
2. **Tag:** `farmos-v<version>` (e.g. `farmos-v0.1.3`), target **main**.
   *Create the tag on publish.*
3. Title/notes: copy the top CHANGELOG entry. Publish.
4. Publishing the tag triggers `build-farmos-image.yml`. Watch **Actions**.
5. First release of each image only: GHCR → the `farmos` and `farmos-db`
   packages → **Package settings → Change visibility → Public** (Umbrel pulls
   anonymously; a private package = `manifest unknown` / image-pull failure on
   the Pi).
6. On the Pi: Umbrel → App Store (community) → Farm OS → **Update**.

If the ruleset ever blocks the *release* UI too, the farmer can relax it in
Settings → Rules; he already loosened it enough to create tags via Releases.

## 4. Known gotchas (each of these cost a build cycle — don't rediscover them)

- **`postgis/postgis:16-3.4` is NOT arm64-safe.** Its tag served amd64 binaries;
  on the Pi the db died with `exec format error` and crash-looped
  (`Restarting (255)`), which then showed downstream as web/worker
  `failed to resolve host 'isa-farmos_db_1'`. **Fix (0.1.3):** `db.Dockerfile`
  now bases on the genuinely multi-arch `postgres:16-bookworm` and installs
  PostGIS from PGDG on top. pgvector install is best-effort (non-fatal) —
  migration 0001 tolerates its absence.
- **`${APP_SEED}` is not reliably substituted by Umbrel** in compose env. It left
  the db with an empty/garbage password → auth failures. **Fix:** the internal DB
  password is a literal (`farmoslocaldbpw`) in both the db env and
  `FARMOS_DATABASE_URL`. Safe because the db publishes no ports and is reachable
  only on the app's private compose network — a per-install secret adds nothing.
- **GDAL/fiona has no arm64 wheel** → `pip install ./backend` tried to build from
  source (needs `gdal-config`) and failed the image build (0.1.1). **Fix (0.1.2):**
  dropped fiona for pure-Python **`pyshp`** (+ shapely + json) in
  `services/clu_import.py`. **Rule going forward: every dep must ship an arm64
  wheel** — no source builds on the Pi or under QEMU. (Also why we use
  `procrastinate` on the psycopg3 connector, not `[psycopg2]`.)
- **whisper.cpp wouldn't compile under QEMU** (0.1.0, cmake exit 2). **Fix:**
  `-DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF` and
  `cmake --build build -j2 --target whisper-cli` (native CPU detection off, keep
  the parallelism modest so QEMU doesn't OOM).
- **psycopg 3.3.x returns `bytes` for `server_version`** → breaks SQLAlchemy
  dialect init. Pinned `psycopg[binary]>=3.2,<3.3`.
- **ALTER migrations must be idempotent.** The 0001 baseline builds tables from
  *current* metadata, so a fresh DB already has columns that later migrations add.
  0003/0004 collided until switched to `ADD COLUMN IF NOT EXISTS`. The **CI
  restore drill caught this** — keep running it after any schema change.
- **Procrastinate needs the connector opened in *both* processes.** The worker
  needs an async connector (`replace_connector` in `worker.py`); the web process
  must `job_app.open()` in the FastAPI lifespan or deferred jobs silently fail
  until the nightly retry. Both were caught by sandbox mode.
- **Terminal reminders for the farmer:** docker on the Pi needs `sudo`; the
  seed command is `python -m app.manage seed-demo` (no trailing comma — a stray
  `seed-demo,` just prints usage).
- **API tests share ONE session-scoped DB** (`app_and_engine` builds tables once;
  rows accumulate across tests, never reset). New `tests/api` cases MUST use their
  own isolated `crop_year` and unique `farm_number`/`tract_number`/field name, or
  they collide with sibling tests (a `field_fsa_uq` UniqueViolation or a summed
  total that's off by another test's data). This bit the 0.2.0 cash-flow tests
  twice; grep existing `YEAR =` / `farm_number=` before picking values.

## 5. Sandbox & sample data (for demoing / testing without real data or a key)

- **Sandbox mode:** `FARMOS_DEV_FAKE_LLM=1` → a $0 local stub, every output
  labeled `[sandbox model]`. `python -m app.manage seed-demo` builds "Demo Farm
  (Sandbox)": 6 fields, rotation, operations, inventory, money, contracts, scale
  tickets, practices with tamper-evident evidence, an enrollment, and a 3-record
  voice capture sitting in the inbox. The whole capture→inbox→chat loop runs
  offline. `seed_demo.py` is the source of truth for that farm.
- **Sample upload files** (for a *running* instance, exercise the real import code
  paths — both verified end-to-end):
  - `FarmOS_Sample_Data_2024-2026.xlsx` — tabs *Rotation Plan*
    (Field|Acres|2024|2025|2026), *Transactions* (28 rows), *Budget 2026*
    (Crop|Category|$/ac); blue-font input cells. Imports to 6 crop_years/year,
    28 transactions, 11 budget_lines, no warnings.
  - `FarmOS_Sample_Fields.geojson` — 6 Story County, IA (STATE_ANSI 19,
    COUNTY_ANSI 169) CLU polygons, FARM_NBR 4321, tract/CLU numbers, computed
    acres within 0.3% of stated. Imports through the CLU importer.
  - These currently live in the session scratchpad, not the repo. If they should
    become fixtures, land them under `farmos/tests/` or `farmos/docs/samples/`.

## 6. Open decisions (don't silently resolve these — they're product calls)

- **Grain marketing = education, not advice.** Store-vs-sell analysis and a
  marketing scorecard are **deliberately deferred** until the framing is settled:
  the assistant shows a farmer his own position and the mechanics, never "you
  should sell." Anyone extending `services/grain.py` must read this first.
- **Ship-name collision with farmOS.org.** The product is called "Farm OS" and
  there's an established open-source **farmOS**. Revisit the public name before
  any wider release (app id `isa-farmos` is fine internally).
- **Region-pack verification owner.** Every program claim carries `verify_by`;
  someone has to actually re-verify against FSA/NRCS/IDALS on cadence and bump the
  pack version. Iowa pack is at `ia-2026.5.yaml`. This is an ongoing human job,
  not code.
- **Bitcorn permission before Phase 6.** Fork is authorized (written agreement via
  text) for the Lightning integration, standalone core stays independent. Confirm
  scope/licensing again in writing before building against the fork.
- **Phase 4 / financials advice framing — RESOLVED 2026-07-12 (owner).** The owner
  decided there is **no education-not-advice limit on this app**. Financials may
  draw plain comparative conclusions from real numbers (0.2.0 operating-mode
  scenarios ship a comparative verdict). The one hard rule that still stands is
  separate and unchanged: **never fabricate a number** — surface gaps instead.
  This same decision unblocks the **grain-marketing** deferral above (store-vs-sell,
  marketing scorecard), but `services/grain.py` was **not** touched in 0.2.0; that
  is a clean future workstream now that the framing is settled.

### New open decisions from the 0.2.0 accounting expansion (don't silently resolve)
- **Release version number.** Staged as `0.2.0` (a feature expansion, not a patch).
  Change to `0.1.4` before cutting the tag if you prefer to continue the patch line.
- **Schedule F "other" handling.** The default category `other` and any unrecognized
  category are treated as **uncategorized** (surfaced, excluded from totals) rather
  than swept into IRS line 32. Deliberate (maximizes honesty; WS4 lets the farmer
  reclassify), but confirm you don't want a first-class path to line 32.
- **Cash-flow timing pack ownership.** `cashflow_packs/ia-cashflow-2026.yaml` is a
  cited *typical* Iowa calendar with a `verify_by` — like region packs, it needs a
  human to re-verify on cadence. Also open: should the farmer be able to override
  per-category timing (currently pack-only)?
- **Operating-line interest.** Interest is a manually-entered ledger event; there is
  no auto-accrual from the APR field. Confirm manual entry is sufficient.
- **Lender packet format.** Ships as print-to-PDF HTML (no new dep, per D3). Revisit
  if a native PDF is wanted — only with a confirmed pure-Python arm64 wheel.

## 7. What to do next

0. **DONE (0.1.3):** the tag is cut and the build is green (see §1). Still confirm
   the two GHCR packages are **public** and do the on-Pi Update — the db container
   should come up healthy on arm64 (the whole point of 0.1.3).
1. **Ship the 0.2.0 accounting expansion.** Built + tested on
   `claude/farmos-expansion-plan-qj1muj`; the 3-file bump to `0.2.0` is staged.
   To release: fast-forward `main`, then cut `farmos-v0.2.0` via the Releases UI
   (§3). What shipped (all API-first, offline-safe, LLM-free, gap-honest):
   - Schedule F classification (`/financials/schedule-f`) from a versioned tax pack
   - Lender-packet export (`/financials/lender-packet`, print-to-PDF HTML; no
     balance sheet — disclosed, not faked)
   - Cash-flow projection (`/financials/cash-flow`) + operating-line ledger
     (`/operating-loans`, balance derived from draws/paydowns)
   - Enterprise allocation (`PATCH /transactions/{id}`) — reclassify closes the
     Schedule F uncategorized gap
   - Operating-mode scenarios (`POST /financials/scenarios`) + wired Lease
     (`/leases`); comparative verdict allowed (§6 resolution)
   - New migrations 0008–0009; restore drill re-verified.
2. **On-Pi validation:** `seed-demo` (now ships an operating line + two leases),
   walk capture→inbox→confirm, upload the sample files, and check the Money tab's
   new cards (Schedule F, lender packet, cash flow, operating line, tenure).
3. **whisper-under-bitcoind timing:** confirm a 45s transcription stays polite
   (nice'd, ≤2 threads) while Bitcoin Core + LND share the 4 cores.
4. **USB restore drill on real hardware** (CI covers it in a container; prove it
   on the Pi's actual USB path once).
5. Then pick the next §8 domain to deepen — GIS boundary editor, agronomy
   CI-score, more region packs, or the now-unblocked grain-marketing advice (§6).

## 8. Roadmap beyond current

- **Phase 6 — Lightning** (⬜): off by default behind a flag; integrates against a
  forked Bitcorn's HTTP API on regtest/mock. A payments service holds the only key
  (spend caps + allowlist); the agent never touches a wallet. Planned entities:
  `LightningNode`, `PeerSettlement`, `EscrowContract`, `PaymentPolicy`.
- **Phase 7 — Native app** (⬜): React Native client reusing the same `/api/v1`
  (device-pairing auth already supports it — no browser sessions to unwind).
- Everything is already API-first, so both are additive, not rewrites.
