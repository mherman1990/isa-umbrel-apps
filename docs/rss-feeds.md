# Ag-news RSS feeds — candidate list for the `rss` adapter

Feeds flow through the existing `rss` adapter → **News** class (News tab), attributed to a
registry entity. Wiring = add each as an entity with an `rss` channel in `registry.json`; the
Registry page's channel-health guard flags dead feeds on the Pi.

**Reality check learned while verifying these:** *government* and *advocacy-group* feeds are the
reliable RSS wins. Most *commercial* ag-news sites either retired public RSS, paywall it, or
**block automated fetchers (403)** — so for those, the newsletter→`beanbrief@` route we already
built is actually more dependable than RSS. Status: ✅ verified live here · ⚠️ verify on Pi
(flaked here, likely the office LAN's Cloudflare quirk) · 🔒 blocks bots / paywalled (try from Pi).

## 1. Government agencies
| Source | Feed | Status |
|---|---|---|
| CFTC press releases | https://www.cftc.gov/RSS/RSSGP/rssgp.xml | ✅ |
| USDA press releases | https://www.usda.gov/media/press-releases/rss.xml | ⚠️ |
| EPA news releases | https://www.epa.gov/newsreleases/search/rss | ⚠️ |
| USDA NASS newsroom | https://www.nass.usda.gov/Newsroom/rss/ | ⚠️ |
| USTR press office | https://ustr.gov/about-us/policy-offices/press-office/press-releases.rss | ⚠️ |
| FDA (food/nutrition — MAHA) | https://www.fda.gov/food/rss.xml | ⚠️ |

*(Federal Register + Regulations.gov are already covered by their own adapters — no RSS needed.)*

## 2. News agencies / wire services
| Source | Feed | Status |
|---|---|---|
| Farm Progress | https://www.farmprogress.com/rss.xml | ✅ |
| Agri-Pulse (headlines) | https://www.agri-pulse.com/rss/1-agriculture-news | ✅ |
| Brownfield Ag News | https://www.brownfieldagnews.com/feed/ | 🔒 |
| AgWeb / Farm Journal | https://www.agweb.com/rss.xml | 🔒 |
| Successful Farming | https://www.agriculture.com/feeds/all/rss.xml | 🔒 (paywall) |
| Radio Iowa (agriculture) | https://www.radioiowa.com/category/agriculture/feed/ | 🔒 |
| Reuters / AP agriculture | — | mostly retired public RSS; rely on newsletters |

## 3. Commodity / trade groups (on-topic by construction — high signal)
| Source | Feed (WordPress `/feed/` where applicable) | Status |
|---|---|---|
| American Soybean Association | https://soygrowers.com/feed/ | ⚠️ |
| Renewable Fuels Association | https://ethanolrfa.org/feed/ | ⚠️ |
| Growth Energy | https://growthenergy.org/feed/ | ⚠️ |
| Clean Fuels Alliance America | https://cleanfuels.org/feed/ | ⚠️ |
| National Corn Growers | https://ncga.com/feed/ | ⚠️ |
| Iowa Soybean Association (own org) | https://www.iasoybeans.com/feed | ⚠️ |

## Recommendation
Wire **tier 1 (gov) + tier 3 (advocacy)** first — they're reliable and on-topic. Treat the
commercial-news feeds (tier 2 🔒) as best-effort; where they block us, the newsletter route wins.
Since these feed the **News** tab and its coming AI digest, wiring them pairs naturally with the
News-tab redesign.
