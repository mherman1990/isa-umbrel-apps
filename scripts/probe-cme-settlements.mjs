#!/usr/bin/env node
// probe-cme-settlements.mjs — does the CME settlements data actually reach us FROM THIS HOST?
//
// CME IP-blocks cloud/dev IPs (both the CmeWS JSON endpoint and ftp/pub/settle/stlags 403 from the
// workstation — verified). The bet is that the Pi's residential/business IP is not blocked. This probe
// answers that from wherever it runs and DUMPS THE REAL RESPONSE SHAPE (top-level keys + the first raw
// settlement rows), so the adapter's field-name assumptions can be confirmed against reality — the dev
// IP can't see it.
//
// ⚠️ SELF-CONTAINED ON PURPOSE: no repo imports, Node built-ins only. The deployed container runs a
// BUILT IMAGE, so branch files aren't in /app — this script has to be runnable standalone. Run it on
// the Pi, inside the app container (its outbound traffic egresses from the Pi's IP), one of two ways:
//
//   # A) if you have this branch checked out on your workstation, copy it over then pipe it in:
//   scp scripts/probe-cme-settlements.mjs umbrel@umbrel:/tmp/probe-cme.mjs
//   cat /tmp/probe-cme.mjs | sudo docker exec -i isa-polibrief_web_1 node --input-type=module -
//
//   # B) or paste it onto the Pi with a heredoc, then pipe it in:
//   cat > /tmp/probe-cme.mjs <<'EOF'
//   ...(paste this whole file)...
//   EOF
//   cat /tmp/probe-cme.mjs | sudo docker exec -i isa-polibrief_web_1 node --input-type=module -
//
// It never touches the database. Exit 0 = at least one route returned a soybean curve; non-zero = every
// route was blocked/empty (then: retry later, or fall back to Barchart — docs/market-data-options.md).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CmeWS product ids: soybeans 320 and corn 300 are confirmed (docs/overnight-queue.md); meal 310 and
// oil 312 follow CME's numbering and are what this probe is here to confirm.
const PRODUCTS = [
  { key: "zs", id: 320, label: "Soybeans" },
  { key: "zm", id: 310, label: "Soybean meal" },
  { key: "zl", id: 312, label: "Soybean oil" },
  { key: "zc", id: 300, label: "Corn" },
];
const CMEWS = "https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements";
const STLAGS = "https://www.cmegroup.com/ftp/pub/settle/stlags";
const UA = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const TIMEOUT_MS = 30_000;

const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cme-probe-"));
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };

async function grab(url, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": UA, accept } });
    const body = await res.text();
    return { status: res.status, ok: res.ok, ctype: res.headers.get("content-type") || "", bytes: body.length, ms: Date.now() - started, body };
  } catch (err) {
    return { status: 0, ok: false, ctype: "", bytes: 0, ms: Date.now() - started, body: "", error: err.name === "AbortError" ? `timeout ${TIMEOUT_MS / 1000}s` : err.message };
  } finally {
    clearTimeout(timer);
  }
}
const save = (name, body) => { const p = path.join(OUT_DIR, name); try { fs.writeFileSync(p, body); } catch { /* ignore */ } return p; };
const clip = (s, n = 200) => String(s).replace(/\s+/g, " ").slice(0, n);

let soybeanCurveSeen = false;

console.log("\n=== Route 1: CmeWS JSON settlements (per product) ===");
for (const p of PRODUCTS) {
  const url = `${CMEWS}/${p.id}/FUT`;
  const r = await grab(url, "application/json");
  console.log(`\n  ${p.label} (id ${p.id}) → ${url}`);
  console.log(`    HTTP ${r.status} | ${r.ctype || "?"} | ${r.bytes} bytes | ${r.ms}ms${r.error ? ` | ${r.error}` : ""}`);
  if (!r.ok || !r.bytes) { bad(`${p.label}: not reachable — ${clip(r.body || r.error, 160)}`); continue; }
  let json;
  try { json = JSON.parse(r.body); } catch (e) { bad(`${p.label}: not JSON (${e.message})`); continue; }
  save(`cmews-${p.key}.json`, r.body);
  const rows = Array.isArray(json.settlements) ? json.settlements : [];
  console.log(`    top-level keys: [${Object.keys(json).join(", ")}]`);
  console.log(`    tradeDate: ${JSON.stringify(json.tradeDate ?? json.tradeDateLabel ?? null)} | settlements: ${rows.length}`);
  if (rows.length) {
    // Print the FIRST TWO ROWS VERBATIM — this is how we confirm the real field names (settle?
    // openInterest? volume?), which the adapter currently only assumes.
    console.log(`    first rows verbatim (confirm field names against the adapter):`);
    for (const row of rows.slice(0, 2)) console.log(`      ${JSON.stringify(row)}`);
    ok(`${p.label}: reachable, ${rows.length} settlement rows`);
    if (p.key === "zs") soybeanCurveSeen = true;
  } else {
    bad(`${p.label}: reachable but no settlements[] — raw head: ${clip(r.body, 200)}`);
  }
}

console.log("\n=== Route 2: ftp/pub/settle/stlags text file ===");
{
  const r = await grab(STLAGS, "*/*");
  console.log(`  ${STLAGS}`);
  console.log(`    HTTP ${r.status} | ${r.ctype || "?"} | ${r.bytes} bytes | ${r.ms}ms${r.error ? ` | ${r.error}` : ""}`);
  const looksBlocked = /application\/json/i.test(r.ctype) && /block|scraping|terms of use/i.test(r.body);
  if (r.ok && r.bytes && !looksBlocked) {
    save("stlags.txt", r.body);
    console.log(`    First 40 lines (PASTE THESE BACK so the text parser can be pinned to the real layout):`);
    console.log(r.body.split(/\r?\n/).slice(0, 40).map((l) => "      " + l).join("\n"));
    ok("stlags: reachable text file");
    if (/soybean/i.test(r.body)) soybeanCurveSeen = true;
  } else {
    bad(`stlags: not reachable${looksBlocked ? " (IP-block page)" : ""} — ${clip(r.body || r.error, 160)}`);
  }
}

console.log("\n────────────────────────────────────────────────────────");
if (soybeanCurveSeen) {
  console.log(`✅ A soybean curve came back from this host (${pass} ok / ${fail} failed).`);
  console.log(`   Next: confirm the field names in the verbatim rows above match src/adapters/cme_settlements.js,`);
  console.log(`   then set CME_SETTLEMENTS=1 in /data/.env and run  node src/index.js market-refresh.`);
} else {
  console.log(`❌ Every route was blocked or empty from this host (${pass} ok / ${fail} failed).`);
  console.log(`   If this ran on the Pi, CME is blocking its IP too — fall back to Barchart OnDemand`);
  console.log(`   (docs/market-data-options.md) or contact CME's GCC (gcc@cmegroup.com). Leave CME_SETTLEMENTS unset.`);
}
console.log(`\nRaw responses saved under: ${OUT_DIR} (inside the container if run via docker exec)\n`);
process.exit(soybeanCurveSeen ? 0 : 1);
