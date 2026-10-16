// budgetcore.js — the budget's allocation table and arithmetic, with NO store import, so the read-only
// freshness audit (scripts/audit-freshness.mjs → src/health.js) can price month-to-date spend from its own
// read-only connection. src/budget.js wraps this with the live store. See budget.js for the policy.

import { costOf } from "./pricing.js";

export const DEFAULT_MONTHLY_BUDGET_USD = 75;
export const HARD_CEILING_RATIO = 1.1;

/**
 * Where the money goes. `share` sums to 1.0. `est` is the expected monthly cost at current list prices
 * and the default schedule (see docs/BUDGET.md for the arithmetic); the rest of each share is headroom.
 */
export const GROUPS = {
  member_brief: {
    label: "Member Brief (M/W/F) — synthesis + Opus review + one retry",
    share: 0.16,
    essential: true,
    purposes: ["member_brief", "member_review"],
  },
  daily_brief: {
    label: "Daily policy brief — triage, evidence packets, cards + review",
    share: 0.28,
    essential: true,
    purposes: ["triage", "packet", "policy_cards", "policy_review", "brief"],
  },
  panels: {
    label: "Cached panels — storylines, news digest, market intel, signal cards, news ranking, expectations",
    share: 0.2,
    essential: false,
    purposes: ["storylines", "news_digest", "market_intel", "cards", "news_rank", "expectations"],
  },
  analysis: {
    label: "Analyst Note + memos (weekly, monthly, education) + theses/challenger",
    share: 0.2,
    essential: false,
    purposes: ["memo", "thesis", "challenge", "forecast_extract"],
  },
  ask: {
    label: "Ask box + per-item AI summaries",
    share: 0.12,
    essential: false,
    purposes: ["query", "summary"],
  },
  reserve: { label: "Unallocated reserve", share: 0.04, essential: false, purposes: [] },
};

const PURPOSE_GROUP = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, d]) => d.purposes.map((p) => [p, g])));
export const groupOf = (purpose) => PURPOSE_GROUP[purpose] ?? "reserve";

/** The configured monthly budget in USD. */
export function monthlyBudget(env = process.env, watchlist = null) {
  const fromEnv = Number(env.MONTHLY_BUDGET_USD);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromWl = Number(watchlist?.output?.monthlyBudgetUsd);
  if (Number.isFinite(fromWl) && fromWl > 0) return fromWl;
  return DEFAULT_MONTHLY_BUDGET_USD;
}

/**
 * An optional fixed dollar allocation for the "analysis" group (Analyst Note, memos, theses), set with
 * ANALYSIS_BUDGET_USD in .env or `output.analysisBudgetUsd` in watchlist.json (env wins). Null when unset —
 * then the group keeps its 20% share. Added in 1.45.0 so a daily Analyst Note (~$1.20/run on Opus) can be
 * funded without scaling every other group's ceiling up with the total.
 */
export function analysisBudget(env = process.env, watchlist = null) {
  for (const v of [env?.ANALYSIS_BUDGET_USD, watchlist?.output?.analysisBudgetUsd]) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Dollar allocation per group. With no analysis override, every group gets its share of the budget, as
 * before. With one, "analysis" gets exactly that many dollars (capped at the budget) and the other groups
 * divide what is left in proportion to their own shares — so the monthly budget stays the one ceiling.
 * Example: $105 budget with analysis $45 → the others split $60, exactly their dollars at $75 × 80%.
 */
export function allocations(budget, analysisUsd = null) {
  // An override at or above the whole budget would leave the other groups $0 — Panels and Ask would pause
  // at $0 spent. Settings refuses that; a conflicting .env pair falls back to the shares (and /freshness
  // warns) rather than silently starving everything else.
  if (analysisUsd == null || !(analysisUsd < budget)) return Object.fromEntries(Object.entries(GROUPS).map(([g, d]) => [g, budget * d.share]));
  const analysis = Math.max(analysisUsd, 0);
  const rest = budget - analysis;
  const otherShare = 1 - GROUPS.analysis.share;
  return Object.fromEntries(Object.entries(GROUPS).map(([g, d]) => [g, g === "analysis" ? analysis : rest * (d.share / otherShare)]));
}

/** Month-to-date spend from token_usage rows grouped by purpose + model. */
export function spendFromRows(rows) {
  const byGroup = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, 0]));
  let total = 0;
  for (const r of rows ?? []) {
    const c = costOf(r.model, { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens ?? 0, cacheWrite: r.cache_write_tokens ?? 0 });
    byGroup[groupOf(r.purpose)] += c;
    total += c;
  }
  return { total, byGroup };
}

/** The allocation table with spend filled in — shared by the health page and the audit CLI. */
export function summarizeSpend(rows, budget, now = new Date(), analysisUsd = null) {
  const mtd = spendFromRows(rows);
  const alloc = allocations(budget, analysisUsd);
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    budget,
    spent: mtd.total,
    projected: day ? (mtd.total / day) * daysInMonth : 0,
    analysisOverride: analysisUsd,
    groups: Object.entries(GROUPS).map(([id, d]) => ({ id, label: d.label, essential: d.essential, allocation: alloc[id], spent: mtd.byGroup[id] ?? 0 })),
  };
}
