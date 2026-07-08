// adapters/index.js — the adapter registry.
//
// Every data source implements the same interface:
//
//   export const id = "my_source";            // matches a key in watchlist.json "sources"
//   export const label = "My Source";         // human-friendly name for console output
//   export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
//     // returns Array<Item> — see README "Adding a Future Source" for the Item shape
//   }
//
// Adding a future source = add one file in this folder, then register it below.
// No other code changes needed; enable/disable and budgets live in watchlist.json.
//
// Deferred candidates (probed 2026-07-04, no machine-readable surface found):
//   - OIRA/reginfo.gov (rules under OMB review): JSP pages only, no API/RSS.
//   - Iowa Utilities Commission EFS (CO2 pipeline dockets): JavaScript-rendered
//     app, no server-side HTML. Revisit if either publishes an API.

import * as federal_register from "./federal_register.js";
import * as congress_gov from "./congress_gov.js";
import * as legiscan from "./legiscan.js";
import * as eurlex_oj from "./eurlex_oj.js";
import * as iowa_admin_rules from "./iowa_admin_rules.js";
import * as regulations_gov from "./regulations_gov.js";
import * as courtlistener from "./courtlistener.js";
import * as rss from "./rss.js";
import * as email_intake from "./email_intake.js";
import * as usda_nass from "./usda_nass.js";
import * as eia from "./eia.js";
import * as cftc from "./cftc.js";
import * as open_meteo from "./open_meteo.js";
import * as usda_ams from "./usda_ams.js";
import * as agtransport from "./agtransport.js";
import * as drought_monitor from "./drought_monitor.js";
import * as ibge_brazil from "./ibge_brazil.js";
import * as fred from "./fred.js";
import * as wasde from "./wasde.js";
import * as barchart from "./barchart.js";

export const adapters = {
  [federal_register.id]: federal_register,
  [congress_gov.id]: congress_gov,
  [legiscan.id]: legiscan,
  [eurlex_oj.id]: eurlex_oj,
  [iowa_admin_rules.id]: iowa_admin_rules,
  [regulations_gov.id]: regulations_gov,
  [courtlistener.id]: courtlistener,
  // v2 entity-driven sources (registry channels / collector inbox, not topic queries):
  [rss.id]: rss,
  [email_intake.id]: email_intake,
  // demand-side (Markets tab): market data, not topic queries:
  [usda_nass.id]: usda_nass,
  [eia.id]: eia,
  [cftc.id]: cftc,
  [open_meteo.id]: open_meteo,
  [usda_ams.id]: usda_ams,
  [agtransport.id]: agtransport,
  [drought_monitor.id]: drought_monitor,
  [ibge_brazil.id]: ibge_brazil,
  [fred.id]: fred,
  [wasde.id]: wasde,
  [barchart.id]: barchart,
};

// Information CLASS per source — decides which portal tab an item surfaces on, and
// keeps the newsletter/market firehose out of the clean regulatory flow:
//   official = rules, bills, dockets, court, admin rules → Items tab + the policy brief
//   news     = collector newsletters + legislator press  → News tab + daily digest (NOT the policy brief)
//   markets  = demand-side data (exports, supply, biofuel feedstock) → Markets tab (NOT the policy brief)
// Sources default to "official" if unlisted.
export const SOURCE_CLASS = {
  federal_register: "official",
  congress_gov: "official",
  legiscan: "official",
  eurlex_oj: "official",
  iowa_admin_rules: "official",
  regulations_gov: "official",
  courtlistener: "official",
  rss: "news",
  email_intake: "news",
  // demand-side → "markets"
  fas_export_sales: "markets",
  usda_nass: "markets",
  eia: "markets",
  cftc: "markets",
  usda_ams: "markets",
  open_meteo: "markets",
  agtransport: "markets",
  drought_monitor: "markets",
  ibge_brazil: "markets",
  fred: "markets",
  wasde: "markets",
  barchart: "markets",
};
export const classOf = (sourceId) => SOURCE_CLASS[sourceId] ?? "official";
export const sourceIdsForClass = (cls) => Object.keys(SOURCE_CLASS).filter((s) => SOURCE_CLASS[s] === cls);
