// snapshot-harness.js — the byte-identical proof for the multi-state migration (docs/MULTI_STATE.md §13).
//
// Seeds a synthetic store (Q8 of the design: synthetic until an anonymized Pi copy is approved), freezes
// the clock, stubs the model, then captures EVERYTHING the deployment's state shows up in:
//   - every model prompt (system + user turn) for the scheduled outputs and the Member Brief
//   - the rendered Member Brief, the signal/crush/balance/weather text blocks, the Studio catalog
//   - the HTML of the main pages, with only non-deterministic fragments scrubbed
// Each pack step of the migration must leave the Iowa artifacts byte-identical.
//
// The caller sets process.env (DATA_DIR, STATE_PACK…) and mocks Date BEFORE importing this module.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { sseBody } from "./sse.js";

export async function captureState({ stateKey = "ia" } = {}) {
  const store = await import("../../src/store.js");
  const pipeline = await import("../../src/pipeline.js");
  const { triageItems } = await import("../../src/triage.js");
  const { rankNewsItems } = await import("../../src/newsrank.js");
  const { generateBrief } = await import("../../src/brief.js");
  const { runMemberBrief } = await import("../../src/memberbrief.js");
  const { signalsText } = await import("../../src/signals.js");
  const { crushText } = await import("../../src/crush.js");
  const { balanceSheetText } = await import("../../src/balancesheet.js");
  const { weatherRiskText } = await import("../../src/weather.js");
  const { studioCatalog } = await import("../../src/studio.js");
  const { syncRegistryFromSeed } = await import("../../src/registry.js");
  const { claimDataDir } = await import("../../src/setup.js");
  const { pack } = await import("../../src/pack.js");

  claimDataDir(store.DATA_DIR, pack().id); // as the app does at startup
  seed(store, stateKey);
  {
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(store.DB_PATH);
    for (const [k, at] of CARD_BACKDATE.splice(0)) raw.prepare("UPDATE policy_cards SET created_at = ? WHERE event_key = ?").run(at, k);
    raw.close();
  }
  try {
    syncRegistryFromSeed();
  } catch {
    /* registry is optional for a pack */
  }

  // ---- stub the model, capture every request ----
  const prompts = [];
  let label = "";
  const original = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    prompts.push({ label, model: body.model, system: body.system ?? null, messages: body.messages, output_config: body.output_config ?? null, thinking: body.thinking ?? null, max_tokens: body.max_tokens });
    const sys = JSON.stringify(body.system ?? "");
    let text = "stub";
    if (body.output_config?.format) {
      const props = Object.keys(body.output_config.format.schema?.properties ?? {});
      if (props.includes("update")) {
        // Like a real draft: all four sentences for every policy item in the packet (a draft that drops
        // one fails closed), each citing that item's own sources.
        const shown = body.messages[0].content.map((c) => c.text).join("\n");
        const policy = [...shown.matchAll(/^(P\d+) — band: .* — sources: (S\d+(?:, S\d+)*)$/gm)].map(([, id, src]) => {
          const cites = src.split(", ");
          return {
            id,
            whatChanged: { text: "The agency acted on this item.", cites },
            whereItStands: { text: "It is at the stage its band shows.", cites },
            whatItMeans: { text: "It bears on soybean demand.", cites },
            next: { text: "The next step is not yet scheduled.", cites },
          };
        });
        text = JSON.stringify({ update: [{ text: "Policy activity continued this week.", cites: ["S1"] }], policy, markets: { fund: [], oilShare: [], ratio: [], barge: [] } });
      }
      else if (props.includes("sentences")) {
        // Like a real reviewer: one "keep" per sentence and band it was shown (an empty review fails closed).
        const shown = body.messages[0].content.map((c) => c.text).join("\n");
        const [, sents = "", bands = ""] = shown.match(/DRAFT SENTENCES TO REVIEW[^\n]*\n([\s\S]*?)\n\nPOLICY ITEM BANDS:\n([\s\S]*)$/) ?? [];
        const ids = (block, sep) => block.split("\n").map((l) => l.split(sep)[0]).filter((s) => s && s !== "(none)");
        text = JSON.stringify({
          sentences: ids(sents, " ").map((sid) => ({ sid, action: "keep", reason: "" })),
          bands: ids(bands, ":").map((id) => ({ id, action: "keep", to: "", reason: "" })),
        });
      }
      else text = JSON.stringify(Object.fromEntries(props.map((p) => [p, []])));
    } else if (/triage|relevan/i.test(sys)) text = "[]";
    if (body.stream) return new Response(sseBody({ text, model: body.model }), { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const run = async (name, fn) => {
    label = name;
    try {
      await fn();
    } catch {
      /* a stubbed failure still captured the prompt */
    }
  };
  const env = process.env;
  const watchlist = pipeline.loadWatchlist();
  const official = store.listItems({ days: 30, sourceIds: ["federal_register", "legiscan", "iowa_admin_rules", "regulations_gov"] }).map(asItem);
  const news = store.listItems({ days: 30, sourceIds: ["rss"] }).map(asItem);
  await run("news_digest", () => pipeline.generateNewsDigest(env));
  await run("market_intel", () => pipeline.extractMarketIntel(env));
  await run("market_cards", () => pipeline.generateMarketCards(env));
  await run("storylines", () => pipeline.generateStorylines(env));
  await run("expectations", () => pipeline.extractExpectations(env));
  await run("brief", () => generateBrief({ relevantItems: official, watchlist, edition: "am", env, stats: { fetchedCount: 4, sourceCount: 8, skippedSources: [] } }));
  await run("ask", () => pipeline.answerQuery("What is happening with the RFS?", env, "cli"));
  await run("memo_weekly", () => pipeline.generateMemo("weekly", env));
  await run("memo_education", () => pipeline.generateMemo("education", env));
  // Last: their stubbed replies rewrite item verdicts, which would change what the generators above see.
  await run("triage", () => triageItems(official, watchlist.topics, env));
  await run("newsrank", () => rankNewsItems(news, watchlist.topics, env, { log: () => {} }));
  let member = "";
  await run("member", async () => {
    const r = await runMemberBrief({ env, watchlist, preview: true, log: () => {} });
    member = fs.readFileSync(r.path, "utf8");
  });
  // ---- adapter requests: every URL each state-dependent adapter asks for (protects the markets/legislature
  // config migration, which network-free prompt capture can't see). Empty replies; the URLs are the artifact.
  const adapterUrls = {};
  const ADAPTERS = ["usda_nass", "usda_ams", "drought_monitor", "cropcasma", "vegscape", "open_meteo", "legiscan", "barchart", "fas_export_sales", "agtransport", "cftc", "iowa_admin_rules"];
  const keys = { NASS_API_KEY: "k", USDA_AMS_API_KEY: "k", LEGISCAN_API_KEY: "k", BARCHART_API_KEY: "k", FAS_API_KEY: "k" };
  const { adapters: registered } = await import("../../src/adapters/index.js");
  for (const id of ADAPTERS) {
    const mod = registered[id]; // a state-specific adapter is absent under another state's pack
    if (!mod) continue;
    const urls = [];
    globalThis.fetch = async (u) => {
      urls.push(String(u).replace(/([?&](key|api_key|apikey|token)=)[^&]+/gi, "$1K"));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const cfg = { ...(watchlist.sources?.[id] ?? {}), enabled: true };
    for (const fn of ["fetchSeries", "fetchItems"]) {
      if (typeof mod[fn] !== "function") continue;
      try {
        await mod[fn]({ env: { ...env, ...keys }, sourceConfig: cfg, topics: watchlist.topics, sinceISO: "2026-10-01T00:00:00.000Z", channels: [] });
      } catch {
        /* empty replies may throw — the URLs are already recorded */
      }
    }
    adapterUrls[id] = [...new Set(urls)].sort();
  }
  globalThis.fetch = original;

  // ---- deterministic text blocks ----
  const blocks = {};
  for (const [k, f] of Object.entries({ signals: signalsText, crush: crushText, balance: balanceSheetText, weather: weatherRiskText })) {
    try {
      blocks[k] = f();
    } catch (err) {
      blocks[k] = `ERROR ${err.message}`;
    }
  }
  blocks.studio = JSON.stringify(studioCatalog(), null, 1);

  // ---- server pages ----
  const { startServer } = await import("../../src/server.js");
  const server = await startServer({ port: 0, schedule: false });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const port = server.address().port;
  const pages = {};
  for (const p of ["/", "/markets", "/news", "/items", "/sources", "/map", "/watchlist", "/registry", "/studio"]) pages[p] = scrub(await get(port, p));
  await new Promise((r) => server.close(r));

  blocks["adapter-urls"] = JSON.stringify(adapterUrls, null, 1);
  return { prompts: prompts.map(scrubPrompt), member: scrub(member), blocks, pages };
}

function asItem(r) {
  return { uid: r.uid, sourceId: r.source_id, sourceLabel: r.source_id, title: r.title, summary: r.body ?? "", url: r.url, publishedAt: r.published_at, jurisdiction: r.jurisdiction, docType: r.doc_type, raw: { eventKey: r.event_key, commentsCloseOn: r.comment_deadline }, oneLine: r.one_line, tier: r.triage_tier };
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(`${res.statusCode}\n${d}`));
    }).on("error", reject);
  });
}

// Only fragments that change between identical runs or releases are scrubbed: asset cache-busters, the
// app version, and temp paths.
export function scrub(s) {
  return String(s ?? "")
    .replace(/\?v=[a-z0-9.]+/g, "?v=X") // the asset cache-buster is the app version — not state output
    .replace(/\b1\.\d{2}\.\d+\b/g, "VERSION")
    .replace(/\/tmp\/[^\s"'<>)]+/g, "/TMP");
}
function scrubPrompt(p) {
  return JSON.parse(scrub(JSON.stringify(p)));
}

// ---- the synthetic store ----
const CARD_BACKDATE = [];
function seed(store, st) {
  const S = st.toUpperCase();
  const mk = (uid, sourceId, title, body, url, extra = {}, verdict = { relevant: true, topicIds: ["biofuels-infrastructure"], oneLine: `Why ${title} matters.`, tier: "must_read" }) =>
    store.markSeen({ uid, sourceId, title, summary: body, url, publishedAt: "2026-10-06T00:00:00Z", jurisdiction: extra.jurisdiction ?? "US", docType: extra.docType ?? "notice", raw: { commentsCloseOn: extra.deadline } }, verdict);
  mk("fr-1", "federal_register", "Renewable Fuel Standard: 2027-2028 volumes (proposed rule)", "EPA proposes RVOs for biomass-based diesel. Comments due Nov. 17, 2026.", "https://www.federalregister.gov/d/2026-20001", { deadline: "2026-11-17", docType: "proposed-rule" });
  mk("fr-2", "federal_register", "Clean fuel production credit guidance", "Treasury notice on 45Z emissions rates.", "https://www.federalregister.gov/d/2026-20002");
  mk(`ls-${st}-1`, "legiscan", `${S} SF 101: Carbon pipeline eminent domain`, "Senate file on eminent domain for CO2 pipelines.", `https://legiscan.com/${S}/bill/SF101/2026`, { jurisdiction: S, docType: "bill" });
  mk("adm-1", st === "ia" ? "iowa_admin_rules" : "federal_register", "Nutrient management rule amendment", "Agency amends nutrient rules.", "https://example.gov/rule/1", { jurisdiction: S, docType: "admin-rule" });
  mk("rss-1", "rss", "Soybean crush margins widen on renewable diesel demand", "Crush margins widened this week as soybean oil rallied on renewable diesel demand. Board crush rose. Analysts surveyed ahead of the October WASDE expect U.S. soybean ending stocks of 350 million bushels, in a range of 300 to 400 million.", "https://www.agweb.com/a1", { docType: "statement", jurisdiction: S }, null);
  mk("rss-2", "rss", "China books U.S. soybean cargoes", "Exporters reported sales to China for new-crop delivery, the first large Chinese purchase of the marketing year, according to USDA's daily reporting system, with more cargoes expected.", "https://www.farmprogress.com/a2", { docType: "statement", jurisdiction: S }, null);
  store.recordAlert("signal", "Fund positioning flipped bullish", "managed money crossed the 80th percentile");
  store.upsertStoryline({ key: "rfs-volumes", name: "RFS volumes", focus: "EPA RVOs", summary: "EPA proposed volumes.", timeline: [{ date: "2026-10-06", event: "Proposal", url: "" }], materiality: "decision_changing", state: "advanced" });
  store.setState("news_digest", JSON.stringify({ date: "2026-10-07", markdown: "### Crush\nMargins widened.", createdAt: "2026-10-07T11:00:00.000Z", count: 2 }));
  store.setState("market_cards", JSON.stringify({ date: "2026-10-07", markdown: "### Funds\nPositioning is high.", createdAt: "2026-10-07T11:00:00.000Z", triggers: [] }));
  store.insertPolicyCard({
    eventKey: "fr:2026-20001",
    leadUid: "fr-1",
    edition: "am",
    certainty: "proposed",
    status: "kept",
    card: {
      headline: "EPA proposes 2027-28 RFS volumes",
      what_changed: "EPA proposed volumes.",
      posture: { status: "proposed_rule", clock_date: "2026-11-17", clock_label: "comments close", detail: "Comment period open." },
      mechanism: { chain: ["a", "b"], terminal: "soy_oil_demand", weak_link: "" },
      evidence: [{ id: "item:fr-1", kind: "item", key: "fr-1", grade: "primary_source", label: "primary source", title: "RFS", url: "https://www.federalregister.gov/d/2026-20001" }],
      so_what: "More soybean oil demand.",
      watch_next: { event: "Comments close", date: "2026-11-17" },
    },
  });
  // In the Member Brief window (Mon 00:00 → Wed 00:00 CT) so the policy section is exercised.
  CARD_BACKDATE.push(["fr:2026-20001", "2026-10-06T15:00:00.000Z"]);
  const weekly = (end, n, v0, dv) => Array.from({ length: n }, (_, i) => ({ period: new Date(Date.parse(`${end}T00:00:00Z`) - (n - 1 - i) * 7 * 86400e3).toISOString().slice(0, 10), value: v0 + i * dv }));
  const monthly = (endY, endM, n, v0, dv) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(endY, endM - 1 - (n - 1 - i), 1));
    return { period: d.toISOString().slice(0, 7), value: v0 + i * dv };
  });
  const daily = (end, n, v0, dv) => Array.from({ length: n }, (_, i) => ({ period: new Date(Date.parse(`${end}T00:00:00Z`) - (n - 1 - i) * 86400e3).toISOString().slice(0, 10), value: v0 + i * dv }));
  const S_ = (k, label, unit, category, pts, family) => store.saveSeriesPoints(k, { label, unit, category, ...(family ? { family } : {}) }, pts);
  S_("cftc:soybeans:mm-net", "Managed money net position", "contracts", "positioning", weekly("2026-09-29", 120, -20000, 900));
  S_(`nass:${st}:soy-corn-ratio`, `${S} soy:corn ratio`, "ratio", "soy_corn_ratio", monthly(2026, 8, 60, 2.2, 0.005));
  S_(`nass:${st}:price`, `${S} soybean price received`, "$/bu", "soy_price", monthly(2026, 8, 60, 9, 0.02));
  S_("nass:us:price", "US soybean price received", "$/bu", "soy_price", monthly(2026, 8, 60, 9.1, 0.02));
  S_("nass:us:crush", "US soybean crush", "mln bu", "soy_crush", monthly(2026, 7, 60, 170, 0.5));
  S_("nass:us:condition", "US condition", "% G/E", "soy_condition", weekly("2026-09-27", 20, 60, 0.2));
  S_(`vegscape:${st}:vci`, `${S} VCI`, "index", "veg_condition", weekly("2026-09-28", 30, 50, 0.3));
  S_(`cropcasma:${st}:rootzone-sm`, `${S} root-zone`, "m3/m3", "soil_moisture", weekly("2026-09-28", 30, 0.3, 0.001));
  S_(`drought_monitor:${st}:d1`, `${S} D1+`, "%", "drought", weekly("2026-09-29", 60, 10, 0.1));
  S_("wasde:us:soy-stocks-to-use", "Stocks-to-use", "%", "soy_balance_stu", monthly(2026, 9, 40, 8, 0.05));
  S_("wasde:us:soy-endstocks", "Ending stocks", "mln bu", "soy_balance", monthly(2026, 9, 40, 300, 1));
  S_("agtransport:soy-net-export-sales", "Net export sales", "metric tons", "soy_exports", weekly("2026-09-24", 150, 400000, 1000));
  S_("agtransport:barge-freight:st-louis", "Barge freight — St. Louis", "$/ton", "barge_freight", weekly("2026-10-01", 160, 18, 0.05), "agtransport:barge-freight");
  S_("cbot:zm:front", "Meal", "$/ton", "soy_products", daily("2026-10-06", 200, 300, 0.1));
  S_("cbot:zl:front", "Oil", "¢/lb", "soy_products", daily("2026-10-06", 200, 45, 0.02));
  S_("cbot:zs:front", "Soybeans", "¢/bu", "soy_futures", daily("2026-10-06", 260, 1000, 0.2));
  S_("cbot:crush:board-margin", "Board crush", "$/bu", "soy_crush_margin", daily("2026-10-06", 200, 1.5, 0.002));
  S_(`ams:${st}:meal`, `${S} cash meal`, "$/ton", "soy_products_cash", weekly("2026-10-02", 60, 310, 0.5));
  S_(`ams:${st}:oil`, `${S} cash oil`, "¢/lb", "soy_products_cash", weekly("2026-10-02", 60, 48, 0.05));
  S_(`ams:${st}:basis`, `${S} basis`, "¢/bu", "soy_basis", daily("2026-10-06", 120, -40, 0.05));
  S_("open_meteo:us:precip-pctile", "US precip", "pctile", "weather_us", daily("2026-10-06", 40, 50, 0.1));
  S_("cme:zs:2026-11", "ZS Nov", "¢/bu", "soy_curve", daily("2026-10-06", 5, 1040, 2));
  S_("cme:zc:2026-12", "ZC Dec", "¢/bu", "corn_curve", daily("2026-10-06", 5, 420, 1));
}

/** Write or compare a capture against a golden directory. Returns the list of artifacts that differ. */
export function compareGolden(capture, dir, { update = false } = {}) {
  const files = {
    "member.md": capture.member,
    ...Object.fromEntries(Object.entries(capture.blocks).map(([k, v]) => [`block-${k}.txt`, v])),
    ...Object.fromEntries(Object.entries(capture.pages).map(([k, v]) => [`page${k === "/" ? "-home" : k.replace(/\//g, "-")}.html`, v])),
  };
  const byLabel = {};
  for (const p of capture.prompts) (byLabel[p.label] ??= []).push(p);
  for (const [k, v] of Object.entries(byLabel)) files[`prompt-${k}.json`] = JSON.stringify(v, null, 1);
  const diffs = [];
  if (update) fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const f = path.join(dir, name);
    if (update) fs.writeFileSync(f, content);
    else if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== content) diffs.push(name);
  }
  if (!update) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (!(f in files)) diffs.push(`${f} (missing from capture)`);
  return diffs;
}
