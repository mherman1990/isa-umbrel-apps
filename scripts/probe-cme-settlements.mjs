#!/usr/bin/env node
// probe-cme-settlements.mjs — fetch the CME soybean-complex + corn settlement curve FROM THIS HOST.
//
// Confirmed on the Pi (2026-09): CME IP-blocks cloud/dev IPs (403), but the Pi's residential IP reaches
// the CmeWS JSON endpoint (HTTP 200). The endpoint REQUIRES ?tradeDate=MM/DD/YYYY; a day with no session
// returns 200 + empty, so this steps back to the last settled day. (The plan's ftp/pub/settle/stlags text
// file is dead — a real 404 from the Pi — so it's dropped.)
//
// ⚠️ SELF-CONTAINED ON PURPOSE: no repo imports, Node built-ins only. The deployed container runs a BUILT
// IMAGE, so branch files aren't in /app — pipe this into the container's Node instead of exec-ing a path:
//
//   scp scripts/probe-cme-settlements.mjs umbrel@umbrel:/tmp/probe-cme.mjs   # from a workstation clone
//   cat /tmp/probe-cme.mjs | sudo docker exec -i isa-polibrief_web_1 node --input-type=module -
//
// (or paste it onto the Pi with a `cat > /tmp/probe-cme.mjs <<'EOF' … EOF` heredoc, then the same pipe.)
// Once a release carries this file in the image, the plain form works too:
//   sudo docker exec -w /app isa-polibrief_web_1 node scripts/probe-cme-settlements.mjs
//
// Read-only; never touches the database. Exit 0 = a soybean curve came back; non-zero = blocked/empty.

const PRODUCTS = [
  { key: "zs", id: 320, label: "Soybeans" },
  { key: "zm", id: 310, label: "Soybean meal" },
  { key: "zl", id: 312, label: "Soybean oil" },
  { key: "zc", id: 300, label: "Corn" },
];
const CMEWS = "https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements";
const UA = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const TIMEOUT_MS = 30_000;
const LOOKBACK_DAYS = 7;

async function grab(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": UA, accept: "application/json" } });
    const body = await res.text();
    let json = null; try { json = JSON.parse(body); } catch { /* leave null */ }
    return { status: res.status, ok: res.ok, ctype: res.headers.get("content-type") || "", bytes: body.length, ms: Date.now() - started, body, json };
  } catch (err) {
    return { status: 0, ok: false, ctype: "", bytes: 0, ms: Date.now() - started, body: "", json: null, error: err.name === "AbortError" ? `timeout ${TIMEOUT_MS / 1000}s` : err.message };
  } finally {
    clearTimeout(timer);
  }
}
const rowsOf = (j) => (j && Array.isArray(j.settlements) ? j.settlements.filter((r) => r && r.month && !/total/i.test(String(r.month))) : []);
const clip = (s, n = 220) => String(s).replace(/\s+/g, " ").slice(0, n);
function mdy(d) { return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`; }

// Find the most recent settled trade date (steps back over weekends/holidays), using soybeans.
console.log(`\n=== Resolving the last settled trade date (Soybeans, id 320) ===`);
let tradeDate = null;
for (let i = 0; i < LOOKBACK_DAYS; i++) {
  const ds = mdy(new Date(Date.now() - i * 86400000));
  const r = await grab(`${CMEWS}/320/FUT?tradeDate=${ds}`);
  const n = rowsOf(r.json).length;
  console.log(`  tradeDate=${ds} -> HTTP ${r.status} | ${r.bytes}b | settlements=${n}${r.error ? ` | ${r.error}` : ""}`);
  if (r.status !== 200 && i === 0) console.log(`    (not 200 — head: ${clip(r.body || r.error, 200)})`);
  if (r.ok && n) { tradeDate = ds; break; }
}
if (!tradeDate) {
  console.log(`\n❌ No soybean curve from this host in the last ${LOOKBACK_DAYS} days.`);
  console.log(`   If this ran on the Pi, CME is blocking its IP too — fall back to Barchart OnDemand`);
  console.log(`   (docs/market-data-options.md) or contact CME's GCC (gcc@cmegroup.com). Leave CME_SETTLEMENTS unset.\n`);
  process.exit(1);
}

console.log(`\n=== tradeDate=${tradeDate}: dumping all four products (confirm field names against the adapter) ===`);
let okCount = 0;
for (const p of PRODUCTS) {
  const r = await grab(`${CMEWS}/${p.id}/FUT?tradeDate=${tradeDate}`);
  const rows = rowsOf(r.json);
  console.log(`\n  ${p.label} (id ${p.id}) -> HTTP ${r.status} | rows=${rows.length}`);
  if (r.json) console.log(`    top-level keys: [${Object.keys(r.json).join(", ")}] | tradeDate=${JSON.stringify(r.json.tradeDate ?? null)}`);
  for (const row of rows.slice(0, 3)) console.log(`      ${JSON.stringify(row)}`);
  if (rows.length) okCount++;
  else console.log(`    (no rows — head: ${clip(r.body || r.error)})`);
}

console.log(`\n────────────────────────────────────────────────────────`);
console.log(`✅ Reachable: ${okCount}/${PRODUCTS.length} products returned a curve for ${tradeDate}.`);
console.log(`   To enable: set CME_SETTLEMENTS=1 in /data/.env, then  node src/index.js market-refresh.\n`);
process.exit(0);
