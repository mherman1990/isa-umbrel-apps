// triage-issue.mjs — the issue-triage agent.
//
// For a GitHub issue on this repo it: gathers the relevant code (the files the issue names + a
// repo map), asks Claude for a grounded assessment and a recommended fix, and posts that back as
// a comment on the issue, then labels it `claude-triaged` so it isn't re-done.
//
// Run modes (driven by env, set by .github/workflows/issue-triage.yml):
//   ISSUE_NUMBER set  → triage just that issue (an `opened` event or a manual dispatch)
//   ISSUE_NUMBER empty → sweep every open issue not yet labelled `claude-triaged` (the daily cron)
//   node triage-issue.mjs --selftest sample.json → run the analysis on a local JSON issue and
//                                                   print it (no GitHub calls) — for local testing.
//
// Requires: ANTHROPIC_API_KEY (repo secret) and, in the non-selftest path, the `gh` CLI with a
// token (GH_TOKEN=github.token on the runner) plus REPO="owner/name".

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const REPO = process.env.REPO || "";
const MODEL = process.env.TRIAGE_MODEL || "claude-sonnet-5";
const TRIAGE_LABEL = "claude-triaged";
const FILE_CAP = 45000; // per-file char cap fed to the model
const MAX_FILES = 8;

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** Every tracked file — used both as the repo map and to resolve issue-mentioned paths. */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

// Render a file for the prompt. If specific lines were named (e.g. server.js:316), emit numbered
// windows around them (merged) — targeted context for big files like server.js (~2000 lines) whose
// relevant code would otherwise fall outside a head-truncation. Otherwise the whole file, head-capped.
const WINDOW = 70;
function renderFile(pathRel, lines) {
  let content = "";
  try { content = fs.readFileSync(pathRel, "utf8"); } catch { return ""; }
  const all = content.split("\n");
  if (!lines.size) {
    if (content.length <= FILE_CAP) return content;
    return content.slice(0, FILE_CAP) + `\n… [truncated; ${all.length}-line file — reference specific line numbers to surface later sections]`;
  }
  const ranges = [];
  for (const ln of [...lines].sort((a, b) => a - b)) {
    const lo = Math.max(1, ln - WINDOW), hi = Math.min(all.length, ln + WINDOW);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last.hi + 6) last.hi = Math.max(last.hi, hi); // merge nearby windows
    else ranges.push({ lo, hi });
  }
  return ranges
    .map((r) => `… lines ${r.lo}–${r.hi}:\n` + all.slice(r.lo - 1, r.hi).map((l, i) => `${r.lo + i}\t${l}`).join("\n"))
    .join("\n\n…\n\n");
}

/** Pick the files most likely relevant: those the issue names (with any line refs), + anchors. */
function gatherContext(issue) {
  const tracked = trackedFiles();
  const codeMap = tracked.filter((f) => /\.(?:js|mjs|json|ya?ml|md)$/.test(f)).join("\n");
  const text = `${issue.title || ""}\n${issue.body || ""}`;
  const mentions = new Map(); // resolvedPath -> Set(lineNumbers)
  for (const m of text.matchAll(/([\w./-]+\.(?:js|mjs|json|ya?ml|md))(?::(\d+))?/g)) {
    const name = m[1].replace(/^[./]+/, "");
    const hit = tracked.includes(name) ? name : tracked.find((t) => t.endsWith("/" + name));
    if (!hit) continue;
    if (!mentions.has(hit)) mentions.set(hit, new Set());
    if (m[2]) mentions.get(hit).add(Number(m[2]));
  }
  for (const anchor of ["package.json", "README.md"]) {
    if (tracked.includes(anchor) && !mentions.has(anchor)) mentions.set(anchor, new Set());
  }
  const used = [...mentions.keys()].slice(0, MAX_FILES);
  const blobs = used.map((f) => `----- FILE: ${f} -----\n${renderFile(f, mentions.get(f))}`).join("\n\n");
  return { codeMap, blobs, used };
}

const SYSTEM = `You are a senior engineer triaging a GitHub issue for "The Bean Brief" (repo ${REPO}) — a Node 20 ESM app: a plain node:http server (src/server.js, template-string HTML, no web framework), better-sqlite3 (WAL), the Anthropic SDK, one file per data source in src/adapters/. The repo owner is a NON-DEVELOPER, so lead with a plain-English verdict.

Assess the issue STRICTLY AGAINST THE CODE PROVIDED below — do not assume behavior you can't see. Reply in GitHub-flavored markdown with these sections, tight and concrete:

**Verdict** — one line: reproducible bug / not-a-bug / needs-more-info / config-or-setup.
**Just a missing .env / API key?** — yes or no, and why. (The owner specifically worries that some reports are only because keys weren't set. Distinguish "the visible symptom needs a missing key to appear" from "the underlying bug is real regardless".)
**Severity** — low / medium / high, with the actual user impact in one line.
**Root cause** — cite file:line from the provided code; name the function.
**Recommended fix** — a concrete, minimal, contract-preserving change as a unified diff or a precise before/after snippet. If you need a file that wasn't provided, say exactly which.
**Caveats** — anything to double-check, or "none".

Keep it under ~400 words. Do not invent line numbers — if unsure, describe the location.`;

async function analyze(issue) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — add it as a repo secret (Settings → Secrets and variables → Actions).");
  }
  const { codeMap, blobs, used } = gatherContext(issue);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const user =
    `ISSUE #${issue.number}: ${issue.title}\n\n${issue.body || "(no body)"}\n\n` +
    `=== REPO FILE MAP (paths only) ===\n${codeMap}\n\n` +
    `=== RELEVANT FILE CONTENTS ${used.length ? `(${used.join(", ")})` : "(none matched — infer from the map, or ask which file you need)"} ===\n${blobs || "(none)"}`;
  // thinking disabled: this is a structured write-up, not a long-reasoning task, and Sonnet 5's
  // default adaptive thinking counts against max_tokens — leaving it on starved the text output to
  // empty on large inputs (two big source files here). Disabled + a roomy budget is predictable.
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    thinking: { type: "disabled" },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const analysis = resp.content.find((b) => b.type === "text")?.text?.trim() || "";
  if (!analysis) throw new Error("model returned no text — not posting an empty triage comment");
  return { analysis, used };
}

function shortSha() {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

async function triage(number) {
  const issue = JSON.parse(gh(["issue", "view", String(number), "--repo", REPO, "--json", "number,title,body,url"]));
  console.log(`→ triaging #${number}: ${issue.title}`);
  const { analysis, used } = await analyze(issue);
  const body =
    `## 🔎 Automated triage & recommended fix\n\n${analysis}\n\n` +
    `<sub>🤖 Automated triage (model \`${MODEL}\`, repo @ \`${shortSha()}\`${used.length ? `, read: ${used.map((f) => "`" + f + "`").join(", ")}` : ""}). A human should confirm before merging — this is a recommendation, not an applied change.</sub>`;
  fs.writeFileSync("triage-comment.md", body);
  gh(["issue", "comment", String(number), "--repo", REPO, "--body-file", "triage-comment.md"]);
  try {
    gh(["label", "create", TRIAGE_LABEL, "--repo", REPO, "--color", "0e8a16", "--description", "Auto-triaged by the issue agent", "--force"]);
  } catch { /* label may already exist */ }
  try { gh(["issue", "edit", String(number), "--repo", REPO, "--add-label", TRIAGE_LABEL]); } catch { /* non-fatal */ }
  console.log(`✓ commented + labelled #${number}`);
}

/** Open issues not yet triaged — the daily-sweep target. */
function openUntriaged() {
  const list = JSON.parse(gh(["issue", "list", "--repo", REPO, "--state", "open", "--json", "number,labels", "--limit", "60"]));
  return list.filter((i) => !(i.labels || []).some((l) => l.name === TRIAGE_LABEL)).map((i) => i.number);
}

// --- entry point ---
if (process.argv.includes("--selftest")) {
  // Local, no-GitHub path: `node triage-issue.mjs --selftest sample-issue.json`
  const file = process.argv[process.argv.indexOf("--selftest") + 1];
  const issue = JSON.parse(fs.readFileSync(file, "utf8"));
  const { analysis, used } = await analyze(issue);
  console.log(`[selftest] read files: ${used.join(", ") || "(none)"}\n`);
  console.log(analysis);
} else {
  if (!REPO) { console.error("REPO env (owner/name) is required."); process.exit(1); }
  const single = (process.env.ISSUE_NUMBER || "").trim();
  const numbers = single ? [Number(single)] : openUntriaged();
  if (!numbers.length) { console.log("No open, untriaged issues — nothing to do."); process.exit(0); }
  let failed = 0;
  for (const n of numbers) {
    try { await triage(n); } catch (e) { failed++; console.error(`✗ #${n}: ${e.message}`); }
  }
  if (failed) process.exit(1);
}
