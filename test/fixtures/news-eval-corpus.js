// Ground-truth labels for news ranking, taken from the REAL stored corpus.
//
// PROVENANCE: every title below is a verbatim row from `seen_items` where source_id IN ('rss',
// 'email_intake') on 2026-07-30 (68 rows, publishers: Farm Progress 50, farmdoc daily 7, Feedstuffs 6,
// Farm Policy News 3, Growth Energy 1, Clean Fuels Alliance 1). Nothing here is invented — that matters,
// because the whole point is measuring against what this feed actually delivers rather than against a
// tidy imagined version of it.
//
// WHY LABEL ONLY THE ENDS. The corpus has a large genuinely-arguable middle ("Cattle and beef markets
// unfazed by New World screwworm" — soybean meal demand, or livestock trivia?). An eval that asserts on
// arguable cases measures the labeller's taste, not the ranker's quality. So only the unambiguous ends
// are labelled: items a Chief Officer of Demand & Policy would be annoyed to MISS, and items they would
// be annoyed to be SHOWN. The middle is deliberately excluded from scoring and listed separately.
//
// THE USER: Matt Herman, Chief Officer for Demand & Policy at the Iowa Soybean Association. Remit is
// soybean DEMAND (crush, soy oil, biofuel, exports, meal) and POLICY (rules, trade, tax credits,
// freedom to operate). Not agronomy how-tos, not equipment, not community features, not personnel.

/**
 * Items that MUST reach him. Each names a decision or a market mechanism he is accountable for.
 * `why` is the justification for the label, so a future session can dispute it on the merits.
 */
export const MUST_REACH = [
  {
    title: "FIFRA overrides state pesticide warning requirements, SCOTUS rules",
    publisher: "Farm Progress",
    body: "U.S. Supreme Court rules federal law preempts state pesticide label warning claims.",
    why: "A Supreme Court preemption ruling on pesticide labelling — directly changes freedom to operate and the litigation exposure behind every crop-protection input Iowa growers buy.",
  },
  {
    title: "USMCA renewal rejected: Annual reviews ahead for farm trade",
    publisher: "Farm Progress",
    why: "The trade architecture governing the two largest U.S. ag export partners moving to annual review is a structural change to market access.",
  },
  {
    title: "How latest Section 45Z rulings impact farmers",
    publisher: "Farm Progress",
    why: "45Z is the clean-fuel production credit — the single largest policy lever on soybean-oil demand, and an active ISA advocacy file.",
  },
  {
    title: "Bayer seeks tariffs on Chinese glyphosate imports",
    publisher: "Farm Progress",
    why: "A trade action on the most-used herbicide: input cost and availability for Iowa growers.",
  },
  {
    title: "USDA releases June 2026 Acreage Report and Grain Stocks",
    publisher: "Farm Progress",
    body:
      'Progressive Farmer reported, "U.S. farmers planted 95.3 million acres of corn and 85.4 million ' +
      'acres of soybeans in 2026, USDA said in its June Acreage report."',
    why: "The two most market-moving USDA supply reports of the quarter; soybean acreage is the top line of the balance sheet.",
  },
  {
    title: "The Unfinished Farm Bill: First Reading of Proposed Senate Legislation",
    publisher: "farmdoc daily (U. of Illinois)",
    why: "Farm bill text is the defining multi-year policy vehicle for commodity programs and crop insurance.",
  },
  {
    title: "Growth Energy Backs U.S. Penalties Against Brazil for Unfair Trade Practices",
    publisher: "Growth Energy (news)",
    why: "Biofuel trade policy against Brazil — simultaneously the competing soybean supplier and a competing ethanol exporter.",
  },
  {
    title: "Crop progress: Soybean quality fades lower",
    publisher: "Farm Progress",
    why: "A deterioration in soybean condition ratings is a direct supply-side price input.",
  },
];

/**
 * Items that must NOT be promoted. Chosen because each is a realistic FALSE POSITIVE for a
 * keyword-only ranker, an obvious irrelevance, or both.
 */
export const NOISE = [
  {
    title: "Clean Fuels Alliance Foundation Welcomes Chelsey Robinson as New Board Director",
    publisher: "Clean Fuels Alliance (news)",
    body: "Robinson brings expertise in agricultural sustainability, biofuel policy and lifecycle carbon accounting.",
    why:
      "THE decisive test case. It contains 'Clean Fuels', 'biofuel' and 'policy', so a keyword ranker scores it " +
      "highly — and it is a personnel announcement with no market or policy consequence whatsoever. If a push " +
      "system ever fires on this, staff stop trusting pushes.",
  },
  {
    title: "AGI appoints Haaris Uddin as CFO",
    publisher: "Feedstuffs",
    why: "Corporate personnel move at an equipment maker. No demand, policy, or price consequence.",
  },
  {
    title: "Dad's 1952 Wheatland tractor returns home after 11 years",
    publisher: "Farm Progress",
    why: "Human-interest feature. The clearest possible negative.",
  },
  {
    title: "Grab a free tree at Husker Harvest Days",
    publisher: "Farm Progress",
    why: "Trade-show promotion.",
  },
  {
    title: "Should I buy aftermarket parts for combine prep?",
    publisher: "Farm Progress",
    why: "Equipment maintenance advice — a farmer-magazine service piece, not intelligence.",
  },
  {
    title: "Hay storage affects bottom line more than you think",
    publisher: "Farm Progress",
    why: "Forage agronomy; not a soybean demand or policy matter.",
  },
  {
    title: "Sharp knives and clean machines: Get your chopper ready",
    publisher: "Farm Progress",
    why: "Silage equipment prep.",
  },
  {
    title: "From weedy mess to best of show",
    publisher: "Farm Progress",
    why: "Feature story. Note it contains 'weed', a plausible crop-protection keyword hit.",
  },
  {
    title: "Celebrate rural towns through art and community",
    publisher: "Farm Progress",
    why: "Community feature.",
  },
  {
    title: "Nomination window for 2027 Indiana Master Farmers is open",
    publisher: "Farm Progress",
    why: "Awards administration.",
  },
];

/**
 * The genuinely arguable middle — recorded, deliberately NOT scored. Listed so that a future session
 * can see the judgement was declined on purpose rather than overlooked, and so nobody "improves" the
 * eval by labelling these to make a number look better.
 */
export const ARGUABLE = [
  "Cattle and beef markets unfazed by New World screwworm",
  "U.S. beef exports to China to pick up as rivals exhaust quotas",
  "Biofuel plant expansion drives demand for Indiana corn",
  "New gene-editing approach could combat soybean nematode parasitism",
  "Geopolitical tensions and high interest rates challenge Brazilian agricultural dominance",
  "Has Ethanol Changed the Long-Term Growth in Total US Corn Use?",
  "High input costs continue to weigh on farmer sentiment",
  "Watch these grain price flash points",
  "Weather rally in grains off and running, for now",
  "Nebraska passes legislation protecting farmer data",
  "Non-GMO Soybeans Profitability: Experience from PCM",
  "Farmland Prices and Government Programs",
];

/**
 * CROSS-OUTLET DUPLICATES — one story, two publishers, two headlines. Both pairs are real rows.
 *
 * This is the measured limit of title-exact event keys (eventkey.js's last-resort tier): the
 * fertilizer pair below is ONE USDA announcement and normalization cannot collapse it, because the
 * headlines share almost no tokens ("$500 Million Expansion of Domestic Fertilizer Production" vs
 * "$500M into fertilizer investment initiative"). The weather pair IS byte-identical and therefore
 * DOES collapse. Kept as a fixture so the difference is provable rather than assumed — it matters most
 * for a future push, where one announcement must produce one notification.
 */
export const CROSS_OUTLET_DUPES = [
  {
    story: "USDA $500M fertilizer initiative",
    titles: [
      "USDA to Fund $500 Million Expansion of Domestic Fertilizer Production",
      "USDA puts $500M into fertilizer investment initiative",
    ],
    collapsesOnTitleExact: false,
  },
  {
    story: "Weather rally in grains",
    titles: ["Weather rally in grains off and running, for now", "Weather rally in grains off and running, for now"],
    collapsesOnTitleExact: true,
  },
];

/** Total rows in the snapshot these labels were drawn from, for reporting denominators honestly. */
export const CORPUS_SIZE = 68;
