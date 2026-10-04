// setup.js — the first-run / state-pack check (docs/MULTI_STATE.md §10, migration step 7).
//
// One report answers "is this deployment configured for its state?": which pack is active and where the
// choice came from, the extends chain with content hashes, the local overlay and anything it could not
// apply, and a short checklist of what the pack needs to work (admin-rules adapter, geo layers, registry
// seed, the AMS cash report, the keys). Shown by `node src/index.js setup`, on /setup and as a section of
// /freshness.
//
// Store-free (like health.js and pack.js) so it runs before a database exists. Keys are reported as
// present or missing — never their values.

import fs from "node:fs";
import path from "node:path";
import { loadPack, packSpecFromEnv, resolvePack, validatePack, PROJECT_ROOT, PACKS_DIR } from "./pack.js";

const ADAPTERS_DIR = path.join(PROJECT_ROOT, "src", "adapters");

// Keys every state needs, and the ones a missing value only degrades (presence only).
const KEYS = [
  { group: "ANTHROPIC_API_KEY", need: "required", why: "every brief and panel" },
  { group: "LEGISCAN_API_KEY", need: "recommended", why: "state bills" },
  { group: "NASS_API_KEY", need: "recommended", why: "state prices received, crop condition" },
  { group: "OPENSTATES_API_KEY", need: "optional", why: "legislator registry refresh" },
  { group: "FEC_API_KEY", need: "optional", why: "federal candidate registry" },
];

/** Where the active STATE_PACK value came from. */
function specSource(dataDir, env) {
  if (env.STATE_PACK) return "STATE_PACK in the environment";
  for (const f of [path.join(dataDir, ".env"), path.join(PROJECT_ROOT, ".env")]) {
    try {
      if (/^\s*STATE_PACK\s*=/m.test(fs.readFileSync(f, "utf8"))) return `STATE_PACK in ${f}`;
    } catch {
      /* no file */
    }
  }
  return "default (no STATE_PACK set)";
}

/** Files a pack names, resolved through its extends chain (first hit wins, leaf first). */
function packFileExists(chain, rel) {
  if (!rel) return false;
  return [...chain].reverse().some((l) => fs.existsSync(path.join(l.dir, rel)));
}

/**
 * @param {{dataDir:string, env?:object, envPresent?:object, spec?:string}} opts
 * @returns {{ok:boolean, spec:string, specSource:string, pack:object|null, chain:object[], overlay:string|null,
 *            overlayIssues:string[], errors:string[], checks:{name:string, status:"ok"|"info"|"warn"|"error", detail:string}[]}}
 */
export function setupReport({ dataDir, env = process.env, envPresent = null, spec = null } = {}) {
  const chosen = spec ?? packSpecFromEnv(dataDir);
  const out = { ok: false, spec: chosen, specSource: spec ? "requested" : specSource(dataDir, env), pack: null, chain: [], overlay: null, overlayIssues: [], errors: [], checks: [] };
  let p;
  try {
    p = loadPack({ dataDir, spec: chosen });
  } catch (err) {
    out.errors = String(err.message).split("\n").map((s) => s.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
    out.checks.push({ name: "State pack", status: "error", detail: out.errors[0] ?? "could not load" });
    return out;
  }
  const meta = p.__meta;
  out.chain = meta.chain.map((l) => ({ id: l.id, version: l.version, sha256: l.sha256, file: path.relative(PROJECT_ROOT, l.file) }));
  out.overlay = meta.overlay;
  out.overlayIssues = meta.overlayIssues;
  out.pack = { id: p.id, version: p.version, stateName: p.identity.stateName, stateAlpha: p.identity.stateAlpha, orgName: p.identity.orgName, timezone: p.identity.timezone };
  const check = (name, status, detail) => out.checks.push({ name, status, detail });

  check("State pack", "ok", `${p.id}@${p.version} — ${p.identity.orgName} (${p.identity.stateName}) · ${out.specSource}`);
  check("Local overlay", meta.overlayIssues.length ? "warn" : "ok", meta.overlay ? `${meta.overlay}${meta.overlayIssues.length ? ` — ${meta.overlayIssues.join("; ")}` : ""}` : "none (pack-overlay.json in the data folder adds local changes without forking)");

  const rules = p.adminRules?.adapter;
  if (!rules) check("Administrative rules", "warn", "the pack names no admin-rules adapter — state rules are not collected");
  else if (!fs.existsSync(path.join(ADAPTERS_DIR, `${rules}.js`))) check("Administrative rules", "error", `adapter "${rules}" is named by the pack but does not exist`);
  else check("Administrative rules", "ok", `${rules}${p.adminRules.label ? ` — ${p.adminRules.label}` : ""}`);

  const layers = Object.entries(p.geo?.layers ?? {});
  const missingLayers = layers.filter(([, rel]) => !packFileExists(meta.chain, rel)).map(([k]) => k);
  if (!layers.length) check("Map layers", "warn", "the pack ships no boundary layers — /map stays empty (scripts/fetch-geo.mjs builds them)");
  else if (missingLayers.length) check("Map layers", "warn", `missing: ${missingLayers.join(", ")} — run STATE_PACK=${p.id} node scripts/fetch-geo.mjs`);
  else check("Map layers", "ok", layers.map(([k]) => k).join(", "));

  const seed = p.registry?.seed;
  check("Registry seed", seed && packFileExists(meta.chain, seed) ? "ok" : "warn", seed && packFileExists(meta.chain, seed) ? seed : "no registry seed in the pack — the registry starts empty");

  const ams = p.markets?.ams ?? {};
  check("AMS cash grain", ams.cashReportId ? "ok" : "warn", ams.cashReportId ? `report ${ams.cashReportId}` : "no verified cash-grain report — state cash price, basis and the cash crush margin are off");

  check("Campaign-finance seeding", "ok", p.election?.campaignFinance?.enabled ? `enabled in the pack (${p.election.campaignFinance.useRestriction ?? "see the pack"}) — also needs ${p.election.campaignFinance.flag ?? "its env confirmation"}` : "off (the default until counsel confirms the state's data-use terms)");

  const present = envPresent ?? Object.fromEntries(Object.entries(env).filter(([, v]) => v != null && String(v).trim() !== "").map(([k]) => [k, true]));
  for (const k of KEYS) {
    const ok = Boolean(present[k.group]);
    check(`Key ${k.group}`, ok ? "ok" : k.need === "required" ? "error" : k.need === "recommended" ? "warn" : "info", ok ? `present (${k.why})` : `missing — ${k.need} for ${k.why}`);
  }

  out.ok = !out.checks.some((c) => c.status === "error");
  return out;
}

/** Packs shipped in this image, for the setup page's "available" list. */
export function availablePacks(dir = PACKS_DIR) {
  const out = [];
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    for (const version of fs.readdirSync(path.join(dir, id)).sort()) {
      const f = path.join(dir, id, version, "pack.json");
      if (!fs.existsSync(f)) continue;
      try {
        const { pack } = resolvePack(`${id}@${version}`, dir);
        if (pack.abstract) {
          out.push({ spec: `${id}@${version}`, stateName: null, orgName: "base tier — extended by state packs, not deployed alone", valid: true, abstract: true });
          continue;
        }
        out.push({ spec: `${id}@${version}`, stateName: pack.identity?.stateName ?? null, orgName: pack.identity?.orgName ?? null, valid: validatePack(pack).length === 0 });
      } catch (err) {
        out.push({ spec: `${id}@${version}`, stateName: null, orgName: null, valid: false, error: err.message });
      }
    }
  }
  return out;
}

/**
 * Set STATE_PACK in the data folder's .env (replacing an existing line). The target pack must load and
 * validate first — a typo must not leave the next start unable to boot. Takes effect on restart.
 */
export function writeStatePack(dataDir, spec) {
  const p = loadPack({ dataDir, spec }); // throws with every validation error
  if (p.abstract) throw new Error(`${spec} is a base tier, not a deployable state pack`);
  const f = path.join(dataDir, ".env");
  let text = "";
  try {
    text = fs.readFileSync(f, "utf8");
  } catch {
    /* new file */
  }
  const line = `STATE_PACK=${spec}`;
  text = /^\s*STATE_PACK\s*=.*$/m.test(text) ? text.replace(/^\s*STATE_PACK\s*=.*$/m, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  fs.writeFileSync(f, text);
  return f;
}

/** Plain-text rendering for the CLI. */
export function formatSetupReport(r) {
  const mark = { ok: "✓", info: "·", warn: "!", error: "✗" };
  const lines = [`State pack: ${r.spec} (${r.specSource})`];
  for (const l of r.chain) lines.push(`  ${l.id}@${l.version}  sha256 ${l.sha256.slice(0, 12)}  ${l.file}`);
  for (const c of r.checks) lines.push(`${mark[c.status]} ${c.name}: ${c.detail}`);
  for (const e of r.errors.slice(1)) lines.push(`✗   ${e}`);
  lines.push(r.ok ? "Ready." : "Not ready — fix the ✗ items above.");
  return lines.join("\n");
}
