// deliver.js — get the finished brief where it needs to go:
//   1. always: saved as markdown in ./briefings/YYYY-MM-DD-{am|pm}.md (+ indexed in SQLite)
//   2. if TEAMS_WEBHOOK_URL is set: posted to Teams as an Adaptive Card
//   3. if SMTP is configured AND watchlist output.email is true: emailed (HTML + text)
//
// Delivery in practice is EMAIL: the Teams channels each have an inbound address, so a brief
// reaches "Advocacy News" by being emailed there. That means the email's sender and formatting
// ARE the Teams post's sender and formatting — see sendMarkdownEmail.

import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";

// ---------- markdown → email HTML ----------
// Self-contained (server.js's richer renderer can't be imported — server.js imports this module)
// and INLINE-STYLED, because Teams and Outlook both strip <style> blocks. Escape first, then mark
// up, so nothing in a brief can inject markup.
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
const INLINE = (s) =>
  s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#0070C3">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, '<code style="background:#f3f6f9;padding:1px 4px;border-radius:3px">$1</code>');

export function markdownToEmailHtml(markdown, title = "The Bean Brief") {
  const lines = escHtml(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { closeList(); continue; }
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr style="border:none;border-top:1px solid #d9e2ec;margin:18px 0">'); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const size = [1.35, 1.18, 1.05, 1][m[1].length - 1];
      out.push(`<h${m[1].length} style="${FONT};color:#004A8D;font-size:${size}em;margin:18px 0 6px">${INLINE(m[2])}</h${m[1].length}>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (!inList) { out.push(`<ul style="${FONT};margin:6px 0;padding-left:22px">`); inList = true; }
      out.push(`<li style="margin:4px 0">${INLINE(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*(\d+)\.\s+(.*)$/))) {
      if (!inList) { out.push(`<ul style="${FONT};margin:6px 0;padding-left:22px">`); inList = true; }
      out.push(`<li style="margin:4px 0">${INLINE(m[2])}</li>`);
      continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)$/))) {
      closeList();
      out.push(`<blockquote style="${FONT};margin:8px 0;padding-left:12px;border-left:3px solid #A5C6E3;color:#37474f">${INLINE(m[1])}</blockquote>`);
      continue;
    }
    closeList();
    out.push(`<p style="${FONT};line-height:1.55;margin:8px 0">${INLINE(line)}</p>`);
  }
  closeList();
  return `<div style="${FONT};color:#1c2b3a;max-width:760px">
<div style="border-bottom:3px solid #FFC425;padding-bottom:6px;margin-bottom:14px;font-weight:700;color:#004A8D">${escHtml(title)}</div>
${out.join("\n")}
<p style="${FONT};font-size:.8em;color:#6b7c8c;margin-top:20px;border-top:1px solid #d9e2ec;padding-top:8px">The Bean Brief — Iowa Soybean Association · internal monitoring. Informational, not a recommendation.</p>
</div>`;
}

export function saveBrief(markdown, edition, timezone = "America/Chicago") {
  const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const dir = path.join(store.DATA_DIR, "briefings");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${dateLabel}-${edition}.md`);
  fs.writeFileSync(filePath, markdown, "utf8");
  store.recordBrief(edition, path.relative(store.DATA_DIR, filePath));
  return filePath;
}

/**
 * Teams Adaptive Card. Cards render a subset of markdown (bold, links, lists),
 * so ## / ### headings are converted to bold lines, and the card is split into
 * multiple TextBlocks to stay well under Teams' payload limits.
 */
export async function postToTeams(markdown, env) {
  if (!env.TEAMS_WEBHOOK_URL) {
    console.log("💬 Teams: no TEAMS_WEBHOOK_URL in .env — skipping (the brief is still saved locally)");
    return false;
  }

  const cardText = markdown
    .replace(/^### (.*)$/gm, "**$1**")
    .replace(/^## (.*)$/gm, "**$1**")
    .replace(/^---$/gm, "");

  // One TextBlock per section keeps blocks small and renders more reliably.
  const blocks = cardText
    .split(/\n(?=\*\*)/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((chunk) => ({ type: "TextBlock", text: chunk.slice(0, 6000), wrap: true, separator: true }));

  const payload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: blocks,
        },
      },
    ],
  };

  const res = await fetch(env.TEAMS_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Teams webhook returned HTTP ${res.status}${body ? ` — ${body}` : ""} (check the webhook URL is still valid)`);
  }
  return true;
}

/**
 * Low-level SMTP send shared by every render.
 *
 * SENDER: Gmail will only accept a `from` that matches the authenticated account (or one of its
 * verified aliases), so the account in SMTP_USER is what decides who the brief appears to come
 * from — switching the Teams-channel posts to beanbrief@gmail.com is an SMTP_USER/SMTP_PASS
 * change, not a code change. SMTP_FROM is offered only to attach a display name, e.g.
 * `SMTP_FROM="The Bean Brief <beanbrief@gmail.com>"`; if its address doesn't match SMTP_USER
 * Gmail rewrites or rejects it, so it falls back to the bare account.
 *
 * FORMAT: both a text and an HTML part. Teams channel-email posts (and Outlook) render the HTML,
 * so headings and links come through as headings and links instead of literal `##` and `**`.
 */
async function sendMarkdownEmail({ markdown, subject, to, env, html = true }) {
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT || 587) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const from = env.SMTP_FROM && env.SMTP_FROM.includes(env.SMTP_USER) ? env.SMTP_FROM : env.SMTP_USER;
  const message = { from, to, subject, text: markdown };
  if (html) message.html = markdownToEmailHtml(markdown, subject);
  await transport.sendMail(message);
}

export async function sendEmail(markdown, edition, env, watchlist) {
  const wantEmail = watchlist.output?.email === true;
  const to = recipientFor(edition, env, watchlist); // honours a per-edition override, else BRIEF_EMAIL_TO
  const configured = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && to;
  if (!wantEmail) return false;
  if (!configured) {
    console.log('📧 Email: watchlist has "email": true but SMTP settings are missing in .env — skipping');
    return false;
  }
  await sendMarkdownEmail({
    markdown,
    subject: `ISA Policy Brief — ${new Intl.DateTimeFormat("en-CA").format(new Date())} (${edition.toUpperCase()})`,
    to,
    env,
  });
  return true;
}

// Human labels for the subject line of each on-demand report.
const EDITION_LABEL = {
  weekly: "Weekly memo",
  monthly: "Monthly review",
  education: "Market-education brief",
  analyst: "Analyst Note",
};

/**
 * Where does a given edition's mail go? Each Teams channel has its own inbound address, so this map
 * is what puts the market-education brief in a DIFFERENT channel from the daily policy brief.
 * Resolution order, most specific first:
 *   1. env  BRIEF_EMAIL_TO_EDUCATION / _WEEKLY / _MONTHLY / _ANALYST   (lives in /data/.env)
 *   2. watchlist output.editionEmail[edition]                          (editable in Logs & Settings)
 *   3. env  BRIEF_EMAIL_TO — the default channel, used when nothing edition-specific is set
 * Returns "" when nothing is configured, which the callers treat as "don't send".
 */
export function recipientFor(edition, env = process.env, watchlist = null) {
  // AM and PM are the same daily brief, so PM inherits AM's setting when it has none of its own.
  const keys = edition === "pm" ? ["pm", "am"] : [edition];
  for (const k of keys) {
    const specific = env[`BRIEF_EMAIL_TO_${String(k).toUpperCase()}`];
    if (specific && specific.trim()) return specific.trim();
    const fromWatchlist = watchlist?.output?.editionEmail?.[k];
    if (fromWatchlist && String(fromWatchlist).trim()) return String(fromWatchlist).trim();
  }
  return (env.BRIEF_EMAIL_TO || "").trim();
}

/**
 * Deliver an on-demand memo (weekly / monthly / education / analyst) by email.
 *
 * These were previously never delivered AT ALL — runMemo saved the markdown and stopped, so the
 * market-education brief only existed if someone opened the web UI and clicked. Returns a short
 * status string for the run log, or false when it deliberately didn't send.
 */
export async function sendMemoEmail(markdown, edition, env, watchlist) {
  if (watchlist?.output?.email === false) return false; // email switched off entirely
  const to = recipientFor(edition, env, watchlist);
  const configured = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && to;
  if (!configured) return false;
  const label = EDITION_LABEL[edition] || edition;
  const date = new Intl.DateTimeFormat("en-CA").format(new Date());
  await sendMarkdownEmail({
    markdown,
    subject: `The Bean Brief — ${label}, ${date}`,
    to,
    env,
  });
  return to;
}

/**
 * Farmer-facing render → FARMER_BRIEF_TO (comma-separated). Returns false (skips)
 * when no farmer recipients or SMTP are configured — the render is still saved/web.
 */
export async function sendFarmerEmail(markdown, edition, env) {
  const to = env.FARMER_BRIEF_TO;
  const configured = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && to;
  if (!configured) return false;
  await sendMarkdownEmail({
    markdown,
    subject: `The Bean Brief for Farmers — ${new Intl.DateTimeFormat("en-CA").format(new Date())}`,
    to,
    env,
  });
  return true;
}

/** A two-line test message, so a channel address can be proven from the Settings page. */
export async function sendTestEmail(edition, to, env) {
  const label = EDITION_LABEL[edition] || "Daily policy brief";
  await sendMarkdownEmail({
    markdown:
      `## The Bean Brief — delivery test\n\n` +
      `If you can read this in the channel, **${label}** delivery works.\n\n` +
      `- Sent from: ${env.SMTP_USER}\n- Route: ${edition} → ${to}\n`,
    subject: `The Bean Brief — delivery test (${label})`,
    to,
    env,
  });
  return true;
}

/**
 * "What changed" alert digest → BRIEF_EMAIL_TO (or ALERT_EMAIL_TO). Returns false (skips) when
 * SMTP isn't configured. Only called when the caller has opted in (watchlist output.alertEmail).
 */
export async function sendAlertEmail(changes, env) {
  const to = env.ALERT_EMAIL_TO || env.BRIEF_EMAIL_TO;
  const configured = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && to;
  if (!configured || !changes?.length) return false;
  const markdown =
    `## The Bean Brief — what changed\n\n` +
    changes.map((c) => `- **${c.title}**${c.detail ? ` — ${c.detail}` : ""}`).join("\n");
  await sendMarkdownEmail({
    markdown,
    subject: `The Bean Brief — ${changes.length} market change${changes.length === 1 ? "" : "s"}`,
    to,
    env,
  });
  return true;
}
