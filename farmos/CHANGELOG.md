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
