// summarize.js — on-demand AI summary of a single item's linked document.
//
// Fetches the linked rule/notice/docket, extracts its readable text, and asks
// Sonnet for a <=500-word summary of the document and its significance to Iowa
// soybean farmers. Called from the web UI "AI summary" panel on the items page.
// Results are cached (see store.item_summaries) until the item's comment deadline.

import * as cheerio from "cheerio";

import { anthropicClient } from "./llm.js";

import * as store from "./store.js";

const MAX_DOC_CHARS = 18000; // keep token cost bounded for long rules
const FETCH_TIMEOUT_MS = 15000;

/** Best-effort fetch + readable-text extraction for a document/article URL. */
export async function fetchDocumentText(url) {
  if (!url) return { text: "", note: "no link was available" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "the-bean-brief/1.0 (Iowa Soybean Association policy monitor)" },
    });
    if (!res.ok) return { text: "", note: `couldn't fetch the document (HTTP ${res.status})` };
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      return { text: "", note: "the linked document is a PDF; this summary is based on its title and metadata" };
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, nav, header, footer, form, aside").remove();
    const raw = $("main").text() || $("article").text() || $("body").text() || "";
    const clean = raw.replace(/\s+/g, " ").trim();
    if (!clean) return { text: "", note: "the document had no extractable text" };
    return { text: clean.slice(0, MAX_DOC_CHARS), note: null };
  } catch (err) {
    return {
      text: "",
      note: err.name === "AbortError" ? "fetching the document timed out" : `couldn't fetch the document (${err.message})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM = `You are a policy analyst for the Iowa Soybean Association (ISA). You summarize government rules, notices, dockets, and court filings for ISA staff who advocate for Iowa soybean farmers.

Write a clear, factual summary in NO MORE THAN 500 words, in two short parts:
1. What the document is and what it does (the substance).
2. Why it matters to Iowa soybean farmers — the significance, plus any action needed or deadline.

Be specific and neutral. If the document text is missing and you are working only from the title and metadata, say so briefly and summarize what can reasonably be inferred — do not invent specifics. Use short paragraphs or bullet points. Never exceed 500 words.`;

/** Generate a summary for one stored item (a row from store.getItemByUid). */
export async function summarizeItem(item, env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const { text, note } = await fetchDocumentText(item.url);

  const client = anthropicClient(env);
  const model = env.SUMMARY_MODEL || env.BRIEF_MODEL || "claude-sonnet-5";

  const meta = [
    `Title: ${item.title ?? "(untitled)"}`,
    item.jurisdiction ? `Jurisdiction/source: ${item.jurisdiction}` : "",
    item.doc_type ? `Document type: ${item.doc_type}` : "",
    item.published_at ? `Published: ${String(item.published_at).slice(0, 10)}` : "",
    item.comment_deadline ? `Comment deadline: ${String(item.comment_deadline).slice(0, 10)}` : "",
    item.one_line ? `Prior one-line note: ${item.one_line}` : "",
    item.url ? `URL: ${item.url}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const docBlock = text
    ? `Document text (may be truncated):\n"""\n${text}\n"""`
    : `No document text was available${note ? ` — ${note}` : ""}. Summarize from the metadata above.`;

  const response = await client.messages.create({
    model,
    max_tokens: 1200, // ~500-word summary + headroom
    // Disable thinking: condensing a document isn't a reasoning task, and on Sonnet 5 (our default
    // model) adaptive thinking is ON by default and counts against max_tokens — at this small budget
    // it can eat the summary. Off = the full budget goes to the summary, and it's cheaper.
    thinking: { type: "disabled" },
    system: SYSTEM,
    messages: [{ role: "user", content: `${meta}\n\n${docBlock}` }],
  });
  store.recordUsage(model, "summary", response.usage);

  const summary = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  return { summary, model, note };
}
