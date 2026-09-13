// banyan_rin.js — daily RIN (RFS credit) prices, mined from the EcoEngineers "Carbon Markets Snapshot"
// email that lands in the collector inbox (beanbrief@gmail.com).
//
// WHY EMAIL. There is no free RIN-PRICE feed: EPA publishes RIN GENERATION volumes only (as xlsx), and
// live prices are OPIS/broker (paid). But the numbers arrive daily in an inbox if you subscribe — the
// EcoEngineers Carbon Markets Snapshot, whose RIN/LCFS data is Banyan Commodity Group's (EcoEngineers'
// named market-data partner; hence "Banyan"). So this is an email-sourced market series, like
// email_intake but producing a timeseries instead of items.
//
// WHAT WE CAPTURE. The email's "Daily Full RIN Update" is a vintage × D-code matrix — D3/D4/D5/D6 across
// the recent crop-year vintages (e.g. 2024/2025/2026). We capture EVERY cell → one daily point per
// series, grouped per vintage as a §1.3 family so the snapshot renders each year's D3–D6 as one
// cross-section line. D4 (biomass-based diesel) is the soybean-oil-relevant credit; D6 the conventional
// RFS credit; D3/D5 cellulosic/advanced. Keyed by the snapshot's own date so the dataset builds forward
// (plus whatever history is still in the inbox).
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
 * Parse the "Daily Full RIN Update" vintage × D-code matrix out of the snapshot's plain text. Pure;
 * returns [{ dcode:"d4", vintage:"2026", value:2.169 }]. Empty when the table isn't found (fail-soft).
 *
 * Robust to the single-lined text emailBodyToText produces: a vintage row is a 4-digit crop year
 * IMMEDIATELY followed by exactly one $ value per D-code column (the headline "… 2026 D3 D4 D5 D6 $…"
 * never matches, because a D-code — not a $ — follows its year). Column order is taken from the
 * "D-Code D3 D4 D5 D6" header when present, else the RFS-standard D3–D6.
 */
export function parseRinMatrix(text) {
  const s = String(text || "").replace(/\s+/g, " ");
  const hdr = /D[\s-]*Code\s*((?:\s*D[0-9]\b){2,})/i.exec(s);
  let cols = hdr ? hdr[1].match(/D[0-9]/gi) : null;
  if (!cols || cols.length < 2) cols = ["D3", "D4", "D5", "D6"];
  cols = cols.map((c) => c.toUpperCase());
  // A RIN price is a $ value with 1–2 integer digits and 2–3 decimals ($2.169). Bounding the decimals
  // (and allowing zero spaces between cells) keeps a value from swallowing the next row's year if the
  // ESP's HTML has no whitespace between table cells — e.g. "$2.040" stops cleanly before "2025".
  const val = "\\$\\s*[0-9]{1,2}\\.[0-9]{2,3}";
  const rowRe = new RegExp(`\\b(20[0-9]{2})\\b((?:\\s*${val}){${cols.length}})`, "g");
  const out = [];
  let m;
  while ((m = rowRe.exec(s)) !== null) {
    const vintage = m[1];
    const vals = (m[2].match(/[0-9]{1,2}\.[0-9]{2,3}/g) || []).map(Number);
    if (vals.length !== cols.length) continue;
    cols.forEach((dc, i) => {
      const v = vals[i];
      if (Number.isFinite(v) && v > 0) out.push({ dcode: dc.toLowerCase(), vintage, value: v });
    });
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
      const cells = parseRinMatrix(text);
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

export const __test = { parseRinMatrix, snapshotDate };
