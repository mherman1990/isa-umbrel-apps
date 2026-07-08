// seed/openstates.js — populate the registry with current state legislators from
// OpenStates v3 (Plural). Free key: https://open.pluralpolicy.com (X-API-KEY header).
//
// Unlike a collection adapter (which emits Items), a seeder UPSERTS ENTITIES: it is
// the backbone of the legislative registry (names, party, chamber, district, ocd id,
// openstates_person_id for deterministic attribution). Idempotent — safe to re-run.

import { fetchJSON, sleep } from "../util.js";
import * as store from "../store.js";

export const id = "openstates";
export const label = "OpenStates (state legislators)";

const BASE = "https://v3.openstates.org";

function normParty(p) {
  if (!p) return null;
  const s = String(p).toLowerCase();
  if (s.startsWith("republican") || s === "r") return "R";
  if (s.startsWith("democrat") || s === "d") return "D";
  if (s.startsWith("independent") || s === "i") return "I";
  return p;
}

/**
 * Seed / refresh IA legislators.
 * @returns {{ upserted: number, pages: number }}
 */
export async function seed({ env = process.env, jurisdiction = "Iowa", maxPages = 8 } = {}) {
  if (!env.OPENSTATES_API_KEY) {
    throw new Error("OPENSTATES_API_KEY is not set in .env (free key: https://open.pluralpolicy.com)");
  }
  const headers = { "X-API-KEY": env.OPENSTATES_API_KEY };
  let page = 1;
  let upserted = 0;
  let pages = 0;

  while (page <= maxPages) {
    const url = `${BASE}/people?jurisdiction=${encodeURIComponent(jurisdiction)}&per_page=50&page=${page}`;
    const data = await fetchJSON(url, { headers });
    const results = data.results ?? [];

    for (const p of results) {
      const role = p.current_role ?? {};
      const chamber = role.org_classification; // 'upper' | 'lower'
      const office =
        chamber === "upper" ? "Iowa Senate" : chamber === "lower" ? "Iowa House" : role.title ?? "Iowa Legislature";
      const entityId = `openstates:${p.id}`;
      store.upsertEntity({
        id: entityId,
        type: "officeholder",
        full_name: p.name,
        party: normParty(p.party ?? role.party),
        office,
        district: role.district != null ? String(role.district) : null,
        ocd_id: role.division_id ?? null,
        level: "state",
        incumbent: 1,
        status: "active",
        external_ids: { openstates_person_id: p.id },
        source: "openstates",
      });
      upserted++;

      // Best-effort official homepages as website channels (skip shared gov email
      // domains — they'd collide in domain attribution).
      for (const link of p.links ?? []) {
        if (link?.url) store.upsertChannel({ entityId, kind: "website", url_or_handle: link.url });
      }
    }

    pages++;
    const maxPage = data.pagination?.max_page ?? 1;
    if (page >= maxPage || results.length === 0) break;
    page++;
    await sleep(1200); // be polite to the free tier
  }

  return { upserted, pages };
}
