// scripts/fetch-incumbents.mjs — one-off builder for the /map page's incumbent roster.
//
// The 2026 candidate seed (src/data/ia-candidates-2026.json) reliably lists who FILED, but not
// who currently HOLDS each seat — so the map can't name incumbents or color a district by the
// seat-holder's party from it alone. This distills the current Iowa legislature roster from the
// OpenStates bulk export (keyless) down to monitoring-core fields only — name / party / chamber /
// district, no contact PII — and writes src/data/ia-incumbents.json (vendored, like the candidates).
// Re-run after an election seats a new legislature:  node scripts/fetch-incumbents.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "ia-incumbents.json");
const SRC = "https://data.openstates.org/people/current/ia.csv";

// Minimal RFC-4180-ish CSV parser (handles quoted fields with commas/quotes; no embedded newlines
// in the columns we keep).
function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

const PARTY = { Democratic: "D", Republican: "R", Independent: "I", Libertarian: "L", Green: "G" };

async function main() {
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`OpenStates roster HTTP ${res.status}`);
  const rows = parseCSV(await res.text());
  const header = rows.shift();
  const col = (name) => header.indexOf(name);
  const iName = col("name");
  const iParty = col("current_party");
  const iDist = col("current_district");
  const iCh = col("current_chamber");

  const incumbents = [];
  for (const r of rows) {
    const chamber = r[iCh];
    const district = r[iDist];
    if ((chamber !== "lower" && chamber !== "upper") || !district) continue;
    incumbents.push({
      name: r[iName],
      party: PARTY[r[iParty]] || r[iParty] || "?",
      chamber,
      district: String(district),
    });
  }
  incumbents.sort((a, b) => a.chamber.localeCompare(b.chamber) || Number(a.district) - Number(b.district));

  const doc = {
    source: "OpenStates current people (data.openstates.org), Iowa",
    generatedAt: "2026-07-10",
    note: "Current Iowa legislature roster for incumbent identification on /map — name/party/chamber/district only; contact PII intentionally omitted.",
    count: incumbents.length,
    incumbents,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  const h = incumbents.filter((i) => i.chamber === "lower").length;
  const s = incumbents.filter((i) => i.chamber === "upper").length;
  console.log(`Wrote ${incumbents.length} incumbents (${h} House, ${s} Senate) → ${path.relative(process.cwd(), OUT)}`);
}

main();
