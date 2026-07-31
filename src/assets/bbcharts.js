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

  // ---- mobile ----------------------------------------------------------------------------------
  // uPlot 1.6.32 binds mouse events only — there is not a single touch handler in the vendored
  // build. On a phone that meant the charts were inert: no hover legend, no drag-to-zoom, nothing
  // to do but pinch-zoom the whole PAGE. Two additions fix it without touching the library:
  //   bindTouch()  — translates touch into the mouse events uPlot already listens for (so a finger
  //                  drag scrubs the live legend), adds pinch-to-zoom on the x scale, one-finger
  //                  pan while zoomed, and double-tap to reset.
  //   addExpand()  — a ⤢ button that blows one chart up to the full viewport. A 12-point series in
  //                  a 330px column is unreadable however good the interaction is; on a phone,
  //                  full-screen (turned landscape) is the actual fix.
  var isNarrow = function () { return window.matchMedia && window.matchMedia("(max-width: 640px)").matches; };
  function chartHeight(spec) { return isNarrow() ? Math.min(spec.height || 300, 210) : spec.height || 300; }

  // Feed uPlot the mouse events it expects. Deliberately synthetic-event based rather than poking
  // u.setCursor(): the event path is public DOM and cannot drift with a uPlot upgrade.
  function mouse(u, type, t) {
    u.over.dispatchEvent(new MouseEvent(type, { clientX: t.clientX, clientY: t.clientY, bubbles: true, cancelable: true }));
  }
  function bindTouch(c) {
    var u = c.u, over = u.over;
    var pinch = null, pan = null, lastTap = 0;
    function xRange() { var s = u.scales.x; return { min: s.min, max: s.max }; }
    over.addEventListener("touchstart", function (e) {
      if (e.touches.length === 2) {
        var r = xRange();
        pinch = { d: Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1, min: r.min, max: r.max };
        pan = null;
      } else if (e.touches.length === 1) {
        var now = Date.now();
        if (now - lastTap < 320) { u.setScale("x", { min: c.viewMin, max: c.viewMax }); lastTap = 0; return; }
        lastTap = now;
        var r2 = xRange();
        pan = { x: e.touches[0].clientX, min: r2.min, max: r2.max, w: u.bbox.width / (window.devicePixelRatio || 1) };
        mouse(u, "mouseenter", e.touches[0]);
        mouse(u, "mousemove", e.touches[0]);
      }
    }, { passive: true });
    over.addEventListener("touchmove", function (e) {
      if (pinch && e.touches.length === 2) {
        e.preventDefault(); // a pinch on the chart zooms the chart, not the page
        var d = Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1;
        var span = (pinch.max - pinch.min) * (pinch.d / d);
        var mid = (pinch.min + pinch.max) / 2;
        var lo = Math.max(c.minTs, mid - span / 2), hi = Math.min(c.maxTs, mid + span / 2);
        if (hi - lo > DAY) u.setScale("x", { min: lo, max: hi });
        return;
      }
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      var zoomed = pan && (pan.max - pan.min) < (c.maxTs - c.minTs) * 0.999;
      if (zoomed && pan.w) {
        // Panning only makes sense once zoomed in; otherwise the finger scrubs the legend.
        var dx = t.clientX - pan.x;
        var perPx = (pan.max - pan.min) / pan.w;
        var shift = -dx * perPx;
        var lo2 = pan.min + shift, hi2 = pan.max + shift;
        if (lo2 < c.minTs) { hi2 += c.minTs - lo2; lo2 = c.minTs; }
        if (hi2 > c.maxTs) { lo2 -= hi2 - c.maxTs; hi2 = c.maxTs; }
        e.preventDefault();
        u.setScale("x", { min: lo2, max: hi2 });
        return;
      }
      mouse(u, "mousemove", t);
    }, { passive: false });
    over.addEventListener("touchend", function () { pinch = null; pan = null; }, { passive: true });
  }

  // Full-viewport view of one chart. The chart's own DOM node is MOVED into the overlay and moved
  // back on close (uPlot doesn't care where it lives, and re-rendering would lose the zoom state).
  function addExpand(c, spec) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bbchart-expand";
    btn.title = "Expand to full screen";
    btn.setAttribute("aria-label", "Expand chart to full screen");
    btn.innerHTML = "&#10530;"; // ⤢
    c.box.appendChild(btn);
    btn.addEventListener("click", function () {
      var home = c.box.parentNode, after = c.box.nextSibling;
      var ov = document.createElement("div");
      ov.className = "bbchart-overlay";
      var bar = document.createElement("div");
      bar.className = "bbchart-obar";
      bar.innerHTML = '<span class="bbchart-otitle"></span><button type="button" class="bbchart-close">Close ✕</button>';
      bar.querySelector(".bbchart-otitle").textContent = c.title || "";
      ov.appendChild(bar);
      ov.appendChild(c.box);
      document.body.appendChild(ov);
      document.body.style.overflow = "hidden";
      function fit() {
        c.u.setSize({ width: Math.max(260, ov.clientWidth - 24), height: Math.max(220, ov.clientHeight - 70) });
      }
      fit();
      var onResize = function () { fit(); };
      window.addEventListener("resize", onResize);
      window.addEventListener("orientationchange", onResize);
      function close() {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("orientationchange", onResize);
        document.removeEventListener("keydown", onKey);
        if (after) home.insertBefore(c.box, after); else home.appendChild(c.box);
        ov.remove();
        document.body.style.overflow = "";
        c.u.setSize({ width: Math.max(260, c.box.clientWidth || 680), height: chartHeight(spec) });
      }
      function onKey(e) { if (e.key === "Escape") close(); }
      bar.querySelector(".bbchart-close").addEventListener("click", close);
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      document.addEventListener("keydown", onKey);
    });
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
    // Fewer, shorter x ticks on a phone — the default split count crowds ~330px into unreadable mush.
    var xSpace = isNarrow() ? 70 : 50;
    var yAxis = {
      label: spec.unit || "",
      grid: { stroke: "#eef2f6", width: 1 },
      ticks: { stroke: "#e0e0e0" },
      values: function (u, ticks) { return ticks.map(function (t) { return Math.abs(t) >= 1000 ? Math.round(t).toLocaleString() : t; }); },
    };
    var u = new uPlot({
      width: width(),
      height: chartHeight(spec),
      scales: { x: { time: true } },
      axes: [
        { grid: { stroke: "#eef2f6", width: 1 }, ticks: { stroke: "#e0e0e0" }, space: xSpace, values: function (u, splits) { return splits.map(fmtAxisX); } },
        yAxis,
      ],
      series: uSeries,
      plugins: plugins,
      legend: { live: true },
      cursor: { focus: { prox: 24 } },
    }, data, box);
    // Reliable reflow: observe the container itself, so a viewport resize / phone rotation always
    // resizes the chart to fit (the old window-resize handler could leave it oversized → page overflow).
    // Skipped while the chart is expanded — the overlay sizes it explicitly.
    var inOverlay = function () { return !!box.closest(".bbchart-overlay"); };
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(function () { if (!inOverlay()) u.setSize({ width: width(), height: chartHeight(spec) }); });
      ro.observe(box);
    } else {
      window.addEventListener("resize", function () { if (!inOverlay()) u.setSize({ width: width(), height: chartHeight(spec) }); });
    }
    var c = { u: u, minTs: xs[0], maxTs: xs[xs.length - 1], xs: xs, box: box, viewMin: xs[0], viewMax: xs[xs.length - 1], title: spec.title || "" };
    uplots.push(c);
    addExpand(c, spec);
    bindTouch(c); // bound unconditionally: touch listeners are inert on a mouse, and gating them on
                  // a pointer:coarse query made the behaviour untestable and broke hybrid laptops.
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
      // Remember the window the toolbar chose: double-tap-to-reset on touch returns HERE, not to
      // full history, so a reset doesn't silently contradict the range button that's lit up.
      c.viewMin = min; c.viewMax = max;
      c.u.setScale("x", { min: min, max: max });
    });
  }
  function applyDates(fromTs, toTs) {
    uplots.forEach(function (c) {
      var min = fromTs != null ? fromTs : c.minTs, max = toTs != null ? toTs : c.maxTs;
      c.viewMin = min; c.viewMax = max;
      c.u.setScale("x", { min: min, max: max });
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
