/* studio.js — client for The Bean Brief "Studio" chart workbench (desktop-only).
 *
 * A "chart spec" { series[], transform, overlays, rangeMonths, focus } is the single source of
 * truth. The rail + toolbar write the spec; this file fetches the points from /api/studio/*,
 * applies the transform, and renders with the vendored uPlot. The spec also serializes to the URL
 * (?spec=) so a view is shareable/reproducible — the same seam a phase-2 LLM prompt bar will write.
 *
 * Vendored/static, no build step (loaded after uPlot on /studio). Plain ES5-ish, like bbcharts.js.
 * Server never invents data; transforms here are pure functions over stored points.
 */
(function () {
  var app = document.getElementById("studio-app");
  var gate = document.getElementById("studio-gate");
  if (!app) return;

  var PALETTE = ["#004A8D", "#C65E35", "#0070C3", "#91A22B", "#8e7cc3", "#FFC425", "#c0392b", "#5DCAA5", "#9AB8D2", "#BA7517"];
  var DAY = 86400;
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var state = {
    catalog: null,
    data: null,        // last /api/studio/series response { series, stats }
    events: [],        // dated flags for the current range
    spec: { series: [], transform: "none", overlays: { normalBand: true, events: true }, rangeMonths: 36, focus: null },
    charts: [],        // { u, minTs, maxTs }
  };

  // ---------- small utils ----------
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "class") e.className = attrs[k]; else if (k === "html") e.innerHTML = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function periodToTs(p) { var m = String(p).split("-"); return Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1) / 1000; }
  function isMonthStart(dt) { return dt.getUTCDate() === 1; }
  function fmtNum(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toLocaleString();
    if (a >= 10) return (Math.round(v * 10) / 10).toString();
    return (Math.round(v * 100) / 100).toString();
  }
  function fmtPct(v) { return v == null || isNaN(v) ? "—" : (v >= 0 ? "+" : "") + (Math.round(v * 10) / 10) + "%"; }
  function fmtAxisX(ts) {
    var dt = new Date(ts * 1000);
    if (isMonthStart(dt)) return dt.getUTCMonth() === 0 ? String(dt.getUTCFullYear()) : MON[dt.getUTCMonth()] + " '" + String(dt.getUTCFullYear()).slice(2);
    return MON[dt.getUTCMonth()] + " " + dt.getUTCDate();
  }
  function fmtHoverX(ts) { var dt = new Date(ts * 1000); return MON[dt.getUTCMonth()] + " " + (isMonthStart(dt) ? dt.getUTCFullYear() : dt.getUTCDate() + ", " + dt.getUTCFullYear()); }
  function b64urlEncode(o) { try { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); } catch (e) { return ""; } }
  function b64urlDecode(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))))); } catch (e) { return null; } }

  // ---------- desktop gate ----------
  function gateCheck() {
    var wide = window.innerWidth >= 1000;
    app.style.display = wide ? "" : "none";
    if (gate) gate.style.display = wide ? "none" : "block";
  }
  window.addEventListener("resize", function () { gateCheck(); });

  // ---------- transforms (pure) ----------
  // Build aligned lines for the current transform. Returns { xs:[ts], lines:[{label,unit,values,scale}] }.
  function buildLines(seriesList, transform, focusId) {
    if (transform === "seasonal") return buildSeasonal(seriesList, focusId);
    // union of all periods across chosen series
    var pset = {};
    seriesList.forEach(function (s) { s.points.forEach(function (p) { pset[p.period] = 1; }); });
    var periods = Object.keys(pset).sort();
    var xs = periods.map(periodToTs);

    if (transform === "ratio") {
      if (seriesList.length < 2) return { xs: xs, lines: [], note: "Pick two series for a ratio (A ÷ B)." };
      var A = mapOf(seriesList[0]), B = mapOf(seriesList[1]);
      var rv = periods.map(function (p) { var a = A[p], b = B[p]; return (a != null && b != null && b !== 0) ? a / b : null; });
      return { xs: xs, lines: [{ label: seriesList[0].label + " ÷ " + seriesList[1].label, unit: "ratio", values: rv, scale: "y" }] };
    }

    var lines = seriesList.map(function (s) {
      var m = mapOf(s);
      var raw = periods.map(function (p) { return p in m ? m[p] : null; });
      var values, unit;
      if (transform === "rebase100") { values = rebase(raw); unit = "index (100=start)"; }
      else if (transform === "yoy") { values = yoy(periods, m); unit = "% YoY"; }
      else { values = raw; unit = s.unit || ""; }
      return { label: s.label, unit: unit, values: values, scale: "y" };
    });
    // For raw ("none"): assign up to two distinct units to two y-axes so different scales stay readable.
    if (transform === "none") assignScales(lines);
    return { xs: xs, lines: lines };
  }
  function mapOf(s) { var m = {}; s.points.forEach(function (p) { m[p.period] = p.value; }); return m; }
  function rebase(raw) {
    var base = null; for (var i = 0; i < raw.length; i++) { if (raw[i] != null) { base = raw[i]; break; } }
    if (base == null || base === 0) return raw.slice();
    return raw.map(function (v) { return v == null ? null : (v / base) * 100; });
  }
  function yoy(periods, m) {
    var ts = periods.map(periodToTs);
    return periods.map(function (p, i) {
      var target = ts[i] - 365 * DAY, best = null, bestD = Infinity;
      for (var j = 0; j < periods.length; j++) { var d = Math.abs(ts[j] - target); if (d < bestD) { bestD = d; best = periods[j]; } }
      if (bestD > 45 * DAY) return null;
      var cur = m[p], prev = m[best];
      return (cur != null && prev != null && prev !== 0) ? ((cur - prev) / Math.abs(prev)) * 100 : null;
    });
  }
  function assignScales(lines) {
    var units = [];
    lines.forEach(function (l) { if (units.indexOf(l.unit) < 0) units.push(l.unit); });
    if (units.length <= 1) return;
    lines.forEach(function (l) { l.scale = l.unit === units[0] ? "y" : "y2"; });
  }
  // Seasonality: overlay each calendar year of the focus series as its own line on a Jan–Dec axis.
  function buildSeasonal(seriesList, focusId) {
    var s = pick(seriesList, focusId) || seriesList[0];
    if (!s) return { xs: [], lines: [] };
    var byYear = {};
    s.points.forEach(function (p) {
      var m = String(p.period).split("-"); if (m.length < 2) return;
      var yr = m[0], nd = Date.UTC(2000, (+m[1] || 1) - 1, +m[2] || 1) / 1000;
      (byYear[yr] = byYear[yr] || {})[nd] = p.value;
    });
    var xset = {}; for (var y in byYear) for (var nd in byYear[y]) xset[nd] = 1;
    var xs = Object.keys(xset).map(Number).sort(function (a, b) { return a - b; });
    var years = Object.keys(byYear).sort();
    var lines = years.map(function (y) { return { label: y, unit: s.unit || "", scale: "y", values: xs.map(function (nd) { return nd in byYear[y] ? byYear[y][nd] : null; }) }; });
    return { xs: xs, lines: lines, seasonal: true, focusLabel: s.label };
  }
  function pick(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }

  // ---------- overlays (uPlot plugins) ----------
  function bandPlugin(getBand) {
    return { hooks: { drawClear: function (u) {
      var b = getBand(); if (!b) return;
      var y0 = u.valToPos(b.hi, "y", true), y1 = u.valToPos(b.lo, "y", true);
      u.ctx.save(); u.ctx.fillStyle = "rgba(0,74,141,0.08)";
      u.ctx.fillRect(u.bbox.left, Math.min(y0, y1), u.bbox.width, Math.abs(y1 - y0)); u.ctx.restore();
    } } };
  }
  function eventsPlugin(showLabels) {
    return { hooks: { draw: function (u) {
      if (!state.spec.overlays.events || !state.events.length) return;
      var min = u.scales.x.min, max = u.scales.x.max;
      u.ctx.save();
      u.ctx.beginPath(); u.ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height); u.ctx.clip();
      state.events.forEach(function (ev, i) {
        var ts = periodToTs(ev.date); if (ts < min || ts > max) return;
        var x = u.valToPos(ts, "x", true);
        u.ctx.strokeStyle = ev.kind === "alert" ? "rgba(198,94,53,0.55)" : "rgba(142,124,195,0.7)";
        u.ctx.setLineDash([3, 3]); u.ctx.lineWidth = 1;
        u.ctx.beginPath(); u.ctx.moveTo(x, u.bbox.top); u.ctx.lineTo(x, u.bbox.top + u.bbox.height); u.ctx.stroke();
        if (showLabels) {
          u.ctx.setLineDash([]); u.ctx.fillStyle = ev.kind === "alert" ? "#9e4a24" : "#5b4a9c";
          u.ctx.font = "10px system-ui, sans-serif"; u.ctx.textAlign = "left";
          u.ctx.save(); u.ctx.translate(x + 3, u.bbox.top + 2 + (i % 2) * 12); u.ctx.fillText(shortLabel(ev.label), 0, 8); u.ctx.restore();
        }
      });
      u.ctx.restore();
    } } };
  }
  function shortLabel(s) { s = String(s); return s.length > 22 ? s.slice(0, 21) + "…" : s; }
  function quantile(sorted, q) { if (!sorted.length) return null; var pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base; return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base]; }
  function focusBand() {
    if (!state.spec.overlays.normalBand || state.spec.transform !== "none") return null;
    var s = pick(state.data.series, currentFocus()); if (!s) return null;
    var vals = s.points.map(function (p) { return p.value; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
    if (vals.length < 8) return null;
    return { lo: quantile(vals, 0.1), hi: quantile(vals, 0.9) };
  }

  // ---------- rendering ----------
  function destroyCharts() { state.charts.forEach(function (c) { try { c.u.destroy(); } catch (e) {} }); state.charts = []; }
  function currentFocus() { return state.spec.focus && seriesSelected(state.spec.focus) ? state.spec.focus : state.spec.series[0]; }
  function seriesSelected(id) { return state.spec.series.indexOf(id) >= 0; }

  function draw() {
    var panes = document.getElementById("studio-panes");
    var legend = document.getElementById("studio-legend");
    var caption = document.getElementById("studio-caption");
    destroyCharts(); panes.innerHTML = ""; legend.innerHTML = ""; caption.innerHTML = "";
    if (!state.data || !state.data.series.length) {
      panes.appendChild(el("div", { class: "st-empty" }, ["Pick one or more series on the left to build a chart."]));
      renderStats(); updateExportLinks(); return;
    }
    var built;
    try { built = buildLines(state.data.series, state.spec.transform, currentFocus()); }
    catch (e) { panes.appendChild(el("div", { class: "st-empty" }, ["Couldn't build that view."])); return; }
    if (!built.lines.length) { panes.appendChild(el("div", { class: "st-empty" }, [built.note || "Nothing to plot."])); renderStats(); return; }
    if (built.xs.length < 2) { panes.appendChild(el("div", { class: "st-empty" }, ["Not enough history yet for this view."])); renderStats(); return; }

    // caption chips
    caption.appendChild(el("span", { class: "st-title" }, [built.seasonal ? built.focusLabel + " — seasonality" : (state.data.series.length === 1 ? state.data.series[0].label : state.data.series.length + " series")]));
    var tf = transformLabel(state.spec.transform);
    if (tf && !built.seasonal) caption.appendChild(el("span", { class: "st-chip" }, [tf]));
    if (state.spec.overlays.normalBand && focusBand()) caption.appendChild(el("span", { class: "st-chip" }, ["normal band"]));

    var hasY2 = built.lines.some(function (l) { return l.scale === "y2"; });
    var box = el("div", {}); panes.appendChild(box);

    var data = [built.xs].concat(built.lines.map(function (l) { return l.values; }));
    var uSeries = [{ value: function (u, ts) { return ts == null ? "—" : (built.seasonal ? seasonalX(ts) : fmtHoverX(ts)); } }];
    built.lines.forEach(function (l, i) {
      uSeries.push({ label: l.label, scale: l.scale, stroke: PALETTE[i % PALETTE.length], width: 2, spanGaps: true, points: { show: false },
        value: function (u, v) { return v == null ? "—" : fmtNum(v) + unitSuffix(l.unit); } });
    });
    var axes = [{ values: function (u, s) { return s.map(built.seasonal ? seasonalX : fmtAxisX); }, grid: { stroke: "#eef2f6" }, ticks: { stroke: "#e0e0e0" } },
      { scale: "y", grid: { stroke: "#eef2f6" }, ticks: { stroke: "#e0e0e0" }, values: function (u, s) { return s.map(fmtNum); } }];
    if (hasY2) axes.push({ scale: "y2", side: 1, grid: { show: false }, values: function (u, s) { return s.map(fmtNum); } });

    var scales = { x: built.seasonal ? {} : { time: true } };
    var plugins = [eventsPlugin(true)];
    if (!built.seasonal) plugins.unshift(bandPlugin(focusBand));

    var u = new uPlot({
      width: box.clientWidth || 700, height: 380,
      scales: scales, axes: axes, series: uSeries, plugins: plugins,
      legend: { live: true }, cursor: { focus: { prox: 24 } },
    }, data, box);
    state.charts.push({ u: u, minTs: built.xs[0], maxTs: built.xs[built.xs.length - 1] });
    sizeCharts();
    applyRange();

    // legend row (click a swatch to focus that series → drives stats + band)
    built.lines.forEach(function (l, i) {
      var focable = !built.seasonal && state.spec.transform === "none" && pick(state.data.series, seriesIdByLabel(l.label));
      var item = el("span", { class: focable ? "lg-foc" : "" }, []);
      item.appendChild(el("span", { class: "lg-sw", style: "background:" + PALETTE[i % PALETTE.length] }, []));
      item.appendChild(document.createTextNode(l.label + (l.scale === "y2" ? " (right)" : "")));
      if (focable) item.addEventListener("click", function () { state.spec.focus = seriesIdByLabel(l.label); syncURL(); draw(); });
      legend.appendChild(item);
    });
    if (state.spec.overlays.events && state.events.length) {
      var evc = el("span", {}, []); evc.appendChild(el("span", { class: "lg-sw", style: "background:#8e7cc3" }, [])); evc.appendChild(document.createTextNode("policy / report event"));
      legend.appendChild(evc);
    }
    renderStats(); updateExportLinks();
  }
  function seriesIdByLabel(lb) { var s = state.data.series.filter(function (x) { return x.label === lb; })[0]; return s ? s.id : null; }
  function seasonalX(ts) { var dt = new Date(ts * 1000); return MON[dt.getUTCMonth()] + (isMonthStart(dt) ? "" : " " + dt.getUTCDate()); }
  function unitSuffix(u) { if (!u || u === "ratio" || u.indexOf("index") === 0) return ""; if (u.indexOf("%") >= 0) return "%"; return " " + u; }
  function transformLabel(t) { return { none: "", rebase100: "rebased to 100", yoy: "year-over-year %", ratio: "ratio", seasonal: "seasonality" }[t] || ""; }
  function sizeCharts() { state.charts.forEach(function (c) { var w = c.u.root.parentNode.clientWidth || 700; c.u.setSize({ width: w, height: 380 }); }); }
  window.addEventListener("resize", sizeCharts);

  function applyRange() {
    state.charts.forEach(function (c) {
      var max = c.maxTs, min = state.spec.rangeMonths === "all" ? c.minTs : Math.max(c.minTs, max - state.spec.rangeMonths * 30.4 * DAY);
      c.u.setScale("x", { min: min, max: max });
    });
  }

  // ---------- stats panel ----------
  function renderStats() {
    var box = document.getElementById("studio-stats"); box.innerHTML = "";
    box.appendChild(el("div", { class: "st-statshead" }, ["◔ This chart"]));
    if (!state.data || !state.data.series.length) { box.appendChild(el("div", { class: "muted", style: "font-size:.82em" }, ["No series selected."])); return; }
    // focus selector
    var sel = el("select", { class: "st-focussel" }, []);
    state.data.series.forEach(function (s) { var o = el("option", { value: s.id }, [s.label]); if (s.id === currentFocus()) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", function () { state.spec.focus = sel.value; syncURL(); draw(); });
    box.appendChild(sel);
    var st = state.data.stats[currentFocus()];
    if (!st) { box.appendChild(el("div", { class: "muted", style: "font-size:.82em" }, ["No stats for this series."])); return; }
    var rows = [
      ["Latest", fmtNum(st.latest.value) + unitSuffix(st.unit) + "  ", st.latest.period, ""],
      ["Δ prior", fmtPct(st.changePct), "", dirOf(st.changePct)],
      ["YoY", fmtPct(st.yoyPct), "", dirOf(st.yoyPct)],
      ["Percentile", (st.percentile != null ? ordinal(st.percentile) : "—"), "of " + st.count + " obs", ""],
      ["Seasonal", fmtPct(st.seasonalDeltaPct), (st.seasonalPctile != null ? ordinal(st.seasonalPctile) + " for month" : ""), dirOf(st.seasonalDeltaPct)],
      ["Range", fmtNum(st.min.value) + "–" + fmtNum(st.max.value), "since " + st.firstPeriod, ""],
    ];
    rows.forEach(function (r) {
      var row = el("div", { class: "st-stat" }, []);
      row.appendChild(el("span", { class: "k" }, [r[0] + (r[2] ? " " : ""), r[2] ? el("span", { class: "muted", style: "font-size:.85em" }, [r[2]]) : document.createTextNode("")]));
      row.appendChild(el("span", { class: "v " + r[3] }, [r[1]]));
      box.appendChild(row);
    });
    var ex = el("div", { class: "st-explain" }, []);
    ex.appendChild(el("button", { type: "button", disabled: "disabled", title: "LLM chart read — coming next" }, ["Explain this chart  ·  phase 2"]));
    box.appendChild(ex);
    box.appendChild(el("div", { class: "st-foot" }, [footerText()]));
  }
  function dirOf(v) { return v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : ""; }
  function ordinal(n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function footerText() {
    var srcs = uniqArr(state.data.series.map(function (s) { return sourceOf(s.id); })).join(", ");
    return "Source: " + (srcs || "USDA / market data") + " · " + new Date().toISOString().slice(0, 10) + " · Education, not advice.";
  }
  function sourceOf(id) { var a = String(id).split(":")[0]; return ({ usda_nass: "USDA NASS", eia: "EIA", cftc: "CFTC", wasde: "USDA WASDE", fred: "FRED", agtransport: "USDA AgTransport", usda_ams: "USDA AMS", drought_monitor: "U.S. Drought Monitor", open_meteo: "Open-Meteo/ERA5", ibge_brazil: "IBGE" })[a] || a; }
  function uniqArr(a) { var o = []; a.forEach(function (x) { if (x && o.indexOf(x) < 0) o.push(x); }); return o; }

  // ---------- rail ----------
  function buildRail() {
    var rail = document.getElementById("studio-rail"); rail.innerHTML = "";
    rail.appendChild(el("div", { class: "st-railhead" }, ["▤ Series"]));
    state.catalog.categories.forEach(function (cat) {
      rail.appendChild(el("div", { class: "st-grp" }, [cat.label]));
      cat.series.forEach(function (s) {
        var cb = el("input", { type: "checkbox", value: s.id });
        if (seriesSelected(s.id)) cb.checked = true;
        cb.addEventListener("change", onRailChange);
        var lab = el("label", { class: "st-item", title: s.id }, []); lab.appendChild(cb); lab.appendChild(document.createTextNode(s.label + (s.unit ? " (" + s.unit + ")" : "")));
        rail.appendChild(lab);
      });
    });
    // transforms
    var sub = el("div", { class: "st-sub" }, []); sub.appendChild(el("div", { class: "st-railhead" }, ["⇄ Transform"]));
    state.catalog.transforms.forEach(function (t) {
      var rb = el("input", { type: "radio", name: "st-transform", value: t.id }); if (state.spec.transform === t.id) rb.checked = true;
      rb.addEventListener("change", onRailChange);
      var lab = el("label", { class: "st-radio" }, []); lab.appendChild(rb); lab.appendChild(document.createTextNode(t.label));
      sub.appendChild(lab);
    });
    rail.appendChild(sub);
    // overlays
    var ov = el("div", { class: "st-sub" }, []); ov.appendChild(el("div", { class: "st-railhead" }, ["◫ Overlays"]));
    [["normalBand", "Normal-range band"], ["events", "Report / policy flags"]].forEach(function (o) {
      var cb = el("input", { type: "checkbox", "data-ov": o[0] }); if (state.spec.overlays[o[0]]) cb.checked = true;
      cb.addEventListener("change", onRailChange);
      var lab = el("label", { class: "st-item" }, []); lab.appendChild(cb); lab.appendChild(document.createTextNode(o[1]));
      ov.appendChild(lab);
    });
    rail.appendChild(ov);
  }
  function onRailChange() { readControls(); syncURL(); load(); }
  function readControls() {
    var rail = document.getElementById("studio-rail");
    state.spec.series = [].map.call(rail.querySelectorAll('input[type=checkbox][value]'), function (c) { return c.checked ? c.value : null; }).filter(Boolean);
    var tr = rail.querySelector('input[name="st-transform"]:checked'); state.spec.transform = tr ? tr.value : "none";
    state.spec.overlays.normalBand = !!rail.querySelector('input[data-ov="normalBand"]:checked');
    state.spec.overlays.events = !!rail.querySelector('input[data-ov="events"]:checked');
    if (state.spec.focus && state.spec.series.indexOf(state.spec.focus) < 0) state.spec.focus = null;
  }

  // ---------- range toolbar ----------
  function wireRange() {
    var bar = document.getElementById("st-range");
    [].forEach.call(bar.querySelectorAll("button[data-months]"), function (b) {
      b.addEventListener("click", function () {
        [].forEach.call(bar.querySelectorAll("button"), function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        var m = b.getAttribute("data-months"); state.spec.rangeMonths = m === "all" ? "all" : +m;
        applyRange(); syncURL();
      });
    });
  }

  // ---------- export + share ----------
  function updateExportLinks() {
    var csv = document.getElementById("st-csv");
    if (state.spec.series.length) { csv.style.display = ""; csv.href = "/api/studio/series?ids=" + encodeURIComponent(state.spec.series.join(",")) + "&format=csv"; }
    else { csv.style.display = "none"; }
  }
  function exportPNG() {
    if (!state.charts.length) return;
    var cvs = state.charts.map(function (c) { return c.u.root.querySelector("canvas"); }).filter(Boolean);
    if (!cvs.length) return;
    var W = Math.max.apply(null, cvs.map(function (c) { return c.width; }));
    var footH = 46 * (window.devicePixelRatio || 1), y = 0, H = cvs.reduce(function (a, c) { return a + c.height; }, 0) + footH;
    var out = el("canvas", {}); out.width = W; out.height = H;
    var ctx = out.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    cvs.forEach(function (c) { ctx.drawImage(c, 0, y); y += c.height; });
    // compliance footer strip
    ctx.fillStyle = "#f3f6f9"; ctx.fillRect(0, y, W, footH);
    ctx.fillStyle = "#5a6b7b"; ctx.font = (11 * (window.devicePixelRatio || 1)) + "px system-ui, sans-serif"; ctx.textBaseline = "top";
    wrapText(ctx, footerText() + "  |  The Bean Brief · Iowa Soybean Association", 10 * (window.devicePixelRatio || 1), y + 7 * (window.devicePixelRatio || 1), W - 20 * (window.devicePixelRatio || 1), 15 * (window.devicePixelRatio || 1));
    out.toBlob(function (blob) {
      var a = document.createElement("a"); a.download = "bean-brief-chart-" + new Date().toISOString().slice(0, 10) + ".png";
      a.href = URL.createObjectURL(blob); document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
  }
  function wrapText(ctx, text, x, y, maxW, lh) {
    var words = text.split(" "), line = "", yy = y;
    for (var i = 0; i < words.length; i++) { var t = line + words[i] + " "; if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, yy); line = words[i] + " "; yy += lh; } else line = t; }
    ctx.fillText(line, x, yy);
  }
  function share() {
    syncURL();
    var full = location.origin + location.pathname + location.search;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(full).then(flashShare, flashShare);
    else flashShare();
  }
  function flashShare() { var b = document.getElementById("st-share"); var t = b.textContent; b.textContent = "✓ Link copied"; setTimeout(function () { b.textContent = t; }, 1600); }

  function syncURL() {
    var s = b64urlEncode(state.spec);
    var u = location.pathname + (s ? "?spec=" + s : "");
    try { history.replaceState(null, "", u); } catch (e) {}
  }

  // ---------- data load ----------
  function load() {
    updateExportLinks();
    if (!state.spec.series.length) { state.data = { series: [], stats: {} }; state.events = []; draw(); return; }
    var q = encodeURIComponent(state.spec.series.join(","));
    fetch("/api/studio/series?ids=" + q).then(function (r) { return r.json(); }).then(function (res) {
      state.data = res && res.series ? res : { series: [], stats: {} };
      loadEvents(); draw();
    }).catch(function () { state.data = { series: [], stats: {} }; draw(); });
  }
  function loadEvents() {
    if (!state.data.series.length) { state.events = []; return; }
    var from = "9999", to = "0000";
    state.data.series.forEach(function (s) { s.points.forEach(function (p) { if (p.period < from) from = p.period; if (p.period > to) to = p.period; }); });
    fetch("/api/studio/events?from=" + encodeURIComponent(from.slice(0, 10)) + "&to=" + encodeURIComponent(to.slice(0, 10)))
      .then(function (r) { return r.json(); }).then(function (evs) { state.events = evs || []; if (state.charts.length) state.charts.forEach(function (c) { c.u.redraw(); }); }).catch(function () { state.events = []; });
  }

  // ---------- init ----------
  function rehydrate() {
    var raw = app.getAttribute("data-spec");
    var parsed = raw ? b64urlDecode(raw) : null;
    if (parsed && parsed.series) {
      state.spec.series = parsed.series || [];
      state.spec.transform = parsed.transform || "none";
      state.spec.overlays = { normalBand: parsed.overlays ? !!parsed.overlays.normalBand : true, events: parsed.overlays ? !!parsed.overlays.events : true };
      state.spec.rangeMonths = parsed.rangeMonths || 36;
      state.spec.focus = parsed.focus || null;
    }
  }
  function applyRangeButton() {
    var bar = document.getElementById("st-range");
    [].forEach.call(bar.querySelectorAll("button"), function (x) { x.classList.remove("on"); });
    var sel = bar.querySelector('button[data-months="' + state.spec.rangeMonths + '"]') || bar.querySelector('button[data-months="36"]');
    if (sel) sel.classList.add("on");
  }
  function init() {
    if (typeof uPlot === "undefined") { document.getElementById("studio-panes").innerHTML = '<div class="st-empty">Charts failed to load.</div>'; return; }
    gateCheck();
    document.getElementById("st-png").addEventListener("click", exportPNG);
    document.getElementById("st-share").addEventListener("click", share);
    wireRange();
    rehydrate();
    fetch("/api/studio/catalog").then(function (r) { return r.json(); }).then(function (cat) {
      state.catalog = cat; buildRail(); applyRangeButton(); load();
    }).catch(function () { document.getElementById("studio-rail").innerHTML = '<div class="st-empty">Couldn\'t load the series catalog.</div>'; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
