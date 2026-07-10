// scripts/fetch-geo.mjs — one-off builder for the /map page's boundary data.
//
// Fetches Iowa political + conservation boundaries from public GIS services, simplifies
// them server-side (ArcGIS maxAllowableOffset — deterministic Douglas–Peucker, so shared
// borders between adjacent polygons stay coincident), normalizes each feature's props to a
// tiny { key, name } shape, and writes one GeoJSON file per layer into src/assets/geo/.
//
// The outputs are vendored (committed) so the app ships self-contained — no runtime GIS
// calls, matching how uPlot is vendored. Re-run only when the boundaries change (a decade):
//   node scripts/fetch-geo.mjs
//
// Sources (all free, no key):
//   • U.S. Census TIGERweb  — counties, congressional + state legislative districts
//   • Iowa REAP/IDALS       — the 100 Soil & Water Conservation Districts
//   • USGS Watershed Boundary Dataset — HUC8 subbasins intersecting Iowa

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "geo");

// Iowa bounding box (a little padding) — used to grab whole watersheds that touch the state.
const IOWA_BBOX = { xmin: -96.65, ymin: 40.37, xmax: -90.14, ymax: 43.51, spatialReference: { wkid: 4326 } };

const TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";

const LAYERS = [
  {
    name: "counties",
    url: `${TIGER}/State_County/MapServer/1/query`,
    params: { where: "GEOID LIKE '19%'", outFields: "BASENAME,GEOID", maxAllowableOffset: 0.003 },
    map: (p) => ({ key: p.BASENAME, name: `${p.BASENAME} County` }),
  },
  {
    name: "congress",
    url: `${TIGER}/Legislative/MapServer/0/query`,
    params: { where: "GEOID LIKE '19%'", outFields: "BASENAME,NAME,GEOID", maxAllowableOffset: 0.003 },
    map: (p) => ({ key: String(Number(p.BASENAME)), name: `Iowa Congressional District ${Number(p.BASENAME)}` }),
  },
  {
    name: "senate",
    url: `${TIGER}/Legislative/MapServer/1/query`,
    params: { where: "GEOID LIKE '19%'", outFields: "BASENAME,GEOID", maxAllowableOffset: 0.003 },
    map: (p) => ({ key: String(Number(p.BASENAME)), name: `Iowa Senate District ${Number(p.BASENAME)}` }),
  },
  {
    name: "house",
    url: `${TIGER}/Legislative/MapServer/2/query`,
    params: { where: "GEOID LIKE '19%'", outFields: "BASENAME,GEOID", maxAllowableOffset: 0.003 },
    map: (p) => ({ key: String(Number(p.BASENAME)), name: `Iowa House District ${Number(p.BASENAME)}` }),
  },
  {
    name: "huc8",
    url: "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/4/query",
    params: {
      where: "1=1",
      outFields: "huc8,name",
      maxAllowableOffset: 0.003,
      geometry: JSON.stringify(IOWA_BBOX),
      geometryType: "esriGeometryEnvelope",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
    },
    map: (p) => ({ key: p.huc8, name: p.name }),
  },
];

async function fetchLayer(layer) {
  const params = new URLSearchParams({
    returnGeometry: "true",
    geometryPrecision: "4",
    outSR: "4326",
    f: "geojson",
    ...Object.fromEntries(Object.entries(layer.params).map(([k, v]) => [k, String(v)])),
  });
  const url = `${layer.url}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${layer.name}: HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc.features?.length) throw new Error(`${layer.name}: no features (check where/geometry)`);
  // Normalize props to { key, name } and drop everything else to keep files tiny.
  const features = doc.features.map((f) => ({ type: "Feature", properties: layer.map(f.properties), geometry: f.geometry }));
  return { type: "FeatureCollection", features };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const layer of LAYERS) {
    process.stdout.write(`↓ ${layer.name} … `);
    try {
      const fc = await fetchLayer(layer);
      const outPath = path.join(OUT_DIR, `${layer.name}.geojson`);
      fs.writeFileSync(outPath, JSON.stringify(fc));
      const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
      console.log(`${fc.features.length} features, ${kb} KB`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      process.exitCode = 1;
    }
  }
}

main();
