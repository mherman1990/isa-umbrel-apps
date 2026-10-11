#!/usr/bin/env node
// probe-ams-cash-ids.mjs — Run on the Pi to find AMS MARS cashReportId for each state.
// Usage: USDA_AMS_API_KEY=<key> node scripts/probe-ams-cash-ids.mjs
// Outputs slug_ids to paste into each pack's markets.ams.cashReportId field.

const KEY = process.env.USDA_AMS_API_KEY;
if (!KEY) { console.error("Set USDA_AMS_API_KEY first"); process.exit(1); }

const STATES = [
  "Minnesota", "Indiana", "Nebraska", "Missouri",
  "Ohio", "South Dakota", "North Dakota", "Kansas"
];

for (const state of STATES) {
  const url = `https://marsapi.ams.usda.gov/services/v1.2/reports?q=${encodeURIComponent(state + " Daily Cash Grain Bids")}&limit=10`;
  const res = await fetch(url, { headers: { "API_KEY": KEY, "Accept": "application/json" } });
  const data = await res.json();
  const hits = (Array.isArray(data) ? data : [])
    .filter(r => /grain|bid|cash/i.test(r.report_title ?? ""))
    .slice(0, 3);
  console.log(`\n=== ${state} ===`);
  if (!hits.length) console.log("  (no match — try a broader search)");
  for (const r of hits) console.log(`  slug_id: ${r.slug_id}  |  ${r.report_title}`);
}
console.log("\nDone. Copy the correct slug_id into each pack's markets.ams.cashReportId field.");
