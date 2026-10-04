#!/usr/bin/env node
// scripts/audit-freshness.mjs — READ-ONLY freshness audit for The Bean Brief (CLI).
//
// The audit itself lives in src/health.js (shared with the in-app /freshness page). See that file's
// header for what it reports and how read-only is guaranteed.
//
// Usage (on the Pi, inside the app container — the DB lives on the /data volume):
//   docker exec isa-polibrief_web_1 node scripts/audit-freshness.mjs
//   docker exec isa-polibrief_web_1 node scripts/audit-freshness.mjs --json > audit.json
// Optional: --log <file> to mine a captured `docker logs` for the last error per source/panel.
// Flags: --db <path> · --data-dir <dir> · --log <file> · --json · --now <ISO>

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT, auditFreshness, envPresence, renderMarkdown, readJson } from "../src/health.js";

export * from "../src/health.js";

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--json") a.json = true;
    else if (k === "--db") a.db = argv[++i];
    else if (k === "--data-dir") a.dataDir = argv[++i];
    else if (k === "--log") a.log = argv[++i];
    else if (k === "--now") a.now = argv[++i];
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("usage: node scripts/audit-freshness.mjs [--db <path>] [--data-dir <dir>] [--log <file>] [--json] [--now <ISO>]");
    return 0;
  }
  const dataDir = path.resolve(args.dataDir ?? process.env.POLIBRIEF_DATA_DIR ?? PROJECT_ROOT);
  const dbPath = path.resolve(args.db ?? path.join(dataDir, "polibrief.db"));
  const { default: Database } = await import("better-sqlite3");
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`audit-freshness: cannot open ${dbPath} read-only: ${err.message}`);
    return 2;
  }
  const liveWatchlistPath = [path.join(dataDir, "watchlist.json"), path.join(PROJECT_ROOT, "watchlist.json")].find((p) => fs.existsSync(p));
  const watchlist = liveWatchlistPath ? readJson(liveWatchlistPath) : null;
  const defaultWatchlist = readJson(path.join(PROJECT_ROOT, "watchlist.json"));
  const envPresent = envPresence([path.join(PROJECT_ROOT, ".env"), path.join(dataDir, ".env")]);
  let logText = "";
  const logCandidates = [args.log, path.join(dataDir, "logs", "cron.log"), path.join(PROJECT_ROOT, "logs", "cron.log")].filter(Boolean);
  for (const f of logCandidates) {
    try {
      logText = fs.readFileSync(f, "utf8");
      break;
    } catch {
      /* try the next */
    }
  }
  try {
    const report = auditFreshness({
      db,
      watchlist,
      defaultWatchlist: liveWatchlistPath === path.join(PROJECT_ROOT, "watchlist.json") ? null : defaultWatchlist,
      envPresent,
      dataDir,
      now: args.now ? new Date(args.now) : new Date(),
      logText,
    });
    process.stdout.write(args.json ? JSON.stringify(report, null, 2) + "\n" : renderMarkdown(report) + "\n");
  } finally {
    db.close();
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code ?? 0));
}
