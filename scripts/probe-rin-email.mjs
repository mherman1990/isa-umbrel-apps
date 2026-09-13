#!/usr/bin/env node
// probe-rin-email.mjs — confirm the RIN-price parse against the live collector inbox, for banyan_rin.
//
// It reads the EcoEngineers "Carbon Markets Snapshot" emails in beanbrief@gmail.com over IMAP and runs
// the ACTUAL adapter parser on them, so the output is exactly what banyan_rin will store. Use it after
// deploying to (a) confirm EMAIL_INTAKE_PASS is set and the sender/subject match, and (b) verify the
// vintage × D-code matrix parses. If a snapshot yields no cells, its raw text is dumped so the regex
// can be adjusted.
//
// ⚠️ Imports the app's own modules, so run it from the image's app dir (NOT via heredoc):
//   sudo docker exec -w /app isa-polibrief_web_1 node scripts/probe-rin-email.mjs

import fs from "node:fs";
import { emailBodyToText } from "../src/emailhtml.js";
import { parseRinPrices, snapshotDate } from "../src/adapters/banyan_rin.js";

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
  console.log("EMAIL_INTAKE_USER/EMAIL_INTAKE_PASS not set — banyan_rin (and email_intake) need the");
  console.log("collector Gmail's 16-char App Password in /data/.env. See docs/collector-gmail.md.");
  process.exit(0);
}

const { ImapFlow } = await import("imapflow");
const { simpleParser } = await import("mailparser");
const client = new ImapFlow({ host: env.EMAIL_INTAKE_HOST || "imap.gmail.com", port: Number(env.EMAIL_INTAKE_PORT || 993), secure: true, auth: { user, pass }, logger: false });

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
    const cells = parseRinPrices(text);
    console.log(`\n----- uid ${msg.uid} -----`);
    console.log(`  from:    ${parsed.from?.text || ""}`);
    console.log(`  subject: ${parsed.subject || ""}`);
    console.log(`  date hdr: ${parsed.date || ""}   snapshotDate(body): ${snapshotDate(text) || "(none)"}`);
    console.log(`  parsed cells: ${cells.length}`);
    if (cells.length) {
      // group by vintage for a readable dump
      const byV = {};
      for (const c of cells) (byV[c.vintage] ??= []).push(`${c.dcode.toUpperCase()}=${c.value}`);
      for (const v of Object.keys(byV).sort()) console.log(`     ${v}: ${byV[v].join("  ")}`);
    } else {
      console.log("  ⚠️ no cells — dumping the first 1500 chars of body text so the regex can be adjusted:");
      console.log("  " + text.slice(0, 1500).replace(/\n/g, " "));
    }
    // Surface the multi-vintage "Daily Full RIN Update" section (past the headline block) so we can decide
    // whether to add prior-vintage series — its inline format may differ from the current-vintage headline.
    const mi = text.search(/Daily Full RIN Update/i);
    if (mi >= 0) console.log("  Daily Full RIN Update section (400 chars):\n     " + text.slice(mi, mi + 400).replace(/\s+/g, " "));
  }
} finally {
  lock.release();
  await client.logout().catch(() => {});
}

console.log("\n────────────────────────────────────────────────────────");
console.log("If the cells look right, banyan_rin is good — it stores rin:<vintage>:by-dcode:<dcode> daily.");
console.log("If any snapshot shows 0 cells, paste its dumped body text and the regex gets tuned.\n");
process.exit(0);
