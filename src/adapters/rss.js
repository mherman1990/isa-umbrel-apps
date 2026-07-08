// rss.js — entity-driven RSS/Atom collection. Unlike the topic-query adapters,
// this one is driven by the ENTITY REGISTRY: it polls the `rss` channels of the
// entities we track (caucus/official press feeds, campaign blogs) and emits their
// items tagged with the source entity. No API key. See registry.js.
//
// Handles both RSS 2.0 (<rss><channel><item>) and Atom (<feed><entry>). The parse
// step is exported (parseFeed) so it can be unit-tested without a live feed.

import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { fetchText } from "../util.js";
import * as store from "../store.js";

export const id = "rss";
export const label = "Entity RSS/Atom feeds";
// Tells collect.js which registry channel kinds to hand this adapter.
export const channelKinds = ["rss"];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

function toArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") return node["#text"] ?? node.__cdata ?? "";
  return String(node);
}

/** Atom <link> may be a string, one object, or many — pick the alternate/first href. */
function atomLink(links) {
  const arr = toArray(links);
  const alt = arr.find((l) => (l?.["@_rel"] ?? "alternate") === "alternate") ?? arr[0];
  if (!alt) return "";
  return typeof alt === "string" ? alt : alt["@_href"] ?? "";
}

function toISO(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(String(dateStr).trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function hash(s) {
  return createHash("md5").update(String(s)).digest("hex").slice(0, 12);
}

/**
 * Parse a feed XML string into partial Items for one entity/channel.
 * @returns {object[]} normalized Items
 */
export function parseFeed(xml, { entityId, entity, channelId } = {}) {
  const doc = parser.parse(xml);
  const jurisdiction = entity?.level === "federal" ? "US-Federal" : "Iowa";
  const rawEntries =
    doc?.rss?.channel?.item != null
      ? toArray(doc.rss.channel.item)
      : doc?.feed?.entry != null
        ? toArray(doc.feed.entry)
        : [];

  return rawEntries.map((e) => {
    const isAtom =
      e.updated != null || e.published != null || (e.link && typeof e.link === "object") || e.id != null;
    const link = isAtom ? atomLink(e.link) : textOf(e.link);
    const title = textOf(e.title).trim();
    const summary = textOf(e.description ?? e.summary ?? e.content ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const guid = textOf(e.guid) || textOf(e.id) || link || title;
    const publishedAt = toISO(e.pubDate ?? e.published ?? e.updated ?? e["dc:date"]);
    return {
      uid: `rss:${entityId}:${hash(guid)}`,
      sourceId: id,
      sourceLabel: label,
      title,
      summary: summary.slice(0, 800),
      url: link,
      publishedAt: publishedAt ?? new Date().toISOString(),
      jurisdiction,
      docType: "statement",
      raw: {
        entityId,
        channelId: channelId ?? null,
        matchedTopicId: null,
        feedTitle: entity?.full_name ?? null,
      },
    };
  });
}

export async function fetchItems({ sinceISO, channels = [], sourceConfig = {}, env = process.env }) {
  const budget = sourceConfig.maxItemsPerRun ?? 60;
  const sinceMs = Date.parse(sinceISO) || 0;
  const items = [];

  for (const ch of channels) {
    if (items.length >= budget) break;
    let xml;
    try {
      xml = await fetchText(ch.url_or_handle);
      store.markChannelHealth(ch.id, true);
    } catch (err) {
      // A dead feed is flagged (channel health) but never kills the run.
      store.markChannelHealth(ch.id, false, err.message);
      if (env.POLIBRIEF_DEBUG) console.log(`   ⚠️ rss ${ch.url_or_handle}: ${err.message}`);
      continue;
    }
    let feedItems = [];
    try {
      feedItems = parseFeed(xml, { entityId: ch.entity_id, entity: ch.entity, channelId: ch.id });
    } catch (err) {
      store.markChannelHealth(ch.id, false, `parse: ${err.message}`);
      continue;
    }
    for (const it of feedItems) {
      if (Date.parse(it.publishedAt) < sinceMs) continue; // only items newer than last run
      items.push(it);
      if (items.length >= budget) break;
    }
  }
  return items;
}
