// geo.js — resolve an address or event venue to county + legislative districts
// using the free U.S. Census Geocoder (no API key). This is the "where" of §5:
// it powers farmer targeting (which members are in this county/district) and geo-
// tags events. Results are memoized in geo_cache — geography doesn't change, so we
// only ever hit Census once per distinct place. Fail-soft: returns null, never throws.

import { fetchJSON } from "./util.js";
import * as store from "./store.js";

const BASE = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const BENCHMARK = "Public_AR_Current";
const VINTAGE = "Current_Current";

function cacheKey(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Pull county + legislative districts out of a Census "geographies" object. */
function parseGeographies(geo) {
  const out = { county: null, county_fips: null, state: null, districts: {} };
  if (!geo) return out;
  for (const [layer, rows] of Object.entries(geo)) {
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) continue;
    if (/^Counties$/i.test(layer)) {
      out.county = (row.BASENAME || row.NAME || "").replace(/ County$/i, "") || null;
      out.county_fips = row.STATE && row.COUNTY ? `${row.STATE}${row.COUNTY}` : null;
      out.state = out.state || row.STATE || null;
    } else if (/Congressional District/i.test(layer)) {
      out.districts.cd = row.BASENAME || null;
    } else if (/Upper/i.test(layer)) {
      out.districts.sldu = row.BASENAME || null; // state senate
    } else if (/Lower/i.test(layer)) {
      out.districts.sldl = row.BASENAME || null; // state house
    } else if (/^States$/i.test(layer)) {
      out.state = row.STUSAB || out.state;
    }
  }
  return out;
}

/**
 * Geocode an address to { county, county_fips, state, lat, lng, districts, cached }.
 * Cached indefinitely in geo_cache. Returns null on any failure (fail-soft).
 */
export async function geocodeAddress(address, { env = process.env } = {}) {
  if (!address || !address.trim()) return null;
  const key = cacheKey(address);

  const hit = store.getGeoCache(key);
  if (hit) {
    return {
      county: hit.county,
      county_fips: hit.county_fips,
      state: hit.state,
      lat: hit.lat,
      lng: hit.lng,
      districts: hit.districts ? safeParse(hit.districts) : {},
      cached: true,
    };
  }

  const url = `${BASE}?address=${encodeURIComponent(address)}&benchmark=${BENCHMARK}&vintage=${VINTAGE}&format=json`;
  let data;
  try {
    data = await fetchJSON(url);
  } catch (err) {
    if (env.POLIBRIEF_DEBUG) console.log(`   ⚠️ geocode failed for "${address}": ${err.message}`);
    return null; // fail-soft — an unresolved place shouldn't break a run
  }

  const match = data?.result?.addressMatches?.[0];
  if (!match) return null;
  const parsed = parseGeographies(match.geographies);
  const result = {
    county: parsed.county,
    county_fips: parsed.county_fips,
    state: parsed.state,
    lat: match.coordinates?.y ?? null,
    lng: match.coordinates?.x ?? null,
    districts: parsed.districts,
  };
  store.saveGeoCache(key, result);
  return { ...result, cached: false };
}

/** Convenience: just the county name for an address (or null). */
export async function countyForAddress(address, opts) {
  return (await geocodeAddress(address, opts))?.county ?? null;
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
