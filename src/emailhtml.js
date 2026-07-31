// emailhtml.js — turn a newsletter's raw HTML (or plain text) into a SAFE, READABLE subset so the
// News tab can render it like a real inbox message instead of a flattened wall of text.
//
// Four helpers, all pure/no-network:
//   sanitizeEmailHtml(html, maxChars) → whitelisted HTML (keeps paragraphs, lists, headings, LINKS;
//     drops scripts/styles/images/trackers and every attribute except safe <a href>). Safe to render
//     UNescaped inside a scoped container. Idempotent — running it twice is a no-op.
//   emailBodyToText(htmlOrText)       → plain text with link URLs preserved inline ("anchor (url)"),
//     for feeding the news digest / market-intel LLM prompts (they want words, not tags).
//   emailBodyToPreview(htmlOrText)    → plain text with URLs and newsletter chrome REMOVED, for the
//     one-line inbox snippet. Never use emailBodyToText for display: it inlines every href, which is
//     why the inbox preview used to read as 180 characters of tracking URL.
//   textToHtml(text)                  → escape a plain-text email, recover its links, drop its
//     chrome, and paragraph it, so a text/plain message still renders with structure.
//
// WHY THE CHROME PASS EXISTS. Publisher newsletters (Morning Ag Clips, Punchbowl, POLITICO…) are
// ESP-generated, and their text/plain alternative encodes every image and link as a bracketed URL
// after its alt text — "Morning Ag Clips [https://…/mac.png] … Facebook [https://…/icon-fb.png]
// https://securetrack…". Escaping and linkifying that verbatim turned a 3-paragraph story into
// screenfuls of visible tracking URLs. So: image URLs are dropped, real links are kept but reduced
// to a compact ↗ (the label text is already in the prose), and known boilerplate ("Images not
// showing up?", "view this in your browser", unsubscribe/footer lines) is removed. The story
// survives; the plumbing doesn't.
//
// Bodies are re-sanitized at RENDER time (server.js inboxFeed), so this also cleans up mail that
// was already stored — no re-fetch needed.

import * as cheerio from "cheerio";

// Block + inline text tags we keep. Everything else (div/span/table/img/script/style/…) is unwrapped
// or dropped, which also linearizes newsletter table-layouts into readable content.
const ALLOWED = new Set([
  "p", "br", "a", "ul", "ol", "li", "strong", "em", "b", "i", "u",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "pre", "code",
]);
// Elements dropped together WITH their contents (never just unwrapped).
const DROP_WITH_CONTENT = "script,style,head,title,meta,link,noscript,iframe,object,embed,img,svg,video,audio,button,input,form,textarea,select,map,area,base";

const SAFE_HREF = /^(https?:|mailto:)/i;
const IMAGE_URL = /^https?:\/\/[^\s\]]*\.(?:png|jpe?g|gif|svg|webp|bmp|ico)(?:\?[^\s\]]*)?$/i;

// Newsletter plumbing — lines/sentences that are never content. Matched case-insensitively against
// a single line (or an HTML block's text). Deliberately conservative: each pattern is boilerplate
// that carries no editorial information, so removing it can't lose a story.
const CHROME_PATTERNS = [
  /images?\s+not\s+showing\s+up\s*\?/i,
  /(view|read)\s+(this|it)\s+(email\s+)?in\s+(your\s+)?browser/i,
  /view\s+(this\s+)?(email|message)\s+online/i,
  /click\s+here\s+to\s+(view|read|unsubscribe)/i,
  /^\s*unsubscribe\b/i,
  /\bunsubscribe\b.*\b(here|link|preferences)\b/i,
  /manage\s+(your\s+)?(email\s+)?(preferences|subscription)/i,
  /update\s+(your\s+)?(profile|preferences)/i,
  /add\s+us\s+to\s+your\s+address\s+book/i,
  /forward\s+(this\s+)?to\s+a\s+friend/i,
  /you\s+(are\s+)?receiv(e|ed|ing)\s+this\s+(email|message|newsletter)/i,
  /this\s+(email|message)\s+was\s+sent\s+to/i,
  /^\s*sent\s+to\s*:/i,
  /all\s+rights\s+reserved/i,
  /^\s*(copyright\s+)?(©|&copy;)\s*\d{4}/i,
  /^\s*privacy\s+(policy|notice)\s*$/i,
  /^\s*terms\s+(of\s+(use|service))\s*$/i,
  /^\s*(share|subscribe|donate|advertise|weather|events)\s*$/i,
  /^\s*(facebook|twitter|x|instagram|linkedin|youtube|tiktok|threads|email|rss)\s*$/i,
  /^\s*(follow|connect with)\s+us\b/i,
];
const isChrome = (line) => CHROME_PATTERNS.some((re) => re.test(line));

/** True when a line, stripped of links/brackets/punctuation, holds no actual words. */
function isEmptyish(line) {
  return !/[A-Za-z]{3}/.test(String(line).replace(/https?:\/\/\S+/g, "").replace(/[[\]()|·—–-]/g, " "));
}

/**
 * True for an ESP navigation/social strip — "Morning Ag Clips ↗ Facebook ↗ Twitter ↗ … Subscribe ↗".
 * Detected by DENSITY rather than by a word list, so it generalizes past the publishers we've seen:
 * three or more links carrying only a word or two each is a menu; a paragraph of prose that happens
 * to cite three sources has many words per link and is kept.
 */
function isNavRow(chunk) {
  const links = (String(chunk).match(/<a\b/g) || []).length;
  if (links < 3) return false;
  const words = String(chunk).replace(/<[^>]+>/g, " ").split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w)).length;
  return words / links < 4;
}

// The URL-stripped twin of isNavRow, for the preview path (by then the links are gone, so density
// can't be measured — fall back to vocabulary). Three or more of these in one chunk with no
// sentence punctuation is a masthead/social strip, not a sentence.
const NAV_WORDS = /\b(facebook|twitter|instagram|linkedin|youtube|tiktok|threads|subscribe|unsubscribe|share|advertise|donate|newsletter|weather|events|classifieds|obituaries|local news|top stories|view in browser|manage preferences|contact us|about us|home|menu)\b/gi;
function isNavStrip(chunk) {
  const s = String(chunk);
  const hits = (s.match(NAV_WORDS) || []).length;
  if (hits >= 3) return true;
  const words = s.split(/\s+/).filter(Boolean);
  return hits >= 1 && words.length >= 6 && !/[.,;:?!]/.test(s); // a run of bare labels
}

/** Drop the plumbing sentence-by-sentence, keeping any real prose that shares the line with it. */
function stripChrome(line) {
  const chunks = String(line).split(/(?<=[.!?])\s+/);
  const kept = chunks.filter((c) => c.trim() && !isChrome(c) && !isNavRow(c) && !isEmptyish(c));
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

const LINK_GLYPH = '<a class="mi-x" href="$URL$" title="$URL$">&#8599;</a>';

/**
 * Recover the links from an ESP's text/plain alternative and drop its plumbing.
 * Runs on ESCAPED text (escaping leaves `[`, `]`, `:` and `/` alone, and turns `&` inside a URL
 * into `&amp;`, which is what an href needs anyway), so it can emit anchors safely.
 */
function recoverTextLinks(escaped) {
  let s = escaped;
  // 1. Bracketed image URLs are pure layout — drop them (and any alt text left dangling is prose).
  s = s.replace(/\s*\[(https?:\/\/[^\]\s]*\.(?:png|jpe?g|gif|svg|webp|bmp|ico)(?:\?[^\]\s]*)?)\]/gi, "");
  // 2. Any other bracketed URL is a real link whose label is the text right before it — keep the
  //    label as prose and reduce the URL itself to a compact ↗ rather than printing it.
  s = s.replace(/\s*\[(https?:\/\/[^\]\s]+)\]/g, (_m, u) => " " + LINK_GLYPH.replace(/\$URL\$/g, u));
  // 3. Bare URLs (ESPs sprinkle naked tracking links between icons) get the same treatment.
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (_m, pre, u) =>
    IMAGE_URL.test(u) ? pre : pre + LINK_GLYPH.replace(/\$URL\$/g, u)
  );
  // 4. A run of adjacent ↗ (a social-icon row) is one link's worth of information at most.
  s = s.replace(/(?:<a class="mi-x"[^>]*>&#8599;<\/a>\s*){2,}/g, (m) => m.match(/<a class="mi-x"[^>]*>&#8599;<\/a>/)[0] + " ");
  return s.replace(/[ \t]{2,}/g, " ").trim();
}

/** Whitelist-sanitize newsletter HTML into a safe, structure-preserving subset. */
export function sanitizeEmailHtml(html, maxChars = 8000) {
  if (!html) return "";
  let $;
  try {
    $ = cheerio.load(String(html), null, false); // fragment mode — no <html>/<body> wrapper
  } catch {
    return textToHtml(String(html).replace(/<[^>]+>/g, " "));
  }
  $(DROP_WITH_CONTENT).remove();

  // Walk every element: unwrap anything not whitelisted (keeping its children), and strip all
  // attributes from what remains — except a safe href on <a>. Document order (parents first) means
  // unwrapping a container leaves its whitelisted descendants in place to be cleaned on later visits.
  $("*").each((_, el) => {
    const tag = (el.tagName || el.name || "").toLowerCase();
    const $el = $(el);
    if (!ALLOWED.has(tag)) {
      $el.replaceWith($el.contents());
      return;
    }
    for (const attr of Object.keys(el.attribs || {})) {
      if (tag === "a" && attr === "href" && SAFE_HREF.test(el.attribs[attr])) continue;
      if (tag === "a" && attr === "class" && el.attribs[attr] === "mi-x") continue; // our own ↗ marker (idempotent)
      $el.removeAttr(attr);
    }
  });

  // Newsletter chrome, in HTML form: an anchor whose visible text IS a url (or an image filename)
  // carries no information — reduce it to the compact ↗. An anchor left empty by image removal
  // becomes ↗ too, and one with no href at all is unwrapped.
  $("a").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") || "";
    const text = ($a.text() || "").trim();
    if (!href || !SAFE_HREF.test(href)) {
      $a.replaceWith($a.contents());
      return;
    }
    if (!text || /^https?:\/\//i.test(text) || IMAGE_URL.test(text)) {
      $a.attr("class", "mi-x");
      $a.text("↗");
    }
  });
  // Drop boilerplate blocks outright (the "Images not showing up?" / unsubscribe / social rows).
  $("p,li,h1,h2,h3,h4,h5,h6,blockquote").each((_, el) => {
    const $el = $(el);
    const t = ($el.text() || "").replace(/\s+/g, " ").trim();
    if (!t) { $el.remove(); return; }
    // Chrome is chrome even when it's a link ("View this email in your browser" is an anchor), so
    // the boilerplate test runs BEFORE the "holds a real labelled link, leave it alone" guard.
    if (isChrome(t)) { $el.remove(); return; }
    if ($el.find("a[href]:not(.mi-x)").length) return; // a real labelled link — editorial, keep
    if (isNavRow($el.html() || "") || (t.length < 240 && isEmptyish(t))) $el.remove();
  });

  let out = ($.html() || "")
    .replace(/(&nbsp;| )/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/(\s*<br\s*\/?>\s*){3,}/gi, "<br><br>") // cap runaway line breaks
    .replace(/<p>\s*<\/p>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (out.length > maxChars) {
    // Truncate, then re-parse so any tag we cut through is closed back up (keeps the render valid).
    try {
      out = (cheerio.load(out.slice(0, maxChars), null, false).html() || "").trim();
    } catch {
      out = out.slice(0, maxChars);
    }
  }
  return out;
}

/** Plain text (link URLs kept inline) for LLM prompts — strips tags, collapses whitespace. */
export function emailBodyToText(body) {
  if (!body) return "";
  const s = String(body);
  if (!s.includes("<")) return s.replace(/\s+/g, " ").trim();
  let $;
  try {
    $ = cheerio.load(s, null, false);
  } catch {
    return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  $(DROP_WITH_CONTENT).remove(); // never let script/style text leak into an LLM prompt
  $("a[href]").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") || "";
    const text = $a.text() || "";
    if (SAFE_HREF.test(href) && !text.includes(href)) $a.replaceWith(`${text} (${href})`);
  });
  return ($.text() || "").replace(/\s+/g, " ").trim();
}

/**
 * A clean one-line snippet for the inbox list: no URLs, no ESP chrome, first real prose first.
 * (The inbox used emailBodyToText, whose whole job is to INLINE every href for LLM prompts —
 * so a Morning Ag Clips item previewed as a wall of securetrack.morningagclips.com.)
 */
export function emailBodyToPreview(body, maxChars = 180) {
  if (!body) return "";
  let text = String(body);
  if (text.includes("<")) {
    try {
      const $ = cheerio.load(text, null, false);
      $(DROP_WITH_CONTENT).remove();
      $("a.mi-x").remove();
      text = $.text() || "";
    } catch {
      text = text.replace(/<[^>]+>/g, " ");
    }
  }
  const cleaned = text
    .replace(/\s*\[(?:https?:\/\/[^\]\s]+)\]/gi, " ") // bracketed urls (text/plain form)
    .replace(/https?:\/\/\S+/g, " ") // bare urls
    .replace(/↗/g, " ") // our own link glyph
    .replace(/&(nbsp|amp|quot|#39|lt|gt);/gi, " ")
    .replace(/\r/g, "");
  // Prefer the first chunk that reads like a sentence, skipping nav words and boilerplate.
  const chunks = cleaned
    .split(/\n+|(?<=[.!?])\s+/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter((c) => c && !isChrome(c) && !isEmptyish(c) && !isNavStrip(c));
  let out = "";
  for (const c of chunks) {
    // A chunk of ≥40 characters with a couple of real words is prose, not a menu row.
    if (out.length >= 60) break;
    if (out.length === 0 && c.length < 40 && chunks.length > 1) continue;
    out = out ? `${out} ${c}` : c;
  }
  out = (out || chunks.join(" ")).replace(/\s+/g, " ").trim();
  if (out.length <= maxChars) return out;
  const cut = out.slice(0, maxChars);
  const sp = cut.lastIndexOf(" ");
  return (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

/** Escape a plain-text email, recover its links, drop its chrome, and paragraph it into safe HTML. */
export function textToHtml(text) {
  if (!text) return "";
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const paras = String(text).replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of paras) {
    const lines = p
      .split(/\n/)
      .map((line) => stripChrome(recoverTextLinks(esc(line))))
      .filter(Boolean);
    if (lines.length) out.push(`<p>${lines.join("<br>")}</p>`);
  }
  return out.join("\n");
}
