// server.js — the polibrief web UI + built-in scheduler.
//
// Pages:
//   GET  /                dashboard: run buttons, briefs, deadlines, sources, watchlist, settings
//   GET  /items           browse/filter stored items; track 📌 and rate 👍/👎
//   GET  /search?q=       ask a question over stored data (one Sonnet call per search)
//   GET  /logs            recent server output (last 500 lines)
//   GET  /brief/<file>    a rendered brief (+ copy/email/Teams buttons)
//   GET  /brief/<file>/raw  the brief's markdown (for the copy button)
//   GET  /calendar.ics    comment-deadline calendar — subscribe from Outlook
//   GET  /feed.xml        RSS feed of briefs
//   GET  /health          plain-text ok (Docker healthcheck; never behind auth)
//
// The scheduler runs the am/pm editions, the Friday weekly memo, and a nightly
// backup — no cron needed. Set POLIBRIEF_PASSWORD in .env to require a password
// (username can be anything).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import * as store from "./store.js";
import { runPipeline, runMemo, answerQuery, loadWatchlist, saveWatchlist, generateNewsDigest, getCachedNewsDigest, generateMarketCards, getCachedMarketCards, generateStorylines, getStorylinesMeta } from "./pipeline.js";
import { computeSignals } from "./signals.js";
import { upcomingReports } from "./calendar.js";
import { adapters, sourceIdsForClass, classOf } from "./adapters/index.js";
import { postToTeams } from "./deliver.js";
import { summarizeItem, summaryExpiry } from "./summarize.js";
import { syncRegistryFromSeed } from "./registry.js";

// All user-facing timestamps render in Central time (the ISA org timezone).
const CENTRAL_TZ = "America/Chicago";
const fmtCT = (d) => new Date(d).toLocaleString("en-US", { timeZone: CENTRAL_TZ });
const fmtCTtime = (d) => new Date(d).toLocaleTimeString("en-US", { timeZone: CENTRAL_TZ });

// ---------- log ring buffer (powers /logs) ----------
const logBuffer = [];
function captureConsole() {
  for (const level of ["log", "error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logBuffer.push(`${fmtCTtime(Date.now())} ${line}`);
      if (logBuffer.length > 500) logBuffer.shift();
    };
  }
}

// ---------- tiny markdown → HTML renderer (covers exactly what briefs contain) ----------
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(md) {
  return esc(md)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}
export function markdownToHtml(md) {
  const out = [];
  let inList = false;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    const isListItem = /^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t);
    if (inList && !isListItem) {
      out.push("</ul>");
      inList = false;
    }
    if (t === "") continue;
    if (t === "---") out.push("<hr>");
    else if (t.startsWith("### ")) out.push(`<h3>${inline(t.slice(4))}</h3>`);
    else if (t.startsWith("## ")) out.push(`<h2>${inline(t.slice(3))}</h2>`);
    else if (isListItem) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(t.replace(/^([-*]|\d+\.)\s+/, ""))}</li>`);
    } else out.push(`<p>${inline(t)}</p>`);
  }
  if (inList) out.push("</ul>");
  return linkifySeries(out.join("\n"));
}

// ---------- figure drill-down: link market-series names in rendered prose to their chart ----------
// Ask answers and briefs cite series by name ("U.S. soybean crush", "stocks-to-use"); turn the FIRST
// mention of each known series into a link to its Markets chart (/markets#chart_<category>, the id
// chartSection already emits). Operates on the rendered HTML and skips anything already inside an
// <a>, so we never nest or break the item citations the LLM produced.
let _seriesLinkCache = { at: 0, map: [] };
function seriesLinkMap() {
  if (Date.now() - _seriesLinkCache.at < 120000) return _seriesLinkCache.map; // cheap memo — metas rarely change
  let map = [];
  try {
    const seen = new Set();
    for (const m of store.listSeriesMeta()) {
      const label = (m.label || "").trim();
      if (label.length < 5 || !m.category || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      map.push({ label, href: `/markets#chart_${m.category}` });
    }
    map.sort((a, b) => b.label.length - a.label.length); // longest-first so a label isn't shadowed by a shorter substring
  } catch {
    map = [];
  }
  _seriesLinkCache = { at: Date.now(), map };
  return map;
}
function linkifySeries(html) {
  const map = seriesLinkMap(); // longest label first
  if (!map.length || !html) return html;
  const used = new Set();
  const isWord = (c) => c != null && /\w/.test(c);
  const parts = html.split(/(<[^>]+>)/); // alternating text / tag tokens
  let inAnchor = 0;
  for (let idx = 0; idx < parts.length; idx++) {
    const p = parts[idx];
    if (!p) continue;
    if (p[0] === "<") {
      if (/^<a\b/i.test(p)) inAnchor++;
      else if (/^<\/a\s*>/i.test(p)) inAnchor = Math.max(0, inAnchor - 1);
      continue;
    }
    if (inAnchor) continue; // never linkify inside an existing citation link
    // Left-to-right longest-match scan: at each word-boundary position, take the longest unused
    // label that matches there, emit its link, and skip past it. This can't nest or overlap, so
    // "U.S. soybean stocks-to-use" wins over the shorter "U.S. soybean stocks" and never re-matches
    // inside a link we just inserted.
    const text = p;
    let out = "";
    let i = 0;
    while (i < text.length) {
      let hit = null;
      if (i === 0 || !isWord(text[i - 1])) {
        for (const entry of map) {
          if (used.has(entry.label)) continue;
          const L = entry.label.length;
          if (text.slice(i, i + L).toLowerCase() !== entry.label.toLowerCase()) continue;
          if (isWord(text[i + L])) continue; // must end on a boundary too
          hit = entry;
          break; // map is longest-first, so the first match here is the longest eligible
        }
      }
      if (hit) {
        out += `<a class="figlink" href="${hit.href}">${text.slice(i, i + hit.label.length)}</a>`;
        used.add(hit.label);
        i += hit.label.length;
      } else {
        out += text[i];
        i++;
      }
    }
    parts[idx] = out;
  }
  return parts.join("");
}

// ---------- page shell ----------
// Cache-buster for static assets: long-lived cache-control on the files, but a token in
// the URL that changes every restart/deploy so a new version is never served stale.
const ASSET_VER = Date.now().toString(36);

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  /* ---- ISA brand palette (from ISA24 Branding Guidelines: primary p10, 40-tints) ---- */
  :root {
    --isa-dark: #004A8D; --isa-blue: #0070C3; --isa-gold: #FFC425; --isa-gold-light: #FFD370;
    --isa-dark-40: #9AB8D2; --isa-blue-40: #A5C6E3; --isa-gold-40: #FFE8AA; --isa-gold-light-40: #FFEEC7;
    --isa-rust: #C65E35; --isa-olive: #91A22B;
    --ink: #1c2b3a; --line: #d9e2ec; --surface: #ffffff;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 900px;
         margin: 0 auto; padding: 0 16px 64px; line-height: 1.55; color: var(--ink); background: var(--surface); }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
           border-bottom: 3px solid var(--isa-gold); padding: 14px 4px 10px; margin-bottom: 22px; }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .brand .logo { height: 40px; width: auto; display: block; border-radius: 3px; }
  .brand .brandname { font-weight: 700; font-size: 1.15rem; letter-spacing: .2px; color: var(--isa-dark); }
  nav { margin-left: auto; display: flex; gap: 2px; flex-wrap: wrap; font-weight: 600; }
  nav a { text-decoration: none; color: var(--isa-dark); padding: 6px 10px; border-radius: 6px 6px 0 0;
    border-bottom: 3px solid transparent; }
  nav a:hover { background: var(--isa-blue-40); }
  nav a.active { border-bottom-color: var(--isa-gold); color: var(--isa-blue); }
  h1, h2, h3 { color: var(--isa-dark); }
  h1 { font-size: 1.5rem; margin: .2em 0 .5em; } h2 { font-size: 1.3rem; } h3 { margin-top: 26px; }
  ul.briefs { list-style: none; padding: 0; } ul.briefs li { margin: 8px 0; }
  ul.briefs a { font-weight: 600; text-decoration: none; }
  a { color: var(--isa-blue); } a:hover { text-decoration: underline; }
  .muted { opacity: .7; font-size: .9em; }
  hr { border: none; border-top: 1px solid var(--line); margin: 20px 0; }
  form { display: inline; } button { background: var(--isa-blue); color: white; border: none;
    border-radius: 6px; padding: 6px 14px; font-size: .95rem; cursor: pointer; font-weight: 600; }
  button:hover { background: var(--isa-dark); }
  button.ghost { background: transparent; color: var(--isa-dark); border: 1px solid var(--isa-dark-40); }
  button.ghost:hover { background: var(--isa-blue-40); }
  button.tiny { padding: 2px 8px; font-size: .85rem; }
  .banner { background: var(--isa-blue-40); border: 1px solid var(--isa-blue); border-radius: 8px;
    padding: 8px 14px; margin: 12px 0; }
  .banner.err { background: #f7d9d3; border-color: var(--isa-rust); }
  table.sources, table.items { border-collapse: collapse; width: 100%; margin: 8px 0 4px; }
  table.sources th, table.sources td, table.items th, table.items td
    { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.sources th, table.items th { font-size: .85em; opacity: .7; font-weight: 600; }
  table.sources tr.clsrow td { background: var(--isa-gold-light-40); border-bottom: 1px solid var(--isa-gold-40);
    font-size: .88em; padding-top: 9px; padding-bottom: 9px; }
  details.topic { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; margin: 8px 0; }
  details.topic[open] { border-color: var(--isa-dark-40); }
  details.topic summary { cursor: pointer; font-weight: 600; color: var(--isa-dark); }
  details.summary { margin: 6px 0 2px; }
  details.summary > summary { cursor: pointer; font-size: .9em; font-weight: 600; color: var(--isa-blue); list-style: none; }
  details.summary > summary::-webkit-details-marker { display: none; }
  details.summary > summary::before { content: "▸ "; }
  details.summary[open] > summary::before { content: "▾ "; }
  .sumbody { margin: 8px 0 4px; padding: 10px 12px; background: var(--isa-blue-40); border-radius: 8px; font-size: .95em; line-height: 1.5; }
  .sumbody p { margin: .4em 0; } .sumbody ul { margin: .4em 0; padding-left: 1.2em; }
  .summeta { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line); font-size: .82em; opacity: .7; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0 10px; }
  form.chip { display: inline-flex; align-items: center; gap: 4px; background: var(--isa-gold-40);
    border: 1px solid var(--isa-gold); border-radius: 999px; padding: 2px 4px 2px 10px; font-size: .9em; }
  form.chip button { background: none; color: inherit; padding: 0 6px; font-size: 1em; opacity: .6; }
  form.chip button:hover { opacity: 1; background: none; }
  form.pill { display: inline-flex; }
  form.pill button { border-radius: 999px; padding: 3px 11px; font-size: .82em; font-weight: 600;
    border: 1px solid var(--isa-dark-40); background: transparent; color: var(--isa-dark); }
  form.pill.on button { background: var(--isa-blue); color: #fff; border-color: var(--isa-blue); }
  form.pill.off button { opacity: .65; }
  form.pill button:hover { background: var(--isa-blue-40); color: var(--isa-dark); }
  form.pill.on button:hover { background: var(--isa-dark); color: #fff; }
  form.addterm { display: inline-flex; gap: 6px; }
  input[type=text], input[type=number], input[type=time], select { border: 1px solid var(--isa-dark-40); border-radius: 6px;
    padding: 4px 8px; font-size: .9em; background: #fff; color: var(--ink); }
  form.addterm input[type=text] { min-width: 180px; }
  .kicker { font-size: .85em; opacity: .75; margin: 10px 0 2px; font-weight: 600; color: var(--isa-dark); }
  .spark { vertical-align: middle; margin-left: 8px; opacity: .8; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; align-items: center; }
  .answer { border: 1px solid var(--isa-blue); border-radius: 10px; padding: 6px 18px; margin: 14px 0;
    background: var(--isa-blue-40); }
  /* figure drill-down: a cited series name links to its chart — subtle dotted underline, not a loud link */
  a.figlink { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--isa-blue); }
  a.figlink:hover { border-bottom-style: solid; color: var(--isa-dark); }
  pre.logs { background: #f3f6f9; border: 1px solid var(--line); border-radius: 8px; padding: 12px;
    font-size: .8rem; overflow-x: auto; white-space: pre-wrap; color: var(--ink); }
  .fb { opacity: .55; } .fb.on { opacity: 1; }
  ul.whatchanged { list-style: none; margin: 6px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  ul.whatchanged li { font-size: .9em; line-height: 1.42; }
  .storylines { display: flex; flex-direction: column; gap: 13px; margin-top: 2px; }
  .storyline { border-left: 3px solid var(--isa-gold); padding: 1px 0 1px 12px; }
  .storyline .sl-name { font-weight: 700; color: var(--isa-dark); }
  .storyline .sl-focus { font-size: .82em; margin-top: 1px; }
  .storyline .sl-what { margin: 5px 0 4px; font-size: .92em; }
  .storyline ul.sl-tl { margin: 3px 0 0; }
  ul.whatchanged .wc-when { font-size: .8em; color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 5px; white-space: nowrap; }
  .report-cal { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 18px; padding: 8px 14px;
    border: 1px solid var(--isa-gold); background: var(--isa-gold-40); border-radius: 8px; font-size: .85em; }
  .report-cal .rc-lbl { font-weight: 700; color: var(--isa-dark); white-space: nowrap; }
  .report-cal .rc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 18px; }
  .report-cal .rc-list li { white-space: nowrap; }
  .report-cal .rc-date { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--isa-dark); margin-right: 3px; }
  .report-cal .rc-imp { font-size: .82em; font-weight: 700; color: var(--isa-rust); }
  .signals { margin: 6px 0 22px; }
  .sig-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .tilt { font-weight: 700; font-size: .82em; padding: 3px 12px; border-radius: 999px; text-transform: capitalize; }
  .tilt-bullish { background: #e6f1ea; color: #2f7d4e; } .tilt-bearish { background: #f7e2da; color: #b8481f; } .tilt-mixed { background: var(--isa-blue-40); color: var(--isa-dark); }
  .sig-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .sig { border: 1px solid var(--line); border-left-width: 4px; border-radius: 8px; padding: 10px 12px; background: #fff; }
  .sig-top { display: flex; align-items: center; justify-content: space-between; }
  .sig-name { font-weight: 700; color: var(--isa-dark); font-size: .92em; }
  .sig-dir { font-size: 1.05em; font-weight: 700; }
  .sig-label { font-size: .82em; font-weight: 600; opacity: .8; margin: 1px 0 5px; }
  .sig-detail { font-size: .78em; line-height: 1.4; color: var(--ink); opacity: .78; }
  .sig-bullish { border-left-color: #3f9d5e; } .sig-bullish .sig-dir { color: #2f7d4e; }
  .sig-bearish { border-left-color: #cf6a45; } .sig-bearish .sig-dir { color: #b8481f; }
  .sig-neutral { border-left-color: var(--isa-dark-40); } .sig-neutral .sig-dir { color: var(--muted); }
  .chart-range { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 4px 0 16px;
    padding: 8px 12px; background: var(--isa-blue-40); border-radius: 8px; font-size: .85em; }
  .chart-range .rlabel { font-weight: 600; color: var(--isa-dark); margin-right: 2px; }
  .chart-range button { background: #fff; color: var(--isa-dark); border: 1px solid var(--isa-dark-40);
    border-radius: 6px; padding: 3px 12px; font-size: .9em; font-weight: 600; }
  .chart-range button:hover { background: var(--isa-gold-40); }
  .chart-range button.on { background: var(--isa-blue); color: #fff; border-color: var(--isa-blue); }
  .chart-range .rcustom { margin-left: auto; color: var(--isa-dark); opacity: .85; display: inline-flex; align-items: center; gap: 5px; }
  .chart-range input[type=date] { padding: 2px 6px; font-size: .92em; }
  .bbchart-box { margin: 8px 0 6px; min-height: 60px; }
  .u-legend { font-size: .82em; margin-top: 6px; }
  .u-legend .u-marker { width: 10px; height: 10px; }
  .u-title { color: var(--isa-dark); font-weight: 600; }
</style></head>
<body><header>
<a class="brand" href="/"><img class="logo" src="/assets/isa-logo-main.png" alt="Iowa Soybean Association"><span class="brandname">The Bean Brief</span></a>
<nav><a href="/">Home</a><a href="/items">Laws, Rules &amp; Decisions</a><a href="/news">News</a><a href="/markets">Markets</a><a href="/watchlist">Watchlist</a><a href="/sources">Sources</a><a href="/registry">Registry</a><a href="/logs">Logs &amp; Settings</a></nav>
</header>
<script>(function(){var p=location.pathname;document.querySelectorAll('nav a').forEach(function(a){var h=a.getAttribute('href');if(h==='/'?p==='/':p===h||p.indexOf(h+'/')===0)a.classList.add('active');});})();</script>
${body}
</body></html>`;
}

const SAFE_BRIEF_NAME = /^\d{4}-\d{2}-\d{2}-(am|pm|weekly|monthly|farmer|education|analyst|pulse)(-farmer)?\.md$/;

// ---------- run management ----------
let runInProgress = false;
let lastRunProblem = null; // { when, message }
const RUN_BUSY_MESSAGE = "A run is already in progress — give it a minute.";
const RUN_STILL_GOING = Symbol("run-still-going"); // race sentinel: the run outlived the grace window

// Returns null on success, RUN_BUSY_MESSAGE if a run was already in progress (nothing started),
// or a failure string if this run started and then failed. Never throws.
async function triggerRun(edition) {
  if (runInProgress) return RUN_BUSY_MESSAGE; // bounce — a run that never starts must NOT clear the banner
  runInProgress = true;
  lastRunProblem = null; // a genuinely-starting run retires any prior failure banner (not just on success)
  try {
    if (["weekly", "monthly", "farmer", "education", "analyst", "pulse"].includes(edition)) await runMemo(edition, process.env);
    else await runPipeline({ edition, env: process.env });
    return null;
  } catch (err) {
    console.error(`❌ ${edition} run failed: ${err.message}`);
    lastRunProblem = { when: fmtCT(Date.now()), message: `${edition.toUpperCase()} run failed: ${err.message}` };
    return lastRunProblem.message;
  } finally {
    runInProgress = false;
  }
}

// ---------- reusable widgets ----------
function chip(topicId, kind, term) {
  return `<form method="post" action="/watchlist/update" class="chip">
    <input type="hidden" name="action" value="remove">
    <input type="hidden" name="topicId" value="${esc(topicId)}">
    <input type="hidden" name="kind" value="${esc(kind)}">
    <input type="hidden" name="term" value="${esc(term)}">
    <span>${esc(term)}</span><button title="Remove '${esc(term)}'">×</button>
  </form>`;
}

function addForm(topicId, kind, placeholder) {
  return `<form method="post" action="/watchlist/update" class="addterm">
    <input type="hidden" name="action" value="add">
    <input type="hidden" name="topicId" value="${esc(topicId)}">
    <input type="hidden" name="kind" value="${esc(kind)}">
    <input type="text" name="term" placeholder="${esc(placeholder)}" required>
    <button>Add</button>
  </form>`;
}

/** Tiny inline SVG sparkline of daily counts. */
function sparkline(series) {
  const max = Math.max(1, ...series);
  const w = 84;
  const h = 20;
  const step = w / Math.max(1, series.length - 1);
  const points = series.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="#0070C3" stroke-width="1.5"/></svg>`;
}

// ---------- dashboard sections ----------
function sourcesSection(watchlist, openId) {
  const stats = store.getSourceStats(7);
  // All-time fetched/relevant per source — the "value ledger" is cumulative, not just the last week.
  const allTime = {};
  for (const r of store.getAuditData().sourceCounts) allTime[r.source_id] = { total: r.total, relevant: r.relevant ?? 0 };

  // The whole point of #5: value reads DIFFERENTLY by class. Official sources are AI-triaged, so
  // their value is the relevance pass-rate. News/markets are never triaged (everything flows to
  // their own tab), so a relevance % would wrongly brand them as noise — their value is coverage.
  const CLASS_META = {
    official: { label: "Official — laws, rules & decisions", blurb: "AI-triaged → value = relevance pass-rate." },
    news: { label: "News — collector & press", blurb: "Not triaged → everything feeds the News tab + digest. Value = coverage." },
    markets: { label: "Markets — demand & price data", blurb: "Not triaged → series feed the Markets charts + signals. Value = coverage." },
  };

  const rowFor = (adapter) => {
    const cfg = watchlist?.sources?.[adapter.id];
    const s = stats[adapter.id] ?? { seen: 0, relevant: 0, lastSuccess: null };
    const at = allTime[adapter.id] ?? { total: 0, relevant: 0 };
    const enabled = !(cfg && cfg.enabled === false);
    let dot, status;
    if (!enabled) {
      dot = "⚪";
      status = "turned off";
    } else if (s.lastSuccess && Date.now() - new Date(s.lastSuccess).getTime() < 36 * 60 * 60 * 1000) {
      dot = "🟢";
      status = `checked ${fmtCT(s.lastSuccess)}`;
    } else if (s.lastSuccess) {
      dot = "🟠";
      status = `last success ${fmtCT(s.lastSuccess)} — check the logs`;
    } else {
      dot = "🟠";
      status = "waiting for first successful run";
    }
    const toggle = `<form method="post" action="/watchlist/source">
      <input type="hidden" name="sourceId" value="${esc(adapter.id)}">
      <input type="hidden" name="enabled" value="${enabled ? "false" : "true"}">
      <button class="ghost tiny">${enabled ? "turn off" : "turn on"}</button></form>`;
    let value;
    if (classOf(adapter.id) === "official") {
      const pass = at.total ? Math.round((at.relevant / at.total) * 100) : null;
      value = at.total
        ? `<strong>${pass}%</strong> pass<br><span class="muted">${at.relevant} of ${at.total} relevant</span>`
        : `<span class="muted">—</span>`;
    } else {
      value = `<span class="muted">coverage feed<br>(not triaged)</span>`;
    }
    const fetched = `${s.seen}<br><span class="muted">${at.total} all-time</span>`;
    return `<tr><td>${dot}</td><td><strong>${esc(adapter.label)}</strong><br><span class="muted">${esc(status)}</span></td>
      <td>${fetched}</td><td>${value}</td><td>${toggle}</td></tr>`;
  };

  const groups = ["official", "news", "markets"]
    .map((cls) => {
      const list = Object.values(adapters).filter((a) => classOf(a.id) === cls);
      if (!list.length) return "";
      return `<tr class="clsrow"><td colspan="5"><strong>${esc(CLASS_META[cls].label)}</strong> — <span class="muted">${esc(CLASS_META[cls].blurb)}</span></td></tr>${list.map(rowFor).join("\n")}`;
    })
    .join("\n");

  const states = watchlist?.sources?.legiscan?.states ?? [];
  return `
<h2>Sources <span class="muted" style="font-weight:400;font-size:.7em">— value by class</span></h2>
<table class="sources">
  <tr><th></th><th>Source</th><th>Fetched<br><span class="muted" style="font-weight:400">7d · all-time</span></th><th>Value</th><th></th></tr>
  ${groups}
</table>
<p class="muted">🟢 active · 🟠 needs attention · ⚪ turned off. <strong>Official</strong> sources are AI-triaged, so their value is the relevance pass-rate. <strong>News</strong> &amp; <strong>Markets</strong> sources aren't triaged — everything they fetch flows to their own tab — so a relevance score would wrongly read as noise; their value is coverage.</p>
<details class="topic" id="t-states"${openId === "states" ? " open" : ""}>
  <summary>LegiScan states searched <span class="muted">(${esc(states.join(", ") || "none")})</span></summary>
  <div class="kicker">Two-letter codes. Adding "US" also searches the U.S. Congress by full bill text.</div>
  <div class="chips">${states.map((s) => chip("states", "states", s)).join("")} ${addForm("states", "states", "add state code, e.g. US")}</div>
</details>`;
}

function deadlinesSection() {
  const deadlines = store.upcomingDeadlines(6);
  if (deadlines.length === 0) return "";
  const rows = deadlines
    .map(
      (d) =>
        `<li><strong>${esc(d.comment_deadline)}</strong> — <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(
          (d.title ?? "").slice(0, 90)
        )}</a></li>`
    )
    .join("\n");
  return `
<h2>⏰ Upcoming comment deadlines</h2>
<ul>${rows}</ul>
<p class="muted">📅 <a href="/calendar.ics">calendar.ics</a> — in Outlook: Calendar → Add calendar → Subscribe from web → paste this page's address ending in /calendar.ics. Deadlines then appear on your work calendar automatically.</p>`;
}

function watchlistSection(watchlist, openId, activity) {
  const sources = Object.values(adapters);
  const areas = (watchlist?.focusAreas ?? [])
    .map((fa) => {
      const terms = fa.terms ?? [];
      const applies = fa.appliesTo && fa.appliesTo.length ? fa.appliesTo : sources.map((s) => s.id);
      const disabled = fa.enabled === false;
      const spark = activity?.[fa.id] ? sparkline(activity[fa.id]) : "";

      const termChips = terms
        .map(
          (t) => `<form method="post" action="/watchlist/term" class="chip">
            <input type="hidden" name="action" value="remove"><input type="hidden" name="areaId" value="${esc(fa.id)}">
            <input type="hidden" name="term" value="${esc(t)}">
            <span>${esc(t)}</span><button title="Remove '${esc(t)}'">×</button></form>`
        )
        .join("");
      const addTerm = `<form method="post" action="/watchlist/term" class="addterm">
        <input type="hidden" name="action" value="add"><input type="hidden" name="areaId" value="${esc(fa.id)}">
        <input type="text" name="term" placeholder="add term…" required><button>Add</button></form>`;

      const sourcePills = sources
        .map((s) => {
          const on = applies.includes(s.id);
          return `<form method="post" action="/watchlist/area-source" class="pill ${on ? "on" : "off"}">
            <input type="hidden" name="areaId" value="${esc(fa.id)}"><input type="hidden" name="sourceId" value="${esc(s.id)}">
            <input type="hidden" name="on" value="${on ? "false" : "true"}">
            <button title="${on ? "Applies — click to exclude" : "Excluded — click to include"}">${on ? "✓ " : ""}${esc(s.label)}</button></form>`;
        })
        .join("");

      const weightForm = `<form method="post" action="/watchlist/area" class="addterm">
        <input type="hidden" name="action" value="weight"><input type="hidden" name="areaId" value="${esc(fa.id)}">
        <label class="muted">weight <input type="number" name="weight" min="1" max="10" value="${esc(fa.weight)}" style="width:60px"></label>
        <button class="ghost tiny">save</button></form>`;
      const toggleForm = `<form method="post" action="/watchlist/area">
        <input type="hidden" name="action" value="${disabled ? "enable" : "disable"}"><input type="hidden" name="areaId" value="${esc(fa.id)}">
        <button class="ghost tiny">${disabled ? "enable" : "disable"}</button></form>`;
      const deleteForm = `<form method="post" action="/watchlist/area" onsubmit="return confirm('Delete the focus area \\'${esc(fa.label)}\\' and all its terms?')">
        <input type="hidden" name="action" value="delete"><input type="hidden" name="areaId" value="${esc(fa.id)}">
        <button class="ghost tiny">delete</button></form>`;

      return `<details class="topic" id="t-${esc(fa.id)}"${openId === fa.id ? " open" : ""}>
        <summary>${esc(fa.label)} <span class="muted">(weight ${esc(fa.weight)}, ${terms.length} term${terms.length === 1 ? "" : "s"}${disabled ? " · disabled" : ""})</span>${spark}</summary>
        <div class="toolbar">${weightForm} ${toggleForm} ${deleteForm}</div>
        <div class="kicker">Terms <span class="muted" style="font-weight:400">— used to search sources AND to score &amp; tag items</span></div>
        <div class="chips">${termChips} ${addTerm}</div>
        <div class="kicker">Applies to sources</div>
        <div class="chips">${sourcePills}</div>
      </details>`;
    })
    .join("\n");

  return `
<h2>Focus areas</h2>
<p class="muted">Each focus area is an issue bucket with one list of <strong>terms</strong>. Terms drive both what we search for and how items are scored &amp; tagged — no more per-source query lists. Changes save immediately and apply from the next run.</p>
${areas || '<p class="muted">No focus areas yet.</p>'}
<details class="topic" id="t-newarea"${openId === "newarea" ? " open" : ""}>
  <summary>➕ Add a focus area</summary>
  <form method="post" action="/watchlist/area" class="toolbar">
    <input type="hidden" name="action" value="add">
    <input type="text" name="label" placeholder="Focus area name, e.g. Biotech / Gene Editing" required style="min-width:280px">
    <label class="muted">weight <input type="number" name="weight" min="1" max="10" value="7" style="width:60px"></label>
    <button>Create focus area</button>
  </form>
  <p class="muted">Then open it to add terms and choose which sources it applies to.</p>
</details>`;
}

function settingsSection(watchlist, openId) {
  const ed = watchlist?.briefEditions ?? {};
  const out = watchlist?.output ?? {};
  const emailTo = process.env.BRIEF_EMAIL_TO;
  const emailConfigured = Boolean(process.env.SMTP_HOST && emailTo);
  const emailOn = out.email === true;
  return `
<details class="topic" id="t-settings"${openId === "settings" ? " open" : ""}>
  <summary>⚙️ Settings <span class="muted">(schedule, thresholds, Teams)</span></summary>
  <form method="post" action="/watchlist/settings">
    <div class="kicker">Schedule (${esc(ed.timezone ?? "America/Chicago")})</div>
    <div class="toolbar">
      <label class="muted">AM <input type="time" name="am" value="${esc(ed.am ?? "06:30")}"></label>
      <label class="muted">PM <input type="time" name="pm" value="${esc(ed.pm ?? "16:30")}"></label>
      <label class="muted">Weekly memo
        <select name="weeklyDay">
          ${["off", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            .map((d) => `<option value="${d}"${(ed.weekly ?? "Fri 17:00").startsWith(d) || (d === "off" && !ed.weekly) ? " selected" : ""}>${d}</option>`)
            .join("")}
        </select>
        <input type="time" name="weeklyTime" value="${esc((ed.weekly ?? "Fri 17:00").split(" ")[1] ?? "17:00")}">
      </label>
    </div>
    <div class="kicker">Pipeline thresholds</div>
    <div class="toolbar">
      <label class="muted">min local score <input type="number" name="minLocalScoreForTriage" value="${esc(out.minLocalScoreForTriage ?? 5)}" min="0" max="50" style="width:64px"></label>
      <label class="muted">max items to triage <input type="number" name="maxItemsToTriage" value="${esc(out.maxItemsToTriage ?? 80)}" min="5" max="300" style="width:70px"></label>
      <label class="muted">max items in brief <input type="number" name="maxItemsInBrief" value="${esc(out.maxItemsInBrief ?? 25)}" min="5" max="100" style="width:64px"></label>
    </div>
    <div class="toolbar"><button>Save settings</button></div>
  </form>
  <div class="kicker">Email delivery</div>
  <p class="muted">${
    emailConfigured
      ? `Briefs email to <strong>${esc(emailTo)}</strong> via ${esc(process.env.SMTP_HOST)}${
          emailOn ? "." : " — but email delivery is currently <strong>off</strong> in the watchlist (set output.email to true, then restart)."
        }`
      : "Not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS and BRIEF_EMAIL_TO in the .env file, enable email in the watchlist, then restart the app."
  }</p>
  <div class="kicker">Security</div>
  <p class="muted">${process.env.POLIBRIEF_PASSWORD ? "Password protection is ON." : "No password set. To require one, add POLIBRIEF_PASSWORD=yourpassword to .env and restart (fine to skip on a Tailscale-only network)."}</p>
</details>`;
}

// The "what changed" feed — recent event-driven market alerts (src/alerts.js).
function whatChangedSection() {
  let alerts;
  try {
    alerts = store.listAlerts(12);
  } catch {
    return "";
  }
  if (!alerts.length) return "";
  const icon = { signal: "🔀", tilt: "🧭", extreme: "🚩", move: "📈" };
  const items = alerts
    .map(
      (a) => `<li><span class="wc-when">${esc(fmtCT(a.created_at))}</span> ${icon[a.category] || "•"} <strong>${esc(a.title)}</strong>${a.detail ? ` <span class="muted">${esc(a.detail)}</span>` : ""}</li>`
    )
    .join("");
  return `<details class="topic" open><summary>🔔 What changed <span class="muted">(${alerts.length})</span></summary><ul class="whatchanged">${items}</ul></details>`;
}

// Storylines — the ongoing named threads the monitoring is really about (auto-clustered + persistent).
function storylinesSection() {
  let lines;
  try {
    lines = store.listStorylines(6);
  } catch {
    return "";
  }
  if (!lines.length) return "";
  const meta = getStorylinesMeta();
  const cards = lines
    .map((s) => {
      const tl = (s.timeline || [])
        .slice(0, 4)
        .map((e) => `<li><span class="wc-when">${esc(e.date || "")}</span> ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.event)}</a>` : esc(e.event)}</li>`)
        .join("");
      return `<div class="storyline">
        <div class="sl-name">${esc(s.name)}</div>
        ${s.focus ? `<div class="muted sl-focus">${esc(s.focus)}</div>` : ""}
        ${s.summary ? `<p class="sl-what">${esc(s.summary)}</p>` : ""}
        ${tl ? `<ul class="whatchanged sl-tl">${tl}</ul>` : ""}
      </div>`;
    })
    .join("");
  return `<details class="topic"><summary>🧵 Storylines <span class="muted">(${lines.length})${meta?.generatedAt ? ` · updated ${esc(fmtCT(meta.generatedAt))}` : ""}</span></summary>
    <p class="muted" style="margin:2px 0 8px;font-size:.85em">The ongoing threads behind the headlines — auto-clustered from what's flowing in. <form method="post" action="/storylines" style="display:inline"><button class="ghost tiny">↻ Refresh</button></form></p>
    <div class="storylines">${cards}</div></details>`;
}

// Market-education cards — the farmer-facing output of the condition-trigger engine (compliance-
// framed: teach, never advise). Cached; generated on each run + on demand.
function marketCardsSection() {
  const cached = getCachedMarketCards();
  if (cached && cached.markdown) {
    return `<details class="topic" open><summary>🌱 For farmers: what to watch${cached.triggers?.length ? ` <span class="muted">(${cached.triggers.length} active)</span>` : ""}</summary>
      <div class="answer market-cards">${markdownToHtml(cached.markdown)}
        <div class="muted" style="margin-top:6px;font-size:.82em">${esc(cached.date)} · <form method="post" action="/market-cards" style="display:inline"><button class="ghost tiny">↻ Refresh</button></form></div></div></details>`;
  }
  return `<details class="topic"><summary>🌱 For farmers: what to watch</summary>
    <p class="muted" style="font-size:.9em">Farmer-facing education cards from the seasonal / report / positioning triggers — teach, never advise.</p>
    <form method="post" action="/market-cards"><button class="ghost">Generate today's cards</button></form></details>`;
}

function homeBody(notice, openId = null, search = null) {
  const briefs = store.listBriefs(60);
  const items = briefs
    .map((b) => {
      const name = path.basename(b.path);
      const label = name
        .replace(".md", "")
        .replace(/-(am|pm)$/, (m) => m.replace("-", " · ").toUpperCase())
        .replace(/-weekly$/, " · 📚 WEEKLY")
        .replace(/-monthly$/, " · 🗓️ MONTHLY")
        .replace(/-farmer$/, " · 🌾 FARMER")
        .replace(/-education$/, " · 🎓 EDUCATION")
        .replace(/-analyst$/, " · 🔭 ANALYST")
        .replace(/-pulse$/, " · ⚡ PULSE");
      return `<li><a href="/brief/${encodeURIComponent(name)}">${esc(label)}</a> <span class="muted">${esc(
        fmtCT(b.created_at)
      )}</span></li>`;
    })
    .join("\n");

  // Settings moved to the Logs & Settings page; the homepage keeps upcoming comment deadlines.
  void openId;
  let configSections;
  try {
    configSections = deadlinesSection();
  } catch (err) {
    configSections = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
  }

  const searchSection = `<h2 style="margin-bottom:2px">🔎 Ask the Bean Brief</h2>
<form method="get" action="/" class="toolbar">
  <input type="text" name="q" placeholder='e.g. "how is soybean crush trending?" or "connect 45Z guidance to feedstock demand"' value="${esc(search?.q ?? "")}" style="min-width:340px">
  <button>Ask</button>
</form>
<p class="muted" style="margin-top:0">Answers draw on everything stored — Laws/Rules/Decisions + News + Markets data + briefs — with links. One Sonnet call (~a cent) per question.</p>
${search?.error ? `<div class="banner err">⚠️ ${esc(search.error)}</div>` : ""}
${search?.result ? `<div class="answer">${markdownToHtml(search.result.answer)}</div>` : ""}
<hr style="border:none;border-top:1px solid var(--isa-blue-40);margin:16px 0">`;

  return `
${lastRunProblem ? `<div class="banner err">❌ ${esc(lastRunProblem.message)} <span class="muted">(${esc(lastRunProblem.when)})</span><br><span class="muted">Most common cause: missing API keys — edit the .env file in the app's data folder, then restart the app. Details on the <a href="/logs">Logs page</a>.</span></div>` : ""}
${notice ? `<div class="banner">${esc(notice)}</div>` : ""}
${searchSection}
${whatChangedSection()}
<style>
  .reports form{margin:0}
  .reports .report{display:flex;flex-direction:column;gap:3px}
  .reports .rdesc{font-size:.8em;line-height:1.35}
  .reports .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px;margin-top:12px}
  @media(max-width:640px){.reports .grid{grid-template-columns:1fr}}
</style>
<div class="reports">
  <div class="report">
    <form method="post" action="/run"><input type="hidden" name="edition" value="auto"><button>▶ Run policy brief now</button></form>
    <span class="muted rdesc">Scans the 7 government sources, flags what's relevant to Iowa soy, and writes it up. Also the twice-daily refresh that keeps Markets, News &amp; alerts current — it now stays quiet on days with no policy movement instead of saving a blank brief.</span>
  </div>
  <p class="muted" style="margin:16px 0 0;font-weight:600">On-demand reports</p>
  <div class="grid">
    <div class="report">
      <form method="post" action="/run"><input type="hidden" name="edition" value="weekly"><button class="ghost">📚 Weekly memo</button></form>
      <span class="muted rdesc">The past 7 days of policy + markets for colleagues and board who didn't follow the daily flow.</span>
    </div>
    <div class="report">
      <form method="post" action="/run"><input type="hidden" name="edition" value="monthly"><button class="ghost">🗓️ Monthly review</button></form>
      <span class="muted rdesc">A 30-day, higher-altitude "month in review" — trends and direction of travel, for leadership.</span>
    </div>
    <div class="report">
      <form method="post" action="/run"><input type="hidden" name="edition" value="analyst"><button class="ghost">🔭 Analyst Note</button></form>
      <span class="muted rdesc">Internal deep dive: connects policy to the market mechanism and looks around the corner, naming the reports that would confirm or kill each read.</span>
    </div>
    <div class="report">
      <form method="post" action="/run"><input type="hidden" name="edition" value="pulse"><button class="ghost">⚡ Market Pulse</button></form>
      <span class="muted rdesc">Short farmer read on what's moving now and what a marketer is weighing — education, never a buy/sell call.</span>
    </div>
    <div class="report">
      <form method="post" action="/run"><input type="hidden" name="edition" value="farmer"><button class="ghost">🌾 Farmer update</button></form>
      <span class="muted rdesc">Plain, nonpartisan update for members: what your beans are worth, the policy to know, dates to watch.</span>
    </div>
    <div class="report">
      <form method="post" action="/run"><input type="hidden" name="edition" value="education"><button class="ghost">🎓 Market-education brief</button></form>
      <span class="muted rdesc">The daily "teach, don't tell" lesson — one real data point, one market concept, so farmers learn to read the market themselves.</span>
    </div>
  </div>
  ${runInProgress ? '<p class="muted" style="margin-top:10px">a run is in progress…</p>' : ""}
</div>
<h2>Saved briefs <span class="muted" style="font-weight:400;font-size:.7em">(<a href="/feed.xml">RSS</a>)</span></h2>
${briefs.length ? `<ul class="briefs">${items}</ul>` : "<p class='muted'>No briefs yet. Click a Run button above, or wait for the next scheduled edition.</p>"}
${configSections}
`;
}

// ---------- sources page ----------
function sourcesBody(notice, openId) {
  let body;
  try {
    body = sourcesSection(loadWatchlist(), openId);
  } catch (err) {
    body = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
  }
  return `${notice ? `<div class="banner">${esc(notice)}</div>` : ""}${body}`;
}

// ---------- registry page (v2) ----------
function registryBody(notice) {
  let body;
  try {
    const counts = store.entityCountsByType();
    const total = counts.reduce((a, c) => a + c.n, 0);
    const entities = store.listEntities({ limit: 500 });
    const channels = store.listChannels({ active: 1 });
    const chanByEntity = new Map();
    for (const c of channels) chanByEntity.set(c.entity_id, (chanByEntity.get(c.entity_id) ?? 0) + 1);
    const stale = store.staleChannels(10);

    const countLine = counts.map((c) => `<strong>${c.n}</strong> ${esc(c.type)}`).join(" · ") || "no entities yet";

    const staleHtml =
      channels.length === 0
        ? ""
        : stale.length === 0
          ? `<p class="muted">🟢 All ${channels.length} active channels have fetched OK (or are new).</p>`
          : `<details class="topic"><summary>🟠 ${stale.length} channel(s) never fetched or stale &gt;10d — the silent-failure guard</summary>
             <table class="sources"><tr><th>Entity</th><th>Kind</th><th>Target</th><th>Last error</th></tr>
             ${stale
               .slice(0, 60)
               .map((c) => {
                 const e = store.getEntity(c.entity_id);
                 return `<tr><td>${esc(e?.full_name ?? c.entity_id)}</td><td>${esc(c.kind)}</td><td class="muted">${esc(
                   (c.url_or_handle || "").slice(0, 50)
                 )}</td><td class="muted">${esc((c.last_error || "—").slice(0, 60))}</td></tr>`;
               })
               .join("")}</table></details>`;

    const rows = entities
      .map(
        (e) => `<tr>
        <td><strong>${esc(e.full_name)}</strong></td>
        <td>${esc(e.type)}</td>
        <td>${esc(e.party ?? "")}</td>
        <td>${esc(e.office ?? "")}${e.district ? ` <span class="muted">d${esc(e.district)}</span>` : ""}</td>
        <td>${esc(e.level ?? "")}</td>
        <td>${chanByEntity.get(e.id) ?? 0}</td>
        <td class="muted">${esc(e.source ?? "")}</td></tr>`
      )
      .join("\n");

    body = `<h2>Entity Registry</h2>
    <p>${countLine} — <strong>${total}</strong> total · ${channels.length} active channels.</p>
    <form method="post" action="/registry/sync" style="margin:.5rem 0">
      <button class="ghost">↻ Sync registry.json → database</button>
      <span class="muted">Re-imports the hand-seed file (idempotent). Machine seeders run from the CLI.</span></form>
    ${staleHtml}
    <table class="sources">
      <tr><th>Name</th><th>Type</th><th>Party</th><th>Office</th><th>Level</th><th>Ch.</th><th>Source</th></tr>
      ${rows || `<tr><td colspan="7" class="muted">No entities yet — click Sync above, or seed from the CLI: <code>node src/index.js registry-refresh</code>.</td></tr>`}
    </table>
    <p class="muted">The backbone of v2: <em>who</em> we watch and <em>how</em> each publishes. Seed state legislators with <code>registry-seed openstates</code>.</p>`;
  } catch (err) {
    body = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
  }
  return `${notice ? `<div class="banner">${esc(notice)}</div>` : ""}${body}`;
}

// ---------- watchlist page ----------
function watchlistBody(notice, openId) {
  let body;
  try {
    const watchlist = loadWatchlist();
    const activity = store.activitySeries(watchlist.topics ?? [], 28);
    body = watchlistSection(watchlist, openId, activity);
  } catch (err) {
    body = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
  }
  return `${notice ? `<div class="banner">${esc(notice)}</div>` : ""}${body}`;
}

// ---------- items page ----------
// A light headline feed shared by the News and Markets tabs (no triage/track controls —
// this is a "what's flowing in" reading surface, kept separate from the Items workflow).
function feedRows(cls, emptyMsg) {
  const rows = store.listItems({ verdict: "", sourceIds: sourceIdsForClass(cls), days: 21, limit: 150 });
  if (!rows.length) return `<p class="muted">${emptyMsg}</p>`;
  return rows
    .map((r) => {
      const src = adapters[r.source_id]?.label ?? r.source_id;
      const when = (r.first_seen_at || "").slice(0, 10);
      return `<article style="padding:10px 0;border-bottom:1px solid var(--isa-blue-40)">
        <a href="${esc(r.url || "#")}" target="_blank" rel="noopener"><strong>${esc(r.title || "(untitled)")}</strong></a>
        <div class="muted" style="font-size:.85em">${esc(src)} · ${esc(when)}</div>
        ${r.one_line ? `<div>${esc(r.one_line)}</div>` : ""}
      </article>`;
    })
    .join("");
}

// The News inbox — the collector inbox + press RSS, "what's flowing in". Shows the 20 most-recent
// items and tucks the rest into a collapsed "older mail" section, and makes each item expandable
// to read its stored body inline. Emails have no external link, so the stored body IS the way to
// read the message — this is the "I want to read that headline but can't right now" remedy.
function inboxFeed() {
  const rows = store.listItems({ verdict: "", sourceIds: sourceIdsForClass("news"), days: 30, limit: 200 });
  if (!rows.length) {
    return `<p class="muted">No news items yet — they appear once the pipeline runs with the collector (email_intake) enabled on the Pi.</p>`;
  }
  const item = (r) => {
    const src = adapters[r.source_id]?.label ?? r.source_id;
    const when = (r.first_seen_at || "").slice(0, 10);
    const body = (r.body || "").trim();
    const preview = r.one_line || (body ? body.slice(0, 180) + (body.length > 180 ? "…" : "") : "");
    return `<details class="mailitem">
      <summary>
        <span class="mi-title">${esc(r.title || "(untitled)")}</span>
        <span class="mi-meta muted">${esc(src)} · ${esc(when)}</span>
        ${preview ? `<span class="mi-prev muted">${esc(preview)}</span>` : ""}
      </summary>
      <div class="mailbody">
        ${body ? `<div class="mi-body">${esc(body)}</div>` : `<p class="muted" style="margin:.3em 0">No stored text for this one — open the source to read it.</p>`}
        ${r.url ? `<a class="mi-link" href="${esc(r.url)}" target="_blank" rel="noopener">Open original ↗</a>` : `<span class="muted mi-nolink">Email — no external link; the text above is the message.</span>`}
      </div>
    </details>`;
  };
  const recent = rows.slice(0, 20).map(item).join("");
  const older = rows.slice(20);
  const olderBlock = older.length
    ? `<details class="topic mi-older"><summary>📬 Older mail <span class="muted">(${older.length})</span></summary>${older.map(item).join("")}</details>`
    : "";
  return `<div class="inbox">${recent}</div>${olderBlock}`;
}

function newsBody(notice) {
  const cached = getCachedNewsDigest();
  const digestBlock = cached
    ? `<div class="answer news-digest">${markdownToHtml(cached.markdown)}
        <div class="muted" style="margin-top:8px;font-size:.85em">Distilled from ${cached.count} items · ${esc(cached.date)} · <form method="post" action="/news/digest" style="display:inline"><button class="ghost tiny">↻ Refresh</button></form></div></div>`
    : `<form method="post" action="/news/digest"><button class="ghost">🧠 Generate today's digest</button></form>
       <p class="muted" style="font-size:.85em">One cheap Haiku call over the last two days of news.</p>`;
  return `<h1>📰 News</h1>
    ${notice ? `<div class="banner">${esc(notice)}</div>` : ""}
    <style>
      .mailitem{border-bottom:1px solid var(--isa-blue-40);padding:9px 0}
      .mailitem>summary{cursor:pointer;list-style:none;display:block}
      .mailitem>summary::-webkit-details-marker{display:none}
      .mailitem>summary::before{content:"▸";display:inline-block;width:14px;opacity:.55}
      .mailitem[open]>summary::before{content:"▾"}
      .mailitem .mi-title{font-weight:600}
      .mailitem .mi-meta{display:block;font-size:.8em;margin:1px 0 0 14px}
      .mailitem .mi-prev{display:block;font-size:.9em;margin:2px 0 0 14px}
      .mailitem .mailbody{margin:6px 0 4px 14px;font-size:.92em;line-height:1.55;max-width:72ch}
      .mailitem .mi-body{white-space:pre-wrap;margin-bottom:8px}
      .mailitem .mi-link{font-size:.9em}
      .mi-older{margin-top:16px}
      .mi-older>summary{cursor:pointer;font-weight:600}
    </style>
    <h2 style="margin-bottom:2px">🧠 News of the day</h2>
    <p class="muted" style="margin-top:0">A distillation of the collector inbox + press RSS — themes and why they matter, not a relist.</p>
    ${digestBlock}
    ${storylinesSection()}
    <hr style="border:none;border-top:1px solid var(--isa-blue-40);margin:20px 0">
    <h2 style="margin-bottom:2px">📬 What's flowing in</h2>
    <p class="muted" style="margin-top:0">The 20 most-recent items — click any headline to read it right here. Older mail is tucked below.</p>
    ${inboxFeed()}`;
}

// A Markets chart = a container div + a JSON blob of its series, rendered client-side
// by uPlot (assets/bbcharts.js) into an interactive line chart with a live hover legend
// (month + value), real time axes and gridlines. Dependency-light: uPlot is one vendored
// static file, no build step. The `⬇ CSV` link still exports the exact numbers.
function chartSection(category, title, desc, height = 300) {
  const series = store
    .listSeriesMeta(category)
    .map((m) => ({ label: m.label, unit: m.unit, points: store.getSeries(m.series) }))
    .filter((s) => s.points.length);
  if (!series.length) return "";
  const unit = series[0].unit || "";
  const id = `chart_${category}`;
  // Escape "<" inside the JSON so nothing can break out of the <script> element.
  const spec = JSON.stringify({ unit, height, series }).replace(/</g, "\\u003c");
  return `<h2 style="margin-bottom:2px">${title}
      <a class="ghost tiny" href="/markets/csv?category=${category}" style="font-size:.65em;vertical-align:middle">⬇ CSV</a></h2>
    <p class="muted" style="margin-top:0">${desc}</p>
    <div class="bbchart-box" id="${id}"><p class="muted">Loading chart…</p></div>
    <script class="bbchart" type="application/json" data-target="${id}">${spec}</script>`;
}

// The signals board — a bull/bear read at a glance, above the charts (the summary before
// the detail). Powered by src/signals.js over the stored market data.
function signalsBoard() {
  let board;
  try {
    board = computeSignals();
  } catch {
    return "";
  }
  if (!board.signals.length) return "";
  const arrow = { bullish: "▲", bearish: "▼", neutral: "•" };
  const cards = board.signals
    .map(
      (s) => `<div class="sig sig-${s.direction}">
        <div class="sig-top"><span class="sig-name">${esc(s.name)}</span><span class="sig-dir">${arrow[s.direction]}</span></div>
        <div class="sig-label">${esc(s.label)}</div>
        <div class="sig-detail">${esc(s.detail)}</div>
      </div>`
    )
    .join("");
  return `<section class="signals">
    <div class="sig-head">
      <h2 style="margin:0">Market signals</h2>
      <span class="tilt tilt-${board.tilt}">Price tilt: ${board.tilt} · ${board.bullish}▲ / ${board.bearish}▼ / ${board.neutral}•</span>
    </div>
    <p class="muted" style="margin:.2em 0 12px">A bull/bear read across the stored data — bullish = supportive of soybean price. Informational, not a recommendation.</p>
    <div class="sig-grid">${cards}</div>
  </section>`;
}

// The release calendar — what market-moving reports are imminent (time-sensitivity).
function reportCalendar() {
  let list;
  try {
    list = upcomingReports(21);
  } catch {
    return "";
  }
  if (!list.length) return "";
  const badge = (imp) => (imp === "very_high" ? ' <span class="rc-imp">★ high-impact</span>' : imp === "high" ? ' <span class="rc-imp">● notable</span>' : "");
  const items = list
    .slice(0, 6)
    .map((r) => `<li title="${esc(r.note)}"><span class="rc-date">${esc(r.date.slice(5))}</span> <strong>${esc(r.name)}</strong>${badge(r.impact)} <span class="muted">${esc(r.agency)}</span></li>`)
    .join("");
  return `<div class="report-cal"><span class="rc-lbl">📅 Coming up</span><ul class="rc-list">${items}</ul></div>`;
}

// Data health — flags any market series whose latest point is overdue vs. its own cadence,
// so a silently-stale feed doesn't read as a quiet market.
function dataHealth() {
  let rows;
  try {
    rows = store.seriesFreshness();
  } catch {
    return "";
  }
  if (!rows.length) return "";
  const stale = rows.filter((r) => r.stale);
  const staleList = stale
    .map((r) => `<li><strong>${esc(r.label)}</strong> <span class="muted">(${esc(r.category)})</span> — last ${esc(r.latest)}, ${r.ageDays}d old (expected ~${r.cadenceDays}d cadence)</li>`)
    .join("");
  return `<details class="topic data-health"${stale.length ? " open" : ""}>
    <summary>${stale.length ? `🟠 Data health — ${stale.length} of ${rows.length} series overdue` : `🟢 Data health — all ${rows.length} series current`}</summary>
    ${stale.length ? `<ul>${staleList}</ul>` : `<p class="muted">Every market series has updated within its expected cadence.</p>`}
  </details>`;
}

function marketsBody(notice) {
  const charts = [
    chartSection("biofuel_feedstock", "Biofuel feedstock demand", "Lipid feedstocks used in U.S. biodiesel + renewable diesel — soybean oil vs. the competition (corn oil, canola, used cooking oil, tallow…). Hover for the value + month.", 320),
    chartSection("soy_price", "Soybean price received", "Monthly average price ($/bu) — Iowa vs. U.S.", 260),
    chartSection("corn_price", "Corn price received", "Monthly average corn price ($/bu) — Iowa vs. U.S. The other half of the rotation.", 260),
    chartSection("soy_corn_ratio", "Soybean:corn price ratio (Iowa)", "Iowa soybean price ÷ corn price — the relative-value read behind acreage decisions. Historically ~2.3–2.5 is the rough pivot between favoring beans and corn.", 240),
    chartSection("soy_crush", "U.S. soybean crush", "Monthly crush — the domestic-demand engine, near record highs on renewable-diesel demand.", 260),
    chartSection("soy_stocks", "U.S. soybean stocks", "Quarterly ending stocks — the supply cushion behind price.", 260),
    chartSection("soy_balance", "U.S. soybean ending stocks (WASDE)", "USDA's monthly WASDE ending-stocks estimate for the current marketing year (mln bushels) — the supply cushion at the heart of the balance sheet. Each point is a fresh WASDE, so the line doubles as a revision trail.", 260),
    chartSection("soy_balance_stu", "U.S. soybean stocks-to-use (WASDE)", "Ending stocks as a share of total use — the tightness ratio that drives price. Roughly: below ~8% is tight (supportive), above ~15% is ample (a drag).", 240),
    chartSection("soy_condition", "Soybean crop condition", "In-season % rated good or excellent (USDA Crop Progress) — Iowa vs. U.S. Weather's fingerprint on this year's yield potential.", 260),
    chartSection("drought", "Iowa drought coverage", "Share of Iowa land area in drought (D1+) and abnormally dry or worse (D0+), from the weekly U.S. Drought Monitor — a fast read on Corn Belt crop stress.", 260),
    chartSection("weather_us", "U.S. crop-weather anomaly", "Recent 30-day precipitation and heat vs. the ~27-year normal for the U.S. soybean belt (Open-Meteo / ERA5), production-weighted. Percentiles: low precip = drier than normal, high heat = hotter — both crop stress.", 240),
    chartSection("weather_sa", "S. America crop-weather anomaly", "The same anomaly read for the Brazil/Argentina soybean crop — the competitor-supply signal. Stress there shifts demand toward the U.S.", 240),
    chartSection("soy_exports", "Soybean exports (weekly)", "Weekly export activity in metric tons — inspections (actual loadings) vs. net sales (forward bookings). An export-pace / China-demand read; net sales also stands in for the (currently offline) FAS report.", 280),
    chartSection("barge_freight", "Mississippi barge freight", "Cost to move grain down the Mississippi ($/ton) — a driver of the Gulf export basis, and so of what Iowa elevators can bid.", 240),
    chartSection("positioning", "Fund positioning (CFTC)", "CBOT soybean managed-money net position — how the funds are leaning. Extremes can unwind fast.", 240),
    chartSection("macro_usd", "U.S. dollar index", "The broad trade-weighted dollar (FRED). A stronger dollar makes U.S. soybeans more expensive abroad — a quiet cap on export competitiveness vs. Brazil.", 240),
    chartSection("macro_rates", "10-year Treasury yield", "The 10-year yield (FRED) — a read on the cost of carrying stored grain.", 220),
    chartSection("brazil_production", "Brazil soybean production", "Brazil's annual soybean crop (IBGE PAM) — the U.S.'s main export competitor, and the multi-decade rise that reshaped the trade.", 240),
  ].filter(Boolean).join('<hr style="border:none;border-top:1px solid var(--isa-blue-40);margin:18px 0">');
  // Load uPlot + our renderer only on this page, after the chart blobs are in the DOM.
  const chartAssets = charts
    ? `<link rel="stylesheet" href="/assets/uPlot.min.css?v=${ASSET_VER}"><script src="/assets/uPlot.iife.min.js?v=${ASSET_VER}"></script><script src="/assets/bbcharts.js?v=${ASSET_VER}"></script>`
    : "";
  // One range control drives every chart; defaults to the last 6 months (set in bbcharts.js).
  const rangeBar = charts
    ? `<div class="chart-range" id="bbrange">
        <span class="rlabel">Show</span>
        <button data-months="6" type="button">6M</button>
        <button data-months="12" type="button">1Y</button>
        <button data-months="24" type="button">2Y</button>
        <button data-months="all" type="button">All</button>
        <span class="rcustom">custom <input type="date" name="from" aria-label="from date"> → <input type="date" name="to" aria-label="to date"></span>
      </div>`
    : "";
  return `<h1>📈 Markets &amp; Demand</h1>
    ${notice ? `<div class="banner">${esc(notice)}</div>` : ""}
    ${signalsBoard()}
    ${reportCalendar()}
    ${marketCardsSection()}
    ${rangeBar}
    ${charts || '<p class="muted">Charts populate after a run (or <code>market-refresh</code>) once the USDA/EIA keys are set.</p>'}
    <h2 style="margin-top:22px">Latest data points</h2>
    ${feedRows("markets", "No markets data yet — set the USDA/EIA API keys and the demand adapters populate this tab.")}
    <div style="margin-top:16px">${dataHealth()}</div>
    ${chartAssets}`;
}

function itemsBody(params, notice) {
  let watchlist = null;
  try {
    watchlist = loadWatchlist();
  } catch {
    /* filters degrade gracefully */
  }
  const filters = {
    q: params.get("q") ?? "",
    topicId: params.get("topic") ?? "",
    sourceId: params.get("source") ?? "",
    verdict: params.get("verdict") ?? "relevant",
    days: Number(params.get("days") ?? 30) || 30,
  };
  // Items tab = the clean regulatory/legal flow only. News (collector/press) and Markets
  // (demand data) live on their own tabs so they don't dilute this feed. Archived (set-aside)
  // items drop out of the main list into a recoverable archive view.
  const viewingArchive = params.get("archived") === "1";
  const rows = store.listItems({ ...filters, sourceIds: sourceIdsForClass("official"), limit: 200, archived: viewingArchive ? 1 : 0 });
  const nArchived = store.archivedCount();
  const trackedKeys = new Set(store.listTracked().map((t) => t.uid));
  const back = `/items?${params.toString()}`;

  const topicOptions = (watchlist?.topics ?? [])
    .map((t) => `<option value="${esc(t.id)}"${filters.topicId === t.id ? " selected" : ""}>${esc(t.label)}</option>`)
    .join("");
  const officialIds = new Set(sourceIdsForClass("official"));
  const sourceOptions = Object.values(adapters)
    .filter((a) => officialIds.has(a.id))
    .map((a) => `<option value="${esc(a.id)}"${filters.sourceId === a.id ? " selected" : ""}>${esc(a.label)}</option>`)
    .join("");

  const tracked = store.listTracked();
  const trackedBlock = tracked.length
    ? `<h2>📌 Tracked items</h2><ul>${tracked
        .map(
          (t) => `<li><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title ?? t.uid)}</a>
          <form method="post" action="/items/track" style="display:inline">
            <input type="hidden" name="uid" value="${esc(t.uid)}"><input type="hidden" name="on" value="false">
            <input type="hidden" name="back" value="${esc(back)}"><button class="ghost tiny">untrack</button></form></li>`
        )
        .join("")}</ul><p class="muted">New activity on tracked items gets a 📌 section at the top of every brief.</p>`
    : "";

  const summarizedSet = store.summarizedUids();
  const itemRows = rows
    .map((r) => {
      const isTracked = trackedKeys.has(r.uid);
      const hasSummary = summarizedSet.has(r.uid);
      const summaryPanel = `<details class="summary" data-uid="${esc(r.uid)}"${hasSummary ? " data-stored=\"1\"" : ""}>
        <summary>${hasSummary ? '🧠 <span style="color:#0a7d33;font-weight:600" title="Summary stored — click to view (reviewed)">✓ stored</span>' : "🧠 AI summary"}</summary>
        <div class="sumbody"><span class="muted">${hasSummary ? "Open to view the stored summary." : "Open to generate a ≤500-word summary of the linked document and why it matters."}</span></div>
      </details>`;
      // Buttons are AJAX (class "act") — they update in place so the page never scrolls back to the top.
      const trackBtn = `<button type="button" class="ghost tiny act${isTracked ? " on" : ""}" data-act="track" data-uid="${esc(r.uid)}" data-on="${isTracked ? "false" : "true"}" title="${isTracked ? "Stop tracking" : "Track: flag future movement in briefs"}">${isTracked ? "📌 tracked" : "📌 track"}</button>`;
      const fb = (val, emoji) => `<button type="button" class="ghost tiny fb act${r.feedback === val ? " on" : ""}" data-act="feedback" data-uid="${esc(r.uid)}" data-fb="${r.feedback === val ? "" : val}" data-val="${val}" title="${val === "up" ? "Good catch — more like this" : "Not relevant — fewer like this (adds an optional note for the AI)"}">${emoji}</button>`;
      const archiveBtn = viewingArchive
        ? `<button type="button" class="ghost tiny act" data-act="archive" data-uid="${esc(r.uid)}" data-on="false" title="Restore to the main list">♻ restore</button>`
        : `<button type="button" class="ghost tiny act" data-act="archive" data-uid="${esc(r.uid)}" data-on="true" title="Set aside — move to the archive (recoverable)">🗄 set aside</button>`;
      return `<tr data-row="${esc(r.uid)}">
        <td><a href="${esc(r.url ?? "#")}" target="_blank" rel="noopener">${esc((r.title ?? r.uid).slice(0, 110))}</a>
          ${r.one_line ? `<br><span class="muted">${esc(r.one_line)}</span>` : ""}
          ${r.feedback_note ? `<br><span class="muted">📝 ${esc(r.feedback_note)}</span>` : ""}
          ${summaryPanel}</td>
        <td class="muted">${esc(r.jurisdiction ?? "")}<br>${esc((r.published_at ?? r.first_seen_at ?? "").slice(0, 10))}</td>
        <td class="muted">${esc(r.triage_verdict ?? "")}</td>
        <td><div class="toolbar" style="margin:0">${trackBtn}${fb("up", "👍")}${fb("down", "👎")}${archiveBtn}</div></td>
      </tr>`;
    })
    .join("\n");

  return `
${notice ? `<div class="banner">${esc(notice)}</div>` : ""}
${trackedBlock}
<h2>Laws, Rules &amp; Decisions${viewingArchive ? " · 🗄 Archive" : ""}</h2>
${viewingArchive
  ? '<p><a href="/items">← back to the main list</a></p>'
  : nArchived
    ? `<p class="muted"><a href="/items?archived=1">🗄 View archive (${nArchived} set aside)</a></p>`
    : ""}
<form method="get" action="/items" class="toolbar">
  <input type="text" name="q" placeholder="search title / summary…" value="${esc(filters.q)}">
  <select name="topic"><option value="">any topic</option>${topicOptions}</select>
  <select name="source"><option value="">any source</option>${sourceOptions}</select>
  <select name="verdict">
    <option value=""${filters.verdict === "" ? " selected" : ""}>any verdict</option>
    <option value="relevant"${filters.verdict === "relevant" ? " selected" : ""}>relevant</option>
    <option value="irrelevant"${filters.verdict === "irrelevant" ? " selected" : ""}>irrelevant</option>
  </select>
  <select name="days">${[7, 30, 90, 365].map((d) => `<option value="${d}"${filters.days === d ? " selected" : ""}>last ${d} days</option>`).join("")}</select>
  <button>Filter</button>
</form>
<p class="muted">👍/👎 teach the AI triage what you consider relevant — corrections are fed into future runs. 📌 tracks an item so new activity is flagged in briefs.</p>
<table class="items">
  <tr><th>Item</th><th>Where / when</th><th>Verdict</th><th>Actions</th></tr>
  ${itemRows || '<tr><td colspan="4" class="muted">Nothing matches these filters.</td></tr>'}
</table>
<script>
document.querySelectorAll('details.summary').forEach(function(d){
  d.addEventListener('toggle', function(){
    if(!d.open || d.dataset.loaded) return;
    d.dataset.loaded='1';
    var body=d.querySelector('.sumbody');
    body.innerHTML='<span class="muted">Generating summary… this can take ~10 seconds.</span>';
    fetch('/items/summary',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'uid='+encodeURIComponent(d.dataset.uid)})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j.ok){
          body.innerHTML=j.html+'<p class="summeta">'+(j.cached?'cached':'generated')+' · '+j.model+(j.expiresAt?(' · cached until '+j.expiresAt):'')+'</p>';
        } else {
          body.innerHTML='<span class="muted">⚠️ '+(j.error||'Could not summarize this item.')+'</span>';
          d.dataset.loaded='';
        }
      })
      .catch(function(e){ body.innerHTML='<span class="muted">⚠️ '+e+'</span>'; d.dataset.loaded=''; });
  });
});
// Track / 👍 / 👎 update in place via fetch — the page never scrolls back to the top.
document.querySelectorAll('button.act').forEach(function(b){
  b.addEventListener('click', function(){
    var act=b.dataset.act;
    var body;
    if(act==='feedback'){
      var note='';
      if(b.dataset.fb==='down'){ note=window.prompt('Optional note for the AI — why is this not relevant, or how should it weigh this?')||''; }
      body='uid='+encodeURIComponent(b.dataset.uid)+'&fb='+encodeURIComponent(b.dataset.fb)+'&note='+encodeURIComponent(note);
    } else {
      body='uid='+encodeURIComponent(b.dataset.uid)+'&on='+encodeURIComponent(b.dataset.on);
    }
    b.disabled=true;
    fetch('/items/'+act,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-requested-with':'fetch'},body:body})
      .then(function(r){return r.json();}).then(function(j){
        b.disabled=false;
        if(!j.ok) return;
        if(act==='feedback'){
          b.closest('td').querySelectorAll('.fb').forEach(function(x){
            var on=(j.feedback===x.dataset.val);
            x.classList.toggle('on',on); x.dataset.fb= on?'':x.dataset.val;
          });
        } else if(act==='archive'){
          var tr=b.closest('tr'); if(tr){ tr.style.transition='opacity .25s'; tr.style.opacity=.3; setTimeout(function(){tr.remove();},250); }
        } else {
          b.classList.toggle('on',j.tracked);
          b.dataset.on= j.tracked?'false':'true';
          b.textContent= j.tracked?'📌 tracked':'📌 track';
        }
      }).catch(function(){ b.disabled=false; });
  });
});
</script>`;
}

// ---------- search page ----------
function searchBody(q, result, error) {
  return `
<h2>Ask your policy archive</h2>
<form method="get" action="/search" class="toolbar">
  <input type="text" name="q" placeholder='e.g. "what happened with 45Z guidance?"' value="${esc(q ?? "")}" style="min-width:320px" required>
  <button>Search</button>
</form>
<p class="muted">Answers come from everything polibrief has stored (items + briefs), with links. Each search makes one Sonnet call (~a cent).</p>
${error ? `<div class="banner err">⚠️ ${esc(error)}</div>` : ""}
${result ? `<div class="answer">${markdownToHtml(result.answer)}</div>` : ""}
`;
}

// ---------- feeds ----------
function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/[,;]/g, (m) => "\\" + m).replace(/\r?\n/g, "\\n");
}
function icsCalendar() {
  const events = store
    .upcomingDeadlines(200)
    .map((d) => {
      const date = d.comment_deadline.replace(/-/g, "");
      return [
        "BEGIN:VEVENT",
        `UID:${d.uid.replace(/[^A-Za-z0-9:_-]/g, "")}@polibrief`,
        `DTSTART;VALUE=DATE:${date}`,
        `SUMMARY:${icsEscape(`Comment deadline: ${(d.title ?? "").slice(0, 120)}`)}`,
        `DESCRIPTION:${icsEscape(`${d.one_line ?? ""}\n${d.url ?? ""}`)}`,
        `URL:${d.url ?? ""}`,
        "END:VEVENT",
      ].join("\r\n");
    })
    .join("\r\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//polibrief//EN", "X-WR-CALNAME:ISA Policy Deadlines", events, "END:VCALENDAR"].join("\r\n");
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function rssFeed(host) {
  const base = `http://${host}`;
  const entries = store
    .listBriefs(20)
    .map((b) => {
      const name = path.basename(b.path);
      const p = path.join(store.DATA_DIR, b.path);
      const excerpt = fs.existsSync(p) ? fs.readFileSync(p, "utf8").slice(0, 600) : "";
      return `<item>
  <title>${xmlEscape(name.replace(".md", ""))}</title>
  <link>${xmlEscape(`${base}/brief/${encodeURIComponent(name)}`)}</link>
  <guid>${xmlEscape(`${base}/brief/${encodeURIComponent(name)}`)}</guid>
  <pubDate>${new Date(b.created_at).toUTCString()}</pubDate>
  <description>${xmlEscape(excerpt)}</description>
</item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>polibrief — ISA policy briefs</title>
<link>${xmlEscape(base)}</link>
<description>Twice-daily policy briefs for Iowa soybean priorities</description>
${entries}
</channel></rss>`;
}

// ---------- helpers ----------
async function readForm(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "topic";
}

function checkAuth(req, res) {
  const password = process.env.POLIBRIEF_PASSWORD;
  if (!password) return true;
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    if (supplied === password) return true;
  }
  res.writeHead(401, { "www-authenticate": 'Basic realm="polibrief"', "content-type": "text/plain" });
  res.end("Password required (any username; password from POLIBRIEF_PASSWORD in .env)");
  return false;
}

/**
 * First-boot convenience inside Docker/Umbrel: seed the data volume with an
 * editable watchlist.json and .env so the user can change settings without
 * touching the container image.
 */
function seedDataDir() {
  if (store.DATA_DIR === store.PROJECT_ROOT) return;
  const seeds = [
    { from: path.join(store.PROJECT_ROOT, "watchlist.json"), to: path.join(store.DATA_DIR, "watchlist.json") },
    { from: path.join(store.PROJECT_ROOT, "registry.json"), to: path.join(store.DATA_DIR, "registry.json") },
    { from: path.join(store.PROJECT_ROOT, ".env.example"), to: path.join(store.DATA_DIR, ".env") },
  ];
  for (const { from, to } of seeds) {
    if (!fs.existsSync(to) && fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      console.log(`📄 Created editable ${path.basename(to)} at ${to} — edit it there.`);
    }
  }
}

// ---------- the server ----------
export async function startServer({ port = 8484, schedule = true } = {}) {
  captureConsole();
  seedDataDir();
  try {
    const r = syncRegistryFromSeed();
    console.log(`🗂️  Registry synced: ${r.entities} entities, ${r.channels} channels`);
  } catch (err) {
    console.log(`⚠️  Registry sync skipped: ${err.message}`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }

      // static assets (public — load on the login page too). Whitelisted: the brand
      // logo + the vendored uPlot charting lib + our chart renderer.
      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const ASSETS = {
          "isa-logo-main.png": "image/png",
          "uPlot.min.css": "text/css; charset=utf-8",
          "uPlot.iife.min.js": "text/javascript; charset=utf-8",
          "bbcharts.js": "text/javascript; charset=utf-8",
        };
        const name = url.pathname.slice("/assets/".length);
        const ctype = ASSETS[name];
        if (!ctype) {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
          return;
        }
        try {
          const buf = fs.readFileSync(new URL("./assets/" + name, import.meta.url));
          res.writeHead(200, { "content-type": ctype, "cache-control": "public, max-age=86400" });
          res.end(buf);
        } catch {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        }
        return;
      }

      if (!checkAuth(req, res)) return;

      // ----- pages -----
      if (req.method === "GET" && url.pathname === "/") {
        const q = url.searchParams.get("q");
        let search = null;
        if (q) {
          try {
            search = { q, result: await answerQuery(q, process.env) };
          } catch (err) {
            search = { q, error: err.message };
          }
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief", homeBody(url.searchParams.get("notice"), url.searchParams.get("open"), search)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/items") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · laws, rules & decisions", itemsBody(url.searchParams, url.searchParams.get("notice"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/news") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · news", newsBody(url.searchParams.get("notice"))));
        return;
      }

      if (req.method === "POST" && url.pathname === "/market-cards") {
        let notice;
        try {
          const c = await generateMarketCards(process.env);
          notice = c ? `Market cards updated (${c.triggers.length} active trigger${c.triggers.length === 1 ? "" : "s"}).` : "No active triggers or imminent reports today.";
        } catch (err) {
          notice = `Card generation failed: ${err.message}`;
        }
        redirect(res, `/markets?notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/news/digest") {
        let notice;
        try {
          const d = await generateNewsDigest(process.env);
          notice = d ? `News digest updated (${d.count} items distilled).` : "No news items in the last two days to digest yet.";
        } catch (err) {
          notice = `Digest failed: ${err.message}`;
        }
        redirect(res, `/news?notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/storylines") {
        let notice;
        try {
          const s = await generateStorylines(process.env);
          notice = s ? `Storylines updated (${s.count} active thread${s.count === 1 ? "" : "s"}).` : "Not enough recent items to cluster into storylines yet.";
        } catch (err) {
          notice = `Storyline update failed: ${err.message}`;
        }
        redirect(res, `/?notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/markets") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · markets", marketsBody(url.searchParams.get("notice"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/markets/csv") {
        const category = url.searchParams.get("category");
        const series = url.searchParams.get("series");
        const metas = series ? store.listSeriesMeta().filter((m) => m.series === series) : store.listSeriesMeta(category);
        const cols = metas.map((m) => ({ label: m.label, points: store.getSeries(m.series) }));
        const periods = [...new Set(cols.flatMap((c) => c.points.map((p) => p.period)))].sort();
        const lookup = cols.map((c) => new Map(c.points.map((p) => [p.period, p.value])));
        const csvEsc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        const header = ["period", ...cols.map((c) => csvEsc(c.label))].join(",");
        const lines = periods.map((p) => [p, ...lookup.map((m) => (m.has(p) ? m.get(p) : ""))].join(","));
        const fname = (category || series || "series").replace(/[^a-z0-9_-]/gi, "_");
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fname}.csv"` });
        res.end([header, ...lines].join("\n"));
        return;
      }

      if (req.method === "GET" && url.pathname === "/search") {
        redirect(res, url.search ? `/${url.search}` : "/"); // search now lives on the homepage
        return;
      }

      if (req.method === "GET" && url.pathname === "/logs") {
        let settings;
        try {
          settings = settingsSection(loadWatchlist(), url.searchParams.get("open"));
        } catch (err) {
          settings = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
        }
        const body = `<h1>🛠 Logs &amp; Settings</h1>
          <h2>Recent activity</h2><pre class="logs">${esc(logBuffer.slice(-300).join("\n") || "(nothing yet)")}</pre>
          ${settings}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · logs & settings", body));
        return;
      }

      if (req.method === "GET" && url.pathname === "/watchlist") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · watchlist", watchlistBody(url.searchParams.get("notice"), url.searchParams.get("open"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/sources") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · sources", sourcesBody(url.searchParams.get("notice"), url.searchParams.get("open"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/registry") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · registry", registryBody(url.searchParams.get("notice"))));
        return;
      }

      if (req.method === "POST" && url.pathname === "/registry/sync") {
        let notice;
        try {
          const r = syncRegistryFromSeed();
          notice = `Synced registry.json — ${r.entities} entities, ${r.channels} channels.`;
        } catch (err) {
          notice = `Sync failed: ${err.message}`;
        }
        redirect(res, `/registry?notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/calendar.ics") {
        res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
        res.end(icsCalendar());
        return;
      }

      if (req.method === "GET" && url.pathname === "/feed.xml") {
        res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
        res.end(rssFeed(req.headers.host ?? "localhost:8484"));
        return;
      }

      // ----- briefs -----
      const briefMatch = url.pathname.match(/^\/brief\/([^/]+)(\/raw|\/teams)?$/);
      if (briefMatch) {
        const name = path.basename(decodeURIComponent(briefMatch[1]));
        const mode = briefMatch[2] ?? "";
        if (!SAFE_BRIEF_NAME.test(name)) {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
          return;
        }
        const filePath = path.join(store.DATA_DIR, "briefings", name);
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
          return;
        }
        const markdown = fs.readFileSync(filePath, "utf8");

        if (req.method === "GET" && mode === "/raw") {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          res.end(markdown);
          return;
        }
        if (req.method === "POST" && mode === "/teams") {
          let notice;
          try {
            notice = (await postToTeams(markdown, process.env))
              ? `Posted ${name} to Teams.`
              : "Teams isn't configured — add TEAMS_WEBHOOK_URL to .env and restart.";
          } catch (err) {
            notice = `⚠️ Teams post failed: ${err.message}`;
          }
          redirect(res, `/brief/${encodeURIComponent(name)}?notice=${encodeURIComponent(notice)}`);
          return;
        }
        if (req.method === "GET") {
          const notice = url.searchParams.get("notice");
          const buttons = `<div class="toolbar">
            <button class="ghost" onclick="fetch('/brief/${encodeURIComponent(name)}/raw').then(r=>r.text()).then(t=>navigator.clipboard.writeText(t)).then(()=>this.textContent='✓ copied')">📋 Copy markdown</button>
            <a href="mailto:?subject=${encodeURIComponent("ISA Policy Brief " + name.replace(".md", ""))}&body=${encodeURIComponent("Brief attached below (or read it at " + `http://${req.headers.host}/brief/${name}` + " on the office network):%0A%0A")}"><button class="ghost" type="button">✉️ Email</button></a>
            <form method="post" action="/brief/${encodeURIComponent(name)}/teams"><button class="ghost">💬 Post to Teams</button></form>
          </div>`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            page(
              name,
              `${notice ? `<div class="banner">${esc(notice)}</div>` : ""}${buttons}${markdownToHtml(markdown)}<hr><p><a href="/">← All briefs</a></p>`
            )
          );
          return;
        }
      }

      // ----- actions -----
      if (req.method === "POST" && url.pathname === "/run") {
        const form = await readForm(req);
        let edition = ["am", "pm", "auto", "weekly", "monthly", "farmer", "education", "analyst", "pulse"].includes(form.get("edition")) ? form.get("edition") : "auto";
        // The single "Run policy brief now" button posts edition="auto"; resolve it to the
        // am or pm slot by time of day so a manual run lines up with (and doesn't clobber)
        // the scheduled editions. The scheduler still fires am + pm on their own times.
        if (edition === "auto") {
          let tz = "America/Chicago";
          try { tz = loadWatchlist().briefEditions?.timezone ?? tz; } catch { /* default tz */ }
          const hh = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()));
          edition = hh >= 12 ? "pm" : "am";
        }
        // Give a fast-failing (or bouncing) run a short grace window to report itself, so we never
        // flash "run started" over a run that already failed or never started. A genuinely long run
        // loses the race and gets the optimistic notice; the run keeps going regardless of the redirect.
        const runP = triggerRun(edition)
          .then((problem) => { if (problem) console.log(`⚠️  ${problem}`); return problem; })
          .catch((err) => { console.error(err); return `${edition.toUpperCase()} run error: ${err.message}`; });
        const outcome = await Promise.race([runP, new Promise((r) => setTimeout(() => r(RUN_STILL_GOING), 400))]);
        if (outcome === RUN_STILL_GOING) {
          redirect(res, `/?notice=${encodeURIComponent(`${edition.toUpperCase()} run started — refresh in a minute or two. Problems will appear in a red banner here.`)}`);
        } else if (outcome === RUN_BUSY_MESSAGE) {
          redirect(res, `/?notice=${encodeURIComponent(outcome)}`); // explicit "already in progress" bounce
        } else {
          redirect(res, "/"); // fast finish or fast failure — the home page (incl. any red banner) reflects it
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/items/summary") {
        const form = await readForm(req);
        const uid = form.get("uid") ?? "";
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        try {
          const item = store.getItemByUid(uid);
          if (!item) {
            res.end(JSON.stringify({ ok: false, error: "Item not found." }));
            return;
          }
          let cached = store.getSummary(uid);
          const fromCache = Boolean(cached);
          if (!cached) {
            const { summary, model } = await summarizeItem(item, process.env);
            if (!summary) throw new Error("The model returned an empty summary.");
            const expiresAt = summaryExpiry(item);
            store.saveSummary(uid, summary, model, expiresAt);
            cached = { summary, model, expires_at: expiresAt };
          }
          res.end(
            JSON.stringify({
              ok: true,
              cached: fromCache,
              model: cached.model,
              expiresAt: cached.expires_at ? String(cached.expires_at).slice(0, 10) : null,
              html: markdownToHtml(cached.summary),
            })
          );
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/items/track") {
        const form = await readForm(req);
        const uid = form.get("uid") ?? "";
        const on = form.get("on") === "true";
        let ok = true;
        if (on) ok = Boolean(store.trackItem(uid));
        else store.untrackItem(uid);
        if (req.headers["x-requested-with"] === "fetch") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok, tracked: on && ok }));
          return;
        }
        const notice = on ? (ok ? "📌 Tracking — new activity will be flagged in briefs." : "Item not found.") : "Stopped tracking.";
        const back = form.get("back") || "/items";
        redirect(res, `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/items/feedback") {
        const form = await readForm(req);
        const fb = form.get("fb");
        const newState = fb === "up" || fb === "down" ? fb : null;
        const rawNote = form.get("note");
        const note = rawNote ? rawNote.slice(0, 500) : undefined; // only set when non-empty
        store.setFeedback(form.get("uid") ?? "", newState, note);
        if (req.headers["x-requested-with"] === "fetch") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, feedback: newState }));
          return;
        }
        const notice = fb ? (fb === "up" ? "👍 Noted — more like this." : "👎 Noted — the AI will be told to avoid similar items.") : "Feedback cleared.";
        const back = form.get("back") || "/items";
        redirect(res, `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/items/archive") {
        const form = await readForm(req);
        store.archiveItem(form.get("uid") ?? "", form.get("on") === "true");
        if (req.headers["x-requested-with"] === "fetch") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, archived: form.get("on") === "true" }));
          return;
        }
        const back = form.get("back") || "/items";
        redirect(res, `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(form.get("on") === "true" ? "Set aside." : "Restored.")}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/teams/test") {
        let notice;
        try {
          notice = (await postToTeams("## polibrief test card\n\nIf you can read this in your channel, Teams delivery works. 🌱", process.env))
            ? "Test card sent — check your Teams channel."
            : "Teams isn't configured — add TEAMS_WEBHOOK_URL to .env and restart the app.";
        } catch (err) {
          notice = `⚠️ Teams test failed: ${err.message}`;
        }
        redirect(res, `/logs?notice=${encodeURIComponent(notice)}&open=settings#t-settings`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/source") {
        const form = await readForm(req);
        const sourceId = form.get("sourceId") ?? "";
        const enabled = form.get("enabled") === "true";
        let notice;
        try {
          if (!adapters[sourceId]) throw new Error(`Unknown source "${sourceId}"`);
          const watchlist = loadWatchlist();
          watchlist.sources ??= {};
          watchlist.sources[sourceId] ??= { maxItemsPerRun: 20 };
          watchlist.sources[sourceId].enabled = enabled;
          saveWatchlist(watchlist);
          notice = `${adapters[sourceId].label} turned ${enabled ? "on" : "off"}. Applies from the next run.`;
        } catch (err) {
          notice = `⚠️ ${err.message}`;
        }
        redirect(res, `/sources?notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/area") {
        const form = await readForm(req);
        const action = form.get("action");
        let notice;
        let openId = "newarea";
        try {
          const watchlist = loadWatchlist();
          watchlist.focusAreas ??= [];
          const areas = watchlist.focusAreas;
          if (action === "add") {
            const label = (form.get("label") ?? "").trim();
            if (!label) throw new Error("The focus area name was empty");
            const id = slugify(label);
            if (areas.some((a) => a.id === id)) throw new Error(`A focus area like "${label}" already exists`);
            const weight = Math.min(10, Math.max(1, Number(form.get("weight") ?? 7) || 7));
            areas.push({ id, label, weight, enabled: true, terms: [], appliesTo: Object.keys(adapters) });
            saveWatchlist(watchlist);
            notice = `Created focus area "${label}" — now open it to add terms.`;
            openId = id;
          } else {
            const areaId = form.get("areaId") ?? "";
            const area = areas.find((a) => a.id === areaId);
            if (!area) throw new Error(`Unknown focus area "${areaId}"`);
            openId = areaId;
            if (action === "delete") {
              areas.splice(areas.indexOf(area), 1);
              saveWatchlist(watchlist);
              notice = `Deleted focus area "${area.label}".`;
              openId = "";
            } else if (action === "weight") {
              area.weight = Math.min(10, Math.max(1, Number(form.get("weight")) || area.weight));
              saveWatchlist(watchlist);
              notice = `"${area.label}" weight set to ${area.weight}.`;
            } else if (action === "enable" || action === "disable") {
              area.enabled = action === "enable";
              saveWatchlist(watchlist);
              notice = `"${area.label}" ${area.enabled ? "enabled" : "disabled"}. Applies from the next run.`;
            } else throw new Error("Unknown action");
          }
        } catch (err) {
          notice = `⚠️ ${err.message}`;
        }
        const anchor = /^[A-Za-z0-9_-]+$/.test(openId) ? `#t-${openId}` : "";
        redirect(res, `/watchlist?notice=${encodeURIComponent(notice)}&open=${encodeURIComponent(openId)}${anchor}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/term") {
        const form = await readForm(req);
        const action = form.get("action");
        const areaId = form.get("areaId") ?? "";
        const term = (form.get("term") ?? "").trim();
        let notice;
        try {
          const watchlist = loadWatchlist();
          const area = (watchlist.focusAreas ?? []).find((a) => a.id === areaId);
          if (!area) throw new Error(`Unknown focus area "${areaId}"`);
          if (!term) throw new Error("The term was empty");
          area.terms ??= [];
          const idx = area.terms.findIndex((t) => t.toLowerCase() === term.toLowerCase());
          if (action === "add") {
            if (idx >= 0) notice = `"${term}" is already in "${area.label}".`;
            else {
              area.terms.push(term);
              saveWatchlist(watchlist);
              notice = `Added "${term}" to "${area.label}". Applies from the next run.`;
            }
          } else if (action === "remove") {
            if (idx < 0) notice = `"${term}" wasn't found in "${area.label}".`;
            else {
              area.terms.splice(idx, 1);
              saveWatchlist(watchlist);
              notice = `Removed "${term}" from "${area.label}". Applies from the next run.`;
            }
          } else throw new Error("Unknown action");
        } catch (err) {
          notice = `⚠️ Couldn't update the focus area: ${err.message}`;
        }
        redirect(res, `/watchlist?notice=${encodeURIComponent(notice)}&open=${encodeURIComponent(areaId)}#t-${encodeURIComponent(areaId)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/area-source") {
        const form = await readForm(req);
        const areaId = form.get("areaId") ?? "";
        const sourceId = form.get("sourceId") ?? "";
        const on = form.get("on") === "true";
        let notice;
        try {
          const watchlist = loadWatchlist();
          const area = (watchlist.focusAreas ?? []).find((a) => a.id === areaId);
          if (!area) throw new Error(`Unknown focus area "${areaId}"`);
          if (!adapters[sourceId]) throw new Error(`Unknown source "${sourceId}"`);
          const all = Object.keys(adapters);
          area.appliesTo = (area.appliesTo && area.appliesTo.length ? area.appliesTo : [...all]).filter((s) => all.includes(s));
          const has = area.appliesTo.includes(sourceId);
          if (on && !has) area.appliesTo.push(sourceId);
          if (!on && has) area.appliesTo = area.appliesTo.filter((s) => s !== sourceId);
          saveWatchlist(watchlist);
          notice = `"${area.label}" ${on ? "now includes" : "no longer includes"} ${adapters[sourceId].label}. Applies from the next run.`;
        } catch (err) {
          notice = `⚠️ ${err.message}`;
        }
        redirect(res, `/watchlist?notice=${encodeURIComponent(notice)}&open=${encodeURIComponent(areaId)}#t-${encodeURIComponent(areaId)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/settings") {
        const form = await readForm(req);
        let notice;
        try {
          const watchlist = loadWatchlist();
          watchlist.briefEditions ??= {};
          const hhmm = /^\d{2}:\d{2}$/;
          if (hhmm.test(form.get("am") ?? "")) watchlist.briefEditions.am = form.get("am");
          if (hhmm.test(form.get("pm") ?? "")) watchlist.briefEditions.pm = form.get("pm");
          const day = form.get("weeklyDay");
          if (day === "off") delete watchlist.briefEditions.weekly;
          else if (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(day) && hhmm.test(form.get("weeklyTime") ?? "")) {
            watchlist.briefEditions.weekly = `${day} ${form.get("weeklyTime")}`;
          }
          watchlist.output ??= {};
          for (const key of ["minLocalScoreForTriage", "maxItemsToTriage", "maxItemsInBrief"]) {
            const value = Number(form.get(key));
            if (Number.isFinite(value) && value >= 0) watchlist.output[key] = value;
          }
          saveWatchlist(watchlist);
          notice = "Settings saved. Schedule changes apply within a minute; thresholds from the next run.";
        } catch (err) {
          notice = `⚠️ ${err.message}`;
        }
        redirect(res, `/logs?notice=${encodeURIComponent(notice)}&open=settings#t-settings`);
        return;
      }

      // LegiScan state-list editor (Sources page). Focus-area terms use /watchlist/term.
      if (req.method === "POST" && url.pathname === "/watchlist/update") {
        const form = await readForm(req);
        const action = form.get("action");
        const value = (form.get("term") ?? "").trim().toUpperCase();
        let notice;
        try {
          if (!/^[A-Z]{2}$/.test(value)) throw new Error(`"${form.get("term")}" isn't a two-letter code like IA or US`);
          const watchlist = loadWatchlist();
          watchlist.sources ??= {};
          watchlist.sources.legiscan ??= { enabled: true, maxItemsPerRun: 40 };
          watchlist.sources.legiscan.states ??= [];
          const list = watchlist.sources.legiscan.states;
          const existingIdx = list.findIndex((s) => s.toUpperCase() === value);
          if (action === "add") {
            if (existingIdx >= 0) notice = `${value} is already in the LegiScan state list.`;
            else {
              list.push(value);
              saveWatchlist(watchlist);
              notice = `Added ${value} to the LegiScan state list. Applies from the next run.`;
            }
          } else if (action === "remove") {
            if (existingIdx < 0) notice = `${value} wasn't in the LegiScan state list.`;
            else {
              list.splice(existingIdx, 1);
              saveWatchlist(watchlist);
              notice = `Removed ${value} from the LegiScan state list. Applies from the next run.`;
            }
          } else throw new Error("Unknown action");
        } catch (err) {
          notice = `⚠️ Couldn't update the state list: ${err.message}`;
        }
        redirect(res, `/sources?notice=${encodeURIComponent(notice)}&open=states#t-states`);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (err) {
      console.error(`⚠️  web error: ${err.message}`);
      res.writeHead(500, { "content-type": "text/plain" }).end("server error");
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`\n🌐 polibrief web UI on http://localhost:${port} (reachable on your LAN / Tailscale too)`);
  });

  if (schedule) {
    startScheduler();
  } else {
    console.log("⏸  Scheduler disabled (--no-schedule) — briefs only run when you click Run.");
  }

  return server;
}

// ---------- scheduler ----------
function startScheduler() {
  // Seed "already ran" from the briefs table so a container restart mid-day
  // doesn't re-run an edition.
  const ran = new Set();
  for (const b of store.listBriefs(10)) {
    const m = path.basename(b.path).match(/^(\d{4}-\d{2}-\d{2})-(am|pm|weekly)\.md$/);
    if (m) ran.add(`${m[1]}-${m[2]}`);
  }

  const check = async () => {
    let watchlist;
    try {
      watchlist = loadWatchlist();
    } catch {
      return; // bad watchlist edits shouldn't crash the server; run/CLI will report it
    }
    // The whole tick is guarded: watchlist.json invites hand-editing, and a bad briefEditions
    // value (e.g. an invalid IANA timezone → Intl throws RangeError) must degrade to a logged,
    // skipped tick — never an unhandled rejection that would crash-loop the container.
    try {
      const editions = watchlist.briefEditions ?? {};
      const timezone = editions.timezone ?? "America/Chicago";
      const now = new Date();
      const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
      const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now); // "Fri"

      for (const edition of ["am", "pm"]) {
        const key = `${dateLabel}-${edition}`;
        if (editions[edition] && hhmm >= editions[edition] && !ran.has(key)) {
          console.log(`\n⏰ Scheduled ${edition.toUpperCase()} edition (${editions[edition]} ${timezone})`);
          const problem = await triggerRun(edition);
          // Mark the edition done only once it actually STARTED. A "busy" bounce (a manual run in
          // flight) stays eligible so a later tick picks it up once the run frees — no dropped brief.
          if (problem === RUN_BUSY_MESSAGE) console.log(`⏭️  ${edition.toUpperCase()} bounced (run in progress) — retrying next tick`);
          else { ran.add(key); if (problem) console.log(`⚠️  ${problem}`); }
        }
      }

      // Weekly memo, e.g. "Fri 17:00". Guard the type: a hand-edited non-string weekly must not throw.
      const weekly = editions.weekly;
      if (typeof weekly === "string" && weekly.trim()) {
        const [day, time] = weekly.split(/\s+/);
        const key = `${dateLabel}-weekly`;
        if (day === weekday && time && hhmm >= time && !ran.has(key)) {
          console.log(`\n⏰ Scheduled weekly memo (${weekly} ${timezone})`);
          const problem = await triggerRun("weekly");
          if (problem === RUN_BUSY_MESSAGE) console.log(`⏭️  Weekly bounced (run in progress) — retrying next tick`);
          else { ran.add(key); if (problem) console.log(`⚠️  ${problem}`); }
        }
      }

      // Nightly backup at 03:15 local.
      const backupKey = `${dateLabel}-backup`;
      if (hhmm >= "03:15" && !ran.has(backupKey)) {
        ran.add(backupKey);
        try {
          const dir = await store.backupNow();
          console.log(`💾 Nightly backup saved to ${dir} (newest 14 kept)`);
        } catch (err) {
          console.log(`⚠️  Backup failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.log(`⚠️  Scheduler tick skipped — check briefEditions in watchlist.json (${err.message})`);
    }
  };

  // .catch on the tick as a final backstop — setInterval swallows nothing, so an unguarded throw
  // inside an async tick would otherwise become a process-killing unhandled rejection.
  setInterval(() => { check().catch((err) => console.log(`⚠️  Scheduler tick error: ${err.message}`)); }, 30_000);
  console.log("⏰ Scheduler active — am/pm briefs, weekly memo, and a nightly 03:15 backup (times from watchlist.json).");
}
