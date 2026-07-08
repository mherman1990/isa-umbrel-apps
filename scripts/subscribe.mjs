#!/usr/bin/env node
// scripts/subscribe.mjs — helpers for the collector Gmail that feeds email-intake.
//
//   node scripts/subscribe.mjs targets            # print a subscribe worksheet from the registry
//   node scripts/subscribe.mjs confirm [--dry-run] # auto-click double-opt-in confirmation links
//
// `confirm` is the high-value automation: every "confirm your subscription" email
// lands in the collector inbox; this finds the confirmation link and GETs it, so
// double opt-in stops being a chore. Reads creds from .env (EMAIL_INTAKE_*).
// Requires a Gmail APP PASSWORD (2FA on) — the account password will not work.

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: [path.join(ROOT, ".env")], quiet: true });

const mode = process.argv[2] || "targets";

if (mode === "targets") {
  const { syncRegistryFromSeed } = await import("../src/registry.js");
  const store = await import("../src/store.js");
  syncRegistryFromSeed();
  const [base, domain] = (process.env.EMAIL_INTAKE_USER || "beanbrief@gmail.com").split("@");
  const channels = store
    .listChannels({ active: 1 })
    .filter((c) => c.kind === "newsletter_email" || c.kind === "website");

  console.log("\nSubscribe worksheet — subscribe the collector with a per-list plus-address so");
  console.log("attribution is deterministic. Rerun after adding entities to the registry.\n");
  console.log("ENTITY".padEnd(32), "SUBSCRIBE AS".padEnd(30), "SIGN-UP AT");
  const seen = new Set();
  for (const c of channels) {
    const e = store.getEntity(c.entity_id);
    const tag = c.org_id || c.entity_id;
    const key = `${c.entity_id}:${c.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const addr = c.kind === "newsletter_email" ? `${base}+${tag}@${domain}` : "";
    console.log((e?.full_name ?? c.entity_id).slice(0, 31).padEnd(32), addr.padEnd(30), c.url_or_handle);
  }
  console.log(
    `\nTip: use the +tag address where the signup form accepts '+'. Where it doesn't, subscribe`
  );
  console.log(`with the bare ${base}@${domain} and rely on sender-domain attribution.\n`);
  process.exit(0);
}

if (mode === "inbox") {
  // Quick look at what's actually landing in the collector: time | plus-tag | sender domain | subject.
  // Verifies subscriptions/forwards are arriving and shows the tag each is attributed by.
  const user = process.env.EMAIL_INTAKE_USER;
  const pass = process.env.EMAIL_INTAKE_PASS;
  if (!user || !pass) {
    console.error("EMAIL_INTAKE_USER/EMAIL_INTAKE_PASS not set. Gmail needs a 16-char App Password (2FA on).");
    process.exit(1);
  }
  const hoursArg = process.argv.find((a) => /^--hours=/.test(a));
  const hours = hoursArg ? Number(hoursArg.split("=")[1]) : 48;
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const host = process.env.EMAIL_INTAKE_HOST || "imap.gmail.com";
  const port = Number(process.env.EMAIL_INTAKE_PORT || 993);
  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  const rows = [];
  try {
    const since = new Date(Date.now() - hours * 3600e3);
    const uids = await client.search({ since }, { uid: true });
    for await (const msg of client.fetch(uids ?? [], { uid: true, source: true }, { uid: true })) {
      let p;
      try {
        p = await simpleParser(msg.source);
      } catch {
        continue;
      }
      const to = (p.to?.value ?? []).map((v) => v.address || "");
      const tag = (to.map((a) => (a.match(/\+([^@]+)@/) || [])[1]).find(Boolean) || "(bare/none)").toLowerCase();
      const from = (p.from?.value?.[0]?.address || "").split("@")[1] || "";
      rows.push({
        when: p.date ? p.date.toISOString().slice(5, 16).replace("T", " ") : "--",
        tag,
        from,
        subj: (p.subject || "").slice(0, 60),
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  rows.sort((a, b) => a.when.localeCompare(b.when));
  console.log(`\nCollector inbox — last ${hours}h (${rows.length} msgs):\n`);
  console.log("WHEN".padEnd(12), "TAG".padEnd(16), "FROM".padEnd(26), "SUBJECT");
  for (const r of rows) console.log(r.when.padEnd(12), r.tag.padEnd(16), r.from.padEnd(26), r.subj);
  process.exit(0);
}

if (mode === "confirm") {
  const user = process.env.EMAIL_INTAKE_USER;
  const pass = process.env.EMAIL_INTAKE_PASS;
  if (!user || !pass) {
    console.error("EMAIL_INTAKE_USER/EMAIL_INTAKE_PASS not set. Gmail needs a 16-char App Password (2FA on).");
    process.exit(1);
  }
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const host = process.env.EMAIL_INTAKE_HOST || "imap.gmail.com";
  const port = Number(process.env.EMAIL_INTAKE_PORT || 993);
  const dryRun = process.argv.includes("--dry-run");
  const CONFIRM_RE = /confirm|subscription|subscribe|verify|opt[-\s]?in|activate|validate/i;

  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  let clicked = 0;
  let scanned = 0;
  try {
    const since = new Date(Date.now() - 7 * 86400e3);
    const uids = await client.search({ since, seen: false }, { uid: true });
    for await (const msg of client.fetch(uids ?? [], { uid: true, source: true }, { uid: true })) {
      scanned++;
      let parsed;
      try {
        parsed = await simpleParser(msg.source);
      } catch {
        continue;
      }
      const subject = parsed.subject || "";
      const html = parsed.html || "";
      const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]);
      const candidates = links.filter((u) => CONFIRM_RE.test(u));
      const target = candidates[0] || (CONFIRM_RE.test(subject) ? links[0] : null);
      if (!target) continue;
      console.log(`${dryRun ? "[dry] " : ""}confirm: "${subject.slice(0, 50)}" → ${target.slice(0, 80)}`);
      if (!dryRun) {
        try {
          await fetch(target, { redirect: "follow" });
          clicked++;
        } catch (e) {
          console.log("   fetch failed:", e.message);
        }
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  console.log(`\nScanned ${scanned} unseen message(s); ${dryRun ? "would click" : "clicked"} ${clicked} confirmation link(s).`);
  process.exit(0);
}

console.error(`Unknown mode "${mode}". Use: targets | confirm [--dry-run]`);
process.exit(1);
