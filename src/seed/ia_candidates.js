// seed/ia_candidates.js — seed the registry with Iowa 2026 general-election candidates.
//
// Unlike the API seeders (openstates/fec/socrata), this reads a static JSON file shipped in the
// image (packs/us-ia/…/data/ia-candidates-2026.json) distilled from the Iowa Secretary of State candidate
// database — the challengers + statewide candidates that the OpenStates "current officeholders"
// seed doesn't include (e.g. the Secretary of Agriculture race). Monitoring core only:
// name / party / office / district / level / incumbency — no personal contact data. Needs no key,
// so it always runs. Idempotent (stable ids).

import fs from "node:fs";
import * as store from "../store.js";
import { pack, packPath } from "../pack.js";

export const id = "ia_candidates";
export const label = `${pack().identity.stateName} 2026 candidates (registry)`;

// The vendored candidate list ships in the state pack (us-ia: data/ia-candidates-2026.json).
const DATA_FILE = pack().registry?.candidates ? packPath(pack().registry.candidates) : null;

export async function seed() {
  if (!DATA_FILE) return { upserted: 0, skipped: `state pack ${pack().id} ships no candidate list` };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    throw new Error(`${DATA_FILE} unreadable: ${err.message}`);
  }
  const list = doc.candidates ?? [];
  let upserted = 0;
  for (const c of list) {
    store.upsertEntity({
      id: c.id,
      type: c.type ?? "candidate",
      full_name: c.name,
      party: c.party,
      office: c.office,
      district: c.district ?? null,
      level: c.level ?? "state",
      incumbent: c.incumbent ?? null,
      status: "active",
      external_ids: { election: doc.election, ...(c.holdover ? { holdover: true } : {}) },
      source: id,
    });
    upserted++;
  }
  return { upserted, election: doc.election, count: list.length };
}
