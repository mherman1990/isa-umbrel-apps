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
export function summarizeSpend(rows, budget, now = new Date()) {
  const mtd = spendFromRows(rows);
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    budget,
    spent: mtd.total,
    projected: day ? (mtd.total / day) * daysInMonth : 0,
    groups: Object.entries(GROUPS).map(([id, d]) => ({ id, label: d.label, essential: d.essential, allocation: budget * d.share, spent: mtd.byGroup[id] ?? 0 })),
  };
}
