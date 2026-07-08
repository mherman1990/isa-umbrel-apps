// registry.js — the v2 Entity Registry: WHO we monitor and HOW each publishes.
//
// The registry is the backbone of polibrief v2. Instead of trying to watch "all
// Iowa local politics", we watch a curated set of ENTITIES (candidates, officials,
// party orgs, committees) and their CHANNELS (website, rss, ical, mobilize,
// eventbrite, social handle, newsletter list). Everything downstream — which feeds
// to poll, how to attribute an inbound email, farmer targeting by county — hangs
// off this.
//
// Storage: the canonical rows live in SQLite (entity/channel tables in store.js).
// A hand-editable registry.json seed (like watchlist.json) holds the known set and
// is upserted into SQLite on load. Machine seeders (OpenStates/FEC/Socrata) add the
// bulk later. Editing registry.json and re-syncing is always safe (idempotent upsert).

import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";

/** The live registry seed file: the data-volume copy in Docker/Umbrel, else the project one. */
export function registryFilePath() {
  const candidates = [path.join(store.DATA_DIR, "registry.json"), path.join(store.PROJECT_ROOT, "registry.json")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Read + parse registry.json (BOM-tolerant). Returns { version, entities: [...] }. */
export function loadRegistrySeed() {
  const p = registryFilePath();
  if (!p) return { version: "0", entities: [] };
  let text;
  try {
    text = fs.readFileSync(p, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw new Error(`Could not read ${p}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`registry.json is not valid JSON: ${err.message}\n   Tip: paste it into jsonlint.com to find the spot.`);
  }
}

/**
 * Upsert every seed entity + its inline channels into SQLite. Idempotent — safe to
 * run on every boot. Seed entities are tagged source="seed" so a later machine
 * refresh can tell hand-curated rows from imported ones.
 */
export function syncRegistryFromSeed() {
  const seed = loadRegistrySeed();
  let entities = 0;
  let channels = 0;
  for (const e of seed.entities ?? []) {
    const { channels: chans, ...entity } = e;
    store.upsertEntity({ ...entity, source: entity.source ?? "seed" });
    entities++;
    for (const c of chans ?? []) {
      store.upsertChannel({ ...c, entityId: e.id });
      channels++;
    }
  }
  return { entities, channels };
}

/** All active channels of a given kind, each joined with a light entity view. */
export function channelsOfKind(kind) {
  return store.listChannels({ kind, active: 1 }).map((c) => ({ ...c, entity: store.getEntity(c.entity_id) }));
}

/** All active channels across several kinds — what collect.js hands entity-driven adapters. */
export function channelsForKinds(kinds) {
  const out = [];
  for (const k of kinds ?? []) out.push(...channelsOfKind(k));
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic entity attribution (the "who is this about?" of §5).
//
// An inbound item (email, event, post) is matched to a registry entity by strong
// signals first: a plus-address tag, an explicit external id, a platform org id, a
// social handle, or the sender's domain. Low/no-confidence items fall through to the
// LLM step in triage.js — which uses entityDirectoryForPrompt() below.

let _idx = null;
let _idxAt = 0;

/** Build (and briefly cache) the reverse lookup maps from channels + external ids. */
function attributionIndex() {
  if (_idx && Date.now() - _idxAt < 60_000) return _idx;
  const byDomain = new Map(); // site/email domain -> entityId
  const byHandle = new Map(); // lowercased social handle -> entityId
  const byOrgId = new Map(); // 'kind:orgId' -> entityId (mobilize/eventbrite/plus-tag)
  const byExtId = new Map(); // 'system:id' -> entityId

  for (const c of store.listChannels({ active: 1 })) {
    const eid = c.entity_id;
    if (c.org_id) byOrgId.set(`${c.kind}:${String(c.org_id).toLowerCase()}`, eid);
    if (c.kind === "x_handle" || c.kind === "fb_page") {
      byHandle.set(String(c.url_or_handle).replace(/^@/, "").toLowerCase(), eid);
    }
    if (["website", "rss", "press_page", "newsletter_email"].includes(c.kind)) {
      const d = domainOf(c.url_or_handle);
      if (d && !byDomain.has(d)) byDomain.set(d, eid);
    }
  }
  for (const e of store.listEntities({ status: "active" })) {
    let ext = {};
    try {
      ext = JSON.parse(e.external_ids ?? "{}");
    } catch {
      /* ignore malformed */
    }
    for (const [sys, id] of Object.entries(ext)) if (id) byExtId.set(`${sys}:${id}`, e.id);
  }
  _idx = { byDomain, byHandle, byOrgId, byExtId };
  _idxAt = Date.now();
  return _idx;
}

/** Invalidate the attribution cache (call after a registry sync/seed). */
export function refreshAttributionIndex() {
  _idx = null;
  _idxAt = 0;
}

/** Extract a registrable domain from a URL or email address. */
function domainOf(urlOrEmail) {
  if (!urlOrEmail) return null;
  let s = String(urlOrEmail).trim().toLowerCase();
  const at = s.indexOf("@");
  if (at >= 0) s = s.slice(at + 1); // email -> domain
  s = s
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
  return s || null;
}

/** Pull the tag from a plus-address, e.g. collector+iowagop@gmail.com -> "iowagop". */
function plusTag(address) {
  if (!address) return null;
  const m = String(address).match(/\+([^@]+)@/);
  return m ? m[1] : null;
}

/**
 * Resolve an item to a registry entity by deterministic signals only.
 * @param {object} signals { toAddress, fromAddress, handle, orgId, orgKind, externalIds }
 * @returns {{ entityId: string, confidence: number, via: string } | null}
 */
export function resolveEntity(signals = {}) {
  const idx = attributionIndex();

  // 1. plus-address tag on the recipient (our per-list subscription tag) — strongest.
  const tag = plusTag(signals.toAddress);
  if (tag) {
    const byTag = idx.byOrgId.get(`newsletter_email:${tag.toLowerCase()}`);
    if (byTag) return { entityId: byTag, confidence: 1, via: "plus-tag" };
    if (store.getEntity(tag)) return { entityId: tag, confidence: 1, via: "plus-tag-id" };
  }
  // 2. explicit external id (FEC/OpenStates/etc.)
  if (signals.externalIds) {
    for (const [sys, id] of Object.entries(signals.externalIds)) {
      const hit = idx.byExtId.get(`${sys}:${id}`);
      if (hit) return { entityId: hit, confidence: 1, via: `extid:${sys}` };
    }
  }
  // 3. platform org id (Mobilize org, Eventbrite organizer)
  if (signals.orgId && signals.orgKind) {
    const hit = idx.byOrgId.get(`${signals.orgKind}:${String(signals.orgId).toLowerCase()}`);
    if (hit) return { entityId: hit, confidence: 1, via: "org-id" };
  }
  // 4. social handle
  if (signals.handle) {
    const hit = idx.byHandle.get(String(signals.handle).replace(/^@/, "").toLowerCase());
    if (hit) return { entityId: hit, confidence: 0.9, via: "handle" };
  }
  // 5. sender domain (weakest deterministic signal — shared domains can collide)
  const d = domainOf(signals.fromAddress);
  if (d && idx.byDomain.has(d)) return { entityId: idx.byDomain.get(d), confidence: 0.8, via: "domain" };

  return null;
}

/** A compact entity directory for the triage LLM's entity-resolution fallback. */
export function entityDirectoryForPrompt(limit = 400) {
  return store.listEntities({ status: "active", limit }).map((e) => ({
    id: e.id,
    name: e.full_name,
    office: e.office,
    party: e.party,
    district: e.district,
    level: e.level,
  }));
}
