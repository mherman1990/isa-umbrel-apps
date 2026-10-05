// charts.js — static chart images for the Member Brief (1.42.0).
//
// Email clients run no JavaScript and most strip inline SVG, so the brief's charts are drawn here as SVG
// and rasterised to PNG with resvg (a self-contained renderer with prebuilt binaries for the Pi's ARM64 —
// no browser, no cloud). The PNGs are saved next to the brief and embedded in the email as inline
// (CID) images; the web view serves the same files.
//
// Design (the dataviz method): one y-axis per chart, 2px lines with round joins, hairline solid grid,
// end-dots with a 2px surface ring, a legend whenever there are two or more series plus selective end
// labels, text in text tokens (never the series colour). Light surface only — email is read on light.
// Categorical slots 1–3 of the validated reference palette (all-pairs safe for three series); a
// reference line (the 3-year average) is a recessive gray, labelled, so it is never mistaken for data.

import fs from "node:fs";

export const THEME = {
  surface: "#fcfcfb",
  grid: "#e6e5e1",
  axis: "#c9c8c3",
  text: "#0b0b0b",
  text2: "#52514e",
  muted: "#7d7c78",
  ref: "#9a9994",
  series: ["#2a78d6", "#eb6834", "#1baf7a"],
};
const FONT = "DejaVu Sans, Liberation Sans, Arial, sans-serif";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-29" or "2026-09" → epoch ms (UTC). */
export function periodMs(p) {
  const s = String(p);
  if (/^\d{4}-\d{2}$/.test(s)) return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, 15);
  return Date.parse(s.slice(0, 10) + "T00:00:00Z");
}

/** Clean tick values covering [min,max] (≈5 ticks on 1/2/2.5/5×10^n steps). */
export function niceTicks(min, max, target = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const compact = (v, dec) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(v / 1e3)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
};

/** Month ticks across [x0,x1]: every month, or every 2/3/6/12 months to keep ≤ 7 labels. */
function monthTicks(x0, x1) {
  const d0 = new Date(x0);
  const months = (new Date(x1).getUTCFullYear() - d0.getUTCFullYear()) * 12 + new Date(x1).getUTCMonth() - d0.getUTCMonth();
  const every = [1, 2, 3, 6, 12, 24].find((e) => months / e <= 7) ?? 24;
  const out = [];
  let y = d0.getUTCFullYear();
  let m = d0.getUTCMonth() + 1;
  for (; ; m++) {
    if (m > 11) {
      m = 0;
      y++;
    }
    const t = Date.UTC(y, m, 1);
    if (t > x1) break;
    if (m % every === 0 || every === 1) out.push({ t, label: every >= 12 || m === 0 ? `${MON[m]} ’${String(y).slice(2)}` : MON[m] });
  }
  return out;
}

/**
 * One line chart.
 * @param {{title?:string, unit?:string, decimals?:number, width?:number, height?:number,
 *   series:{label:string, points:{period:string,value:number}[]}[],
 *   reference?:{label:string, points:{period:string,value:number}[]},
 *   markers?:{label:string, period:string, value:number}[], zeroLine?:boolean, legend?:boolean}} spec
 * @returns {string} SVG
 */
export function lineChartSvg(spec) {
  const W = spec.width ?? 680;
  const H = spec.height ?? 300;
  const dec = spec.decimals ?? 0;
  const series = (spec.series ?? []).filter((s) => s.points?.length);
  const ref = spec.reference?.points?.length ? spec.reference : null;
  const markers = spec.markers ?? [];
  const all = [...series.flatMap((s) => s.points), ...(ref?.points ?? []), ...markers].filter((p) => Number.isFinite(p.value));
  const showLegend = spec.legend ?? series.length + (ref ? 1 : 0) >= 2;
  const top = spec.title ? 34 : 12;
  const legendH = showLegend ? 22 : 0;
  // Right margin sized to the end labels it must hold (measured at ~6.7px per character, 11px bold),
  // so a label is never clipped by the image edge.
  const lastOf = (pts) => [...pts].sort((a, b) => periodMs(a.period) - periodMs(b.period)).pop();
  const labelTexts = [...series.map((s) => compact(lastOf(s.points).value, dec)), ...markers.map((mk) => `${mk.label} ${compact(mk.value, dec)}`)];
  const M = { l: 58, r: Math.max(56, 18 + Math.max(0, ...labelTexts.map((t) => t.length)) * 6.7), t: top + legendH, b: 30 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`, `<rect width="${W}" height="${H}" fill="${THEME.surface}"/>`];
  if (spec.title) out.push(`<text x="${M.l}" y="22" font-size="14" font-weight="600" fill="${THEME.text}">${esc(spec.title)}</text>`);
  if (!all.length) {
    out.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="${THEME.muted}">No data stored yet</text></svg>`);
    return out.join("");
  }
  const xs = all.map((p) => periodMs(p.period));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let yMin = Math.min(...all.map((p) => p.value));
  let yMax = Math.max(...all.map((p) => p.value));
  if (spec.zeroLine) {
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
  }
  const ticks = niceTicks(yMin, yMax);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const X = (ms) => M.l + (x1 === x0 ? pw / 2 : ((ms - x0) / (x1 - x0)) * pw);
  const Y = (v) => M.t + ph - ((v - t0) / (t1 - t0 || 1)) * ph;
  // grid + y ticks
  for (const t of ticks) {
    out.push(`<line x1="${M.l}" x2="${M.l + pw}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="${t === 0 && spec.zeroLine ? THEME.axis : THEME.grid}" stroke-width="1"/>`);
    out.push(`<text x="${M.l - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${THEME.text2}">${esc(compact(t, t1 - t0 < 5 ? Math.max(dec, 1) : 0))}</text>`);
  }
  // x ticks
  for (const { t, label } of monthTicks(x0, x1)) {
    out.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${M.t + ph}" y2="${M.t + ph + 4}" stroke="${THEME.axis}" stroke-width="1"/>`);
    out.push(`<text x="${X(t).toFixed(1)}" y="${M.t + ph + 18}" text-anchor="middle" font-size="11" fill="${THEME.text2}">${esc(label)}</text>`);
  }
  const path = (pts) =>
    pts
      .filter((p) => Number.isFinite(p.value))
      .sort((a, b) => periodMs(a.period) - periodMs(b.period))
      .map((p, i) => `${i ? "L" : "M"}${X(periodMs(p.period)).toFixed(1)},${Y(p.value).toFixed(1)}`)
      .join("");
  const endLabels = [];
  if (ref) {
    out.push(`<path d="${path(ref.points)}" fill="none" stroke="${THEME.ref}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  series.forEach((s, i) => {
    const color = THEME.series[i % THEME.series.length];
    out.push(`<path d="${path(s.points)}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    const last = [...s.points].sort((a, b) => periodMs(a.period) - periodMs(b.period)).pop();
    const cx = X(periodMs(last.period));
    const cy = Y(last.value);
    out.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${THEME.surface}"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${color}"/>`);
    endLabels.push({ y: cy, text: compact(last.value, dec) });
  });
  for (const mk of markers) {
    const cx = X(periodMs(mk.period));
    const cy = Y(mk.value);
    out.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${THEME.surface}"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="none" stroke="${THEME.text}" stroke-width="2"/>`);
    endLabels.push({ y: cy, text: `${mk.label} ${compact(mk.value, dec)}` });
  }
  // End labels: only when they don't collide (≥ 14px apart); otherwise the legend carries identity.
  const sorted = [...endLabels].sort((a, b) => a.y - b.y);
  const collide = sorted.some((l, i) => i && l.y - sorted[i - 1].y < 14);
  if (!collide) for (const l of endLabels) out.push(`<text x="${M.l + pw + 10}" y="${(l.y + 4).toFixed(1)}" font-size="11" font-weight="600" fill="${THEME.text}">${esc(l.text)}</text>`);
  // legend: a short line-key beside each label (identity is never colour-alone: order + label)
  if (showLegend) {
    let lx = M.l;
    const ly = top + 8;
    const items = series.map((s, i) => ({ label: s.label, color: THEME.series[i % THEME.series.length], w: 2 }));
    if (ref) items.push({ label: ref.label, color: THEME.ref, w: 1.5 });
    for (const it of items) {
      out.push(`<line x1="${lx}" x2="${lx + 16}" y1="${ly}" y2="${ly}" stroke="${it.color}" stroke-width="${it.w + 1}" stroke-linecap="round"/>`);
      out.push(`<text x="${lx + 22}" y="${ly + 4}" font-size="11" fill="${THEME.text2}">${esc(it.label)}</text>`);
      lx += 34 + it.label.length * 6.4;
    }
  }
  out.push("</svg>");
  return out.join("");
}

/**
 * Small multiples: one panel per entity, each its own single-series line chart (+ optional reference),
 * stacked vertically in one image — for 5 barge segments whose levels differ, rather than 5 crossing lines.
 */
export function smallMultiplesSvg(panels, { width = 680, panelHeight = 150, title = "" } = {}) {
  const ref = panels.find((p) => p.reference?.points?.length)?.reference?.label;
  const head = (title ? 30 : 0) + (ref ? 22 : 0);
  const H = head + panels.length * panelHeight;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" font-family="${FONT}">`, `<rect width="${width}" height="${H}" fill="${THEME.surface}"/>`];
  if (title) parts.push(`<text x="58" y="20" font-size="14" font-weight="600" fill="${THEME.text}">${esc(title)}</text>`);
  // One key for every panel: the line is the segment, the gray line its reference.
  if (ref) {
    const ky = (title ? 30 : 0) + 8;
    parts.push(`<line x1="58" x2="74" y1="${ky}" y2="${ky}" stroke="${THEME.series[0]}" stroke-width="3" stroke-linecap="round"/><text x="80" y="${ky + 4}" font-size="11" fill="${THEME.text2}">Last 12 months</text>`);
    parts.push(`<line x1="190" x2="206" y1="${ky}" y2="${ky}" stroke="${THEME.ref}" stroke-width="2.5" stroke-linecap="round"/><text x="212" y="${ky + 4}" font-size="11" fill="${THEME.text2}">${esc(ref)}</text>`);
  }
  panels.forEach((p, i) => {
    const inner = lineChartSvg({ ...p, width, height: panelHeight, legend: false })
      .replace(/^<svg[^>]*>/, "")
      .replace(/<\/svg>$/, "");
    parts.push(`<g transform="translate(0 ${head + i * panelHeight})">${inner}</g>`);
  });
  parts.push("</svg>");
  return parts.join("");
}

let Resvg = null;
const FONT_FILES = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"].filter((f) => fs.existsSync(f));

/** SVG → PNG buffer (2× for crisp email display). Throws when the renderer is unavailable. */
export async function svgToPng(svg) {
  if (!Resvg) ({ Resvg } = await import("@resvg/resvg-js"));
  const r = new Resvg(svg, {
    fitTo: { mode: "zoom", value: 2 },
    font: { loadSystemFonts: true, fontFiles: FONT_FILES, defaultFontFamily: "DejaVu Sans" },
  });
  return r.render().asPng();
}
