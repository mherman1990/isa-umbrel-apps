/* bbcharts.js — renders The Bean Brief's Markets charts with uPlot.
 *
 * The Markets page emits, per chart, a container <div id="chart_x"> plus a
 * <script class="bbchart" type="application/json" data-target="chart_x"> holding
 * { unit, height, series:[{label, points:[{period,value}]}] }, and one global
 * range toolbar (#bbrange). This draws an interactive multi-line chart per blob
 * (hover shows month + each series value), then wires the toolbar so one control
 * sets the visible date window on ALL charts at once.
 *
 * Default view = last 12 months (so price/context reads against the marketing year, not a random
 * 6-month slice), and any chart whose window would show fewer than ~8 points auto-widens to its full
 * history (so annual/quarterly series aren't a lonely dot). A faint normal-range band (10th–90th
 * percentile of the primary series) sits behind level charts as a "is this high or low?" reference.
 *
 * Vendored/static (no build step). Loaded after uPlot on the Markets page.
 */
(function () {
  // Categorical palette: ISA blue lead, then an Okabe-Ito-derived set chosen to stay distinct under
  // the common colour-vision deficiencies (the biofuel chart overlays up to 9 series).
  var PALETTE = ["#004A8D", "#E69F00", "#009E73", "#CC79A7", "#D55E00", "#56B4E9", "#7A4FBF", "#994F00", "#999999", "#FFC425"];
  var DAY = 86400;
  var MIN_PTS = 8; // fewer than this in the window → widen to full history
  var uplots = []; // { u, minTs, maxTs, xs, box } for every rendered chart

  function parsePeriod(p) {
    var m = String(p).split("-");
    return Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1) / 1000;
  }
  function fmt(v) {
    if (v == null) return "—";
    return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100);
  }

  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function isMonthStart(dt) { return dt.getUTCDate() === 1 && dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0; }
  function fmtHoverX(ts) {
    var dt = new Date(ts * 1000);
    return isMonthStart(dt)
      ? MON[dt.getUTCMonth()] + " " + dt.getUTCFullYear()
      : MON[dt.getUTCMonth()] + " " + dt.getUTCDate() + ", " + dt.getUTCFullYear();
  }
  function fmtAxisX(ts) {
    var dt = new Date(ts * 1000);
    if (isMonthStart(dt)) {
      return dt.getUTCMonth() === 0 ? String(dt.getUTCFullYear()) : MON[dt.getUTCMonth()] + " '" + String(dt.getUTCFullYear()).slice(2);
    }
    return MON[dt.getUTCMonth()] + " " + dt.getUTCDate();
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
    return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
  }
  // A faint p10–p90 band from the primary series' full history — the "normal range" reference so a
  // farmer can see whether the latest point is high or low without doing the math.
  function bandPlugin(lo, hi) {
    return { hooks: { drawClear: function (u) {
      var y0 = u.valToPos(hi, "y", true), y1 = u.valToPos(lo, "y", true);
      u.ctx.save(); u.ctx.fillStyle = "rgba(0,74,141,0.06)";
      u.ctx.fillRect(u.bbox.left, Math.min(y0, y1), u.bbox.width, Math.abs(y1 - y0)); u.ctx.restore();
    } } };
  }

  function build(box, spec) {
    var series = spec.series || [];
    var seen = {};
    series.forEach(function (s) { (s.points || []).forEach(function (pt) { seen[pt.period] = 1; }); });
    var periods = Object.keys(seen).sort();
    if (periods.length < 2) { box.innerHTML = '<p class="muted">Not enough history yet.</p>'; return; }
    var xs = periods.map(parsePeriod);
    var data = [xs];
    var uSeries = [{ value: function (u, ts) { return ts == null ? "—" : fmtHoverX(ts); } }];
    series.forEach(function (s, i) {
      var map = {};
      (s.points || []).forEach(function (pt) { map[pt.period] = pt.value; });
      data.push(periods.map(function (p) { return p in map ? map[p] : null; }));
      uSeries.push({
        label: s.label,
        stroke: PALETTE[i % PALETTE.length],
        width: 2,
        spanGaps: true,
        points: { show: false },
        value: function (u, v) { return v == null ? "—" : fmt(v) + (spec.unit ? " " + spec.unit : ""); },
      });
    });

    // Normal-range band from the primary series — only for level charts (≤2 lines); a band behind a
    // 9-series feedstock chart would be noise.
    var plugins = [];
    if (series.length <= 2 && series[0] && series[0].points) {
      var vals = series[0].points.map(function (p) { return p.value; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
      if (vals.length >= MIN_PTS) plugins.push(bandPlugin(quantile(vals, 0.1), quantile(vals, 0.9)));
    }

    box.innerHTML = "";
    function width() { return Math.max(260, box.clientWidth || 680); }
    var yAxis = {
      label: spec.unit || "",
      grid: { stroke: "#eef2f6", width: 1 },
      ticks: { stroke: "#e0e0e0" },
      values: function (u, ticks) { return ticks.map(function (t) { return Math.abs(t) >= 1000 ? Math.round(t).toLocaleString() : t; }); },
    };
    var u = new uPlot({
      width: width(),
      height: spec.height || 300,
      scales: { x: { time: true } },
      axes: [
        { grid: { stroke: "#eef2f6", width: 1 }, ticks: { stroke: "#e0e0e0" }, values: function (u, splits) { return splits.map(fmtAxisX); } },
        yAxis,
      ],
      series: uSeries,
      plugins: plugins,
      legend: { live: true },
      cursor: { focus: { prox: 24 } },
    }, data, box);
    // Reliable reflow: observe the container itself, so a viewport resize / phone rotation always
    // resizes the chart to fit (the old window-resize handler could leave it oversized → page overflow).
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(function () { u.setSize({ width: width(), height: spec.height || 300 }); });
      ro.observe(box);
    } else {
      window.addEventListener("resize", function () { u.setSize({ width: width(), height: spec.height || 300 }); });
    }
    uplots.push({ u: u, minTs: xs[0], maxTs: xs[xs.length - 1], xs: xs, box: box });
    return u;
  }

  // ---- global date-range control (one toolbar drives every chart) ----
  function applyMonths(months) {
    uplots.forEach(function (c) {
      var max = c.maxTs, min;
      if (months == null) { min = c.minTs; }
      else {
        min = Math.max(c.minTs, max - months * 30.4 * DAY);
        // Auto-widen sparse series: an annual/quarterly chart at 6–12 months would show 1–3 points,
        // so fall back to full history when the window is too thin to read.
        var inWin = 0;
        for (var i = 0; i < c.xs.length; i++) if (c.xs[i] >= min && c.xs[i] <= max) inWin++;
        if (inWin < MIN_PTS) min = c.minTs;
      }
      c.u.setScale("x", { min: min, max: max });
    });
  }
  function applyDates(fromTs, toTs) {
    uplots.forEach(function (c) {
      c.u.setScale("x", { min: fromTs != null ? fromTs : c.minTs, max: toTs != null ? toTs : c.maxTs });
    });
  }
  function isoToTs(v) {
    if (!v) return null;
    var m = v.split("-");
    if (m.length < 3) return null;
    return Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1) / 1000;
  }
  function wireRange() {
    var bar = document.getElementById("bbrange");
    if (!bar) return;
    var btns = bar.querySelectorAll("button[data-months]");
    var from = bar.querySelector('input[name="from"]');
    var to = bar.querySelector('input[name="to"]');
    function setActive(el) { for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("on", btns[i] === el); }
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var m = this.getAttribute("data-months");
        applyMonths(m === "all" ? null : +m);
        setActive(this);
        if (from) from.value = ""; if (to) to.value = "";
      });
    }
    function onCustom() {
      applyDates(isoToTs(from && from.value), isoToTs(to && to.value));
      setActive(null);
    }
    if (from) from.addEventListener("change", onCustom);
    if (to) to.addEventListener("change", onCustom);
    // Default view: last 12 months (with per-chart auto-widen for sparse series).
    applyMonths(12);
    var oneY = bar.querySelector('button[data-months="12"]');
    if (oneY) oneY.classList.add("on");
  }

  function init() {
    if (typeof uPlot === "undefined") return;
    var blobs = document.querySelectorAll("script.bbchart");
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var box = document.getElementById(b.getAttribute("data-target"));
      if (!box) continue;
      var spec;
      try { spec = JSON.parse(b.textContent); } catch (e) { continue; }
      try { build(box, spec); } catch (e) { box.innerHTML = '<p class="muted">Chart failed to render.</p>'; }
    }
    wireRange();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
