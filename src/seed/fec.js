// seed/fec.js — federal candidates for Iowa from the FEC API (api.open.fec.gov).
// Free key: https://api.data.gov/signup/ (same key infrastructure as congress.gov).
// Upserts candidate entities (US House/Senate) with fec_id for cross-reference.
// Wired but only runs when FEC_API_KEY is set.

import { fetchJSON } from "../util.js";
import * as store from "../store.js";

export const id = "fec";
export const label = "FEC (federal candidates)";

const BASE = "https://api.open.fec.gov/v1";
const OFFICE = { H: "U.S. House", S: "U.S. Senate", P: "President" };

function normParty(p) {
  if (!p) return null;
  const s = String(p).toUpperCase();
  if (s.startsWith("REP")) return "R";
  if (s.startsWith("DEM")) return "D";
  if (s.startsWith("IND")) return "I";
  return p;
}

export async function seed({ env = process.env, cycle = 2026 } = {}) {
  if (!env.FEC_API_KEY) {
    throw new Error("FEC_API_KEY is not set in .env (free key: https://api.data.gov/signup/)");
  }
  const url =
    `${BASE}/candidates/?api_key=${env.FEC_API_KEY}&state=IA&cycle=${cycle}` +
    `&candidate_status=C&per_page=100&sort=name`;
  const data = await fetchJSON(url);
  let upserted = 0;

  for (const c of data.results ?? []) {
    store.upsertEntity({
      id: `fec:${c.candidate_id}`,
      type: "candidate",
      full_name: c.name, // FEC returns "LAST, FIRST" — left as-is; refine later if desired
      party: normParty(c.party),
      office: OFFICE[c.office] ?? c.office_full ?? "Federal",
      district: c.office === "H" && c.district ? `IA-${String(c.district).padStart(2, "0")}` : "IA",
      level: "federal",
      status: c.candidate_status === "N" ? "inactive" : "active",
      external_ids: { fec_id: c.candidate_id },
      source: "fec",
    });
    upserted++;
  }
  return { upserted };
}
