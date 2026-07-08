// deliver.js — get the finished brief where it needs to go:
//   1. always: saved as markdown in ./briefings/YYYY-MM-DD-{am|pm}.md (+ indexed in SQLite)
//   2. if TEAMS_WEBHOOK_URL is set: posted to Teams as an Adaptive Card
//   3. if SMTP is configured AND watchlist output.email is true: emailed as plain text

import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";

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

/** Low-level SMTP send shared by the internal and farmer renders. */
async function sendMarkdownEmail({ markdown, subject, to, env }) {
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT || 587) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  await transport.sendMail({ from: env.SMTP_USER, to, subject, text: markdown });
}

export async function sendEmail(markdown, edition, env, watchlist) {
  const wantEmail = watchlist.output?.email === true;
  const configured = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.BRIEF_EMAIL_TO;
  if (!wantEmail) return false;
  if (!configured) {
    console.log('📧 Email: watchlist has "email": true but SMTP settings are missing in .env — skipping');
    return false;
  }
  await sendMarkdownEmail({
    markdown,
    subject: `ISA Policy Brief — ${new Intl.DateTimeFormat("en-CA").format(new Date())} (${edition.toUpperCase()})`,
    to: env.BRIEF_EMAIL_TO,
    env,
  });
  return true;
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
