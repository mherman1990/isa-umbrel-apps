// email_intake.js — pull the collector inbox (a dedicated Gmail subscribed to every
// campaign list, county mailer, caucus newsletter, and news source) over IMAP, and
// turn each message into an Item attributed to a registry entity. THE answer to "the
// information is dispersed": content that lives nowhere with an API still lands in an
// inbox if you sign up.
//
// Attribution is deterministic: the per-list plus-address tag (collector+<tag>@) is
// matched first, then the sender domain (registry.resolveEntity). Unattributed mail
// still flows but only survives local scoring if it hits a topic keyword.
//
// Requires a Google APP PASSWORD (2FA on) in EMAIL_INTAKE_PASS — the account password
// will NOT authenticate IMAP. Left disabled in watchlist.json until that is set.

import { createHash } from "node:crypto";
import { resolveEntity } from "../registry.js";
import { getEntity } from "../store.js";
// imapflow + mailparser are lazy-imported inside fetchItems (like nodemailer in
// deliver.js) so a missing optional dep never breaks the whole adapter registry —
// it only matters once email-intake is actually enabled.

export const id = "email_intake";
export const label = "Email intake (collector inbox)";

function hash(s) {
  return createHash("md5").update(String(s)).digest("hex").slice(0, 12);
}

export async function fetchItems({ sinceISO, sourceConfig = {}, env = process.env }) {
  const host = env.EMAIL_INTAKE_HOST || "imap.gmail.com";
  const port = Number(env.EMAIL_INTAKE_PORT || 993);
  const user = env.EMAIL_INTAKE_USER;
  const pass = env.EMAIL_INTAKE_PASS;
  if (!user || !pass) {
    throw new Error(
      "EMAIL_INTAKE_USER/EMAIL_INTAKE_PASS not set — Gmail IMAP needs a 16-char App Password (2FA on), not the account password"
    );
  }
  const budget = sourceConfig.maxItemsPerRun ?? 100;
  const mailbox = sourceConfig.mailbox || "INBOX";
  const sinceDate = new Date(sinceISO);

  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");

  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
  const items = [];

  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uids = await client.search({ since: sinceDate }, { uid: true });
    const take = (uids ?? []).slice(-budget); // newest N within budget
    if (take.length === 0) return [];

    for await (const msg of client.fetch(take, { uid: true, source: true }, { uid: true })) {
      let parsed;
      try {
        parsed = await simpleParser(msg.source);
      } catch {
        continue; // a single unparseable message never kills the run
      }
      const from = parsed.from?.value?.[0]?.address ?? "";
      const toAddrs = (parsed.to?.value ?? []).map((v) => v.address).filter(Boolean);
      // Prefer the plus-tagged recipient (our per-list subscription address).
      const taggedTo = toAddrs.find((a) => a.split("@")[0].includes("+")) ?? toAddrs[0] ?? user;
      const resolved = resolveEntity({ toAddress: taggedTo, fromAddress: from });
      // Broad publishers (farmdoc, Punchbowl, POLITICO…) are registered so we can attribute
      // + label them, but they must NOT get the blanket entity score boost — otherwise every
      // off-topic issue floods the brief. They surface only on a Focus-Area keyword hit.
      // Narrow, on-topic sources (RFA, Growth Energy, Struyk) keep the boost.
      const suppressEntityBoost = resolved?.entityId ? getEntity(resolved.entityId)?.type === "news_broad" : false;
      const messageId = parsed.messageId || `${msg.uid}`;
      const body = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").replace(/\s+/g, " ").trim();

      items.push({
        uid: `email:${hash(messageId)}`,
        sourceId: id,
        sourceLabel: label,
        title: (parsed.subject || "(no subject)").slice(0, 300),
        // Store a generous slice so the News tab's "read it here" expansion shows the real message
        // (emails have no external link). markSeen caps the persisted body at 4000 to match.
        summary: body.slice(0, 4000),
        url: "",
        publishedAt: (parsed.date || new Date()).toISOString(),
        jurisdiction: "Iowa",
        docType: "email",
        raw: {
          entityId: resolved?.entityId ?? null,
          suppressEntityBoost,
          resolvedVia: resolved?.via ?? null,
          resolveConfidence: resolved?.confidence ?? null,
          fromAddress: from,
          toAddress: taggedTo,
          listTag: taggedTo.includes("+") ? taggedTo.split("+")[1]?.split("@")[0] : null,
        },
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return items;
}
