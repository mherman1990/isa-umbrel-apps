// usda_ams.js — USDA AMS "My Market News" (MARS API): Iowa state-average soybean cash
// price + basis. Free key: https://mymarketnews.ams.usda.gov  → USDA_AMS_API_KEY (sent as
// HTTP Basic auth, key as username, empty password).
//
// Report 2850 = "Iowa Daily Cash Grain Bids". Its structured rows are report metadata; the
// useful state-average line lives in report_narrative, e.g.:
//   "State Average Price: Corn -- $4.05 (-.33U) Up 16 cents | Soybeans -- $11.36 (-.48Q) Up 50 cents"
// We parse the Soybeans figure → cash price + basis (vs the referenced CME futures month).
// The member-facing "basis vs. board at a glance". Emits a "markets"-class item; fail-soft.

import { fetchJSON } from "../util.js";

export const id = "usda_ams";
export const label = "USDA AMS (Iowa cash & basis)";

const REPORT = "https://marsapi.ams.usda.gov/services/v1.2/reports/2850";
const MONTHS = { F: "Jan", G: "Feb", H: "Mar", J: "Apr", K: "May", M: "Jun", N: "Jul", Q: "Aug", U: "Sep", V: "Oct", X: "Nov", Z: "Dec" };

export async function fetchItems({ env = process.env } = {}) {
  const key = env.USDA_AMS_API_KEY;
  if (!key) throw new Error("USDA_AMS_API_KEY not set (free: https://mymarketnews.ams.usda.gov)");
  const auth = "Basic " + Buffer.from(`${key}:`).toString("base64");
  const d = await fetchJSON(REPORT, { headers: { Authorization: auth } });

  const r = (d.results ?? [])[0];
  const narrative = r?.report_narrative ?? "";
  const m = narrative.match(/Soybeans?\s*--\s*\$([\d.]+)\s*\(([-+]?\.?\d+)([A-Z])\)\s*(Up|Down)?\s*([\d.]+)?/i);
  if (!m) return []; // format changed → skip rather than emit garbage

  const [, price, basis, month, dir = "", chg = ""] = m;
  const date = String(r.report_date ?? r.published_date ?? "").slice(0, 10);
  const change = dir ? `${dir} ${chg}¢` : "";

  return [
    {
      uid: `${id}:soybeans:${date}`,
      sourceId: id,
      sourceLabel: label,
      title: `Iowa avg soybean cash $${price}, basis ${basis} vs ${MONTHS[month] ?? month} futures${change ? ` (${change})` : ""} — ${date}`,
      summary: narrative.split("\n")[0].slice(0, 300),
      url: "https://mymarketnews.ams.usda.gov/viewReport/2850",
      publishedAt: new Date(r.published_date ?? Date.now()).toISOString(),
      jurisdiction: "Iowa",
      docType: "data",
      raw: { metric: "basis", price: Number(price), basis: Number(basis), futuresMonth: month, change: chg ? Number(chg) : null, direction: dir },
    },
  ];
}
