// eu_ets.js — EU ETS carbon price, the global carbon-price benchmark.
//
// WHY NOT THE ECOENGINEERS EMAIL. The EcoEngineers "Carbon Markets Snapshot" (which banyan_rin + carbon_prices
// mine for RIN and LCFS) shows an EU ETS number too, but ONLY as an EMBER chart image — confirmed via
// scripts/probe-carbon-prices.mjs on the Pi, the plain text is "EU€ per Metric Ton of CO2e (EU ETS Allowance)
// Source: EMBER (<link>)" with no value. So EU ETS has to come from a real feed.
//
// THE SOURCE. There is no clean free daily EUA API: EEX (the official auction platform) serves only a
// JS/Cloudflare site + a key-gated webservice, and Ember's old carbon-price API is gone. CBAM Guide
// (cbamguide.com/api/cbam-price) exposes, with no key or signup, the EUROPEAN COMMISSION's official CBAM
// certificate price — the quarterly (weekly from 2027) weighted average of EU ETS auction clearing prices,
// published under Regulation (EU) 2023/956 Art. 22 — plus a daily EUA reference when it has a fresh one.
// The certificate price IS the EU's official carbon reference and a faithful EU-ETS price level; the daily
// reference is a bonus (it is upstream-stale as of 2026-09, so we take it only when flagged fresh).
//
// ATTRIBUTION (CBAM Guide fair-use): "Source: CBAM Guide (cbamguide.com)"; cache responses ≥15 min (our
// market refresh cadence is far longer). Underlying data: European Commission. If the brief is ever
// published externally, surface that attribution wherever the number appears.
//
// Keyless and "markets"-class, so it refreshes on every market pass. Fail-soft: a fetch error propagates
// (refreshMarketSeries records the layer unavailable rather than showing a stale number as current).

import { fetchJSON } from "../util.js";

export const id = "eu_ets";
export const label = "EU ETS carbon price (CBAM certificate, EC via CBAM Guide)";

const API_URL = "https://cbamguide.com/api/cbam-price";

const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/**
 * Parse the CBAM Guide payload into series points. Pure; exported for unit tests against the real shape.
 * Returns { cert: [{period, value}], daily: {period, value} | null }.
 *
 *   cert  — the official CBAM certificate price series (certificate.series[].{publishedDate, price}), plus
 *           certificate.latest, deduped by publishedDate and sorted. This is the reliable, always-current
 *           official figure (quarterly in 2026, weekly from 2027).
 *   daily — the daily EUA reference (ets.{price,date}) but ONLY when ets.stale === false, so a frozen
 *           upstream value is never stored as if it were today's. null otherwise.
 */
export function parseCbamPrice(json) {
  const rows = [];
  const series = json?.certificate?.series;
  if (Array.isArray(series)) rows.push(...series);
  const latest = json?.certificate?.latest;
  if (latest) rows.push(latest);

  const cert = [];
  const seen = new Set();
  for (const r of rows) {
    const period = String(r?.publishedDate || "").slice(0, 10);
    const value = Number(r?.price);
    if (!isISODate(period) || !Number.isFinite(value) || value <= 0 || seen.has(period)) continue;
    seen.add(period);
    cert.push({ period, value });
  }
  cert.sort((a, b) => a.period.localeCompare(b.period));

  let daily = null;
  const ets = json?.ets;
  if (ets && ets.stale === false) {
    const period = String(ets.date || ets.asOf || "").slice(0, 10);
    const value = Number(ets.price);
    if (isISODate(period) && Number.isFinite(value) && value > 0) daily = { period, value };
  }

  return { cert, daily };
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. Fetch errors propagate (fail-loud). */
export async function fetchSeries({ env = process.env } = {}) {
  void env; // keyless — no per-deployment config needed
  const json = await fetchJSON(API_URL, { headers: { accept: "application/json" } });
  const { cert, daily } = parseCbamPrice(json);
  const out = [];
  if (cert.length) {
    out.push({
      series: "euets:cbam-cert",
      meta: { label: "EU ETS price (CBAM certificate, EC)", unit: "€/t CO2e", category: "carbon_prices", source: "CBAM Guide (cbamguide.com); data: European Commission" },
      points: cert,
    });
  }
  if (daily) {
    out.push({
      series: "euets:daily",
      meta: { label: "EU ETS daily reference (EUA)", unit: "€/t CO2e", category: "carbon_prices", source: "CBAM Guide (cbamguide.com)" },
      points: [daily],
    });
  }
  return out;
}

export const __test = { parseCbamPrice, API_URL };
