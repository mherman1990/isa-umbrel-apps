#!/usr/bin/env node
// probe-carbon-prices.mjs — confirm the LCFS + EU-ETS parse against the live collector inbox, for
// carbon_prices. Companion to probe-rin-email.mjs (which covers the RIN block of the same email).
//
// It reads the EcoEngineers "Carbon Markets Snapshot" emails in beanbrief@gmail.com over IMAP and runs
// the ACTUAL adapter parser on them, so the output is exactly what carbon_prices will store. Critically it
// ALSO dumps the RAW carbon-markets region (RIN → LCFS → EU ETS → offsets) unconditionally, so even if the
// EU-ETS value position differs from what the parser assumes, one run shows the real layout to tune against.
//
// ⚠️ Imports the app's own modules, so run it from the image's app dir (NOT via heredoc):
//   sudo docker exec -w /app isa-polibrief_web_1 node scripts/probe-carbon-prices.mjs

import fs from "node:fs";
import { emailBodyToText } from "../src/emailhtml.js";
import { parseCarbonPrices, __test } from "../src/adapters/carbon_prices.js";
import { snapshotDate } from "../src/adapters/banyan_rin.js";

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
const user = env.EMAIL_INTAKE_USER;
const pass = env.EMAIL_INTAKE_PASS;
if (!user || !pass) {
  console.log("EMAIL_INTAKE_USER/EMAIL_INTAKE_PASS not set — carbon_prices (and banyan_rin / email_intake)");
  console.log("need the collector Gmail's 16-char App Password in /data/.env. See docs/collector-gmail.md.");
  process.exit(0);
}

const { ImapFlow } = await import("imapflow");
const { simpleParser } = await import("mailparser");
const client = new ImapFlow({ host: env.EMAIL_INTAKE_HOST || "imap.gmail.com", port: Number(env.EMAIL_INTAKE_PORT || 993), secure: true, auth: { user, pass }, logger: false });

/** Dump a raw slice starting at the first match of `re`, `len` chars, whitespace-collapsed. */
function dumpFrom(text, re, len, tag) {
  const i = text.search(re);
  if (i < 0) { console.log(`  (${tag}: anchor not found)`); return; }
  console.log(`  ${tag}:\n     ${text.slice(i, i + len).replace(/\s+/g, " ")}`);
}

await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const uids = await client.search({ from: "ecoengineers.us" }, { uid: true });
  console.log(`\n=== EcoEngineers Carbon Markets Snapshot emails in the inbox: ${uids?.length ?? 0} ===`);
  if (!uids || !uids.length) {
    console.log("None found. Check the collector is subscribed (marketing@ecoengineers.us) and IMAP is on.");
    process.exit(0);
  }
  const newest = uids.slice(-3); // parse the newest few
  for await (const msg of client.fetch(newest, { uid: true, source: true }, { uid: true })) {
    const parsed = await simpleParser(msg.source);
    const text = emailBodyToText(parsed.html || parsed.text || "");
    const prices = parseCarbonPrices(text);
    const period = snapshotDate(text);
    console.log(`\n----- uid ${msg.uid} -----`);
    console.log(`  from:    ${parsed.from?.text || ""}`);
    console.log(`  subject: ${parsed.subject || ""}`);
    console.log(`  date hdr: ${parsed.date || ""}   snapshotDate(body): ${period || "(none)"}`);
    console.log(`  LCFS parsed (${prices.lcfs.length}): ${prices.lcfs.map((c) => `${c.token}=${c.value}`).join("  ") || "(none)"}`);
    console.log(`  EU-ETS parsed: ${prices.euets != null ? prices.euets : "(none)"}`);
    console.log(`  → series rows: ${__test.toSeriesRows(prices, period || "?").map((r) => r.series).join(", ") || "(none)"}`);
    // Raw regions — always dumped, so a wrong/missing EU-ETS value is diagnosable in one run.
    dumpFrom(text, /US\$ per Metric Ton of CO2e|State LCFS Programs/i, 600, "LCFS+EU-ETS region (600 chars)");
    dumpFrom(text, /EU ETS Allowance/i, 200, "EU ETS region (200 chars)");
    dumpFrom(text, /Voluntary|Offset|Nature-?based|Tech-?based/i, 300, "Offsets region (300 chars, for a later follow-up)");
  }
} finally {
  lock.release();
  await client.logout().catch(() => {});
}

console.log("\n────────────────────────────────────────────────────────");
console.log("If LCFS shows CA/OR and EU-ETS shows a sane €/t number, carbon_prices is good — it stores");
console.log("lcfs:by-program:<STATE> (a cross-section family) + euets:allowance daily.");
console.log("If EU-ETS is (none) or wrong, paste the 'EU ETS region' dump and the parser gets tuned.\n");
process.exit(0);
