// policyrender.js — checked card records → the markdown that ships.
//
// ⚠️ THIS FILE DOES NOT TOUCH deliver.js, DELIBERATELY. `markdownToEmailHtml` is being changed by a
// concurrent session in this same working tree and its edit is uncommitted. So the certainty
// separation this module is required to make "visually unmissable" is achieved with PLAIN MARKDOWN
// STRUCTURE — headings, a bracketed status band, and an explicit uppercase label — every part of
// which survives markdown, the email HTML conversion, and a Teams channel post that renders none of
// it. Nothing here depends on a CSS class or on any renderer change landing.
//
// ⚠️ SEPARATION IS STRUCTURAL, NOT COSMETIC. Cards are GROUPED INTO SECTIONS by certainty rather
// than merely badged. A badge can be skimmed past; a section heading cannot, because a proposed card
// is not physically inside the "in force" part of the document. The spec names "a reader treating a
// proposed rule as a done deal" as the single largest failure mode of a policy brief, and a chip in
// the corner is not a defence against skimming.
//
// ⚠️ EVERY NUMBER HERE IS COMPUTED, NOT COPIED. Day counts are derived from the clock date in code —
// the same rule as brief.js's stats footer and `daysToDeadline`. Models should not be trusted to do
// arithmetic that the reader will act on.

import { MECHANISM_TERMINALS } from "./prompts/policy-domain.js";

const TERMINAL_LABEL = new Map(MECHANISM_TERMINALS.map((t) => [t.id, t.label]));

/**
 * The sections, in render order. Each carries the plain-language warning that belongs with it —
 * "proposed" alone does not tell a reader it may never take effect.
 */
const SECTIONS = [
  { id: "enacted", heading: "✅ In force", caveat: "Final and in effect." },
  { id: "contested", heading: "⚖️ In force but under challenge", caveat: "Currently binding, but subject to live litigation — it may not survive." },
  { id: "proposed", heading: "📝 Proposed — NOT final", caveat: "Published but not in effect. These may change substantially or never take effect at all." },
  { id: "speculative", heading: "🔭 Signalled, not yet an action", caveat: "Reported or expected. Nothing has been published, and there is no obligation or deadline yet." },
];

const BADGE = {
  enacted: "ENACTED — IN FORCE",
  contested: "IN FORCE — UNDER LEGAL CHALLENGE",
  proposed: "PROPOSED — NOT FINAL",
  speculative: "SPECULATIVE — NO ACTION PUBLISHED",
};

/** Days between two YYYY-MM-DD dates, compared as UTC midnights so DST never shifts a boundary.
 *  Same helper and same reasoning as brief.js — these are calendar dates, not instants. */
export function daysBetweenDates(fromISO, toISO) {
  const a = Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** "in 12 days" / "today" / "8 days ago" — computed, never taken from the model. */
function relativeClock(todayISO, dateISO) {
  const d = daysBetweenDates(todayISO, dateISO);
  if (d === null) return "";
  if (d === 0) return "today";
  if (d > 0) return `in ${d} day${d === 1 ? "" : "s"}`;
  return `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago`;
}

/** One evidence line, provenance grade visible so the reader can weigh it without leaving the brief. */
function renderEvidence(evidence) {
  if (!evidence?.length) return "";
  const parts = evidence.map((e) => {
    if (e.kind === "item") {
      const title = String(e.title ?? e.key).slice(0, 80);
      const link = e.url ? `[${title}](${e.url})` : title;
      return `${link} — *${e.label}${e.advocacy ? ", interested party" : ""}*`;
    }
    return `\`${e.key}\` — *series*`;
  });
  return `**Evidence:** ${parts.join(" · ")}`;
}

/** The mechanism as an arrow chain ending in the named variable, bolded so the terminal stands out. */
function renderMechanism(mech) {
  const chain = (mech?.chain ?? []).filter(Boolean);
  const terminal = TERMINAL_LABEL.get(mech?.terminal) ?? mech?.terminal ?? "";
  if (!chain.length) return "";
  const body = chain.join(" → ");
  return `**Mechanism:** ${body} → **${terminal}**`;
}

/** Render one card. Every field is emitted as ONE line — brief.js's rule, because the email renderer
 *  turns each line into its own paragraph and a wrapped entry arrives broken into fragments. */
export function renderCard(card, todayISO) {
  const lines = [];
  lines.push(`#### ${card.headline ?? "(untitled)"}`);
  lines.push("");

  const p = card.posture ?? {};
  const clock = p.clock_date ? `${p.clock_label || "date"} ${p.clock_date} (${relativeClock(todayISO, p.clock_date)})` : p.clock_label || "no date given";
  lines.push(`**[${BADGE[card.certainty] ?? String(card.certainty ?? "").toUpperCase()}]** · ${clock}`);
  lines.push("");
  lines.push(`**What changed:** ${card.what_changed ?? ""}`);
  if (p.detail) lines.push(`**Posture:** ${p.detail}`);

  const mech = renderMechanism(card.mechanism);
  if (mech) lines.push(mech);
  if (card.mechanism?.weak_link) lines.push(`*Weak link: ${card.mechanism.weak_link}*`);

  if (card.so_what) lines.push(`**So what, for an Iowa operation:** ${card.so_what}`);

  const w = card.watch_next ?? {};
  if (w.event) {
    const when = w.date ? `${w.date}${/^\d{4}-\d{2}-\d{2}$/.test(w.date) ? ` (${relativeClock(todayISO, w.date)})` : ""}` : "date not given";
    lines.push(`**Watch next:** ${w.event} — ${when}`);
  }

  const ev = renderEvidence(card.boundEvidence);
  if (ev) lines.push(ev);

  // A downgrade is shown, not hidden. The reader is entitled to know the first draft claimed more.
  if (card.downgradedFrom) {
    lines.push(`*Certainty lowered from "${card.downgradedFrom}" in review${card.downgradeReason ? `: ${card.downgradeReason}` : ""}.*`);
  }
  return lines.join("\n");
}

/**
 * The whole brief.
 *
 * @param {object} o
 * @param {Array} o.cards survivors, already filed
 * @param {string} o.dateLabel YYYY-MM-DD in the configured timezone
 * @param {string} o.edition am | pm
 * @param {string[]} o.missingLayers evidence layers that failed this run — named in the brief
 * @param {string} o.reviewNote set when the adversarial review did not run
 */
export function renderPolicyBrief({ cards, dateLabel, edition, missingLayers = [], reviewNote = null }) {
  const out = [`## ISA Policy Brief — ${dateLabel} (${edition.toUpperCase()} edition)`, ""];

  if (!cards.length) {
    out.push("No action cleared the evidence bar this scan. Nothing is being withheld — the items collected either had no retrievable substance, no corroborating data, or no development since the last brief.");
    out.push("");
  }

  for (const section of SECTIONS) {
    const group = cards.filter((c) => c.certainty === section.id);
    if (!group.length) continue;
    out.push(`### ${section.heading}`);
    out.push("");
    out.push(`*${section.caveat}*`);
    out.push("");
    for (const card of group) {
      out.push(renderCard(card, dateLabel));
      out.push("");
    }
  }

  // Deadlines across every card, soonest first — the one list that is worth repeating out of
  // section order, because a clock does not care what procedural state its action is in.
  const dated = cards
    .map((c) => ({ card: c, date: c.posture?.clock_date }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x.date ?? "")))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length > 1) {
    out.push("### ⏰ Clocks");
    out.push("");
    for (const { card, date } of dated) {
      out.push(`- **${date}** (${relativeClock(dateLabel, date)}) — ${card.posture?.clock_label || "date"}: ${card.headline}`);
    }
    out.push("");
  }

  // ⚠️ HOUSE RULE: NO SILENT DEGRADATION. A brief that quietly omits a layer looks identical to a
  // brief where that layer had nothing to say.
  if (missingLayers.length || reviewNote) {
    out.push("### ⚠️ About this run");
    out.push("");
    if (missingLayers.length) {
      out.push(`These evidence layers were unavailable, and no card above rests on them: ${missingLayers.join(", ")}.`);
    }
    if (reviewNote) out.push(`The adversarial review did not run on these cards — ${reviewNote}.`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export const __testing = { SECTIONS, BADGE, relativeClock };
