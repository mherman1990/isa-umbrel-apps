# Anthropic budget — $75/month and where it goes

Set 2026-10-04. Enforced in code by `src/budget.js`. Visible live on **Logs & Settings → 🩺 Data freshness & spend** (`/freshness`), and editable in **Settings → monthly AI budget**. `MONTHLY_BUDGET_USD` in `.env` overrides the Settings value.

**Since 1.45.0 the analysis group can be set in dollars** — Settings → *analysis budget $* (or `ANALYSIS_BUDGET_USD` in `.env`). Blank keeps its 20% share. When it is set, the analysis group gets exactly that amount and the other groups divide the rest of the monthly budget in proportion to their shares, so the monthly budget stays the one ceiling. See *Daily Analyst Note + education brief* below.

## Prices used (re-verified 2026-10-04)

| Model | Input $/MTok | Output $/MTok | Used for |
|---|---|---|---|
| Haiku 4.5 | 1.00 | 5.00 | triage, news ranking, digest, intel, expectations (`TRIAGE_MODEL`) |
| Sonnet 5 / 5.5 | 2.00 | 10.00 | brief, cards, storylines, packets, memos, Ask, Member Brief draft (`BRIEF_MODEL`) |
| Opus 5.5 | 4.00 | 20.00 | Member Brief review (`REVIEW_MODEL`) |
| Opus 4.8 / 5 | 5.00 | 25.00 | Analyst Note (`ANALYST_MODEL`) |

`pricing.js` had Sonnet 5 at $3/$15, so every Sonnet cost the app reported before 1.39.0 was 50% too high.

## Expected run-rate vs. allocation

The estimates assume the default schedule: AM + PM daily, storylines AM only, Member Brief Mon/Wed/Fri, weekly memo Fri, Analyst Note weekly if scheduled, ~100 Ask questions. Token sizes are taken from the measured `token_usage` notes in the CHANGELOG where they exist, and estimated otherwise. Check them against `/freshness` after the first full month.

| Group | What's in it | Est. $/mo | Allocation | Policy |
|---|---|---|---|---|
| **Member Brief** | Sonnet draft (~10k in / ~2.5k out ≈ $0.045), Opus 5.5 review at high effort (~12k in / ~3k out ≈ $0.11), one retry on some editions, previews — ≈ $0.15 typical, $0.31 worst case per edition | ~$2.5–3.5 | **$12.00** (16%) | essential |
| **Daily policy brief** | triage, evidence packets, policy cards + review | ~$9 | **$21.00** (28%) | essential |
| **Cached panels** | signal cards (2×/day, thinking at medium effort), storylines (AM; now 9k cap), digest, intel, news ranking, expectations | ~$10 | **$15.00** (20%) | discretionary |
| **Analysis** | Analyst Note + theses + Challenger, weekly/monthly/education memos | ~$4 (≈$8 with a weekly Analyst Note) | **$15.00** (20%) | discretionary |
| **Ask box + summaries** | ~$0.03 per question | ~$3 | **$9.00** (12%) | discretionary |
| Reserve | — | — | $3.00 (4%) | — |
| **Total** | | **≈ $28–33** | **$75.00** | |

### How the extra headroom was spent

Raising the cap from the old ~$20–30 run-rate to $75 went into **quality where a reader sees it**, not volume:

1. **The Member Brief's adversarial review runs on Opus 5.5 at high effort, with one retry before failing closed.** This is the costliest single safeguard. It is also the one that matters most for something sent under ISA's name.
2. **Signal cards keep their reasoning.** Thinking stays on, at medium effort, with an 8k cap instead of 2.5k. The old cap could be used up entirely by thinking, which returned an empty card.
3. **Storylines get room to finish** (9k cap, bounded to 6 threads) instead of truncating every morning.
4. **The digest and intel caps rise from ~1.5k to 2.4k**, so a busy inbox day isn't cut off mid-theme.
5. **Analysis has room for a weekly Analyst Note on Opus.** This is recommended, not switched on: set Settings → Scheduled reports → Analyst Note → `Mon 06:00`. A scheduled Analyst Note is what keeps the forecast ledger fed. The refresh gate makes sure the AM data refresh completes before it runs.

### Enforcement

- **Discretionary groups** pause when their allocation is spent, or when the month reaches 100% of the budget.
  - A paused panel records outcome `skipped` and says so on screen.
  - The Ask box and memos return a "paused by the monthly AI budget" message.
- **Essential groups** (daily brief, Member Brief) are never stopped by their own allocation. They stop only at the **hard ceiling of 110%** of the budget.
  - At that point the Member Brief **fails closed**: it is not sent, the draft is saved, and you get an alert.
- Allocations are shares of the budget, so changing the $75 scales every line — except an analysis budget set in dollars, which stays fixed while the other groups share the remainder.

### Daily Analyst Note + education brief (1.45.0)

Scheduling both reports every day (e.g. *Daily 15:30*) moves the analysis group from ~$4–8 to roughly **$38–41 a month**:

| Report | Model | Per run | 30 runs |
|---|---|---|---|
| Analyst Note | Opus 4.8, effort xhigh, web search, + thesis + Challenger calls | ≈ $1.16–1.24 (range $0.61–2.18) | ≈ $35–37 |
| Market-education brief | Sonnet 5, one call | ≈ $0.09–0.12 | ≈ $3 |

At the default 20% share ($15 of $75) both reports would be paused from about day 12 of each month, taking the weekly and monthly memos with them. The recommended setting is **monthly budget $105, analysis budget $45**: analysis gets $45 and every other group keeps exactly the dollars it had at $75 ($60 between them). Expected total spend is about $65–75 a month; the $105 is a ceiling, not a target. Re-measure after a week of daily runs:

```sql
SELECT purpose, model, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens)
  FROM token_usage WHERE purpose IN ('memo','thesis','challenge') AND ts >= date('now','-7 day') GROUP BY 1,2;
```

Prompt caching does not carry across days (the longest TTL is one hour); inside one Analyst run it still saves the web-search loop's re-reads. The Batch API would halve the Analyst's main call but cannot guarantee a 15:30 delivery, so it is not used.

### Not used yet: Batch API (50% off)

None of the scheduled calls is latency-tolerant enough today:
- The AM run feeds the brief within minutes.
- The Member Brief has a fixed send time.

The candidate is storylines. It could be submitted as a batch at the AM run and collected at PM, which would save ≈$1/month. That is not worth the moving parts at this budget. Revisit if the cap tightens.
