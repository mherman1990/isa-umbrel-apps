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

## 1. Current deploy state (as of 0.1.3)

- **Latest version:** `0.1.3`. Set in three places that must always agree:
  `isa-farmos/umbrel-app.yml` (`version: "0.1.3"`, port 8585),
  `isa-farmos/docker-compose.yml` (image tags `ghcr.io/mherman1990/farmos:0.1.3`
  for web+worker, `ghcr.io/mherman1990/farmos-db:0.1.3` for db), and
  `farmos/backend/pyproject.toml` (`version = "0.1.3"`).
- **`main` holds the 0.1.3 db fix** (commit `9b9842b`): multi-arch database image
  + fixed internal DB password. This is the fix that makes the Pi's db container
  actually come up on arm64 (see §4).
- **Build status:** 0.1.2 built and pushed images successfully; 0.1.3's code is on
  `main` but the **`farmos-v0.1.3` tag has not been cut yet** — until it is, GHCR
  still serves the 0.1.2 db image (the crash-looping one). *Next physical step is
  cutting that tag* (§3).
- **Branch:** active development is on `claude/farm-os-platform-dwg85i`; releases
  fast-forward to `main`, then a `farmos-v*` tag triggers the image build.
- **Phase status:** 1 Foundation ✅ · 2 Timestamping + Agronomy + Accounting ✅ ·
  3 FSA packet + Conservation engine ✅ (core) · 4 Grain position (records slice)
  ✅ / advice features **deferred** (§6) · 5 Assistant + sandbox ✅ ·
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
- **Phase 4 advice framing** (same root as the grain decision): where's the line
  between "here are your numbers" and "here's what to do"? Applies to financials
  scenarios too.

## 7. What to do next

1. **Cut `farmos-v0.1.3`** (§3) → verify the build is green → confirm both GHCR
   packages are public → Update on the Pi → **the db container should now come up
   healthy** (this is the whole point of 0.1.3). First real end-to-end install
   validation.
2. **On-Pi validation once it's up:** run `seed-demo`, walk capture→inbox→confirm,
   upload the two sample files, check the Money/Programs/Farm tabs populate.
3. **whisper-under-bitcoind timing:** confirm a 45s transcription stays polite
   (nice'd, ≤2 threads) while Bitcoin Core + LND share the 4 cores.
4. **USB restore drill on real hardware** (CI covers it in a container; prove it
   on the Pi's actual USB path once).
5. Then pick a domain to deepen from **START.md §8** — accounting exports,
   GIS boundary editor, agronomy CI-score, more region packs, etc.

## 8. Roadmap beyond current

- **Phase 6 — Lightning** (⬜): off by default behind a flag; integrates against a
  forked Bitcorn's HTTP API on regtest/mock. A payments service holds the only key
  (spend caps + allowlist); the agent never touches a wallet. Planned entities:
  `LightningNode`, `PeerSettlement`, `EscrowContract`, `PaymentPolicy`.
- **Phase 7 — Native app** (⬜): React Native client reusing the same `/api/v1`
  (device-pairing auth already supports it — no browser sessions to unwind).
- Everything is already API-first, so both are additive, not rewrites.
