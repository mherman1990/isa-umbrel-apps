// scripts/build-district-hucs.mjs — precompute which HUC8 watersheds each political district
// overlaps, so the /map hover card can list them (a district typically spans several HUC8s).
//
// Reads the vendored boundary GeoJSON (src/assets/geo/{house,senate,congress,huc8}.geojson) and
// writes src/data/district-hucs.json: a code→name map plus, per layer, district-key → [huc codes].
// Self-contained geometry (bbox prefilter + point-in-polygon + segment-intersection) — no deps,
// matching the repo's no-build-tooling philosophy. Re-run if the boundaries change:
//   node scripts/build-district-hucs.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEO = path.join(ROOT, "src", "assets", "geo");
const OUT = path.join(ROOT, "src", "data", "district-hucs.json");

const read = (name) => JSON.parse(fs.readFileSync(path.join(GEO, `${name}.geojson`), "utf8"));

// --- geometry helpers (lon/lat treated as planar x/y — fine for overlap tests at this scale) ---

/** Outer rings of a Polygon/MultiPolygon as arrays of [x,y] (holes ignored — negligible here). */
function outerRings(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates[0]];
  if (geom.type === "MultiPolygon") return geom.coordinates.map((poly) => poly[0]);
  return [];
}

function bboxOfRings(rings) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
  }
  return [minx, miny, maxx, maxy];
}

function bboxOverlap(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Ray-casting point-in-ring; true if pt is inside ANY of the outer rings. */
function pointInRings(pt, rings) {
  const [x, y] = pt;
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function ccw(a, b, c) {
  return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
}
/** Do segments AB and CD properly cross? */
function segCross(a, b, c, d) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function anyEdgeCross(ringsA, ringsB) {
  for (const ra of ringsA) {
    for (let i = 1; i < ra.length; i++) {
      const a1 = ra[i - 1], a2 = ra[i];
      for (const rb of ringsB) {
        for (let k = 1; k < rb.length; k++) {
          if (segCross(a1, a2, rb[k - 1], rb[k])) return true;
        }
      }
    }
  }
  return false;
}

/** True if the two polygons overlap: one contains a vertex of the other, or their edges cross. */
function polysOverlap(A, B) {
  if (!bboxOverlap(A.bbox, B.bbox)) return false;
  if (A.rings.some((r) => r.some((pt) => pointInRings(pt, B.rings)))) return true;
  if (B.rings.some((r) => r.some((pt) => pointInRings(pt, A.rings)))) return true;
  return anyEdgeCross(A.rings, B.rings);
}

function prep(feature) {
  const rings = outerRings(feature.geometry);
  return { key: feature.properties.key, name: feature.properties.name, rings, bbox: bboxOfRings(rings) };
}

// --- build ---

const hucFeatures = read("huc8").features.map(prep);
const hucNames = {};
for (const h of hucFeatures) hucNames[h.key] = h.name;

function overlapsFor(layerName) {
  const out = {};
  const districts = read(layerName).features.map(prep);
  for (const d of districts) {
    const hits = [];
    for (const h of hucFeatures) if (polysOverlap(d, h)) hits.push(h.key);
    hits.sort();
    out[d.key] = hits;
  }
  return out;
}

const doc = {
  generatedFrom: "src/assets/geo/{house,senate,congress,huc8}.geojson",
  note: "Per political district, the HUC8 watersheds it overlaps (a district usually spans several). Codes map to hucNames.",
  hucNames,
  house: overlapsFor("house"),
  senate: overlapsFor("senate"),
  congress: overlapsFor("congress"),
};
fs.writeFileSync(OUT, JSON.stringify(doc));

const stat = (layer) => {
  const vals = Object.values(doc[layer]);
  const counts = vals.map((v) => v.length);
  const avg = (counts.reduce((a, c) => a + c, 0) / counts.length).toFixed(1);
  return `${layer}: ${vals.length} districts, avg ${avg} HUC8s (min ${Math.min(...counts)}, max ${Math.max(...counts)})`;
};
console.log(`Wrote ${path.relative(ROOT, OUT)} — ${Object.keys(hucNames).length} HUC8s`);
console.log("  " + stat("house"));
console.log("  " + stat("senate"));
console.log("  " + stat("congress"));
