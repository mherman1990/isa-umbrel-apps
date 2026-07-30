// congress_hearings.js — Congressional committee HEARINGS & markups from the Congress.gov API
// (reuses the free CONGRESS_GOV_API_KEY). Docs:
//   https://github.com/LibraryOfCongress/api.congress.gov/blob/main/Documentation/CommitteeMeetingEndpoint.md
//
// The chamber list endpoint returns only {eventId, updateDate, url}, so we page recently-updated
// meetings (incremental by updateDate via fromDateTime) and fetch each meeting's DETAIL to get its
// committee, title, date, status, witnesses, and any linked bills.
//
// Volume control is the whole game — a chamber runs ~1,500 meetings a Congress across every
// committee. We keep only meetings before committees ISA cares about, via a two-tier whitelist:
//   Tier A (keep every meeting):  House Ag, Senate Ag, both Ag-Appropriations subcommittees,
//                                 Senate Environment & Public Works.
//   Tier B (keep only soy-relevant meetings): Ways & Means, Senate Finance, House Energy & Commerce,
//                                 House Transportation & Infrastructure, Senate Commerce — kept only
//                                 when the title or a linked bill matches a Focus-Area keyword.
// Committees are matched by the 4-char chamber+committee PREFIX of the systemCode (so every
// subcommittee of a whitelisted committee counts), except Appropriations, where we pin the exact
// Agriculture subcommittee code so the defense/labor/etc. subcommittees don't leak in.

import { fetchJSON, mapPool, keywordRegex } from "../util.js";

export const id = "congress_hearings";
export const label = "Congressional hearings";

const BASE = "https://api.congress.gov/v3";

// Congresses last two years, starting in odd years: 2025-2026 → 119th.
function currentCongress(date = new Date()) {
  return Math.floor((date.getUTCFullYear() - 1789) / 2) + 1;
}

// The whitelist. `prefix` matches a committee family (all its subcommittees share the 4-char
// chamber+committee prefix); `exact` matches one subcommittee systemCode. `iowa` = Iowa delegation
// members on that committee (for flagging in the feed).
const COMMITTEES = [
  { prefix: "hsag", tier: "A", name: "House Agriculture", iowa: ["Rep. Nunn", "Rep. Feenstra"] },
  { prefix: "ssaf", tier: "A", name: "Senate Agriculture", iowa: ["Sen. Grassley", "Sen. Ernst"] },
  { exact: "hsap01", tier: "A", name: "House Appropriations — Agriculture", iowa: ["Rep. Hinson"] },
  { exact: "ssap01", tier: "A", name: "Senate Appropriations — Agriculture", iowa: [] },
  { prefix: "ssev", tier: "A", name: "Senate Environment & Public Works", iowa: [] },
  { prefix: "hswm", tier: "B", name: "House Ways & Means", iowa: ["Rep. Feenstra"] },
  { prefix: "ssfi", tier: "B", name: "Senate Finance", iowa: ["Sen. Grassley"] },
  { prefix: "hsif", tier: "B", name: "House Energy & Commerce", iowa: ["Rep. Miller-Meeks"] },
  { prefix: "hspw", tier: "B", name: "House Transportation & Infrastructure", iowa: [] },
  { prefix: "sscm", tier: "B", name: "Senate Commerce", iowa: [] },
];

// Best whitelist match for a systemCode (exact subcommittee wins; else 4-char family prefix).
function matchCommittee(systemCode) {
  const code = String(systemCode || "").toLowerCase();
  return COMMITTEES.find((c) => (c.exact ? code === c.exact : code.startsWith(c.prefix))) || null;
}

// Public, human-readable link for a meeting (the API url needs the key, so isn't user-facing).
// House meetings have a clean event page; Senate meetings expose a congress.gov notice PDF when one
// exists, else fall back to the Senate hearings index.
function publicUrl(chamber, eventId, docs) {
  if (chamber === "house") return `https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=${eventId}`;
  const gov = (docs || []).map((d) => d.url).find((u) => /^https?:\/\/www\.congress\.gov\//i.test(u || ""));
  return gov || "https://www.senate.gov/committees/hearings_meetings.htm";
}

// relatedItems shape varies (and is often absent for hearings) — collect bills defensively.
function relatedBills(m) {
  const r = m.relatedItems;
  const arr = Array.isArray(r) ? r : Array.isArray(r?.bills) ? r.bills : [];
  return arr
    .map((b) => ({ type: b.type ?? b.billType ?? "", number: b.number ?? b.billNumber ?? "", title: b.title ?? "" }))
    .filter((b) => b.number || b.title)
    .slice(0, 10);
}

export async function fetchItems({ sinceISO, topics = [], sourceConfig = {}, env = process.env }) {
  if (!env.CONGRESS_GOV_API_KEY) {
    throw new Error("CONGRESS_GOV_API_KEY is not set in .env (free key: https://api.congress.gov/sign-up/)");
  }
  const key = env.CONGRESS_GOV_API_KEY;
  const congress = currentCongress();
  const fromDateTime = sinceISO.replace(/\.\d{3}Z$/, "Z"); // API wants YYYY-MM-DDTHH:MM:SSZ
  const maxDetail = sourceConfig.maxDetailPerRun ?? 120; // cap detail calls per chamber (cost guard)

  // Tier-B keyword gate: union of each Focus Area's query terms + keywords (bill/hearing titles are
  // short, so match on the same terms the scorer uses).
  const matchers = [];
  for (const topic of topics) {
    const terms = new Set([...(topic.queries?.[id] ?? []), ...(topic.keywords ?? [])]);
    for (const term of terms) matchers.push(keywordRegex(term));
  }
  const keywordHit = (text) => matchers.some((re) => re.test(text));

  const items = [];
  for (const chamber of ["house", "senate"]) {
    // 1. List recently-updated meetings (newest first), bounded to the detail budget.
    const eventIds = [];
    const PAGE = 250;
    for (let offset = 0; offset < maxDetail; offset += PAGE) {
      const url =
        `${BASE}/committee-meeting/${congress}/${chamber}` +
        `?fromDateTime=${encodeURIComponent(fromDateTime)}` +
        `&sort=updateDate+desc&limit=${Math.min(PAGE, maxDetail)}&offset=${offset}&format=json` +
        `&api_key=${encodeURIComponent(key)}`;
      let data;
      try {
        data = await fetchJSON(url);
      } catch (err) {
        console.log(`⚠️  hearings ${chamber} list failed: ${err.message}`);
        break;
      }
      const list = data.committeeMeetings ?? [];
      for (const mtg of list) eventIds.push(mtg.eventId);
      if (list.length < PAGE) break;
    }
    const take = eventIds.slice(0, maxDetail);

    // 2. Fetch each meeting's detail (bounded concurrency), then filter.
    const details = await mapPool(take, 4, async (eventId) => {
      const url = `${BASE}/committee-meeting/${congress}/${chamber}/${eventId}?format=json&api_key=${encodeURIComponent(key)}`;
      try {
        return (await fetchJSON(url)).committeeMeeting || null;
      } catch {
        return null; // one bad detail never kills the run
      }
    });

    for (const m of details) {
      if (!m) continue;
      const status = m.meetingStatus || "";
      if (/cancel/i.test(status)) continue; // drop canceled; keep Scheduled/Rescheduled/Postponed

      // Committee whitelist match — prefer a Tier-A committee if the meeting lists several.
      let match = null;
      for (const c of m.committees || []) {
        const w = matchCommittee(c.systemCode);
        if (w && (!match || (match.tier === "B" && w.tier === "A"))) match = w;
      }
      if (!match) continue;

      const title = (m.title || "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
      const bills = relatedBills(m);
      const billText = bills.map((b) => `${b.type} ${b.number} ${b.title}`).join(" ");
      // Tier B: keep only if the title or a linked bill hits a Focus-Area keyword.
      if (match.tier === "B" && matchers.length && !keywordHit(`${title} ${billText}`)) continue;

      const dateISO = m.date ? new Date(m.date).toISOString() : new Date(m.updateDate || Date.now()).toISOString();
      const typeLabel = m.type || "Meeting";
      const loc = m.location ? [m.location.room, m.location.building].filter(Boolean).join(" ") : "";
      const witnesses = (m.witnesses || [])
        .map((w) => `${w.name || ""}${w.organization ? ` (${w.organization})` : ""}`.trim())
        .filter(Boolean)
        .slice(0, 8);
      const statusNote = /schedul/i.test(status) ? "" : ` [${status}]`;

      const summary = [
        `${typeLabel}${statusNote} — ${match.name}`,
        `When: ${dateISO.slice(0, 16).replace("T", " ")} UTC${loc ? ` · ${loc}` : ""}`,
        match.iowa.length ? `Iowa delegation on this committee: ${match.iowa.join(", ")}` : "",
        witnesses.length ? `Witnesses: ${witnesses.join("; ")}` : "",
        billText.trim() ? `Related bills: ${billText.trim().slice(0, 300)}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      items.push({
        uid: `${id}:${chamber}:${m.eventId}`,
        sourceId: id,
        sourceLabel: label,
        title: `${typeLabel}: ${match.name} — ${title || "(untitled)"}`,
        summary,
        url: publicUrl(chamber, m.eventId, m.meetingDocuments),
        publishedAt: dateISO, // the MEETING date (often future) — powers the homepage calendar
        jurisdiction: "US-Federal",
        docType: "hearing",
        raw: {
          eventId: m.eventId,
          chamber: m.chamber,
          committee: match.name,
          committeeTier: match.tier,
          meetingStatus: status,
          meetingDate: dateISO,
          iowaMembers: match.iowa,
          hearingType: typeLabel,
          relatedBills: bills,
        },
      });
    }
  }

  return items;
}
