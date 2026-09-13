// banyan_rin.js — daily RIN (RFS credit) prices, mined from the EcoEngineers "Carbon Markets Snapshot"
// email that lands in the collector inbox (beanbrief@gmail.com).
//
// WHY EMAIL. There is no free RIN-PRICE feed: EPA publishes RIN GENERATION volumes only (as xlsx), and
// live prices are OPIS/broker (paid). But the numbers arrive daily in an inbox if you subscribe — the
// EcoEngineers Carbon Markets Snapshot, whose RIN/LCFS data is Banyan Commodity Group's (EcoEngineers'
// named market-data partner; hence "Banyan"). So this is an email-sourced market series, like
// email_intake but producing a timeseries instead of items.
//
// WHAT WE CAPTURE. The snapshot lists each RIN D-code with its price INLINE, e.g. (confirmed against the
// live email via scripts/probe-rin-email.mjs, 2026-09-13):
//   "US$ per RIN (Renewable Fuel Standard) 2026 D3 $2.370 D4 $2.169 D5 $2.160 D6 $2.112"
// We read every D-code (D3/D4/D5/D6) for that block's vintage → one daily point per series, grouped per
// vintage as a §1.3 family so the snapshot renders each year's D3–D6 as one cross-section line. D4
// (biomass-based diesel) is the soybean-oil-relevant credit; D6 the conventional RFS credit; D3/D5
// cellulosic/advanced. Keyed by the snapshot's own date so the dataset builds forward. (The report also
// carries a multi-vintage "Daily Full RIN Update" table further down; if it ever renders inline pairs the
// parser picks those up too — today only the current-vintage headline block is inline.)
//
// Requires the same Gmail App Password as email_intake (EMAIL_INTAKE_PASS); INERT (returns []) without
// it — exactly like email_intake staying skipped until the key is set. scripts/probe-rin-email.mjs
// confirms the sender/subject + the parse against the live inbox on the Pi.

import * as store from "../store.js";
import { emailBodyToText } from "../emailhtml.js";
// imapflow + mailparser are lazy-imported inside fetchSeries (like email_intake / deliver.js) so a
// missing optional dep never breaks the adapter registry — it only matters once this is enabled.

export const id = "banyan_rin";
export const label = "RIN prices (Banyan via EcoEngineers)";

const FROM = "ecoengineers.us"; // IMAP FROM substring — the Carbon Markets Snapshot sender
// Deep-pull the inbox's back-history once, then a short rolling window. Stored points persist beyond the
// window, so the series only grows. Same self-healing shape as usda_ams's backfill.
const BACKFILL_DAYS = 730;
const INCREMENTAL_DAYS = 21;
const BACKFILL_THRESHOLD_POINTS = 20;

const MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/**
 * The snapshot's own date, from its "Month D, YYYY" headline — authoritative and timezone-proof (the
 * email's Date header can roll a day under UTC conversion). Returns "YYYY-MM-DD" or null.
 */
export function snapshotDate(text) {
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})\b/i.exec(String(text || ""));
  if (!m) return null;
  return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${String(m[2]).padStart(2, "0")}`;
}

/**
 * Parse the RIN D-code prices out of the snapshot's plain text. Pure; returns
 * [{ dcode:"d4", vintage:"2026", value:2.169 }]. Empty when no RIN block is found (fail-soft).
 *
 * CONFIRMED against the live email (scripts/probe-rin-email.mjs, 2026-09-13): emailBodyToText renders the
 * RIN block INLINE — a vintage header followed by D-code/price PAIRS:
 *   "US$ per RIN (Renewable Fuel Standard) 2026 D3 $2.370 D4 $2.169 D5 $2.160 D6 $2.112"
 * (NOT a D-code header row then a values row — that was only how the PDF happened to lay it out). So we
 * anchor on each "US$ per RIN … <YEAR>" block and read the "D<n> $<price>" pairs that follow it, stopping
 * at the next section. A price is bounded ($ + 1–2 integer digits + 2–3 decimals) so a two-decimal LCFS
 * credit or a bare year can never be mistaken for one.
 */
export function parseRinPrices(text) {
  const s = String(text || "").replace(/\s+/g, " ");
  const out = [];
  const seen = new Set(); // dedupe vintage:dcode across repeated blocks
  const anchor = /US\$\s*per\s*RIN\b[^0-9]{0,40}(20[0-9]{2})/gi;
  let a;
  while ((a = anchor.exec(s)) !== null) {
    const vintage = a[1];
    // The D-code prices sit right after the vintage; stop at the next section so nothing else is scanned.
    let seg = s.slice(anchor.lastIndex, anchor.lastIndex + 200);
    const stop = seg.search(/US\$|EU€|Metric Ton|Daily Full/i);
    if (stop >= 0) seg = seg.slice(0, stop);
    const pairRe = /\bD([3-9])\s*\$\s*([0-9]{1,2}\.[0-9]{2,3})\b/g;
    let p;
    while ((p = pairRe.exec(seg)) !== null) {
      const dcode = `d${p[1]}`;
      const value = Number(p[2]);
      const k = `${vintage}:${dcode}`;
      if (!seen.has(k) && Number.isFinite(value) && value > 0) {
        seen.add(k);
        out.push({ dcode, vintage, value });
      }
    }
  }
  return out;
}

function haveHistory() {
  try {
    const yr = new Date().getUTCFullYear();
    for (const y of [yr, yr - 1]) {
      if (store.getSeries(`rin:${y}:by-dcode:d4`).length >= BACKFILL_THRESHOLD_POINTS) return true;
    }
  } catch { /* no store yet → treat as un-backfilled */ }
  return false;
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. INERT (return []) without creds. */
export async function fetchSeries({ env = process.env, sourceConfig = {} } = {}) {
  const host = env.EMAIL_INTAKE_HOST || "imap.gmail.com";
  const port = Number(env.EMAIL_INTAKE_PORT || 993);
  const user = env.EMAIL_INTAKE_USER;
  const pass = env.EMAIL_INTAKE_PASS;
  if (!user || !pass) return []; // fail-soft: needs the collector Gmail App Password (EMAIL_INTAKE_PASS)

  const lookbackDays = Number(sourceConfig.lookbackDays) || (haveHistory() ? INCREMENTAL_DAYS : BACKFILL_DAYS);
  const mailbox = sourceConfig.mailbox || "INBOX";
  const since = new Date(Date.now() - lookbackDays * 864e5);

  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });

  // series key → { meta, points: Map<period, value> }
  const series = new Map();
  const add = (key, meta, period, value) => {
    if (!series.has(key)) series.set(key, { meta, points: new Map() });
    series.get(key).points.set(period, value); // last write wins on a same-day duplicate
  };

  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uids = await client.search({ from: FROM, since }, { uid: true });
    for await (const msg of client.fetch(uids ?? [], { uid: true, source: true }, { uid: true })) {
      let parsed;
      try {
        parsed = await simpleParser(msg.source);
      } catch {
        continue; // a single unparseable message never kills the run
      }
      const text = emailBodyToText(parsed.html || parsed.text || "");
      const cells = parseRinPrices(text);
      if (!cells.length) continue; // not a snapshot with a RIN table (or format changed) → skip
      const period = snapshotDate(text) || (parsed.date && !isNaN(new Date(parsed.date)) ? new Date(parsed.date).toISOString().slice(0, 10) : null);
      if (!period) continue;
      for (const { dcode, vintage, value } of cells) {
        const fam = `rin:${vintage}:by-dcode`;
        add(`${fam}:${dcode}`, { label: `RIN ${vintage} ${dcode.toUpperCase()}`, unit: "$/RIN", category: "rin_prices", family: fam }, period, value);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  const out = [];
  for (const [key, { meta, points }] of series) {
    const pts = [...points.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
    if (pts.length) out.push({ series: key, meta, points: pts });
  }
  return out;
}

export const __test = { parseRinPrices, snapshotDate };
