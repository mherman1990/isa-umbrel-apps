#!/usr/bin/env node
// probe-eu-ets.mjs — confirm the EU ETS carbon-price feed (CBAM Guide API) is reachable and parses, for
// eu_ets. No credentials needed (keyless HTTP). Run it after deploy to confirm the Pi can reach the API:
//   sudo docker exec -w /app isa-polibrief_web_1 node scripts/probe-eu-ets.mjs
// (or, if the container name differs, discover it with:  docker ps --filter name=polibrief --format '{{.Names}}')

import { fetchSeries, __test } from "../src/adapters/eu_ets.js";

console.log(`\n=== GET ${__test.API_URL} ===`);
let json;
try {
  json = await (await fetch(__test.API_URL, { headers: { accept: "application/json" } })).json();
} catch (err) {
  console.log(`✗ could not reach the API: ${err.message}`);
  console.log("  If this fails only on the Pi (not elsewhere), the Pi's network policy is blocking cbamguide.com.");
  process.exit(0);
}

console.log(`  certificate.latest: ${json?.certificate?.latest?.price} ${json?.certificate?.latest?.currency}/${json?.certificate?.latest?.unit} (${json?.certificate?.latest?.quarter}, published ${json?.certificate?.latest?.publishedDate}, source ${json?.certificate?.latest?.source})`);
console.log(`  certificate.series: ${(json?.certificate?.series || []).length} quarterly points`);
console.log(`  ets (daily EUA):    price ${json?.ets?.price} ${json?.ets?.unit}, date ${json?.ets?.date}, stale=${json?.ets?.stale}`);
console.log(`  attribution:        ${json?.attribution?.text || "(none)"}`);

const { cert, daily } = __test.parseCbamPrice(json);
console.log(`\n  parsed cert points (${cert.length}): ${cert.map((p) => `${p.period}=${p.value}`).join("  ") || "(none)"}`);
console.log(`  parsed daily point: ${daily ? `${daily.period}=${daily.value}` : "(none — upstream stale or absent)"}`);

const series = await fetchSeries({ env: {} });
console.log(`\n  → stored series:`);
for (const s of series) console.log(`     ${s.series}  |  ${s.meta.label}  |  ${s.meta.unit}  |  ${s.points.length} pts, latest ${JSON.stringify(s.points.at(-1))}`);

console.log("\n────────────────────────────────────────────────────────");
console.log("euets:cbam-cert = official EC CBAM certificate price (quarterly→weekly). euets:daily fills in");
console.log("only when the CBAM Guide daily EUA reference is fresh. Attribution: Source: CBAM Guide (cbamguide.com).\n");
process.exit(0);
