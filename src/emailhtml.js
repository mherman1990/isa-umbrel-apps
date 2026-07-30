// emailhtml.js — turn a newsletter's raw HTML (or plain text) into a SAFE, readable subset so the
// News tab can render it like a real inbox message instead of a flattened wall of text.
//
// Three helpers, all pure/no-network:
//   sanitizeEmailHtml(html, maxChars) → whitelisted HTML (keeps paragraphs, lists, headings, LINKS;
//     drops scripts/styles/images/trackers and every attribute except safe <a href>). Safe to render
//     UNescaped inside a scoped container. Idempotent — running it twice is a no-op.
//   emailBodyToText(htmlOrText)       → plain text with link URLs preserved inline ("anchor (url)"),
//     for feeding the news digest / market-intel LLM prompts (they want words, not tags).
//   textToHtml(text)                  → escape a plain-text email + linkify bare URLs + paragraph it,
//     so a text/plain message still renders with structure in the inbox.
//
// Previously email_intake.js stored `parsed.html.replace(/<[^>]+>/g," ").replace(/\s+/g," ")`, which
// threw away every hyperlink href and every line break — the root cause of the "wall of text".

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
      $el.removeAttr(attr);
    }
  });

  let out = ($.html() || "")
    .replace(/(&nbsp;| )/g, " ")
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

/** Escape a plain-text email, linkify bare URLs, and paragraph it into safe HTML for the inbox. */
export function textToHtml(text) {
  if (!text) return "";
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const paras = String(text).replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const linkify = (line) =>
    esc(line).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u.replace(/"/g, "&quot;")}">${u}</a>`);
  return paras.map((p) => `<p>${p.split(/\n/).map(linkify).join("<br>")}</p>`).join("\n");
}
