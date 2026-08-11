# 🌱 polibrief

**Twice-daily policy intelligence briefs for Iowa soybean priorities — on autopilot.**

polibrief watches five government data sources, filters everything against a topic
watchlist *you* control, has Claude (Anthropic's AI) triage what actually matters to
Iowa soy, and writes a structured policy brief — delivered to a web page, saved as
markdown, and optionally posted to a Microsoft Teams channel.

| Source | What it covers | Key needed? |
|---|---|---|
| Federal Register | Federal rules, proposed rules, notices (EPA, USDA, Treasury/IRS, CFTC, USTR) | No |
| Congress.gov | Federal bills with recent activity | Free key |
| LegiScan | State bills in IA, IL, MN, NE, IN, MO, WI (add "US" for full-text Congress search) | Free key |
| EUR-Lex | EU regulations (Official Journal, L series) | No |
| Iowa Admin Bulletin | Iowa administrative rule filings | No |
| Regulations.gov | Rulemaking dockets + comment deadlines | Same key as Congress.gov |
| CourtListener | Federal litigation (Roundup/FIFRA, WOTUS, pipeline cases) | No |

---

## What a run looks like

```
🌱 polibrief — am edition

📥 Federal Register: 32 fetched since 2026-06-27, 32 new
📥 Congress.gov: 0 fetched since 2026-06-27, 0 new
📥 LegiScan (state bills): 13 fetched since 2026-06-27, 13 new
📥 EUR-Lex OJ (EU law): 4 fetched since 2026-06-27, 4 new
📥 Iowa Admin Rules: 15 fetched since 2026-06-27, 15 new

🔎 Scoring 64 new items…            ← free, local keyword filter
🤖 Triage (claude-haiku-4-5): 29 relevant   ← cheap AI pass
📝 Generating brief (claude-sonnet-4-6)…     ← one AI call writes the brief
✅ Saved briefings/2026-07-03-am.md
```

Cost discipline is built in: every item is remembered in a local database so nothing
is ever paid for twice, each source only fetches what's new since its last success,
and the free local filter runs *before* any AI sees anything.

---

## First-Time Setup (on your computer)

1. Install [Node.js 20 or newer](https://nodejs.org) (LTS version).
2. In a terminal, from this folder:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and paste in your API keys (next section).
4. Test without spending anything:
   ```
   node src/index.js run --dry-run
   ```
5. Produce your first real brief:
   ```
   node src/index.js run --edition am
   ```
6. Read it in your browser:
   ```
   node src/index.js serve
   ```
   …then open http://localhost:8484

## Getting Your API Keys

- **Anthropic** (powers the AI triage + brief): create a key at
  [console.anthropic.com](https://console.anthropic.com) → API Keys. Paid, but cheap
  here — see Cost Notes below.
- **Congress.gov**: free, instant. Sign up at
  [api.congress.gov/sign-up](https://api.congress.gov/sign-up/) (keys are issued
  through api.data.gov — a Data.gov key is the same thing).
- **LegiScan**: free (30,000 queries/month). Register at
  [legiscan.com/legiscan](https://legiscan.com/legiscan) → API tab.
- **USDA FAS Export Sales** (weekly export sales + China detail): free, instant. Register at
  [apps.fas.usda.gov/opendataweb/home](https://apps.fas.usda.gov/opendataweb/home) and put it in
  `FAS_API_KEY`. ⚠️ If you ever debug this by hand: the API's docs say to send an `API_KEY` header,
  which returns *"No api_key was supplied"* — the header it actually accepts is `X-Api-Key`. The
  adapter already does the right thing; this note is here so nobody "fixes" it to match the docs.
- **Federal Register and EUR-Lex**: no keys needed.
- **Teams (optional)**: in your Teams channel → ⋯ → Workflows/Connectors → create an
  *Incoming Webhook*, and paste its URL into `TEAMS_WEBHOOK_URL` in `.env`.

## Reading a Brief

The daily policy brief is built from **policy cards**. Each card is one government action —
a rule, a bill, a court decision, a trade measure — and every card answers the same six
questions, in the same order, every time:

| | |
|---|---|
| **What changed** | The action, and who took it |
| **Posture** | Where it sits procedurally, and the date on the clock |
| **Mechanism** | The causal path from that action to a specific number |
| **So what** | What it means for an Iowa corn/soybean operation |
| **Watch next** | The named next event, with a date |
| **Evidence** | The sources it rests on, each labelled by how authoritative it is |

**The most important thing on a card is the band at the top.** Cards are grouped into
sections by how real the action is, and the band repeats it:

- **✅ In force** — final, and in effect now.
- **⚖️ In force but under challenge** — binding today, but in litigation. It may not survive.
- **📝 Proposed — NOT final** — published, not in effect. It may change a lot, or never happen.
- **🔭 Signalled, not yet an action** — someone said something. Nothing has been published,
  and there is no deadline.

A card in the "Proposed" section is **not a decision**. That distinction is the single most
important thing the brief does, which is why proposed items sit in their own section rather
than being mixed in with a small label.

Evidence is labelled by source type — *primary source* (the government's own record) down
through *agency release*, *trade press*, *general press*, *aggregator*. If a trade group
published it, it says **interested party**, because a trade group's description of a rule is
that group's characterisation, not the rule. A card can only say something is **enacted** if
a primary source establishes it; the tool refuses to publish that claim on trade-press
reporting alone.

Two more things you may see:
- ***Weak link:*** — the step in the reasoning the tool is least sure about. It is deliberate.
  A card that names its own weak step is more trustworthy than one that sounds certain.
- ***Certainty lowered from "…" in review*** — a second model reviewed the card and judged the
  first draft overstated how settled the action was. You are seeing the corrected version.

The brief ends with a stats footer showing what was scanned, and — if anything went wrong —
an **⚠️ About this run** section naming any evidence source that was unavailable. If a data
source was down, the brief says so rather than quietly leaving it out.

## Which report should I run?

Five reports, and they answer genuinely different questions. The **daily policy brief** is
the only one where policy is the subject; in the other four, markets lead.

| Report | Use it when | Lede | Runs |
|---|---|---|---|
| **▶ Run policy brief now** | Something happened in Washington, Des Moines, Brussels or a courtroom and you need to know what it does | A government action | Twice daily, plus on demand |
| **📚 Weekly memo** | Catching a colleague or board member up on the week | The week's markets, then policy | On demand |
| **🗓️ Monthly review** | Leadership wants direction of travel, not a list | The month's trends | On demand |
| **🔭 Analyst Note** | You want the forward read — where this is heading and what would prove it wrong | The market signal board | On demand |
| **🎓 Market-education brief** | A staffer needs to *learn* how the market works, not just what it did | One data point and one concept | On demand |

The rule of thumb for the daily brief: **would this still matter if the futures board hadn't
moved at all today?** If yes, it belongs in the policy brief. If the story is the price move
itself, the Analyst Note or the weekly memo is the right place.

The daily brief is deliberately short and will sometimes be empty. An empty brief means
nothing cleared the evidence bar — not that nothing was collected. Everything collected is
always on the **Laws, Rules & Decisions** tab whether it made the brief or not.

If you want to know why a brief was short, **Logs & Settings → Brief runs** shows the funnel
for every run: how many cards were drafted, how many failed the six-question contract, how
many the reviewer rejected, and how many were published.

## All Commands

```
node src/index.js run --edition am     # full pipeline (am or pm)
node src/index.js run --dry-run        # fetch + score only — NO AI calls, costs $0
node src/index.js run --source legiscan  # test one source
node src/index.js weekly               # the Friday-style synthesis memo, on demand
node src/index.js query "45Z guidance" # ask a question over everything stored
node src/index.js audit                # per-source stats + AI spend this month
node src/index.js serve                # web UI + automatic scheduling
```

## The web app

Everything below happens in the browser (the Umbrel tile / port 8484):

- **Home** — run buttons (AM / PM / weekly memo), saved briefs, upcoming comment
  deadlines, per-source status lights with 7-day counts, and the full watchlist
  editor: add/remove keywords, search phrases, LegiScan states, whole topics,
  topic weights, schedule times, and pipeline thresholds. Run failures show up
  in a red banner right on the page.
- **Items** — browse and search everything polibrief has stored. 📌 **track** an
  item and any new activity gets its own section at the top of future briefs.
  👍/👎 an item and the AI triage is told about your correction on future runs.
- **Search** — ask questions in plain English over your whole archive
  ("what happened with 45Z guidance?"); answers cite items with links.
- **📅 Deadline calendar** — subscribe to `/calendar.ics` from Outlook
  (Calendar → Add calendar → Subscribe from web) and every comment deadline
  appears on your work calendar automatically.
- **RSS** — `/feed.xml` for anything that can subscribe to feeds.
- **Brief pages** — copy the markdown, email it, or re-post it to Teams with one click.
- **Logs** — recent activity, in plain English, when something looks off.
- Scheduler runs the AM/PM briefs, the weekly memo (default Friday 5 PM), and a
  nightly backup (kept 14 days, in the data folder under `backups/`).
- Optional password: set `POLIBRIEF_PASSWORD=...` in `.env` and restart.

---

## Editing watchlist.json (no code changes, ever)

`watchlist.json` is the single source of truth. Edit it, save, done — the next run
picks it up. (On Umbrel/Docker, edit the copy in the app's data folder.)

**Add a keyword to an existing topic** — find the topic, add to its `keywords` list:
```json
"keywords": ["biodiesel", "renewable diesel", "sustainable aviation fuel", "SAF",
             "soybean oil", "used cooking oil"]
```

**Add a whole new topic** — copy an existing block and adjust. `weight` (1–10) is how
much you care; `queries` are what get sent to each source's search (leave a source's
list empty to skip it for this topic):
```json
{
  "id": "prop-12-style", "label": "Animal Housing Standards", "weight": 6,
  "keywords": ["animal housing", "confinement standards", "Proposition 12"],
  "queries": {
    "federal_register": ["animal confinement"],
    "congress_gov": ["animal housing standards"],
    "legiscan": ["animal confinement"],
    "eurlex_oj": []
  }
}
```

**Track another state** — add its two-letter code to `sources.legiscan.states`.

**Disable a source** — set its `"enabled": false`.

**Change budgets** — `maxItemsPerRun` per source caps fetching;
`output.minLocalScoreForTriage` (raise it for a stricter free filter),
`output.maxItemsToTriage`, and `output.maxItemsInBrief` control the AI stages.

**Change the schedule** — `briefEditions`: `"am"`, `"pm"` (24-hour times) and
`timezone`. The web app's scheduler follows these directly; if you use cron instead,
also update your crontab.

## Adding a Future Source

Every source is one file in `src/adapters/` implementing the same small interface —
`id`, `label`, and `fetchItems({ sinceISO, topics, sourceConfig, env })` returning a
list of normalized items (`uid`, `sourceId`, `sourceLabel`, `title`, `summary`,
`url`, `publishedAt`, `jurisdiction`, `docType`, `raw`). Register it in
`src/adapters/index.js`, add a matching entry under `sources` in `watchlist.json`,
and you're done — budgets, incremental fetching, dedup, scoring, triage, and the
brief all apply automatically. `src/adapters/iowa_admin_rules.js` is a good template
for scraping a state website; note there is no unified API for state administrative
rules, so each additional state needs its own adapter like that one.

---

## Deploying to the Raspberry Pi (Umbrel)

You have Tailscale on both machines, which makes everything easier: `ssh
umbrel@umbrel.local` from your network, or `ssh umbrel@<pi-tailscale-name>` from
anywhere. Default password is your Umbrel dashboard password.

### Option A — Clickable Umbrel app (recommended)

This puts a **polibrief tile on your Umbrel home screen**. One-time setup, three parts:

**1. The Docker image builds itself.** Pushing a `vX.Y.Z` git tag to this repo triggers the GitHub
Action (`.github/workflows/build-image.yml`), which builds the multi-arch (ARM64 + x64) image and
publishes it to `ghcr.io/mherman1990/polibrief:X.Y.Z`. No manual Docker build needed.

**2. The app store IS this repo.** `umbrel-app-store.yml` + the `isa-polibrief/` folder at the root
are the store manifest — source code and store now live together, so there's no separate store repo
to keep in sync.

**3. Install on Umbrel:**
- Umbrel dashboard → **App Store → ⋯ → Community App Stores** → paste your repo URL
  → Add → Open → install **polibrief**.
- Click the new tile once — the app creates editable `watchlist.json` and `.env`
  files in its data folder. SSH in and add your keys:
  ```bash
  nano ~/umbrel/app-data/isa-polibrief/data/.env
  ```
  then restart the app from the dashboard.

From then on: briefs run automatically at your am/pm times, and the tile opens the
reader. Over Tailscale it's also at `http://<pi-tailscale-name>:8484`.

### Option B — Plain Docker on the Pi (no app tile)

```bash
scp -r polibrief umbrel@umbrel.local:~/polibrief   # copy the folder over
ssh umbrel@umbrel.local
cd ~/polibrief && docker compose -f docker/docker-compose.yml up -d --build
```
Open `http://umbrel.local:8484` (or the Tailscale name). Edit config in
`~/polibrief/polibrief-data/`.

### Option C — Bare metal + cron (no Docker at all)

```bash
scp -r polibrief umbrel@umbrel.local:~/polibrief
ssh umbrel@umbrel.local
cd ~/polibrief && bash scripts/install-pi.sh
```
The script checks the machine, installs Node 20 if needed, verifies the database
engine built, creates `.env` for you to edit, and prints the exact cron lines to add
(see `scripts/crontab.example` for the Central-vs-UTC timezone note).

### Checking logs

- Umbrel app: dashboard → polibrief → ⋯ → Logs (or `docker logs isa-polibrief_web_1`)
- Plain Docker: `docker logs polibrief`
- Cron: `tail -50 ~/polibrief/logs/cron.log`

---

## Cost Notes

Two-model strategy, deliberately: **Haiku** (cheap, fast) reads every candidate item
and votes relevant/not; **Sonnet** (smarter, pricier) makes exactly **one** call per
brief to write it. Model names live in `.env` so you can upgrade them without
touching code.

Measured during development: a full run with 64 new items cost **about $0.11**; a
quiet run with nothing new costs **$0.00** (no AI calls at all). At two runs a day
expect roughly **$3–8/month** at default budgets. Check anytime with
`node src/index.js audit`.

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| `HTTP 401/403 … (check the API key in .env)` from a source | Wrong or expired key in `.env`. The run continues without that source and says so in the brief footer. |
| `ANTHROPIC_API_KEY is not set` | Add it to `.env` (the editable copy is in the app data folder on Umbrel). `--dry-run` works without it. |
| Congress.gov fetches 0 items | Usually normal — federal bills matching your topics don't move every day. |
| LegiScan errors about quota | Free tier is 30,000 queries/month; each run uses up to ~70. Trim `states` or per-topic `legiscan` queries if you ever hit it. |
| Iowa Admin Rules says "could not parse the bulletin" | The state changed its website markup. The run continues; the selector logic is isolated at the top of `src/adapters/iowa_admin_rules.js`. |
| better-sqlite3 won't install on the Pi | `sudo apt install -y build-essential python3` then `npm rebuild better-sqlite3 --build-from-source`. |
| Teams post fails with HTTP 4xx | The webhook URL is wrong or was deleted — create a new Incoming Webhook and update `.env`. Briefs are still saved locally either way. |
| "no items found" everywhere | First check `node src/index.js audit` for last-success times. If sources fail repeatedly from one network, try from the Pi — some networks block automated requests. |
| Want full error details | Re-run with `POLIBRIEF_DEBUG=1` set. |

## How It Works (one paragraph)

`collect.js` asks each adapter in `src/adapters/` for items published since that
source's last successful run (7-day cap on the first ever run), skipping anything
already in the SQLite database. `score.js` ranks the rest against your watchlist
keywords for free. Survivors go to Haiku in batches for relevance verdicts
(`triage.js`), every verdict is remembered so tomorrow it costs nothing, and one
Sonnet call (`brief.js`) turns the relevant items into the brief, which `deliver.js`
saves, posts to Teams, and/or emails. `server.js` is the web reader + scheduler that
the Umbrel tile opens.
