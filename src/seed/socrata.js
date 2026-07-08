// seed/socrata.js — data.iowa.gov "Registered Political Candidates, Committees and
// Entities in Iowa" (from the Iowa Ethics & Campaign Disclosure Board / IECDB).
//
// ⚠️ COMPLIANCE GATE (Iowa Code § 68B.32A(7)): information from IECDB filings "shall
// not be copied or otherwise used for any commercial purpose", where commercial
// purpose includes solicitations by a business or charitable organization. polibrief
// may use this data ONLY to INFORM (registry → informational, nonpartisan briefings),
// NEVER to solicit members or anyone else. This seeder is therefore hard-gated behind
// an explicit informational-use confirmation, and counsel (Nyemaster) should sign off
// on the specific uses before it is enabled. See §10 of the v2 plan.

import { fetchJSON } from "../util.js";
import * as store from "../store.js";

export const id = "socrata";
export const label = "data.iowa.gov (IA candidates/committees — IECDB)";

// The Socrata dataset id (the 4x4 token in the data.iowa.gov URL). Set once verified.
const DATASET = process.env.IECDB_DATASET_ID || "";
const DOMAIN = "data.iowa.gov";

export async function seed({ env = process.env, confirmInformationalUse = false, limit = 5000 } = {}) {
  if (!confirmInformationalUse && env.IECDB_INFORMATIONAL_USE !== "true") {
    throw new Error(
      "Socrata/IECDB seeder is compliance-gated (Iowa Code § 68B.32A(7): no commercial use or solicitation). " +
        "Confirm informational-only use — set IECDB_INFORMATIONAL_USE=true in .env after counsel review — before enabling. See §10 of the v2 plan."
    );
  }
  if (!DATASET) {
    throw new Error("IECDB_DATASET_ID is not set — find the dataset id on data.iowa.gov and set it in .env.");
  }

  // SODA query — adjust $select/column names to the actual dataset schema on the Pi.
  const url = `https://${DOMAIN}/resource/${DATASET}.json?$limit=${limit}`;
  const rows = await fetchJSON(url, env.SOCRATA_APP_TOKEN ? { headers: { "X-App-Token": env.SOCRATA_APP_TOKEN } } : {});
  let upserted = 0;

  for (const r of rows ?? []) {
    // Column names vary by dataset revision — map defensively.
    const name = r.candidate_name || r.committee_name || r.name;
    if (!name) continue;
    const isCandidate = Boolean(r.candidate_name);
    store.upsertEntity({
      id: `iecdb:${r.committee_id || r.id || name}`,
      type: isCandidate ? "candidate" : "committee",
      full_name: name,
      office: r.office_sought || null,
      party: r.party || null,
      level: "state",
      counties: r.county ? [String(r.county)] : null,
      external_ids: { iecdb_committee_id: r.committee_id || null },
      source: "socrata",
    });
    upserted++;
  }
  return { upserted };
}
