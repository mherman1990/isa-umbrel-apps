#!/usr/bin/env node
// probe-45z-sources.mjs — discovery probe for the 45Z/RFS quantitative layer (§2 rows 2–4): Census
// trade, EIA biodiesel/renewable-diesel production + capacity, and EPA RIN data. These all key-gate or
// (EPA) publish only spreadsheets, so their exact field names / series codes CANNOT be seen from the dev
// environment — this confirms them from the Pi, where the keys and the right IP live.
//
// ⚠️ SELF-CONTAINED (Node built-ins only) so it runs before the image carries it. Pipe it into the app
// container's Node (it reads keys from /data/.env):
//
//   scp scripts/probe-45z-sources.mjs umbrel@umbrel:/tmp/probe-45z.mjs      # or paste via a heredoc
//   cat /tmp/probe-45z.mjs | sudo docker exec -i isa-polibrief_web_1 node --input-type=module -
//
// Read-only; never writes the database. Paste the output back so the Census HS codes + EIA series codes
// can be pinned and the adapters finalized.

import fs from "node:fs";

// Read keys the way the app does: /data/.env first (the mounted volume), then /app/.env.
function loadEnv() {
  const env = { ...process.env };
  for (const p of ["/data/.env", "/app/.env"]) {
    try {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const i = line.indexOf("=");
        if (i < 0 || line.trim().startsWith("#")) continue;
        const k = line.slice(0, i).trim();
        if (!(k in env)) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* file may not exist */ }
  }
  return env;
}
const env = loadEnv();

async function grab(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { "user-agent": "polibrief-probe/1.0", accept: "application/json" } });
    const body = await res.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { status: res.status, ok: res.ok, body, json };
  } catch (e) {
    return { status: 0, ok: false, body: "", json: null, error: e.message };
  } finally { clearTimeout(timer); }
}
const clip = (s, n = 400) => String(s).replace(/\s+/g, " ").slice(0, n);
const redact = (u) => u.replace(/([?&](?:key|api_key)=)[^&]+/gi, "$1***");

// ───────────────────────────── Census trade (row 2) ─────────────────────────────
console.log("\n=== Census international trade (needs CENSUS_API_KEY) ===");
if (!env.CENSUS_API_KEY) {
  console.log("  CENSUS_API_KEY not set — get a free key at https://api.census.gov/data/key_signup.html");
} else {
  const B = "https://api.census.gov/data/timeseries/intltrade";
  const probes = [
    ["exports soybeans HS4 1201", `${B}/exports/hs?get=ALL_VAL_MO,CTY_NAME,E_COMMODITY&E_COMMODITY=1201&COMM_LVL=HS4&time=2026-06&key=${env.CENSUS_API_KEY}`],
    ["imports fats/oils HS4 1518 (UCO/DCO live here)", `${B}/imports/hs?get=GEN_VAL_MO,CTY_NAME,I_COMMODITY&I_COMMODITY=1518&COMM_LVL=HS4&time=2026-06&key=${env.CENSUS_API_KEY}`],
    ["imports HS10 under 1518 (to find the UCO/DCO break-outs)", `${B}/imports/hs?get=GEN_VAL_MO,I_COMMODITY,I_COMMODITY_LDESC&I_COMMODITY=1518&COMM_LVL=HS10&time=2026-06&key=${env.CENSUS_API_KEY}`],
    ["imports biodiesel HS4 3826", `${B}/imports/hs?get=GEN_VAL_MO,CTY_NAME,I_COMMODITY&I_COMMODITY=3826&COMM_LVL=HS4&time=2026-06&key=${env.CENSUS_API_KEY}`],
  ];
  for (const [name, url] of probes) {
    const r = await grab(url);
    console.log(`\n  ${name}\n    -> HTTP ${r.status} (${redact(url)})`);
    if (Array.isArray(r.json)) {
      console.log(`    header: ${JSON.stringify(r.json[0])}`);
      for (const row of r.json.slice(1, 6)) console.log(`      ${JSON.stringify(row)}`);
      console.log(`    (${r.json.length - 1} rows)`);
    } else {
      console.log(`    non-array body: ${clip(r.body || r.error)}`);
    }
  }
}

// ───────────────────────────── EIA biodiesel/RD production + capacity (row 4) ─────────────────────────────
console.log("\n=== EIA biodiesel / renewable-diesel production + capacity (needs EIA_API_KEY) ===");
if (!env.EIA_API_KEY) {
  console.log("  EIA_API_KEY not set — the feedstock series already use it, so it should be in /data/.env");
} else {
  const k = env.EIA_API_KEY;
  // Dump route metadata so we can locate the production/capacity sub-routes + their product codes. EIA v2
  // returns child routes + facet options for a route; feedbiofuel is the known feedstock route.
  const routes = [
    ["petroleum/pnp (child routes)", `https://api.eia.gov/v2/petroleum/pnp?api_key=${k}`],
    ["feedbiofuel facet options (product codes)", `https://api.eia.gov/v2/petroleum/pnp/feedbiofuel/facet/product?api_key=${k}`],
  ];
  for (const [name, url] of routes) {
    const r = await grab(url);
    console.log(`\n  ${name} -> HTTP ${r.status}`);
    if (r.json?.response) {
      const resp = r.json.response;
      if (resp.routes) console.log(`    child routes: ${resp.routes.map((x) => `${x.id}`).join(", ")}`);
      if (resp.facets) console.log(`    facet values (look for biodiesel/renewable-diesel PRODUCTION + CAPACITY):\n${resp.facets.slice(0, 60).map((f) => `      ${f.id}  ${f.name || ""}`).join("\n")}${resp.facets.length > 60 ? `\n      …(${resp.facets.length} total)` : ""}`);
    } else {
      console.log(`    ${clip(r.body || r.error)}`);
    }
  }
  console.log("\n  → From the above, note the product codes for biodiesel/RD PRODUCTION and CAPACITY and paste them back;");
  console.log("    the adapter will pull production ÷ capacity = renewable-diesel utilization (the crush.js move for RD).");
}

// ───────────────────────────── EPA RIN data (row 3) ─────────────────────────────
console.log("\n=== EPA RIN generation + prices (row 3) — expected to be spreadsheet-only ===");
const epa = await grab("https://www.epa.gov/fuels-registration-reporting-and-compliance-help/rin-generation-and-renewable-fuel-volume-production-fuel");
console.log(`  EPA RIN page reachable: HTTP ${epa.status}. EPA publishes RIN generation-by-D-code and RIN trades/prices as`);
console.log("  Excel workbooks, not a JSON/CSV API. Parsing them needs an xlsx dependency (the repo has none) — so row 3");
console.log("  is a dependency decision, not a quick adapter. If a machine-readable mirror exists, note the URL.");

console.log("\n────────────────────────────────────────────────────────");
console.log("Paste this whole output back to finalize the Census HS codes + EIA production/capacity series codes.\n");
process.exit(0);
