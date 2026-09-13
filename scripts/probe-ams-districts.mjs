#!/usr/bin/env node
// probe-ams-districts.mjs — confirm the district dimension in AMS report 2850 ("Iowa Daily Cash Grain
// Bids"), for the §1.3 per-district basis family. The MARS call needs USDA_AMS_API_KEY + the Pi's
// residential IP, so the exact FIELD NAME and the district LABELS can't be seen from the dev box — this
// reads them off a live pull so the adapter's auto-detection can be confirmed (or pinned).
//
// ⚠️ SELF-CONTAINED (Node built-ins only) so it runs before the image carries it. Pipe it into the app
// container's Node (it reads the key from /data/.env):
//
//   cat scripts/probe-ams-districts.mjs | sudo docker exec -i isa-polibrief_web_1 node --input-type=module -
//
// Read-only; never writes the database. Paste the output back so the district field can be pinned.

import fs from "node:fs";

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

const KEY = env.USDA_AMS_API_KEY;
if (!KEY) {
  console.log("USDA_AMS_API_KEY not set — it should be in /data/.env (the Iowa cash/basis series already use it).");
  process.exit(0);
}

// Same district phrasings the adapter recognizes, so this flags which field IS the district.
const DISTRICT_RE = /north\s*west|north\s*central|north\s*east|west\s*central|east\s*central|south\s*west|south\s*central|south\s*east|\bcentral\b|\b[nsew][ncew]?\b/i;

async function grab(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: "Basic " + Buffer.from(`${KEY}:`).toString("base64"), accept: "application/json" },
      signal: ctl.signal,
    });
    const body = await res.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { status: res.status, ok: res.ok, body, json };
  } catch (e) {
    return { status: 0, ok: false, body: "", json: null, error: e.message };
  } finally { clearTimeout(timer); }
}

const BASE = "https://marsapi.ams.usda.gov/services/v1.2/reports/2850/Report%20Detail?lastDays=10";
console.log("\n=== AMS 2850 Report Detail (lastDays=10) ===");
const r = await grab(BASE);
console.log(`  -> HTTP ${r.status}`);
const rows = r.json?.results ?? [];
if (!Array.isArray(rows) || !rows.length) {
  console.log(`  no rows: ${String(r.body || r.error).replace(/\s+/g, " ").slice(0, 300)}`);
  process.exit(0);
}
const soy = rows.filter((x) => /soybean/i.test(String(x.commodity ?? "")));
console.log(`  ${rows.length} rows, ${soy.length} soybean rows\n`);

console.log("  Field names on a soybean row:");
console.log(`    ${Object.keys(soy[0] ?? rows[0]).join(", ")}\n`);

// For each field, distinct value count + a sample; flag any whose values look like Iowa districts. The
// district field is the small-cardinality categorical whose values match the compass names.
console.log("  Per-field distinct values (categorical fields; district field flagged ⭐):");
const sample = soy.length ? soy : rows;
for (const k of Object.keys(sample[0] ?? {})) {
  const vals = new Map();
  for (const row of sample) { const v = row[k]; if (v != null && v !== "") vals.set(String(v), (vals.get(String(v)) ?? 0) + 1); }
  if (vals.size === 0 || vals.size > 20) continue; // skip free/continuous fields (prices, dates)
  const distinct = [...vals.keys()];
  const looksDistrict = distinct.filter((v) => DISTRICT_RE.test(v)).length >= 3;
  console.log(`    ${looksDistrict ? "⭐ " : "   "}${k}  (${vals.size} distinct): ${distinct.slice(0, 12).join(" | ")}`);
}

console.log("\n  One full soybean row (verbatim), to see delivery_point vs district etc.:");
console.log("    " + JSON.stringify(soy[0] ?? rows[0]));

console.log("\n────────────────────────────────────────────────────────");
console.log("Paste this back: the ⭐ field (or, if none, the real district field name + its exact labels)");
console.log("lets us confirm ams:ia:basis-by-district is resolving the right dimension on the Pi.\n");
process.exit(0);
