// pack.js — state packs: everything that makes a deployment "Iowa" (or "Illinois"), as versioned data.
//
// Design: docs/MULTI_STATE.md §2. The code contains no state literals; it asks this module:
//   pack().identity.stateName          "Iowa"
//   pack().prompts.operation           "an Iowa corn/soybean operation"
//   seriesKey("nass", "soy-corn-ratio") "nass:ia:soy-corn-ratio"   (state scope)
//
// Load order, later wins:  packs/<extends…>/pack.json  →  packs/<id>/<version>/pack.json  →  /data/pack-overlay.json
// Merge rules: objects deep-merge; arrays replace; `null` deletes an inherited key; an array may instead
// be written { "inherit": true, "add": [...], "remove": [...] } to extend its parent.
//
// Store-free on purpose (no import of store.js), like health.js — the read-only audit and the first-run
// setup check load packs without opening the database.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PACKS_DIR = path.join(PROJECT_ROOT, "packs");
export const DEFAULT_PACK = "us-ia";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge `over` onto `base` with the pack rules above. Pure. */
export function mergePack(base, over) {
  if (over === undefined) return base;
  if (over === null) return undefined;
  if (Array.isArray(over)) return [...over];
  if (isObj(over) && over.inherit === true && (Array.isArray(over.add) || Array.isArray(over.remove))) {
    const parent = Array.isArray(base) ? base : [];
    const rm = new Set((over.remove ?? []).map((x) => (isObj(x) ? x.id : x)));
    const kept = parent.filter((x) => !rm.has(isObj(x) ? x.id : x));
    return [...kept, ...(over.add ?? [])];
  }
  if (isObj(over)) {
    const out = isObj(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(over)) {
      const m = mergePack(out[k], v);
      if (m === undefined) delete out[k];
      else out[k] = m;
    }
    return out;
  }
  return over;
}

/** packs/<id>/<version>/pack.json for "us-ia" (newest version) or "us-ia@2026.1". */
export function packFile(spec, dir = PACKS_DIR) {
  const [id, version] = String(spec).split("@");
  const root = path.join(dir, id);
  if (!fs.existsSync(root)) throw new Error(`state pack "${id}" not found in ${dir}`);
  const versions = fs.readdirSync(root).filter((v) => fs.existsSync(path.join(root, v, "pack.json")));
  if (!versions.length) throw new Error(`state pack "${id}" has no versions`);
  const pick = version ?? versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  const f = path.join(root, pick, "pack.json");
  if (!fs.existsSync(f)) throw new Error(`state pack "${id}@${pick}" not found`);
  return f;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));

/** Resolve one pack and its `extends` chain (cycle-guarded). Returns { pack, chain:[{id,version,file,sha256}] }. */
export function resolvePack(spec, dir = PACKS_DIR, seen = new Set()) {
  const file = packFile(spec, dir);
  const raw = fs.readFileSync(file);
  const own = JSON.parse(raw.toString("utf8"));
  const key = `${own.id}@${own.version}`;
  if (seen.has(key)) throw new Error(`state pack extends cycle at ${key}`);
  seen.add(key);
  const link = { id: own.id, version: own.version, file, dir: path.dirname(file), sha256: crypto.createHash("sha256").update(raw).digest("hex") };
  if (!own.extends) return { pack: own, chain: [link] };
  const parent = resolvePack(own.extends, dir, seen);
  const { extends: _e, ...rest } = own;
  void _e;
  return { pack: mergePack(parent.pack, rest), chain: [...parent.chain, link] };
}

// ── validation (hand-written: no new dependency) ──────────────────────────────────────────────────
const REQUIRED = [
  ["id", "string"],
  ["version", "string"],
  ["identity.orgName", "string"],
  ["identity.orgShort", "string"],
  ["identity.stateName", "string"],
  ["identity.stateAlpha", "string"],
  ["identity.stateFips", "string"],
  ["identity.timezone", "string"],
  ["prompts.reader", "string"],
  ["prompts.operation", "string"],
  ["legislature.legiscanHome", "string"],
  ["markets.nass.stateAlpha", "string"],
];
const SECRETISH = /(api[_-]?key|token|passw(or)?d|secret|smtp_pass)$/i;

/** @returns {string[]} validation errors (empty = valid) */
export function validatePack(p) {
  const errors = [];
  const get = (dotted) => dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), p);
  for (const [k, type] of REQUIRED) {
    const v = get(k);
    if (typeof v !== type || (type === "string" && !v.trim())) errors.push(`${k} must be a non-empty ${type}`);
  }
  if (p?.identity?.stateAlpha && !/^[A-Z]{2}$/.test(p.identity.stateAlpha)) errors.push("identity.stateAlpha must be two capital letters");
  if (p?.identity?.stateFips && !/^\d{2}$/.test(p.identity.stateFips)) errors.push("identity.stateFips must be two digits");
  if (p?.identity?.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: p.identity.timezone });
    } catch {
      errors.push(`identity.timezone "${p.identity.timezone}" is not a valid IANA time zone`);
    }
  }
  // Secrets never live in a pack (docs/MULTI_STATE.md §11): a key-like field with a value is refused.
  const walk = (o, at) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (isObj(o)) for (const [k, v] of Object.entries(o)) {
      if (SECRETISH.test(k) && typeof v === "string" && v.trim() && !/^[A-Z][A-Z0-9_]+$/.test(v)) errors.push(`${at}${k} looks like a secret — packs may name an env var, never hold a value`);
      walk(v, `${at}${k}.`);
    }
  };
  walk(p, "");
  return errors;
}

// ── the singleton ─────────────────────────────────────────────────────────────────────────────────
let CURRENT = null;

/**
 * Load the active pack: STATE_PACK (default us-ia), merged with /data/pack-overlay.json when present.
 * Throws with every validation error listed — a bad pack must stop the app before the scheduler runs.
 */
/**
 * STATE_PACK from the environment, else from the .env files. ⚠️ Modules compute their pack-driven strings
 * at IMPORT time, which runs before index.js calls dotenv — so a STATE_PACK set only in /data/.env would
 * otherwise be missed and the Iowa default silently loaded for another state.
 */
export function packSpecFromEnv(dataDir) {
  if (process.env.STATE_PACK) return process.env.STATE_PACK;
  for (const f of [path.join(dataDir, ".env"), path.join(PROJECT_ROOT, ".env")]) {
    try {
      const m = fs.readFileSync(f, "utf8").match(/^\s*STATE_PACK\s*=\s*["']?([^"'\s#]+)/m);
      if (m) return m[1];
    } catch {
      /* no file */
    }
  }
  return DEFAULT_PACK;
}

export function loadPack({ dataDir = process.env.POLIBRIEF_DATA_DIR ? path.resolve(process.env.POLIBRIEF_DATA_DIR) : PROJECT_ROOT, spec = packSpecFromEnv(dataDir), dir = PACKS_DIR } = {}) {
  const { pack: base, chain } = resolvePack(spec, dir);
  let merged = base;
  let overlay = null;
  const overlayFile = path.join(dataDir, "pack-overlay.json");
  const overlayIssues = [];
  if (fs.existsSync(overlayFile)) {
    try {
      overlay = readJson(overlayFile);
      // Report overlay keys the shipped pack does not have (renamed in an upgrade) instead of
      // silently dropping them — they are still merged, so nothing local is lost.
      for (const k of Object.keys(overlay)) if (!(k in base)) overlayIssues.push(`overlay key "${k}" is not part of pack ${base.id}@${base.version}`);
      merged = mergePack(base, overlay);
    } catch (err) {
      overlayIssues.push(`pack-overlay.json ignored: ${err.message}`);
    }
  }
  const errors = validatePack(merged);
  if (errors.length) throw new Error(`state pack ${spec} is invalid:\n  - ${errors.join("\n  - ")}`);
  const leaf = chain[chain.length - 1];
  merged.__meta = { spec, chain, overlay: overlay ? overlayFile : null, overlayIssues, dir: leaf.dir };
  return merged;
}

/** The active pack (loaded once per process). */
export function pack() {
  if (!CURRENT) CURRENT = loadPack();
  return CURRENT;
}

/** Test hook: forget the cached pack (e.g. after changing STATE_PACK). */
export function resetPack() {
  CURRENT = null;
}

/**
 * A market-series key in the active state's namespace. `scope: "us"` keeps national series national.
 *   seriesKey("nass", "soy-corn-ratio")          → "nass:ia:soy-corn-ratio"
 *   seriesKey("nass", "crush", { scope: "us" })   → "nass:us:crush"
 */
export function seriesKey(source, name, { scope = "state" } = {}) {
  const st = scope === "us" ? "us" : pack().identity.stateAlpha.toLowerCase();
  return `${source}:${st}:${name}`;
}

/** The pack's own state as a crop/drought area of interest: { key: "ia", fips: "19", name: "Iowa" }. */
export function homeRegion() {
  const id = pack().identity;
  return { key: id.stateAlpha.toLowerCase(), fips: id.stateFips, name: id.stateName };
}

/** The neighbouring belt states a pack follows for context (markets.cropRegions.belt). */
export function beltRegions() {
  return pack().markets?.cropRegions?.belt ?? [];
}

/**
 * The barge-freight river segments a pack follows (markets.barge.locations). USDA's dataset reports $/ton
 * per river SEGMENT ("Cape Girardeau – Grafton"), so each entry names the segment exactly as USDA does,
 * with an optional reader-facing label. A bare string is a segment named by itself.
 * @returns {{segment:string, label:string, slug:string, series:string}[]}
 */
export function bargeLocations(list = pack().markets?.barge?.locations ?? []) {
  return list
    .map((e) => (typeof e === "string" ? { segment: e, label: e } : { segment: e?.segment, label: e?.label ?? e?.segment }))
    .filter((e) => e.segment)
    .map((e) => {
      const slug = String(e.segment).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return { ...e, slug, series: `agtransport:barge-freight:${slug}` };
    });
}

// The 1.40.0 watchlist default (sources.agtransport.bargeLocations). Neither name exists in USDA's segment
// data, so an untouched copy of it in a live /data/watchlist.json is treated as "not set".
const LEGACY_BARGE = ["st louis", "illinois river"];
const normName = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The barge segments actually in effect: the watchlist's `sources.agtransport.bargeLocations` override
 * when it is a real choice, else the pack's. ONE resolver for the adapter, the Member Brief and
 * /freshness, so the three never disagree about which segments are followed.
 */
export function effectiveBargeLocations(override) {
  const list = Array.isArray(override) ? override : [];
  const legacy = list.length === LEGACY_BARGE.length && list.every((o) => typeof o === "string" && LEGACY_BARGE.includes(normName(o)));
  return bargeLocations(list.length && !legacy ? list : undefined);
}

/** Absolute path of a file the pack ships (geo layers, data files, branding). */
export function packPath(rel) {
  const p = pack();
  for (const link of [...p.__meta.chain].reverse()) {
    const f = path.join(link.dir, rel);
    if (fs.existsSync(f)) return f;
  }
  return path.join(p.__meta.dir, rel);
}

/** Fill {stateName}, {orgName}… placeholders in a pack string. */
export function fill(template, extra = {}) {
  const id = pack().identity;
  const vars = { ...id, ...extra };
  return String(template ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * The interpolation vocabulary for prompt and UI strings: `${V.state}`, `${V.org}`… Built once per
 * process from the active pack. "an Iowa" / "a Nebraska" is derived, so packs don't carry grammar.
 */
export function voice() {
  const p = pack();
  const id = p.identity;
  const article = /^[aeiou]/i.test(id.stateName) ? "an" : "a";
  return {
    org: id.orgName,
    short: id.orgShort,
    state: id.stateName,
    aState: `${article} ${id.stateName}`,
    alpha: id.stateAlpha,
    product: id.productName ?? "The Bean Brief",
    reader: p.prompts.readerTitle,
    operation: p.prompts.operation,
    tz: id.timezone,
  };
}
