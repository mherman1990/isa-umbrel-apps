#!/usr/bin/env node
// probe-cme-settlements.mjs — does the CME settlements data actually reach us FROM THIS HOST?
//
// CME IP-blocks cloud/dev IPs (both the CmeWS JSON endpoint and ftp/pub/settle/stlags 403 from the
// workstation — verified). The bet is that the Pi's residential/business IP is not blocked. This probe
// answers that from wherever it runs, and — crucially — DUMPS THE REAL RESPONSE SHAPE so the adapter's
// parsers can be pinned to the actual format (the dev IP can't see it). Run it ON THE PI:
//
//   sudo docker exec -w /app isa-polibrief_web_1 node scripts/probe-cme-settlements.mjs
//
// (or, on any host with the repo checked out:  node scripts/probe-cme-settlements.mjs)
//
// It never writes to the database. Raw responses are saved under a temp dir for inspection. Exit code
// 0 = at least one route returned a parseable soybean curve; non-zero = every route was blocked or
// empty (then: try again later, or fall back to Barchart OnDemand — see docs/market-data-options.md).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cme = await import(pathToFileURL(path.join(ROOT, "src/adapters/cme_settlements.js")).href);
const { PRODUCTS, CMEWS_BASE, STLAGS_URL } = cme.__internal;
const UA = cme.BROWSER_UA;

const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cme-probe-"));
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };

const TIMEOUT_MS = 30_000;
async function grab(url, { json = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": UA, accept: json ? "application/json" : "*/*" } });
    const body = await res.text();
    return { status: res.status, ok: res.ok, contentType: res.headers.get("content-type") || "", bytes: body.length, ms: Date.now() - started, body };
  } catch (err) {
    return { status: 0, ok: false, contentType: "", bytes: 0, ms: Date.now() - started, body: "", error: err.name === "AbortError" ? `timeout after ${TIMEOUT_MS / 1000}s` : err.message };
  }
}
const save = (name, body) => { const p = path.join(OUT_DIR, name); fs.writeFileSync(p, body); return p; };
const head = (body, n = 40) => body.split(/\r?\n/).slice(0, n).join("\n");

let soybeanCurveSeen = false;

// ───────────────────────────────── Route 1: CmeWS JSON (the adapter's primary route) ──────────────
console.log("\n=== Route 1: CmeWS JSON settlements (per product) ===");
for (const product of PRODUCTS) {
  const url = `${CMEWS_BASE}/${product.productId}/FUT`;
  const r = await grab(url, { json: true });
  console.log(`\n  ${product.label} (id ${product.productId})  →  ${url}`);
  console.log(`    HTTP ${r.status} | ${r.contentType || "?"} | ${r.bytes} bytes | ${r.ms}ms${r.error ? ` | ${r.error}` : ""}`);
  if (!r.ok || !r.bytes) { bad(`${product.label}: not reachable (see status above)`); continue; }
  const file = save(`cmews-${product.key}.json`, r.body);
  let parsed = null;
  try { parsed = cme.parseSettlementsJson(JSON.parse(r.body)); } catch (e) { console.log(`    (JSON.parse/parseSettlementsJson failed: ${e.message})`); }
  if (!parsed || !parsed.rows.length) {
    console.log(`    raw head:\n${head(r.body, 6).split("\n").map((l) => "      " + l.slice(0, 160)).join("\n")}`);
    bad(`${product.label}: reachable but no contract rows parsed — inspect ${file}`);
    continue;
  }
  console.log(`    tradeDate=${parsed.tradeDate} | ${parsed.rows.length} contract months parsed. First 3:`);
  for (const row of parsed.rows.slice(0, 3)) console.log(`      ${row.contractMonth}  settle=${row.settle}  OI=${row.openInterest ?? "—"}  vol=${row.volume ?? "—"}`);
  ok(`${product.label}: parsed ${parsed.rows.length} contracts (settle + OI) — raw saved to ${file}`);
  if (product.key === "zs") soybeanCurveSeen = true;
}

// ───────────────────────────────── Route 2: ftp/pub/settle/stlags text file ───────────────────────
console.log("\n=== Route 2: ftp/pub/settle/stlags text file (the plan's preferred single-file route) ===");
{
  const r = await grab(STLAGS_URL);
  console.log(`  ${STLAGS_URL}`);
  console.log(`    HTTP ${r.status} | ${r.contentType || "?"} | ${r.bytes} bytes | ${r.ms}ms${r.error ? ` | ${r.error}` : ""}`);
  if (!r.ok || !r.bytes) {
    bad("stlags: not reachable from this host");
  } else {
    const file = save("stlags.txt", r.body);
    console.log(`    raw saved to ${file}. First 40 lines (SO WE CAN PIN THE PARSER — paste these back if the parser under-reads):`);
    console.log(head(r.body, 40).split("\n").map((l) => "      " + l).join("\n"));
    let parsed = null;
    try { parsed = cme.parseStlags(r.body); } catch (e) { console.log(`    (parseStlags threw: ${e.message})`); }
    if (parsed) {
      const counts = Object.entries(parsed.byProduct).map(([k, v]) => `${k}=${v.length}`).join(" ") || "(none)";
      console.log(`    provisional parse: tradeDate=${parsed.tradeDate} | contracts by product: ${counts}`);
      const zs = parsed.byProduct.zs || [];
      if (zs.length) { for (const row of zs.slice(0, 3)) console.log(`      zs ${row.contractMonth}  settle=${row.settle}  OI=${row.openInterest ?? "—"}`); soybeanCurveSeen = true; }
      if (zs.length) ok(`stlags: reachable and the provisional parser found ${zs.length} soybean contracts (VERIFY against the raw dump above)`);
      else bad("stlags: reachable but the provisional parser found no soybean contracts — pin parseStlags() to the raw dump above");
    }
  }
}

// ───────────────────────────────── Verdict ────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────");
if (soybeanCurveSeen) {
  console.log(`✅ At least one route delivered a soybean curve from this host.`);
  console.log(`   Next: skim the saved raw files in ${OUT_DIR}, confirm the field names/units match the`);
  console.log(`   adapter, then set  CME_SETTLEMENTS=1  in .env and run  node src/index.js market-refresh.`);
  console.log(`   (If only stlags worked, finalize parseStlags() in src/adapters/cme_settlements.js against`);
  console.log(`   the raw dump first, then enable.)`);
} else {
  console.log(`❌ Every route was blocked or empty FROM THIS HOST (${pass} ok / ${fail} failed).`);
  console.log(`   If this ran on the Pi, CME is blocking its IP too — fall back to Barchart OnDemand`);
  console.log(`   (docs/market-data-options.md), or contact CME's GCC (gcc@cmegroup.com) for a data feed.`);
  console.log(`   Leave CME_SETTLEMENTS unset; the adapter stays inert.`);
}
console.log(`\nRaw responses saved under: ${OUT_DIR}\n`);
process.exit(soybeanCurveSeen ? 0 : 1);
