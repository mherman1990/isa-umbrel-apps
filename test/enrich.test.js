// enrich.test.js — the document-grounding pass, verified offline.
//
// `globalThis.fetch` is stubbed with the exact response shapes both APIs return (recorded live on
// 2026-07-30), so this test proves the wiring — including the two things that make the pass worth
// having — without a network call, a key, or a rate limit:
//
//   1. It reads the Federal Register document number out of the Regulations.gov DETAIL record. That
//      field is `frDocNum`, and it is absent from the search response the adapter uses, which is why
//      the adapter could never have supplied it.
//   2. It fetches each Federal Register document ONCE however many docket copies cite it. Three
//      copies of notice 2026-13552 must produce three detail calls and ONE Federal Register call —
//      otherwise grounding costs 3× more requests than it needs to, and the whole point of resolving
//      the shared identifier is lost.
//
// It also records the before/after grounding rate, which is the number the whole change rests on:
// the adapter emitted `summary: ""` for every item in this stream.

import test from "node:test";
import assert from "node:assert/strict";

import { enrichItems, frDocNumOf } from "../src/enrich.js";
import { eventKeyFor } from "../src/eventkey.js";
import { FR_13552_ABSTRACT } from "./fixtures/eval-corpus.js";

// ---- the source-data defect ---------------------------------------------------------------------
// Recorded from live EPA records on 2026-07-30. Two of eleven sampled documents had their citation
// fields shifted by one position, putting a PAGE RANGE where the document number belongs. Trusting
// the field produced the event key "fr:46594 - 46594" — which grouped those two filings only because
// both were misfiled identically. A page range repeats across volumes, so that key is a latent
// false merge, and a false merge silently deletes a real action from the feed.

test("enrich: the document number is recovered by shape, not taken on faith", () => {
  // Canonical.
  assert.equal(frDocNumOf({ frDocNum: "2026-13552" }), "2026-13552");
  assert.equal(frDocNumOf({ frDocNum: " 2026-13552 " }), "2026-13552", "whitespace tolerated");

  // The shifted-field case, verbatim from EPA-HQ-OPP-2025-0024-0006.
  assert.equal(
    frDocNumOf({
      frDocNum: "46594 - 46594",
      frVolNum: "46594 Federal Register / Vol. 90, No. 186 / Monday, September 29, 2025 / Notices",
      startEndPage: "2025-18840",
    }),
    "2025-18840",
    "the real number is found in startEndPage and the page range is rejected"
  );

  // Nothing usable anywhere — must be null, so the caller falls back rather than inventing a key.
  assert.equal(frDocNumOf({ frDocNum: null, frVolNum: null, startEndPage: null }), null);
  assert.equal(frDocNumOf({ frDocNum: "46594 - 46594" }), null, "a page range alone yields no key at all");
  assert.equal(frDocNumOf({}), null);

  // And a page range must never become an event key.
  assert.ok(!eventKeyFor({ sourceId: "regulations_gov", uid: "regulations_gov:x", title: "A pesticide notice of some length here", raw: { frDocNum: "46594 - 46594" } }).startsWith("fr:"));
});

// The three docket copies of one notice, exactly as adapters/regulations_gov.js emits them.
const DOCKET_COPIES = ["EPA-HQ-OPP-2025-1905-0003", "EPA-HQ-OPP-2026-1783-0001", "EPA-HQ-OPP-2025-2500-0002"].map((docId) => ({
  uid: `regulations_gov:${docId}`,
  sourceId: "regulations_gov",
  sourceLabel: "Regulations.gov",
  title: "Pesticide Product Registration: Applications for New Uses (April 2026)",
  summary: "", // ← the defect, verbatim
  url: `https://www.regulations.gov/document/${docId}`,
  publishedAt: "2026-07-06T00:00:00.000Z",
  jurisdiction: "US-Federal",
  docType: "notice",
  raw: { docketId: docId.replace(/-\d+$/, ""), commentsCloseOn: "2026-08-06" },
}));

/** Install a fetch stub; returns the call log so a test can assert on request counts. */
function stubFetch({ failFR = false, failDetail = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u.split("?")[0]);
    if (u.includes("api.regulations.gov")) {
      if (failDetail) return { ok: false, status: 503, text: async () => "upstream down" };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            attributes: {
              // Regulations.gov's own abstract is the FR citation line, not the substance.
              docAbstract: " Federal Register for Monday, July 6, 2026 (91 FR 41018) ( FRL–13199–04–OCSPP) EPA–HQ–OPP–2026–0334 Pesticide Product Registration; Receipt of Applications for New Uses (April 2026)",
              frDocNum: "2026-13552",
              docketId: "EPA-HQ-OPP-2026-0334",
              commentEndDate: "2026-08-06T23:59:59Z",
              subject: null,
              cfrPart: null,
            },
          },
        }),
      };
    }
    if (u.includes("federalregister.gov")) {
      if (failFR) return { ok: false, status: 500, text: async () => "boom" };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          title: "Pesticide Product Registration; Receipt of Applications for New Uses (April 2026)",
          abstract: FR_13552_ABSTRACT,
          action: "Notice of receipt and request for comment.",
          type: "Notice",
          html_url: "https://www.federalregister.gov/documents/2026-13552",
          comments_close_on: "2026-08-05",
          agencies: [{ name: "Environmental Protection Agency" }],
          docket_ids: ["EPA-HQ-OPP-2026-0334"],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const ENV = { REGULATIONS_GOV_API_KEY: "test-key" };
const quiet = () => {};

test("enrich: a docket copy with no summary comes back carrying the real document text", async () => {
  const s = stubFetch();
  try {
    const before = DOCKET_COPIES.filter((i) => i.summary.length >= 200).length;
    const { items, stats } = await enrichItems(DOCKET_COPIES, { env: ENV, log: quiet });
    const after = items.filter((i) => (i.summary ?? "").length >= 200).length;

    assert.equal(before, 0, "baseline: the adapter supplied no document text at all");
    assert.equal(after, DOCKET_COPIES.length, "every copy is now grounded");
    assert.equal(stats.grounded, 3);
    assert.equal(stats.linked, 3, "and every copy resolved a Federal Register document number");

    const one = items[0];
    assert.ok(one.summary.includes("change in use pattern"), "the FR abstract is what landed in summary");
    assert.ok(one.summary.includes("Notice of receipt and request for comment"), "the action line is included");
    assert.ok(one.summary.includes("Environmental Protection Agency"), "and the agency");
    assert.ok(one.summary.includes("91 FR 41018"), "the citation is kept as provenance");
    console.log(`      grounding_rate: 0/3 → 3/3 items with ≥200 chars of document text`);
  } finally {
    s.restore();
  }
});

test("enrich: the Federal Register is called once per document, not once per docket copy", async () => {
  const s = stubFetch();
  try {
    await enrichItems(DOCKET_COPIES, { env: ENV, log: quiet });
    const detail = s.calls.filter((c) => c.includes("api.regulations.gov")).length;
    const frCalls = s.calls.filter((c) => c.includes("federalregister.gov")).length;
    assert.equal(detail, 3, "one detail call per item — that is where frDocNum lives");
    assert.equal(frCalls, 1, "and ONE Federal Register call shared by all three copies");
  } finally {
    s.restore();
  }
});

test("enrich: the resolved document number is what groups the copies together", async () => {
  const s = stubFetch();
  try {
    const { items } = await enrichItems(DOCKET_COPIES, { env: ENV, log: quiet });
    const keys = new Set(items.map((i) => eventKeyFor(i)));
    assert.deepEqual([...keys], ["fr:2026-13552"], "three filings, one action, keyed on the publisher's own identifier");

    // Un-enriched, the same three still collapse — but via the weaker normalized-title rule, which
    // is why enrichment matters for CONFIDENCE as much as for content: same answer, better evidence.
    // (They deliberately do NOT key on their dockets: one notice is cross-filed into many dockets,
    // and one docket accumulates several different actions, so a docket key is wrong both ways.)
    const unenriched = new Set(DOCKET_COPIES.map((i) => eventKeyFor(i)));
    assert.equal(unenriched.size, 1, "the title fallback reaches the same grouping");
    assert.ok([...unenriched][0].startsWith("t:"), "but says plainly that it got there by title, not by identifier");
  } finally {
    s.restore();
  }
});

test("enrich: a deadline disagreement between the two systems is recorded, never applied", async () => {
  const s = stubFetch();
  try {
    const { items } = await enrichItems(DOCKET_COPIES, { env: ENV, log: quiet });
    const d = items[0].raw.deadlineDisagreement;
    assert.deepEqual(d, { regulationsGov: "2026-08-06", federalRegister: "2026-08-05" }, "both dates are preserved");
    assert.equal(items[0].raw.commentsCloseOn, "2026-08-06", "and the operative date is untouched — Regulations.gov accepts the comment");
  } finally {
    s.restore();
  }
});

test("enrich: failure is a no-op — items pass through exactly as the adapter produced them", async () => {
  for (const mode of [{ failDetail: true }, { failFR: true }]) {
    const s = stubFetch(mode);
    try {
      const { items, stats } = await enrichItems(DOCKET_COPIES, { env: ENV, log: quiet });
      assert.equal(items.length, DOCKET_COPIES.length, "nothing is dropped");
      if (mode.failDetail) {
        assert.equal(stats.failed, 3);
        assert.deepEqual(items.map((i) => i.summary), DOCKET_COPIES.map((i) => i.summary), "unchanged");
      } else {
        // The FR lookup failed but the Regulations.gov citation still landed — degraded, not broken.
        assert.equal(stats.failed, 0);
        assert.ok(items[0].summary.includes("91 FR 41018"), "the citation survives an FR outage");
        assert.ok(!items[0].summary.includes("change in use pattern"), "the abstract does not, and nothing is invented");
      }
    } finally {
      s.restore();
    }
  }
});

test("enrich: no key means skip, not throw", async () => {
  const s = stubFetch();
  try {
    const { items, stats } = await enrichItems(DOCKET_COPIES, { env: {}, log: quiet });
    assert.equal(stats.attempted, 0);
    assert.equal(items.length, DOCKET_COPIES.length);
    assert.equal(s.calls.length, 0, "and no request is made");
  } finally {
    s.restore();
  }
});

test("enrich: an item the adapter already grounded is never re-fetched", async () => {
  const s = stubFetch();
  try {
    const already = [{ ...DOCKET_COPIES[0], summary: FR_13552_ABSTRACT }];
    const { stats } = await enrichItems(already, { env: ENV, log: quiet });
    assert.equal(stats.attempted, 0, "spend nothing on what is already there");
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});
