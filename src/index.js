#!/usr/bin/env node
// index.js — polibrief command line.
//
//   node src/index.js run --edition am        full pipeline: fetch → score → triage → brief → deliver
//   node src/index.js run --dry-run           fetch + score only, prints a table, NO Anthropic calls
//   node src/index.js run --source legiscan   restrict to one source (testing)
//   node src/index.js dry-run --source X      shorthand for run --dry-run --source X
//   node src/index.js query "45Z guidance"    ask across stored items + market data + briefs
//   node src/index.js audit                   per-source stats + Anthropic token usage this month
//   node src/index.js serve                   web UI for reading briefs + built-in am/pm scheduler

import { Command } from "commander";
import dotenv from "dotenv";
import path from "node:path";

import { PROJECT_ROOT, DATA_DIR } from "./store.js";

// Prefer the data-volume .env (Docker/Umbrel); fall back to the project root.
dotenv.config({ path: [path.join(DATA_DIR, ".env"), path.join(PROJECT_ROOT, ".env")], quiet: true });

const program = new Command();
program.name("polibrief").description("Policy intelligence briefings for Iowa soybean priorities");

program
  .command("run")
  .description("Run the pipeline")
  .option("--edition <edition>", "am or pm", "am")
  .option("--dry-run", "fetch + score only; print a table; no Anthropic calls")
  .option("--source <sourceId>", "restrict to a single source (testing)")
  .action(async (opts) => {
    const { runPipeline } = await import("./pipeline.js");
    await runPipeline({ edition: opts.edition, dryRun: Boolean(opts.dryRun), source: opts.source ?? null });
  });

program
  .command("dry-run")
  .description("Shorthand for: run --dry-run")
  .option("--source <sourceId>", "restrict to a single source (testing)")
  .action(async (opts) => {
    const { runPipeline } = await import("./pipeline.js");
    await runPipeline({ dryRun: true, source: opts.source ?? null });
  });

program
  .command("weekly")
  .description("Generate the weekly memo (shorthand for: memo weekly)")
  .action(async () => {
    const { runWeekly } = await import("./pipeline.js");
    await runWeekly(process.env);
  });

program
  .command("memo <preset>")
  .description("Generate an on-demand memo across all streams: weekly | monthly | education | analyst")
  .action(async (preset) => {
    const { runMemo } = await import("./pipeline.js");
    await runMemo(preset, process.env);
  });

program
  .command("query <question>")
  .description("Ask across stored items (laws/rules + news), market data, and recent briefs")
  .action(async (question) => {
    const { runQuery } = await import("./pipeline.js");
    await runQuery(question, process.env);
  });

program
  .command("audit")
  .description("Per-source stats, last-success times, and Anthropic token usage this month")
  .action(async () => {
    const { runAudit } = await import("./pipeline.js");
    await runAudit();
  });

program
  .command("serve")
  .description("Start the web UI (brief reader) with the built-in am/pm scheduler")
  .option("--port <port>", "port to listen on", process.env.PORT ?? "8484")
  .option("--no-schedule", "serve the UI only; don't run the pipeline on the am/pm schedule")
  .action(async (opts) => {
    const { startServer } = await import("./server.js");
    await startServer({ port: Number(opts.port), schedule: opts.schedule });
  });

// ----- v2 Entity Registry -----
program
  .command("registry-sync")
  .description("Sync registry.json (the hand-seed) into the database (idempotent)")
  .action(async () => {
    const { syncRegistryFromSeed } = await import("./registry.js");
    const r = syncRegistryFromSeed();
    console.log(`🗂️  Synced ${r.entities} entities, ${r.channels} channels from registry.json`);
  });

program
  .command("market-refresh")
  .description("Refresh market timeseries (Markets charts) from adapters with fetchSeries")
  .action(async () => {
    const { refreshMarketSeries, runAlertsCheck } = await import("./pipeline.js");
    const n = await refreshMarketSeries(process.env);
    console.log(`📈 Refreshed ${n} market series.`);
    await runAlertsCheck(process.env);
  });

program
  .command("expectations")
  .description("Show pre-report consensus on file and past releases scored as surprises")
  .option("--scan", "First mine recent news bodies for pre-report trade estimates")
  .option("--settle", "Join any open expectations to their published actual and score the surprise")
  .action(async (opts) => {
    const { extractExpectations, computeSurprises, surpriseText } = await import("./pipeline.js");
    const store = await import("./store.js");
    if (opts.scan) {
      const r = await extractExpectations(process.env);
      console.log(`   scanned ${r.scanned} news bodies, filed ${r.stored} estimates\n`);
      if (!r.stored) {
        console.log("   NOTE: no trade-survey language found. This is the open question about this feature —");
        console.log("   the collector inbox may simply not carry pre-report analyst surveys. If this keeps");
        console.log("   returning 0 on the Pi, the fix is a subscription that does (or entering the figure");
        console.log("   directly), not more prompt tuning — the extraction works, the source may be absent.\n");
      }
    }
    if (opts.settle) {
      const s = computeSurprises();
      console.log(`   settled ${s.settled}\n`);
    }
    const rows = store.listExpectations({ limit: 30 });
    if (!rows.length) {
      console.log("🎯 No expectations on file yet. Try: node src/index.js expectations --scan");
      return;
    }
    console.log("🎯 Report expectations");
    for (const e of rows) {
      const tag = e.resolved_at ? "✓" : "…";
      console.log(`   ${tag} ${e.report} · ${e.item}`);
      console.log(`      consensus ${e.est_avg}${e.est_low != null ? ` (${e.est_low}–${e.est_high})` : ""} ${e.unit ?? ""}${e.source ? `  [${e.source}]` : ""}`);
      if (e.resolved_at) console.log(`      actual ${e.actual_value} @ ${e.actual_period} → surprise ${e.surprise > 0 ? "+" : ""}${Number(e.surprise).toFixed(2)}${e.surprise_sigma != null ? ` (${Number(e.surprise_sigma).toFixed(1)}× range)` : ""}`);
    }
    const txt = surpriseText();
    if (txt) console.log(`\n   --- as injected into prompts ---\n${txt.split("\n").map((l) => "   " + l).join("\n")}`);
  });

program
  .command("forecasts")
  .description("Show the forecast ledger — this tool's own past calls and how they scored")
  .option("--resolve", "First judge any forecasts whose horizon has elapsed")
  .action(async (opts) => {
    const { resolveForecasts, forecastTrackRecordText } = await import("./pipeline.js");
    const store = await import("./store.js");
    if (opts.resolve) {
      const r = resolveForecasts();
      console.log(`🔮 Resolved ${r.judged + r.unresolvable}: ${r.hit} hit / ${r.miss} miss / ${r.unresolvable} unresolvable\n`);
    }
    const card = store.forecastScorecard();
    console.log("📊 Forecast scorecard");
    console.log(`   judged ${card.judged}  (hit ${card.hit} / miss ${card.miss})${card.hitRate != null ? `  → ${Math.round(card.hitRate * 100)}% hit rate` : ""}`);
    console.log(`   pending ${card.pending}   unresolvable ${card.unresolvable}`);
    if (card.judged < 5) console.log("   ⚠️  too few judged forecasts to infer skill — the ledger is still filling");
    const rows = store.listForecasts({ limit: 25 });
    if (!rows.length) {
      console.log("\n   (ledger is empty — run an Analyst Note to start filing claims)");
      return;
    }
    console.log("\n   most recent claims:");
    for (const r of rows) {
      const tag = r.outcome === "pending" ? "…" : r.outcome === "hit" ? "✓" : r.outcome === "miss" ? "✗" : "–";
      console.log(`   ${tag} [${String(r.created_at).slice(0, 10)}] ${r.direction ?? "?"} ${r.series ?? "(no series)"} by ${r.resolve_by ?? "?"}`);
      console.log(`      ${String(r.claim).slice(0, 150)}`);
      if (r.resolution_note) console.log(`      → ${r.resolution_note}`);
    }
    const txt = forecastTrackRecordText();
    if (txt) console.log(`\n   --- as injected into prompts ---\n${txt.split("\n").map((l) => "   " + l).join("\n")}`);
  });

program
  .command("news-digest")
  .description("Generate the News-of-the-day digest from the last two days of news items")
  .action(async () => {
    const { generateNewsDigest, extractMarketIntel } = await import("./pipeline.js");
    const d = await generateNewsDigest(process.env);
    console.log(d ? `🧠 News digest updated (${d.count} items).` : "   (no news items in the last two days)");
    const intel = await extractMarketIntel(process.env).catch((e) => { console.log(`   ⚠️ market intel skipped: ${e.message}`); return null; });
    if (intel) console.log(`📈 Market intel refreshed (${intel.count} items with content).`);
  });

program
  .command("market-intel")
  .description("Distil market intelligence from recent newsletter bodies into the shared intel block (feeds Analyst/Pulse/Ask)")
  .action(async () => {
    const { extractMarketIntel } = await import("./pipeline.js");
    const intel = await extractMarketIntel(process.env);
    console.log(intel ? `📈 Market intel refreshed (${intel.count} items).\n\n${intel.markdown}` : "   (no news bodies in the last few days to mine)");
  });

program
  .command("market-cards")
  .description("Generate the internal market signal cards from the active condition triggers")
  .action(async () => {
    const { generateMarketCards } = await import("./pipeline.js");
    const c = await generateMarketCards(process.env);
    console.log(c ? `🌱 Market cards updated (${c.triggers.length} triggers${c.flags.length ? `, ${c.flags.length} compliance flags` : ""}).` : "   (no active triggers or reports today)");
  });

program
  .command("storylines")
  .description("Cluster recent relevant items into named, persistent storyline threads")
  .action(async () => {
    const { generateStorylines } = await import("./pipeline.js");
    const s = await generateStorylines(process.env);
    console.log(s ? `🧵 Storylines updated (${s.count} active thread${s.count === 1 ? "" : "s"}).` : "   (not enough recent items to cluster yet)");
  });

program
  .command("alerts-check")
  .description("Detect material market changes since last check → the 'what changed' feed")
  .action(async () => {
    const { runAlertsCheck } = await import("./pipeline.js");
    const changes = await runAlertsCheck(process.env);
    if (!changes.length) console.log("   (no material changes since last check)");
  });

program
  .command("data-health")
  .description("List market series whose latest data point is overdue vs. its cadence")
  .action(async () => {
    const store = await import("./store.js");
    const rows = store.seriesFreshness();
    const stale = rows.filter((r) => r.stale);
    console.log(`\n📊 Data health: ${rows.length} series, ${stale.length} overdue\n`);
    for (const r of rows) {
      console.log(`   ${r.stale ? "🟠" : "🟢"} ${r.label.padEnd(34)} last ${r.latest} (${String(r.ageDays).padStart(4)}d, ~${r.cadenceDays}d cadence)`);
    }
    console.log();
  });

program
  .command("seed-curriculum")
  .description("Load the education-engine concept bank + glossary into SQLite (idempotent)")
  .action(async () => {
    const { seedCurriculum } = await import("./curriculum.js");
    const r = seedCurriculum();
    console.log(`📚 Seeded ${r.concepts} concepts + ${r.terms} glossary terms.`);
  });

program
  .command("registry-seed <source>")
  .description("Run one registry seeder: openstates | fec | socrata")
  .action(async (source) => {
    const { runSeed } = await import("./seed/index.js");
    const r = await runSeed(source, { env: process.env });
    console.log(`🌱 ${source}: ${JSON.stringify(r)}`);
  });

program
  .command("registry-refresh")
  .description("Sync the hand-seed + run every seeder whose API key is set (fail-soft)")
  .action(async () => {
    const { refreshRegistry } = await import("./seed/index.js");
    const r = await refreshRegistry({ env: process.env });
    console.log("\n✅ Registry refresh:");
    for (const x of r.ran) console.log(`   ✓ ${x.id}: ${JSON.stringify(x)}`);
    for (const x of r.skipped) console.log(`   ⚠️  ${x.id} skipped — ${x.reason}`);
    console.log();
  });

program
  .command("registry-health")
  .description("List registry channels that never fetched or are stale (silent-failure guard)")
  .option("--days <n>", "staleness threshold in days", "10")
  .action(async (opts) => {
    const store = await import("./store.js");
    const stale = store.staleChannels(Number(opts.days));
    console.log(`\n🩺 ${stale.length} channel(s) never fetched or stale >${opts.days}d:`);
    for (const c of stale) {
      const e = store.getEntity(c.entity_id);
      console.log(`   ${(e?.full_name ?? c.entity_id).padEnd(28)} ${c.kind.padEnd(16)} ${(c.last_error ?? "").slice(0, 50)}`);
    }
    console.log();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n❌ ${err.message}`);
  if (process.env.POLIBRIEF_DEBUG) console.error(err.stack);
  else console.error("   (set POLIBRIEF_DEBUG=1 for the full technical details)");
  process.exit(1);
});
