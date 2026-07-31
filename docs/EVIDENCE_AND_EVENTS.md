# Evidence & Events — the information→insight layer

*The durable reference for the 1.27.0 work: **document grounding**, **event identity**, **ranked
retrieval**, and **context freshness**. Companion to `HANDOFF.md` (architecture), `STATE.md` (state),
`ENGINE_TUNING.md` (prompt/voice dials). Where those describe what the system is, this one describes
how information is allowed to lose fidelity on its way to the analyst — and what now prevents it.*

---

## 1. The diagnosis, with the measurements it came from

Bean Brief's collection, market layer and prompt design were in good shape. The losses were all in
the middle: between *fetching* something and *reasoning about* it.

### 1.1 Three official adapters supplied no document text at all

`regulations_gov.js:67`, `iowa_admin_rules.js:77` and `eurlex_oj.js:93` each set `summary: ""`.
`summary` is the field that becomes `seen_items.body`, and it was the **only** document text anything
downstream saw:

| Consumer | What it read |
|---|---|
| `score.js` | `title + summary` |
| `triage.js` | `title` + `summary.slice(0, 600)` |
| `compactItems` (every prompt: Ask box, Analyst, weekly, monthly) | `title` + `one_line` — the body was **dropped entirely** |
| `store.searchSeenItems` (Ask-box retrieval) | `title` + `one_line` |

So for the comment-docket stream — the most actionable source an advocacy organisation has, because
it is where ISA would actually file — every judgement in the system was made from a headline. It
showed in the stored verdicts: *"Submission for OMB review with insufficient detail to assess
relevance to soybeans"* is the triager reporting that it was handed nothing to judge.

The substance was always available. Regulations.gov's detail endpoint carries the document's
Federal Register number; the Federal Register API then returns a **740-character abstract** and
**9,200 characters** of full text for the very notice the pipeline had recorded as `""`.

> Two caveats found while measuring, so they are not re-derived as bugs:
> the local dev database also shows empty bodies for `federal_register` rows collected before
> 2026-07-08 — that is the `body` column not yet existing, an artefact of the snapshot, **not** a
> live defect. Federal Register abstracts arrive normally (6 of 7 populated, 287–2,325 chars, on a
> live check). The genuine defect is the three hard-coded `""`s.

### 1.2 One government action was arriving as many items

Measured on the stored feed:

- **19%** of the "relevant" feed was an exact-title repeat of a row already in it.
- The homepage calendar's "Upcoming" list: **six of eight** entries were the same three EPA notices.
- The comment-deadline panel: **nine "Aug 6" rows**.

Resolved against `api.regulations.gov`, those nine rows are **three** Federal Register notices:

| Federal Register notice | Regulations.gov docket copies |
|---|---|
| `2026-13557` | 4 |
| `2026-13552` | 3 |
| `2026-13553` | 2 |

Each copy got its own Haiku one-liner, its own feed row, its own calendar entry and its own comment
deadline. Because the titles are byte-identical *and* the abstracts were `""`, the analyst had no way
to tell which was which — and to a synthesising model, ten near-identical entries read as ten
independent corroborating signals of one claim. That is the mechanism by which a tool manufactures
false confidence.

The same pattern, differently caused, in two more streams: `legiscan`'s uid embeds `change_hash` and
`courtlistener`'s embeds the latest filing date, so a bill that moves four times or a docket with four
filings became four unrelated feed rows.

### 1.3 Ask-box retrieval could not reach this domain's vocabulary

`answerQuery` ran `searchSeenItems(question)` — one `LIKE '%<the entire question>%'`, which matches
nothing — then fell back to `searchSeenItemsAny(question.split(/\s+/))`, which kept only words
**longer than 3 characters**, OR-ed them, and ordered by `first_seen_at DESC`.

Every identifier this domain runs on is 2–3 characters: **45Z, RFS, RIN, EPA, SAF, EU, ESR**. All
were silently dropped. What survived were stopwords, which match a large share of the table, so
retrieval degenerated into "the 30 newest rows". Reproduced on the real database:

```
"What's happening with 45Z?"  →  IL SB0315: BUSINESS-TECH
                                 Submission for OMB Review; Comment Request
                                 Virtual fencing with eyes in the sky changes cattle game
```

Zero relevant results, and `body` was never searched at all.

### 1.4 Cached model output aged into misinformation

The Markets page rendered a signal card written 2026-07-08, **expanded by default**, stating
*"managed-money funds… net-long 38,149 contracts (39th percentile)"* and *"The July WASDE, releasing
July 10"* — directly beneath a live signal board reading **130,505 contracts at the 79th
percentile**, three weeks after that WASDE. Two values for one series on one screen, with nothing to
say which was current. The date was present, in 0.82em muted text, at the bottom.

Worse than the display: `marketIntelText()` injects the same cached block into the Ask box and the
Analyst Note **with no age attached**, where a three-week-old cash-basis quote competes with fresh
series data.

---

## 2. The design

### 2.1 Event identity — `src/eventkey.js`

`eventKeyFor(item)` returns the identity of the government **action** an item reports on, using
identifiers the *publisher* assigns, strongest first:

| Key | Source of truth | What it collapses |
|---|---|---|
| `fr:2026-13552` | Federal Register document number (`frDocNum` on Regulations.gov detail records) | docket copies **and** the Federal Register original — across sources |
| `bill:ia:1893441` | LegiScan `bill_id` | every status change of one bill |
| `case:<court>:<no>` | CourtListener docket number | every filing in one case |
| `hearing:` / `oj:` / `iar:` | publisher event id | already one-per-action; made uniform |
| `t:<hash>` | normalized-title **exact** match | last resort — the same wire story republished |

**There is deliberately no docket-based rule.** A Regulations.gov docket is wrong in both
directions: one notice is cross-filed into many dockets (so a docket key prevents the grouping), and
one docket accumulates a proposed rule, a final rule and supporting analyses (so a docket key would
*merge different actions*). Un-enriched items fall through to the title rule instead.

**Why not embeddings.** These documents share an exact primary key. Semantic clustering would be
slower, cost money per item, need a similarity threshold nobody can defend, and be *less* accurate
than the identifier the publisher already assigns. Verified empirically: on the stored Aug-6 block
the deterministic rules reproduce the `frDocNum` ground truth exactly (group sizes 4/3/2). Semantic
similarity stays unused until there is a case with no shared identifier that the exact-title fallback
provably misses.

**Validated, not trusted.** Sampling 11 live EPA records found two with the citation fields shifted
by one position — `frDocNum: "46594 - 46594"` (a page *range*), with the real number `2025-18840`
sitting in `startEndPage`. Taking the field on faith produced the key `fr:46594 - 46594`; a page range
is not unique across volumes, so that is a latent false merge. `frDocNumOf()` scans the three
candidate fields for the canonical `YYYY-NNNNN` shape and refuses anything else.

### 2.2 Grounding — `src/enrich.js`

Runs **after collect, before score**. For each Regulations.gov item lacking text: one detail call
(which yields both the document text *and* `frDocNum`), then one Federal Register lookup **per
distinct document number** — so three docket copies cost three detail calls and **one** FR call.

Order is load-bearing:

- *before score*, so the retrieved abstract counts toward the local keyword score. A docket whose
  title is generic but whose abstract says "soybean" used to score zero and never reach triage.
- *before the event key*, because the same request supplies the identifier that groups the copies.

No Anthropic tokens. Every fetch individually caught; budget-capped at 40/run; a failure leaves the
item exactly as the adapter produced it, which is the previous behaviour.

### 2.3 One verdict per action

`runFullPipeline` groups the locally-filtered survivors, triages **one representative** per group
(the copy with document text, preferring the publisher of record), then writes that verdict to the
other copies. Fewer tokens, and — more importantly — the group now *agrees* instead of carrying four
differently-worded one-liners about one document.

Every filing keeps its own row, uid, url and docket. Collapsing is a **display and triage** decision,
never a deletion: `diagnoseCoverage` ("Did we see this?") and the archive view still show every copy,
and the LRD help text states how many rows were folded.

### 2.4 Ranked retrieval — `store.parseQuery` / `store.searchItemsRanked`

- Quoted phrases survive as phrases and score 3×.
- Alphanumeric/ALL-CAPS tokens are kept at **any** length (45Z, RFS, EU, HF2571).
- Ordinary words: ≥4 chars, de-stopworded. A query of nothing but stopwords returns **nothing**,
  rather than the newest rows.
- Scored across `title` (6) / `one_line` (3) / `body` (2); recency is the tie-break, not the sort key.

FTS5 is the natural next step and `better-sqlite3` ships it, but it needs a shadow table maintained on
the hot write path, and the gain here is ranking quality rather than *reachability*. Reachability was
the bug. This change touches no schema and no write path, so it is fully reversible.

### 2.5 Freshness

`marketIntelText()` now **dates** what it injects and **withholds** it past 4 days. Cached panels
carry an age badge in the summary line; a stale panel starts collapsed with an explicit warning that
its figures may be superseded. Expanded-by-default is a claim that content is current.

---

## 3. Measuring it — `test/eval-intelligence.test.js`

`npm test` prints a scorecard. Fixtures (`test/fixtures/eval-corpus.js`) carry recorded provenance —
real docket ids, real document numbers, the real 740-char abstract — and no network or model calls.

| Metric | Meaning | Why it is in the set |
|---|---|---|
| `redundancy_rate` | share of rows repeating an action already listed | what the user feels first |
| `false_merge_rate` | different actions wrongly merged | **must be 0**; a merge deletes a real item |
| `thread_fragmentation` | rows produced by one multi-stage proceeding | change detection vs. feed noise |
| `grounding_rate` | context entries carrying the document's own words | the ceiling on any synthesis |
| `retrieval_p_at_5` | precision@5 on questions as the user writes them | includes the 2–3 char identifiers |
| `repetition_as_evidence` | duplicate entries reaching the model | how false confidence is manufactured |
| `recall_preserved` | every fetched row still findable | dedup must never delete |
| `stale_context_suppressed` | aged cached output withheld/dated | cached error compounding |

`false_merge_rate` exists to keep `redundancy_rate` honest: the two hard-negative cases are two
Federal Register notices whose titles differ only by the active ingredient, and a wire story
carried by three outlets alongside a genuinely different follow-up story.

---

## 4. What this did **not** address

Named so the next developer does not mistake silence for completeness:

- **News is still unranked.** News items are stored `unscored` and the News tab is pure
  reverse-chronological, so a Supreme Court FIFRA preemption ruling sits at the same visual weight as
  a feature about virtual cattle fencing. The scoring machinery exists; pointing it at the news class
  is a product decision (what a "background" news item means) more than an engineering one.
- **The news inbox hides its publisher.** Every row reads `ENTITY RSS/ATOM FEEDS`; the entity is
  resolved and stored but not displayed, so a reader cannot tell a wire report from a trade group's
  press release — which is exactly the judgement they need to make.
- **Article text is still fetched and thrown away.** `generateNewsDigest` fetches up to 14 articles'
  readable text into a local Map, uses it once, and discards it; `summarizeItem` caches its summary
  but not the document text it summarised. Both should persist into `body`.
- **`iowa_admin_rules` and `eurlex_oj` remain title-only.** Their substance is behind a PDF and an
  EUR-Lex document respectively; enrichment currently covers Regulations.gov only.
- **No claim-level citation checking.** Prompts now distinguish sourced text from interpretation, but
  nothing verifies that a citation supports the specific sentence attached to it.
- **`triage_tier` is still assigned per action from the title-and-abstract**, not from full text.
