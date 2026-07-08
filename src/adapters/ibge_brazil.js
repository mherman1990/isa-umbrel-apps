// ibge_brazil.js — Brazil IBGE SIDRA (LSPA), keyless. Brazil is the U.S.'s main soybean
// export competitor, so its crop size is a demand-side signal for U.S. soy. "markets"-class.
//
// Source: SIDRA aggregate 1618 ("Área plantada, área colhida e produção, por ano da safra e
// produto"), the current LSPA estimate. It reports the latest + prior CROP YEAR (safra), so
// this yields ~2 recent points per series — real and current (record 2026 crop), but short.
// A long historical production trend would come from PAM (aggregate 1612) — see the queue
// Punch-list. Variable 35 = Produção (t), 216 = Área colhida (ha); Produto Soja = 48[39443].

import { fetchJSON } from "../util.js";

export const id = "ibge_brazil";
export const label = "IBGE (Brazil crops)";

const BASE = "https://servicodados.ibge.gov.br/api/v3/agregados/1618";
const SOY = "48[39443]"; // Produto das lavouras = Soja
const CROP_YEARS = "49[all]"; // Ano da safra — all crop years in the latest estimate

// PAM (Produção Agrícola Municipal, aggregate 1612) — FINAL annual production, long history
// (1974–), for the multi-year Brazil production trend chart. Variable 214 = produção (t),
// Produto Soja = classification 81[2713].
async function pamAnnualProduction() {
  const url = "https://servicodados.ibge.gov.br/api/v3/agregados/1612/periodos/-16/variaveis/214?localidades=N1[all]&classificacao=81[2713]";
  const j = await fetchJSON(url);
  const serie = j?.[0]?.resultados?.[0]?.series?.[0]?.serie ?? {};
  return Object.entries(serie)
    .map(([period, raw]) => ({ period, value: Number(String(raw).replace(/[^\d.-]/g, "")) }))
    .filter((p) => /^\d{4}$/.test(p.period) && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.period.localeCompare(b.period));
}

async function bySafra(variable) {
  const url = `${BASE}/periodos/-1/variaveis/${variable}?localidades=N1[all]&classificacao=${SOY}|${CROP_YEARS}`;
  const j = await fetchJSON(url);
  const unit = j?.[0]?.unidade ?? "";
  const points = [];
  for (const res of j?.[0]?.resultados ?? []) {
    const cyCat = res.classificacoes?.find((c) => String(c.id) === "49")?.categoria ?? {};
    const cyName = Object.values(cyCat)[0]; // e.g. "Safra 2026"
    const yr = String(cyName).match(/(\d{4})/);
    const raw = Object.values(res.series?.[0]?.serie ?? {})[0];
    const val = Number(String(raw).replace(/[^\d.-]/g, ""));
    if (yr && Number.isFinite(val) && raw !== "..." && raw !== "-") points.push({ period: yr[1], value: val });
  }
  points.sort((a, b) => a.period.localeCompare(b.period));
  return { unit, points };
}

export async function fetchItems() {
  try {
    const prod = await bySafra("35");
    if (!prod.points.length) return [];
    const last = prod.points[prod.points.length - 1];
    return [
      {
        uid: `${id}:soy-production:${last.period}`,
        sourceId: id,
        sourceLabel: label,
        title: `Brazil soybean production (${last.period} crop): ${(last.value / 1e6).toFixed(1)}M metric tons`,
        summary: "IBGE LSPA — Brazil's soybean crop, the main competitor for U.S. soybean exports.",
        url: "https://sidra.ibge.gov.br/tabela/1618",
        publishedAt: new Date().toISOString(),
        jurisdiction: "International",
        docType: "data",
        raw: { metric: "br_soy_production", value: last.value, unit: prod.unit, period: last.period },
      },
    ];
  } catch {
    return [];
  }
}

/** Returns [{ series, meta, points }] — queryable by the master engine (charts optional). */
export async function fetchSeries() {
  const out = [];
  try {
    const prod = await bySafra("35");
    if (prod.points.length) out.push({ series: `${id}:soy-production`, meta: { label: "Brazil soybean production", unit: "t", category: "brazil_soy" }, points: prod.points });
  } catch {
    /* fail-soft */
  }
  try {
    const area = await bySafra("216");
    if (area.points.length) out.push({ series: `${id}:soy-area`, meta: { label: "Brazil soybean area harvested", unit: "ha", category: "brazil_soy_area" }, points: area.points });
  } catch {
    /* fail-soft */
  }
  try {
    const annual = await pamAnnualProduction();
    if (annual.length) out.push({ series: `${id}:soy-production-annual`, meta: { label: "Brazil soybean production", unit: "t", category: "brazil_production" }, points: annual });
  } catch {
    /* fail-soft */
  }
  return out;
}
