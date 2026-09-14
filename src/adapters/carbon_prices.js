// carbon_prices.js — daily state LCFS/CFP credit prices, mined from the same EcoEngineers "Carbon Markets
// Snapshot" email that lands in the collector inbox (beanbrief@gmail.com).
//
// WHY EMAIL. Same reason as banyan_rin: there is no free daily feed for LCFS credit prices, but they arrive
// in the inbox every trading day in the EcoEngineers Carbon Markets Snapshot (RIN/LCFS data is Banyan
// Commodity Group's). banyan_rin mines the RIN (RFS) block of that email; this adapter mines the
// State LCFS Programs block:
//   - California LCFS and Oregon CFP credit prices (US$ per tonne CO2e). LCFS credit value is the demand
//     pull on low-CI fuels; it sits alongside the 45Z/RIN story for soy oil.
//
// WHY NOT EU ETS HERE. The snapshot shows an EU ETS number too, but ONLY as an EMBER chart image —
// confirmed via scripts/probe-carbon-prices.mjs on the Pi (2026-09-14), the plain text reads
// "EU€ per Metric Ton of CO2e (EU ETS Allowance) Source: EMBER (<link>)" with no value. So EU ETS cannot be
// parsed from the email; it comes from a real feed instead — see src/adapters/eu_ets.js (CBAM Guide API).
//
// WHY A SEPARATE ADAPTER (not folded into banyan_rin). banyan_rin is specifically the RFS RIN D-code
// credits; keeping this separate keeps each parser single-purpose and leaves the freshly-validated RIN
// capture untouched. The cost is a second IMAP read of the same inbox on each market refresh — negligible
// (a handful of messages, once per refresh, off the hot path). Both share emailBodyToText and snapshotDate.
//
// WHAT WE CAPTURE. Confirmed layout (EcoEngineers snapshot, via scripts/probe-carbon-prices.mjs, 2026-09-14):
//   "US$ per Metric Ton of CO2e (State LCFS Programs)
//      Oregon Clean Fuels Program (CFP) Credit $122.00
//      California Low Carbon Fuel Standard (LCFS) Credit $84.50"
// LCFS programs are captured as a §1.3 family (lcfs:by-program:<STATE>) so CA/OR (and WA if it appears)
// render as one cross-section line. Keyed by the snapshot's own date so the dataset builds forward, one
// point per program per day.
//
// Requires the same Gmail App Password as email_intake / banyan_rin (EMAIL_INTAKE_PASS); INERT (returns [])
// without it.

import * as store from "../store.js";
import { emailBodyToText } from "../emailhtml.js";
import { snapshotDate } from "./banyan_rin.js"; // reuse the timezone-proof headline-date parser
// imapflow + mailparser are lazy-imported inside fetchSeries (like email_intake / banyan_rin) so a
// missing optional dep never breaks the adapter registry — it only matters once this is enabled.

export const id = "carbon_prices";
export const label = "Carbon prices — LCFS & EU ETS (via EcoEngineers)";

const FROM = "ecoengineers.us"; // IMAP FROM substring — the Carbon Markets Snapshot sender
// Deep-pull the inbox's back-history once, then a short rolling window. Stored points persist beyond the
// window, so the series only grows. Same self-healing shape as banyan_rin.
const BACKFILL_DAYS = 730;
const INCREMENTAL_DAYS = 21;
const BACKFILL_THRESHOLD_POINTS = 20;

// State → { token, label } for the LCFS family. Oregon's program is the Clean Fuels Program (CFP);
// California's is the LCFS proper. Washington's CFS is pre-wired in case the snapshot adds it.
const LCFS_PROGRAMS = [
  { re: /\bCalifornia\b/i, token: "CA", label: "LCFS credit — California" },
  { re: /\bOregon\b/i, token: "OR", label: "LCFS credit — Oregon CFP" },
  { re: /\bWashington\b/i, token: "WA", label: "LCFS credit — Washington CFS" },
];

/**
 * Parse the LCFS prices out of the snapshot's plain text. Pure; returns
 *   { lcfs: [{ token:"CA", label, value:84.5 }, …] }
 * Empty when the block is absent (fail-soft), so a non-snapshot email (e.g. a webinar invite) yields
 * { lcfs: [] } and is skipped by fetchSeries.
 *
 * Each program line is "<State> … Credit $<price>". We require the literal "Credit" between the state name
 * and the dollar amount so a stray dollar figure elsewhere can never be mistaken for a credit price, and we
 * scope the scan to the "State LCFS Programs" section so a "California" mentioned elsewhere cannot leak in.
 *
 * (EU ETS is NOT parsed here — the email carries it only as an image; it comes from src/adapters/eu_ets.js.)
 */
export function parseCarbonPrices(text) {
  const s = String(text || "").replace(/\s+/g, " ");
  return { lcfs: parseLcfs(s) };
}

function parseLcfs(s) {
  // Scope to the LCFS section: from its header to the next block header, so nothing outside it is scanned.
  const start = s.search(/State LCFS Programs/i);
  if (start < 0) return [];
  let seg = s.slice(start);
  const stop = seg.slice(20).search(/EU€|EU ETS|US\$ per RIN|Daily Full|Voluntary|provides this data/i);
  if (stop >= 0) seg = seg.slice(0, stop + 20);

  const out = [];
  const seen = new Set();
  // "<State> … Credit $<price>" — the lazy [^$] run can't cross a "$", so it stops at this program's own
  // amount; requiring "Credit" anchors it to the credit price rather than any other figure.
  const rowRe = /\b(California|Oregon|Washington)\b[^$]{0,160}?\bCredit\b[^$]{0,12}\$\s*([0-9]{1,4}(?:\.[0-9]{1,2})?)/gi;
  let m;
  while ((m = rowRe.exec(seg)) !== null) {
    const prog = LCFS_PROGRAMS.find((p) => p.re.test(m[1]));
    if (!prog || seen.has(prog.token)) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value) || value <= 0) continue;
    seen.add(prog.token);
    out.push({ token: prog.token, label: prog.label, value });
  }
  return out;
}

/**
 * Map one snapshot's parsed LCFS prices to store-ready series rows. Pure; exported for unit tests so the
 * §1.3 family key shape (lcfs:by-program:<STATE>) is locked without needing IMAP.
 */
export function toSeriesRows(parsed, period) {
  const rows = [];
  for (const { token, label, value } of parsed.lcfs || []) {
    rows.push({
      series: `lcfs:by-program:${token}`,
      meta: { label, unit: "$/t CO2e", category: "carbon_prices", family: "lcfs:by-program" },
      period,
      value,
    });
  }
  return rows;
}

function haveHistory() {
  try {
    for (const k of ["lcfs:by-program:CA", "lcfs:by-program:OR"]) {
      if (store.getSeries(k).length >= BACKFILL_THRESHOLD_POINTS) return true;
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
      const prices = parseCarbonPrices(text);
      const period = snapshotDate(text) || (parsed.date && !isNaN(new Date(parsed.date)) ? new Date(parsed.date).toISOString().slice(0, 10) : null);
      if (!period) continue;
      const rows = toSeriesRows(prices, period);
      if (!rows.length) continue; // not a snapshot with a carbon-price block (or format changed) → skip
      for (const row of rows) add(row.series, row.meta, row.period, row.value);
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

export const __test = { parseCarbonPrices, parseLcfs, toSeriesRows };
