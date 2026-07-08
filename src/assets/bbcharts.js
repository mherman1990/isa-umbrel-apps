/* bbcharts.js — renders The Bean Brief's Markets charts with uPlot.
 *
 * The Markets page emits, per chart, a container <div id="chart_x"> plus a
 * <script class="bbchart" type="application/json" data-target="chart_x"> holding
 * { unit, height, series:[{label, points:[{period,value}]}] }, and one global
 * range toolbar (#bbrange). This draws an interactive multi-line chart per blob
 * (hover shows month + each series value), then wires the toolbar so one control
 * sets the visible date window on ALL charts at once — defaulting to the last 6
 * months so the recent move isn't buried under years of history.
 *
 * Vendored/static (no build step). Loaded after uPlot on the Markets page.
 */
(function () {
  var PALETTE = ["#004A8D", "#FFC425", "#0070C3", "#C65E35", "#6aa84f", "#9AB8D2", "#c0392b", "#8e7cc3", "#A5C6E3", "#91A22B"];
  var DAY = 86400;
  var uplots = []; // { u, minTs, maxTs } for every rendered chart

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
      legend: { live: true },
      cursor: { focus: { prox: 24 } },
    }, data, box);
    window.addEventListener("resize", function () { u.setSize({ width: width(), height: spec.height || 300 }); });
    uplots.push({ u: u, minTs: xs[0], maxTs: xs[xs.length - 1] });
    return u;
  }

  // ---- global date-range control (one toolbar drives every chart) ----
  function applyMonths(months) {
    uplots.forEach(function (c) {
      var max = c.maxTs;
      var min = months == null ? c.minTs : Math.max(c.minTs, max - months * 30.4 * DAY);
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
    // Default view: last 6 months.
    applyMonths(6);
    var six = bar.querySelector('button[data-months="6"]');
    if (six) six.classList.add("on");
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
