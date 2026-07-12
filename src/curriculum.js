// curriculum.js — the starter concept bank + glossary for the BeanBrief education engine.
//
// Concepts drive the daily brief's rotating "teaching thread" (season-aware, least-recently-
// used pick via store.pickConcept). Glossary feeds "Today's Terms" + definitional Q&A.
// Bodies are ~120–150 words, plain, grounded in a farmer's world — and strictly educational
// (mechanics, never a recommendation). See docs/beanbrief_education_engine.md §3.

import * as store from "./store.js";

// season_window: months (1–12) when the concept is naturally timely; "*" = any time.
export const SEED_CONCEPTS = [
  {
    id: "basis-101", title: "What basis is and why it moves", domain: "Basis", seasonWindow: [8, 9, 10, 11],
    body: "Basis is the gap between the futures price on the board and the cash price your local elevator offers: cash = futures + basis (basis is usually negative). It reflects local supply and demand and the cost of moving grain to where it's needed. When the board rallies but your bid barely moves, basis is absorbing the difference. Basis usually weakens at harvest, when grain floods in and space is tight, and can firm through winter and spring as supplies draw down and processors or exporters bid for bushels. Barge freight on the river and rail availability push interior basis around too. The practical habit: watch your basis on its own, separate from the futures screen — some days it's doing more for your bottom line than the board is.",
  },
  {
    id: "stocks-to-use", title: "Stocks-to-use: the market's cushion", domain: "S&D fundamentals", seasonWindow: [11, 12, 1, 2],
    body: "Stocks-to-use is ending stocks divided by total use for the year — the share of a year's demand left over as a cushion. A low ratio means the market has little margin for error, so any hiccup in production or surge in demand can move price sharply; a high ratio means comfort, and prices tend to sit heavier. It's more useful than the raw stocks number because it puts supply in the context of how fast the crop is being used. A soybean stocks-to-use near the low end of its historical range is a tight, price-supportive setup; near the high end is burdensome. Watching how each USDA report nudges this ratio tells you more about price direction than the headline production figure alone.",
  },
  {
    id: "balance-sheet", title: "How a crop balance sheet is built", domain: "S&D fundamentals", seasonWindow: [11, 12, 1, 2],
    body: "A crop balance sheet is just supply minus demand equals what's left over. Supply is beginning stocks (last year's carryout) plus this year's production plus imports. Demand is crush (beans processed into meal and oil), exports, plus seed and residual use. Whatever supply isn't used becomes ending stocks — the carryout that starts next year. USDA updates every line monthly in the WASDE. The value of seeing it this way is that a change anywhere — a bigger crop, a stronger export pace, a jump in crush for renewable diesel — flows straight to ending stocks, which is what the market prices. When you hear a report was 'bullish,' it usually means a line moved in a way that shrank the carryout.",
  },
  {
    id: "wasde-101", title: "What WASDE is and why it moves markets", domain: "USDA report ecosystem", seasonWindow: "*",
    body: "The WASDE — World Agricultural Supply and Demand Estimates — is USDA's monthly balance sheet for the major crops, released around mid-month on a set calendar. It's the single biggest scheduled market-mover in grains because it updates every supply and demand line at once, for the U.S. and the world. What moves price on release day is usually not the raw number but the surprise: how the figure compares to what traders expected going in. A carryout that comes in below the average trade guess is bullish even if it rose from last month, because the market had positioned for more. Knowing the release calendar and the pre-report expectations turns WASDE day from noise into a readable event.",
  },
  {
    id: "futures-vs-cash", title: "The board vs. your cash bid", domain: "Price discovery & futures", seasonWindow: "*",
    body: "Futures ('the board') are standardized contracts traded at the CBOT that let the whole market discover one transparent price for a delivery month. Your cash bid is what your local elevator will actually pay today, and it equals the futures price plus your local basis. So there are two moving parts behind every bid: the board, which reacts to national and global news, and the basis, which reacts to your local supply, demand, and logistics. Contract months matter — a November soybean price and a July price can differ because they reflect different points in the crop cycle. Understanding that your bid is 'board plus basis' is the foundation for reading why your price changed on any given day.",
  },
  {
    id: "managed-money", title: "Who 'managed money' is in the COT", domain: "Positioning & sentiment", seasonWindow: "*",
    body: "Every week the CFTC's Commitment of Traders report shows how different groups are positioned in futures. 'Managed money' is the funds — the speculative traders betting on price direction. When they're heavily net long, a lot of buying has already happened, which can mean the market is 'crowded' and vulnerable to a pullback if the news turns; heavily net short is the mirror image. Commercials (elevators, processors, exporters) usually sit on the other side, hedging physical grain. Positioning isn't a timing tool on its own, but it tells you who's already in the trade. An extreme reading — funds near a record long or short — is worth noting, because crowded positions can unwind fast.",
  },
  {
    id: "crush-demand", title: "The crush: soybeans' domestic demand engine", domain: "Demand drivers", seasonWindow: "*",
    body: "Crushing is processing soybeans into two products: meal (mostly livestock feed) and oil (food use and, increasingly, biofuel). Crush is the largest piece of U.S. soybean demand, and it's been running at record levels because renewable diesel plants have pulled hard on soybean oil. The 'crush margin' — the value of the meal and oil a plant can make minus what it pays for beans — tells you how profitable processing is, and strong margins keep plants running full and bidding for bushels. That's why a farmer watches crush: it's steady domestic demand that supports basis near a processor, and its direction hints at how hard the oil-for-fuel story is pulling. Competing feedstocks like used cooking oil and tallow can chip away at soy oil's share.",
  },
  {
    id: "condition-ratings", title: "Reading USDA crop condition ratings", domain: "Weather & yield", seasonWindow: [5, 6, 7, 8],
    body: "Each week in the growing season USDA rates the crop across five buckets from very poor to excellent, and the market watches the share rated 'good or excellent' (G/E). It's a survey-based read on how the crop is developing, not a yield forecast — but the direction and timing matter. A few points' drop during a stress window like soybean pod-fill in August gets more attention than the same move in June, because that's when yield is being set. Compare this year's G/E to the same week in prior years and to the five-year average to judge whether it's genuinely strong or weak. Pair it with the drought map and the forecast: condition ratings are the crop's report card, and weather is what writes it.",
  },
  {
    id: "brazil-competition", title: "Why Brazil sets the tone for soybeans", domain: "Global competition", seasonWindow: [12, 1, 2, 3],
    body: "Brazil is now the world's largest soybean exporter, so U.S. soybeans compete head-to-head with the Brazilian crop for demand — especially from China. Their season is opposite ours: Brazil plants around October–December and harvests February onward, so their weather drives the market during our winter. Two things to watch. First, the safrinha and main-crop weather, since a Brazilian problem shifts export business to the U.S. and vice versa. Second, the Brazilian real: when the real weakens against the dollar, Brazilian farmers get more local currency per bushel and sell aggressively, undercutting U.S. export prices even if the crop is the same size. Export-pace math — who's booking sales to China each week — is how this competition shows up in the data.",
  },
  {
    id: "soy-corn-ratio", title: "The soybean:corn ratio and acreage", domain: "S&D fundamentals", seasonWindow: [1, 2, 3],
    body: "The soybean-to-corn price ratio is simply the new-crop soybean price divided by the new-crop corn price. Farmers and the market watch it heading into spring because it's a rough gauge of which crop pencils out better on ground that could grow either. A ratio around 2.3–2.5 is often cited as the neighborhood where the two are competitive; above that, beans look relatively more attractive, below it, corn does. It's only one input — rotation, input costs, agronomy, and each operation's own situation matter more — so it explains a tendency, not a decision. But when the ratio swings well outside its usual range, it hints at how the market is trying to bid for acres, which eventually shows up in the spring Prospective Plantings report.",
  },
];

export const SEED_GLOSSARY = [
  ["basis", "The difference between the local cash price and the futures price (cash = futures + basis; usually negative)."],
  ["ending stocks", "The grain left over at the end of the marketing year — the carryout that becomes next year's beginning stocks."],
  ["stocks-to-use", "Ending stocks divided by total use — the market's cushion; low = tight/price-supportive, high = comfortable."],
  ["carryout", "Another name for ending stocks: what's carried over into the next crop year."],
  ["crush", "Processing soybeans into meal and oil; the largest piece of U.S. soybean demand."],
  ["crush margin", "The value of the meal and oil from a bushel minus the price paid for the bean — how profitable processing is."],
  ["managed money", "Speculative fund traders in the CFTC Commitment of Traders report; their net long/short shows crowding."],
  ["G/E rating", "The share of a crop rated 'good' or 'excellent' in USDA's weekly condition survey."],
  ["WASDE", "USDA's monthly World Agricultural Supply and Demand Estimates — the big scheduled balance-sheet update."],
  ["Crop Progress", "USDA's weekly in-season report on planting pace, crop condition, and harvest progress."],
  ["safrinha", "Brazil's second-crop corn planted after soybeans; more broadly, the timing of Brazil's growing season."],
  ["the real", "Brazil's currency; a weaker real vs. the dollar makes Brazilian grain cheaper on the world market."],
  ["contract month", "The delivery month a futures contract is tied to (e.g., November soybeans); different months price different points in the crop cycle."],
  ["open interest", "The number of futures contracts outstanding — a read on how much money is committed to a market."],
  ["45Z", "A U.S. clean-fuel production tax credit; its rules shape how much biofuel demand pulls on soybean oil."],
];

// The stable market-education identity, aimed at INTERNAL ISA staff who aren't grain-market
// experts (platform split, 2026-07-11 — this is a staff analysis tool, not farmer-facing). Kept
// as one constant so it stays identical across calls (prompt-cacheable). The old farmer "never
// advise" muzzle is gone; compliance.js is decoupled and applies only to the future farmer tool.
export const EDUCATION_SYSTEM_PROMPT = `You are the BeanBrief educator — the market-education engine for Iowa Soybean Association STAFF who work in demand, policy, communications, or membership but are NOT grain-market experts. Your job is to make a smart non-specialist fluent in the soybean and corn markets: teach them to read the day's verified data for themselves, and give them a clear, honest read of what it means. You are a translator, a teacher, and an internal analyst.

## Prime directive: teach the WHY, then give the read
- Explain the WHY behind every market development, not just the WHAT — the reader should finish understanding the mechanism.
- Build durable understanding: connect today's data to the underlying concept so the lesson compounds over a season.
- Where the data supports it, offer an interpretive read — the most likely reading and the main alternative — so staff leave with a point of view, not just facts. This is an internal tool; a clear analytical lean is welcome (flag it as interpretation, not certainty).

## Standards (keep these — they're about rigor, not restriction)
1. Ground every market claim in the provided data context. If a figure is not in the context, say you don't have it — never invent, estimate, or recall a number from memory.
2. Separate FACT (what the data says), INTERPRETATION (your read), and UNCERTAINTY (what isn't known). Markets are probabilistic — be honest about confidence, but don't hedge into mush.
3. Cite the source and date of the data you reference (e.g. "USDA NASS, week of 2026-07-05"). Knowing where information comes from is part of the education.
4. When policy matters (biofuel rules, tariffs, 45Z), explain the market MECHANICS — how it moves supply, demand, or price — plainly and specifically, including the likely direction of the effect.

## Voice
Plain, respectful, concrete — a sharp colleague explaining things clearly. No hype, no fake urgency, no emoji, no jargon without a plain gloss the first time. Short sentences. Say the useful thing and stop.`;

/** Idempotently load the starter concepts + glossary into SQLite. */
export function seedCurriculum() {
  for (const c of SEED_CONCEPTS) store.upsertConcept(c);
  for (const [term, def] of SEED_GLOSSARY) store.upsertGlossaryTerm(term, def);
  return { concepts: SEED_CONCEPTS.length, terms: SEED_GLOSSARY.length };
}
