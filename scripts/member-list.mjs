#!/usr/bin/env node
// scripts/member-list.mjs — manage the ISA Member Brief recipient list (/data/member-list.txt).
//
//   node scripts/member-list.mjs list
//   node scripts/member-list.mjs add a@x.org b@y.com      # or: add --file members.csv (first email per line)
//   node scripts/member-list.mjs rm a@x.org
//   node scripts/member-list.mjs unsubscribes [--days=14] [--dry-run]
//
// `unsubscribes` follows scripts/subscribe.mjs's IMAP pattern: it reads the mailbox that receives replies
// (MEMBER_LIST_IMAP_USER/PASS, falling back to EMAIL_INTAKE_USER/PASS; a Gmail APP PASSWORD, not the
// account password), finds replies whose subject or first lines say "unsubscribe" or "remove me", and
// removes the sender. It never adds anyone. Every change is printed; --dry-run changes nothing.
//
// Recipients are also read from MEMBER_BRIEF_TO (.env) and Settings → member recipients; this file is
// the one meant for a full member list. One address per line; lines starting with # are comments.

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const DATA = process.env.POLIBRIEF_DATA_DIR ? path.resolve(process.env.POLIBRIEF_DATA_DIR) : ROOT;
dotenv.config({ path: [path.join(DATA, ".env"), path.join(ROOT, ".env")], quiet: true });
const FILE = path.join(DATA, "member-list.txt");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readList(file = FILE) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#") && EMAIL.test(l));
  } catch {
    return [];
  }
}
export function writeList(list, file = FILE) {
  const uniq = [...new Set(list.map((x) => x.trim().toLowerCase()).filter((x) => EMAIL.test(x)))].sort();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `# ISA Member Brief recipients — one address per line (managed by scripts/member-list.mjs)\n${uniq.join("\n")}\n`);
  fs.renameSync(tmp, file);
  return uniq;
}
export const UNSUB = /\b(unsubscribe|remove me|take me off|stop sending|opt[- ]?out)\b/i;

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "list") {
    const l = readList();
    console.log(l.join("\n") || "(empty)");
    console.log(`\n${l.length} recipient(s) in ${FILE}`);
    return;
  }
  if (mode === "add" || mode === "rm") {
    let addrs = args.filter((a) => !a.startsWith("--"));
    const fileArg = args.indexOf("--file");
    if (fileArg >= 0) addrs = fs.readFileSync(args[fileArg + 1], "utf8").split(/\r?\n/).map((l) => (l.match(/[^\s,;"<>]+@[^\s,;"<>]+/) ?? [])[0]).filter(Boolean);
    const bad = addrs.filter((a) => !EMAIL.test(a));
    if (bad.length) console.log(`skipping ${bad.length} invalid: ${bad.join(", ")}`);
    const cur = readList();
    const want = addrs.filter((a) => EMAIL.test(a)).map((a) => a.toLowerCase());
    const next = mode === "add" ? [...cur, ...want] : cur.filter((a) => !want.includes(a));
    const out = writeList(next);
    console.log(`${mode === "add" ? "added" : "removed"} — list now has ${out.length} recipient(s)`);
    return;
  }
  if (mode === "unsubscribes") {
    const user = process.env.MEMBER_LIST_IMAP_USER || process.env.EMAIL_INTAKE_USER;
    const pass = process.env.MEMBER_LIST_IMAP_PASS || process.env.EMAIL_INTAKE_PASS;
    if (!user || !pass) {
      console.error("Set MEMBER_LIST_IMAP_USER/PASS (or EMAIL_INTAKE_USER/PASS) to the mailbox that receives replies — a Gmail App Password.");
      process.exit(1);
    }
    const days = Number((args.find((a) => a.startsWith("--days=")) ?? "--days=14").split("=")[1]);
    const dry = args.includes("--dry-run");
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    const client = new ImapFlow({ host: process.env.MEMBER_LIST_IMAP_HOST || process.env.EMAIL_INTAKE_HOST || "imap.gmail.com", port: Number(process.env.MEMBER_LIST_IMAP_PORT || process.env.EMAIL_INTAKE_PORT || 993), secure: true, auth: { user, pass }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    const found = new Set();
    try {
      const uids = await client.search({ since: new Date(Date.now() - days * 86400e3) }, { uid: true });
      for await (const msg of client.fetch(uids ?? [], { uid: true, source: true }, { uid: true })) {
        let p;
        try {
          p = await simpleParser(msg.source);
        } catch {
          continue;
        }
        const head = `${p.subject ?? ""}\n${String(p.text ?? "").split(/\r?\n/).slice(0, 5).join("\n")}`;
        const from = (p.from?.value?.[0]?.address || "").toLowerCase();
        if (from && UNSUB.test(head)) found.add(from);
      }
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
    const cur = readList();
    const hits = cur.filter((a) => found.has(a));
    console.log(`${found.size} unsubscribe request(s) in the last ${days} days; ${hits.length} on the list: ${hits.join(", ") || "—"}`);
    if (hits.length && !dry) console.log(`list now has ${writeList(cur.filter((a) => !found.has(a))).length} recipient(s)`);
    else if (dry) console.log("(dry run — nothing changed)");
    return;
  }
  console.log("usage: node scripts/member-list.mjs list | add <emails…> [--file f.csv] | rm <emails…> | unsubscribes [--days=14] [--dry-run]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
