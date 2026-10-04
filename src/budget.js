// budget.js — the monthly Anthropic spend cap and how it is distributed across the system.
//
// Matt set the ceiling at $75/month (2026-10-04). Before this there was no monthly ceiling at all — only
// the daily brief's optional per-run `briefCostCeilingUsd`. Measured run-rate at corrected list prices is
// roughly $20–30/month, so the cap is headroom, not a squeeze: it lets the quality-sensitive work (the
// Member Brief's Opus review, the Analyst Note) run at full strength while guaranteeing no runaway month.
//
// HOW IT IS ENFORCED
//   - Every model call already lands in token_usage with a `purpose`. Purposes roll up into GROUPS below,
//     and month-to-date (UTC calendar month) spend per group is priced with pricing.costOf().
//   - DISCRETIONARY groups (panels, memos/analyst, Ask) stop when their own allocation is spent OR the
//     whole month reaches 100% of the budget. The panel then records outcome "skipped" and says why.
//   - ESSENTIAL groups (the daily policy brief, the Member Brief) are never stopped by their allocation —
//     a member-facing product must not silently vanish because the Ask box was busy — only by the HARD
//     ceiling of 110% of the monthly budget, at which point the Member Brief fails CLOSED and alerts.
//   - Allocations are SHARES of the budget, so raising MONTHLY_BUDGET_USD scales every line.
//
// Configure with MONTHLY_BUDGET_USD in .env or `output.monthlyBudgetUsd` in watchlist.json (env wins).

import * as store from "./store.js";

export { DEFAULT_MONTHLY_BUDGET_USD, HARD_CEILING_RATIO, GROUPS, groupOf, monthlyBudget } from "./budgetcore.js";
import { HARD_CEILING_RATIO, GROUPS, groupOf, monthlyBudget, spendFromRows, summarizeSpend } from "./budgetcore.js";

/** Month-to-date spend, total and per group. */
export function monthToDate(now = new Date()) {
  return spendFromRows(store.monthUsageByPurpose(now));
}

/**
 * May a call for `purpose` proceed right now?
 * @returns {boolean}
 */
export function allow(purpose, { env = process.env, watchlist = null, now = new Date() } = {}) {
  return check(purpose, { env, watchlist, now }).ok;
}

/** Same decision as allow(), with the reason — for UI and logs. */
export function check(purpose, { env = process.env, watchlist = null, now = new Date() } = {}) {
  let mtd;
  try {
    mtd = monthToDate(now);
  } catch {
    return { ok: true, reason: "budget unreadable — allowing" }; // never let bookkeeping block a run
  }
  const budget = monthlyBudget(env, watchlist);
  const g = groupOf(purpose);
  const def = GROUPS[g];
  const alloc = budget * def.share;
  if (mtd.total >= budget * HARD_CEILING_RATIO) {
    return { ok: false, reason: `month-to-date spend $${mtd.total.toFixed(2)} is past the hard ceiling ($${(budget * HARD_CEILING_RATIO).toFixed(2)})` };
  }
  if (def.essential) return { ok: true, reason: "essential" };
  if (mtd.total >= budget) return { ok: false, reason: `monthly budget $${budget.toFixed(2)} is spent ($${mtd.total.toFixed(2)})` };
  if (mtd.byGroup[g] >= alloc) return { ok: false, reason: `the ${g} allocation ($${alloc.toFixed(2)}) is spent ($${mtd.byGroup[g].toFixed(2)})` };
  return { ok: true, reason: "within allocation" };
}

/** Table for the health page / audit. */
export function summary({ env = process.env, watchlist = null, now = new Date() } = {}) {
  return summarizeSpend(store.monthUsageByPurpose(now), monthlyBudget(env, watchlist), now);
}
