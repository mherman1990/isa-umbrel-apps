// seed/ia_candidates.js — seed the registry with Iowa 2026 general-election candidates.
//
// Unlike the API seeders (openstates/fec/socrata), this reads a static JSON file shipped in the
// image (src/data/ia-candidates-2026.json) distilled from the Iowa Secretary of State candidate
// database — the challengers + statewide candidates that the OpenStates "current officeholders"
// seed doesn't include (e.g. the Secretary of Agriculture race). Monitoring core only:
// name / party / office / district / level / incumbency — no personal contact data. Needs no key,
// so it always runs. Idempotent (stable ids).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "../store.js";

export const id = "ia_candidates";
export const label = "Iowa 2026 candidates (registry)";

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "ia-candidates-2026.json");

export async function seed() {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    throw new Error(`ia-candidates-2026.json unreadable: ${err.message}`);
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
