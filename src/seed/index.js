// seed/index.js — the registry seeders. A seeder UPSERTS ENTITIES into the registry
// (a different verb from a collection adapter, which emits Items). Each exports
// { id, label, seed({ env, ... }) -> { upserted, ... } }.

import * as openstates from "./openstates.js";
import * as fec from "./fec.js";
import * as socrata from "./socrata.js";
import { refreshAttributionIndex } from "../registry.js";

export const seeders = {
  [openstates.id]: openstates,
  [fec.id]: fec,
  [socrata.id]: socrata,
};

/** Run one seeder by name and refresh the attribution index afterward. */
export async function runSeed(name, opts = {}) {
  const s = seeders[name];
  if (!s) throw new Error(`Unknown seeder "${name}". Known: ${Object.keys(seeders).join(", ")}`);
  const res = await s.seed(opts);
  refreshAttributionIndex();
  return res;
}

/**
 * Refresh the whole registry: sync the hand-seed, then run every seeder whose key is
 * present (missing-key seeders are skipped, not fatal — same fail-soft ethos as collect).
 * @returns {{ ran: object[], skipped: object[] }}
 */
export async function refreshRegistry({ env = process.env } = {}) {
  const { syncRegistryFromSeed } = await import("../registry.js");
  const ran = [];
  const skipped = [];
  const seedCounts = syncRegistryFromSeed();
  ran.push({ id: "hand-seed", ...seedCounts });

  for (const [name, s] of Object.entries(seeders)) {
    try {
      const res = await s.seed({ env });
      ran.push({ id: name, ...res });
    } catch (err) {
      skipped.push({ id: name, reason: err.message });
    }
  }
  refreshAttributionIndex();
  return { ran, skipped };
}
