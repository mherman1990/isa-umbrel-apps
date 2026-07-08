# BeanBrief — Marketing Trigger Engine: Domain & Build Context

**Audience:** the coding agent / synthesis step building BeanBrief's market-education trigger system.
**Purpose:** give you enough grain-marketing domain knowledge to (a) implement the two trigger engines correctly, (b) render farmer-facing cards that teach rather than advise, and (c) stay inside the compliance line. Read this before touching `calendar_events.2026.json` or `condition_triggers.json`.

BeanBrief is an **education** product, not an advisory service. It never tells a farmer to buy or sell. It surfaces *what is happening*, *what history shows*, and *what a farmer might review in their own plan or with their own advisor*. Every design decision below serves that framing.

---

## 1. The core model: two kinds of triggers

Respected grain-marketing educators (Ed Usset / U. Minnesota Center for Farm Financial Management, and the extension economists whose seasonal work underpins this) converge on one framework: a sound marketing plan pairs **price/condition targets** with **decision dates**. The hard part is knowing which one governs when they disagree. BeanBrief encodes both as separate engines:

| Engine | Table / file | Nature | Evaluated by |
|---|---|---|---|
| **Calendar engine** | `calendar_events.2026.json` | Fixed known dates (USDA reports, crop-insurance milestones). Deterministic. | A cron job that looks ahead `lead_days` and queues a card. No model needed to decide *whether* to fire. |
| **Condition engine** | `condition_triggers.json` | Computed market states (seasonal windows, COT extremes, basis/carry state). | A scheduled evaluator that runs each trigger's `fire_when` predicate against live data feeds. |

Both feed the existing **Haiku triage → Sonnet synthesis** pipeline. Haiku decides which live triggers matter *today* and de-duplicates overlaps; Sonnet writes the single human-readable BeanBrief card.

**Design rule:** the calendar engine answers "is a known event coming?"; the condition engine answers "is the market in a noteworthy state?" Keep them decoupled — different refresh cadences, different failure modes.

---

## 2. Compliance guardrails (read this twice)

This is the most important section. A well-meaning model will drift toward advice. Do not let it.

### 2.1 Card taxonomy — every card is exactly one type

- **`whats_happening`** — a factual, scheduled event. *"The Acreage report releases June 30 at 11:00 a.m. CT. It's frequently the single largest price-moving report of the year."*
- **`what_history_shows`** — a statistical/seasonal pattern, always with the sample and the caveat. *"Since 2010, soybean cash prices have been weakest near harvest and firmer through winter and spring in most years — though not all."*
- **`review_your_plan`** — prompts the farmer toward their own numbers/advisor, never a directive. *"This is the window many operations use to check new-crop prices against their own breakeven. Your crop-insurance guarantee and cost of production are the numbers to have in front of you."*

If a card doesn't fit one of these three cleanly, it isn't ready to ship.

### 2.2 Banned phrasings (hard filter — reject any card containing these intents)

- "You should sell / buy / hold / store now."
- "Now is a good/bad time to price."
- "Prices will / are going to [rise/fall]." (Prediction. Replace with what history *has done* or what the market *is* doing.)
- "We recommend / our advice is / the smart move is…"
- Any implied guarantee about crop-insurance payouts, basis, or price direction.

### 2.3 Required elements on every card

- **Sample + caveat** on any `what_history_shows` card. Frequencies must state the window (e.g., "in X of the last 15 years"). Never present a seasonal tendency as a rule.
- **Standard footer** (paraphrase, don't hardcode a copied sentence): *Seasonal and historical patterns are a baseline expectation, not a forecast. They don't hold every year. This is general education, not a recommendation to buy, sell, or hold. Decisions should reflect your own costs, cash-flow needs, risk tolerance, and — where appropriate — your own advisor.*
- **No personalized numbers server-side.** See §6.

### 2.4 The one framing that lets us teach pre-harvest selling safely

Farmers worry pre-harvest selling means "selling low then watching a rally." The clean, compliant education point is the **Revenue Protection Harvest Price Option (RP-HPO)**: policies with the harvest-price option settle on the *higher* of the February spring price or the October harvest price. So on RP-HPO acres, a rally after an early sale raises the insurance guarantee to help cover replacement bushels. We can *explain that mechanic* (it's how the product works) without ever recommending a sale. This is the backbone of any pre-harvest-timing card.

---

## 3. Seasonal spine (the `what_history_shows` core)

This is the most robust, most-cited body of knowledge and the source of most condition triggers. Consistent across CME education, multiple land-grant extension programs, and Grant Gardner's (U. Kentucky) 2010–2025 national soybean seasonal-price-index study.

**The shape of a "typical" soybean year:**

1. **Harvest low (Sept–Nov).** Prices usually weakest when supply peaks; basis is widest. Post-harvest prices then tend to recover.
2. **Post-harvest recovery (Jan–Mar).** Michigan State data: post-harvest cash prices exceeded the marketing-year average ~70% of the time in Jan–Mar.
3. **"February break."** South American harvest begins in February and pressures winter U.S. rallies unless SA has a short crop.
4. **Spring/summer high — the "money window."** Soybean prices typically peak mid-to-late summer, then fade into harvest. Practitioner rule of thumb (Naomi Blohm, Total Farm Marketing): the best seasonal pricing window is often **Mother's Day to Father's Day — roughly mid-May to mid-June.**
5. **"July 4th" checkpoint.** Widely taught extension heuristic: in ~9 years out of 10 it has paid to have stored old-crop and pre-harvest new-crop marketing wrapped up by early July.

**Two guardrail patterns (so BeanBrief doesn't cry seasonality every year):**

- **Harvest-strong years are rare but real.** Over the last 15 years, soybeans were stronger at harvest than the rest of the year only ~3 times (2015, 2019, 2024), driven by tight stocks, weather risk, or trade uncertainty. BeanBrief should detect and flag when the *current* year is tracking like a harvest-strong exception, and soften the standard seasonal card accordingly.
- **February is almost never the annual high.** Going back to 1994, February was the calendar-year high for new-crop November soybeans (or December corn) only once. Useful as a calming counterweight during the February crop-insurance-price rally, when farmers may feel pressure to act on a spike.

**Institutional validation of the window:** ADM's Automatic Selling Price (ASP) contract averages new-crop pricing over **May 22 – Aug 4** precisely because, on a ~10-year average, November soybean futures peaked in late May and eased into summer. It reportedly averaged ~42¢/bu better than the harvest price across 2013–2022. (Use as evidence the window is real; do not present the contract itself.)

---

## 4. The Usset planning framework (source of the `review_your_plan` cards)

Ed Usset's "Grain Marketing Is Simple (It's Just Not Easy)" and the extension "Winning the Game" workshops are the canonical, land-grant, non-commercial teaching. Two farm-specific numbers drive everything:

- **Cost of production (breakeven)** — the minimum-price floor / discipline anchor.
- **Crop-insurance guaranteed bushels** — the safe basis for *sizing* pre-harvest sales.

Sizing convention educators teach: price in **10–20% increments** of expected or insurance-guaranteed production. His teaching characters map cleanly to card content:

- *Justin Price* — prices ~80% of expected production in four 20% "scale-up" steps, each target above breakeven; risk is being "too stubborn," missing good-not-great years by holding out for top prices.
- *Terry Timer* — prices in 20% increments **monthly, March–June**, plus 20% at harvest, with a breakeven minimum for discipline. Illustrates decision-dates + a floor.
- *Aunt Tilly* — simplest pre-harvest approach; over ~32 years beat the harvest price by ~16¢/bu corn and ~24¢/bu soybeans. Evidence that *some* disciplined pre-harvest action beat selling everything off the combine.

**Card use:** these become winter "write your plan" prompts and spring "checkpoint" prompts — never "do what Justin did," but "here's the planning arc many operations use; your breakeven and insurance bushels are the inputs."

---

## 5. Condition signals — implementation notes

Details of each predicate live in `condition_triggers.json`; the domain rationale is here.

### 5.1 COT / managed-money positioning
- Source: CFTC **Disaggregated** COT, **Managed Money** category. Released **Fridays 3:00 p.m. CT**, data as of the prior **Tuesday**. Barchart mirrors it if a direct feed is easier.
- Behavior model: managed money is **trend-following**; commercials **fade** rallies. The teachable event is a **record/large short position unwinding** (short-covering), which historically has coincided with pricing windows for unpriced producers.
- Compute: net managed-money position as a **percentile and z-score over a ~156-week (3-yr) lookback**, plus **flip detection** (net long ↔ net short) and week-over-week change.
- Framing: treat extremes as **context, not a signal** — this is both good statistics and good compliance. Ties directly into the existing ISA Market Intel COT dashboard; reuse that logic.

### 5.2 Basis + carry (the sell-now-vs-store education 2×2)
The cleanest computable store/deliver card. `carry` = the futures **calendar spread** (e.g., Jul − May); `basis` = local cash − nearby futures.

| | **Weak basis** | **Strong basis** |
|---|---|---|
| **Large carry (≥ storage cost)** | Market wants grain **later** → education: conditions that have historically favored storing | mixed signal → present both sides |
| **Low / negative carry** | mixed signal → present both sides | Market wants grain **now** → education: conditions that have historically favored delivery |

Also teach the predictable shape: **basis widens into harvest, narrows through the storage season.** Always pair with "storage has real costs (interest, shrink, quality) — compare against your own."

### 5.3 China seasonal demand clock
Practitioner consensus: China sources **Brazilian** beans roughly **Feb–July** (SA harvest), and typically doesn't return to **U.S.** new crop until **~August**. The recurring "does China show up for new crop in August?" question is a schedulable narrative beat, and export-sales Thursdays are where it shows up in the data.

### 5.4 Pre-report fund positioning
Watch the **3–5 days before Acreage (Jun 30) and quarterly Grain Stocks** for fund "evening up." Example: the week before June 30, 2026, funds liquidated 3B+ bushels of length across corn/soy/wheat, driving a seasonal dip. Card: heightened-volatility-ahead-of-report, not a direction call.

---

## 6. Personalization hooks (client-side only)

Usset's method is farm-specific, but BeanBrief's privacy philosophy (localStorage, no server-side farm data — same as ISA Market Intel) must hold. Optional, browser-local inputs:

- `breakeven_per_bu` — lets a seasonal-window card add context ("new-crop is trading above the breakeven you entered during the mid-May–mid-June window"). Never stored server-side, never logged.
- `pct_sold` — lets the July-4 checkpoint card personalize ("you've marked ~40% priced").
- `insurance_guaranteed_bu` — for sizing-education context in increments.

**Rule:** personalization changes *wording of the education*, never crosses into a recommendation, and never leaves the browser. If a value is absent, fall back to the generic card.

---

## 7. Triage / de-duplication rules (for the Haiku step)

Multiple triggers routinely co-fire (e.g., on a mid-June Tuesday: `seasonal_window_open` + a WASDE two days out + a COT flip). Rules:

1. **One primary card per push.** Rank by `impact` (calendar) / `priority` (condition); highest wins the headline, others become at-most-two secondary bullets.
2. **Suppress redundant seasonality.** If a fixed-date report card is the headline, don't also lead with a generic seasonal card the same day.
3. **Respect `suppress_if`.** e.g., soften/skip the standard bullish-seasonal card when `harvest_strong_anomaly` is active.
4. **Never stack disclaimers.** One footer per card.
5. **Cadence hygiene.** Weekly recurring items (Crop Progress Mon, Export Sales Thu) are background context, not standalone pushes unless a condition trigger elevates them.

---

## 8. Data feeds & cadence (build checklist)

| Feed | Source | Cadence | Powers |
|---|---|---|---|
| WASDE / Crop Production | USDA WAOB / NASS | Monthly (see JSON) | Calendar events |
| Prospective Plantings, Acreage, Grain Stocks | USDA NASS | Per calendar | Calendar events |
| Crop Progress | USDA NASS | Mon 4:00 p.m. ET, Apr–Nov | Condition context |
| Export Sales | USDA FAS | Thu 8:30 a.m. ET | China clock, demand |
| Futures (Nov beans, Dec corn, spreads) | market data feed | intraday/daily | seasonal windows, carry |
| Local cash / basis | elevator or basis source | daily | basis/carry 2×2 |
| Disaggregated COT | CFTC (or Barchart) | Fri 3:00 p.m. CT | COT trigger |
| Crop-insurance prices | USDA RMA | Feb & Oct discovery | insurance milestone cards |

All USDA report **times are Eastern**; USDA shifts dates around holidays — verify annually against issuing-agency calendars. 2026 crop-insurance spring projected prices already set: soybeans **$11.09**, corn **$4.62**, spring wheat **$6.19**.

---

## 9. Sources (for provenance; not to be reproduced in cards)

- Seasonal patterns: U. Wisconsin Extension; CME Group grain seasonality education; Michigan State Extension ("When is the Best Time to Sell Grain?"); Grant Gardner, *Southern Ag Today*, "Price Seasonality: What the Pattern Shows" (Feb 2026), 2010–2025 index.
- Planning framework: Ed Usset, U. Minnesota CFFM — "Grain Marketing Is Simple," "Winning the Game," Farm Progress columns (Justin Price / Terry Timer / Aunt Tilly).
- USDA calendar: USDA WASDE page; CME "Understanding Major USDA Reports in 2026"; NASS release calendar.
- Crop insurance: USDA RMA; American Farm Bureau Market Intel; *farmdoc daily* (projected prices/volatility 2026); DTN.
- Condition signals: CFTC Disaggregated COT notes; Barchart COT; U. Nebraska CropWatch (basis & carry); Naomi Blohm / Arlan Suderman / Rhett Montgomery market commentary (2026).

---

*This document is internal build context for BeanBrief. The seasonal statistics and dates reflect sources current as of mid-2026 and should be re-verified each crop year.*
