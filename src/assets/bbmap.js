/* bbmap.js — renders The Bean Brief's Iowa Political Map with Leaflet.
 *
 * The /map page emits a #ia-map container and a <script id="mapdata"> JSON blob with the
 * candidate/incumbent join { house, senate, congress, statewide }, each district keyed by number
 * as { n, incumbent:{name,party}, cands:[{name,party,inc}], tone, hucs:[{huc,name}] }. This draws
 * a muted CARTO basemap, overlays crisp county lines, then lays the chosen political boundary
 * (House / Senate / Congress) translucently on top — each district shaded RED or BLUE by the
 * seat-holder's party. Hovering a district shows an info box naming the incumbent and the 2026
 * challenger(s). The HUC8 watershed overlay is a passive background layer (non-interactive), so
 * hovering always shows the candidate card; when it's on, that card also lists the watersheds the
 * district spans (a district usually covers several).
 *
 * Vendored/static (no build step). Loaded after leaflet.js on the /map page.
 */
(function () {
  if (typeof L === "undefined") return;

  // Fill = current seat-holder's party. Red = Republican, blue = Democratic.
  var TONE = { R: "#C0392B", D: "#2C6FB0", other: "#C77D0A", none: "#CBD3DA" };
  var HUC_COLOR = "#2E86AB";

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function pdot(party) {
    return '<span class="pdot p-' + esc(String(party || "?").toLowerCase()) + '"></span>';
  }
  function person(p) {
    return pdot(p.party) + " " + esc(p.name) + " (" + esc(p.party || "?") + ")";
  }

  function getData() {
    var el = document.getElementById("mapdata");
    if (!el) return { house: {}, senate: {}, congress: {}, statewide: [] };
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return { house: {}, senate: {}, congress: {}, statewide: [] };
    }
  }

  // The hover/click info box: district, incumbent, challenger(s), and — when the HUC layer is on —
  // the watersheds this district spans.
  function infoHtml(name, d, showHuc) {
    var h = '<div class="tip-title">' + esc((d && d.n) || name) + "</div>";
    if (!d) return h + '<div class="muted">No data for this district.</div>';
    var cands = d.cands || [];
    var incRunning = cands.some(function (c) { return c.inc; });

    if (d.incumbent) {
      h += '<div class="tip-row"><span class="tip-role">Incumbent</span><span class="tip-name">' + person(d.incumbent) + "</span></div>";
      if (!incRunning) h += '<div class="tip-row"><span class="tip-open">Open seat — incumbent not on the 2026 ballot</span></div>';
    }

    var others = cands.filter(function (c) { return !c.inc; });
    var role = d.incumbent && incRunning ? "Challenger" : "Candidate";
    if (others.length) {
      others.forEach(function (c, i) {
        h += '<div class="tip-row"><span class="tip-role">' + (i === 0 ? role : "") + '</span><span class="tip-name">' + person(c) + "</span></div>";
      });
    } else if (d.incumbent && incRunning) {
      h += '<div class="tip-row"><span class="tip-role">Challenger</span><span class="muted">none filed</span></div>';
    } else if (!d.incumbent && !cands.length) {
      h += '<div class="muted">No candidate on file for 2026.</div>';
    }

    if (showHuc && d.hucs && d.hucs.length) {
      h += '<div class="tip-huc"><div class="tip-huc-h">Watersheds (HUC8) — ' + d.hucs.length + "</div>";
      d.hucs.forEach(function (x) {
        h += '<div class="tip-huc-row"><span class="tip-huc-code">' + esc(x.huc) + "</span> " + esc(x.name) + "</div>";
      });
      h += "</div>";
    }
    return h;
  }

  // A choropleth political boundary joined to the candidate data by feature.properties.key.
  // Cards are bound with static content for the current HUC state; refreshCards() re-sets them
  // (via setTooltipContent) whenever the HUC overlay is toggled — deterministic, no reliance on
  // Leaflet re-evaluating function content on each reopen.
  function districtLayer(geo, dict, showHuc) {
    var gj = L.geoJSON(geo, {
      style: function (f) {
        var d = dict[f.properties.key];
        return { color: "#3f4b57", weight: 1, fillColor: TONE[d ? d.tone : "none"], fillOpacity: 0.4 };
      },
      onEachFeature: function (f, layer) {
        var d = dict[f.properties.key];
        var html = infoHtml(f.properties.name, d, showHuc());
        layer.bindTooltip(html, { sticky: true, direction: "top", className: "map-tip", opacity: 1 });
        layer.bindPopup(html, { maxWidth: 320 });
        layer.on("mouseover", function () {
          layer.setStyle({ weight: 2.5, fillOpacity: 0.6 });
          layer.bringToFront();
        });
        layer.on("mouseout", function () {
          gj.resetStyle(layer);
        });
      },
    });
    gj._dict = dict; // used by refreshCards() on HUC toggle
    return gj;
  }

  // Re-set every district's card content to match the current HUC-overlay state.
  function refreshCards(groups, showHuc) {
    groups.forEach(function (gj) {
      gj.eachLayer(function (layer) {
        var f = layer.feature;
        if (!f) return;
        var html = infoHtml(f.properties.name, gj._dict[f.properties.key], showHuc);
        layer.setTooltipContent(html);
        if (layer.getPopup()) layer.setPopupContent(html);
        // drop a card that's open right now so the next hover shows the refreshed content
        if (layer.isTooltipOpen && layer.isTooltipOpen()) layer.closeTooltip();
      });
    });
  }

  // Always-on county lines — the reference base beneath the translucent districts. Non-interactive
  // so hover/click fall through to the political layer on top.
  function countyLines(geo) {
    return L.geoJSON(geo, {
      interactive: false,
      style: { color: "#4a5763", weight: 1, fill: false, opacity: 0.55 },
    });
  }

  // HUC8 watersheds — a passive BACKGROUND layer in a low pane, non-interactive so it never grabs
  // the hover (the district card wins). Soft fill + stroke so the basins read behind the districts.
  function hucLayer(geo) {
    return L.geoJSON(geo, {
      pane: "hucBg",
      interactive: false,
      style: { color: HUC_COLOR, weight: 1.2, opacity: 0.7, fill: true, fillColor: HUC_COLOR, fillOpacity: 0.14 },
    });
  }

  // Processing-plant markers: soybean crush = green circle, biodiesel = amber square, a site that
  // hosts BOTH = green circle with an amber ring. Two distinct icons, one layer (§ map tab request).
  function facIcon(f) {
    var html;
    if (f.crush && f.biodiesel) html = '<div style="width:13px;height:13px;border-radius:50%;background:#4a7c1f;border:2.5px solid #e08a1e;box-shadow:0 0 2px rgba(0,0,0,.6)"></div>';
    else if (f.biodiesel) html = '<div style="width:12px;height:12px;background:#e08a1e;border:1.5px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.6)"></div>';
    else html = '<div style="width:12px;height:12px;border-radius:50%;background:#4a7c1f;border:1.5px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.6)"></div>';
    return L.divIcon({ html: html, className: "fac-marker", iconSize: [13, 13], iconAnchor: [7, 7] });
  }
  function facilityLayer(facs) {
    var g = L.layerGroup();
    (facs || []).forEach(function (f) {
      if (typeof f.lat !== "number" || typeof f.lng !== "number") return;
      if (f.state !== "IA") return; // Iowa-only on the map; the full national crush list stays in facilities.json
      var types = [];
      if (f.crush) types.push("Soybean crush");
      if (f.biodiesel) types.push("Biodiesel");
      var html =
        '<div class="tip-title">' + esc(f.name) + "</div>" +
        '<div class="tip-row"><span class="tip-role">Type</span><span class="tip-name">' + esc(types.join(" + ") || "—") + "</span></div>" +
        (f.capacity ? '<div class="tip-row"><span class="tip-role">Capacity</span><span class="tip-name">' + esc(f.capacity) + "</span></div>" : "") +
        (f.status && f.status !== "operating" ? '<div class="tip-row"><span class="tip-role">Status</span><span class="tip-name">' + esc(f.status) + "</span></div>" : "");
      L.marker([f.lat, f.lng], { icon: facIcon(f) })
        .bindTooltip(html, { direction: "top", className: "map-tip", opacity: 1 })
        .bindPopup(html, { maxWidth: 300 })
        .addTo(g);
    });
    return g;
  }

  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return r.json();
    });
  }

  function legend() {
    var c = L.control({ position: "bottomright" });
    c.onAdd = function () {
      var div = L.DomUtil.create("div", "map-legend");
      div.innerHTML =
        "<h4>Seat currently held by</h4>" +
        '<div class="row"><span class="sw" style="background:' + TONE.R + '"></span>Republican</div>' +
        '<div class="row"><span class="sw" style="background:' + TONE.D + '"></span>Democrat</div>' +
        '<h4 style="margin-top:6px">Reference</h4>' +
        '<div class="row"><span class="sw" style="border:1px solid #4a5763;background:transparent"></span>County line</div>' +
        '<div class="row"><span class="sw" style="background:' + HUC_COLOR + ';opacity:.45"></span>HUC8 watershed</div>' +
        '<h4 style="margin-top:6px">Processing plants</h4>' +
        '<div class="row"><span class="sw" style="border-radius:50%;background:#4a7c1f"></span>Soybean crush</div>' +
        '<div class="row"><span class="sw" style="background:#e08a1e"></span>Biodiesel</div>' +
        '<div class="row"><span class="sw" style="border-radius:50%;background:#4a7c1f;border:2px solid #e08a1e"></span>Both</div>';
      return div;
    };
    return c;
  }

  function init() {
    var box = document.getElementById("ia-map");
    if (!box) return;
    var data = getData();

    var map = L.map(box, { center: [42.02, -93.55], zoom: 7, minZoom: 6, maxZoom: 14, scrollWheelZoom: true });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);

    // A low pane so the HUC8 basins sit BEHIND the county lines + district polygons (above the tiles).
    map.createPane("hucBg");
    map.getPane("hucBg").style.zIndex = 350;

    legend().addTo(map);

    var G = "/assets/geo/";
    Promise.all([
      loadJSON(G + "counties.geojson"),
      loadJSON(G + "house.geojson"),
      loadJSON(G + "senate.geojson"),
      loadJSON(G + "congress.geojson"),
      loadJSON(G + "huc8.geojson"),
      loadJSON(G + "facilities.json").catch(function () { return []; }), // fail-soft: missing plant data never breaks the political map
    ])
      .then(function (geo) {
        var counties = countyLines(geo[0]);
        var huc8 = hucLayer(geo[4]);
        var hucOn = function () { return map.hasLayer(huc8); };
        var house = districtLayer(geo[1], data.house, hucOn);
        var senate = districtLayer(geo[2], data.senate, hucOn);
        var congress = districtLayer(geo[3], data.congress, hucOn);
        var groups = [house, senate, congress];
        var facilities = facilityLayer(geo[5]);

        counties.addTo(map); // always-on base reference
        house.addTo(map); // default political boundary (translucent, over the county lines)
        facilities.addTo(map); // crush + biodiesel plants (toggle off in the layer control)

        L.control
          .layers(
            { "Iowa House": house, "Iowa Senate": senate, "U.S. Congress": congress },
            { "HUC8 Watersheds": huc8, "🌱 Iowa crush &amp; biodiesel plants": facilities },
            { collapsed: false }
          )
          .addTo(map);

        // Toggling the HUC overlay rewrites every district card to add/remove its watershed list.
        var onOverlay = function () { refreshCards(groups, hucOn()); };
        map.on("overlayadd", onOverlay);
        map.on("overlayremove", onOverlay);

        try {
          map.fitBounds(counties.getBounds(), { padding: [10, 10] });
        } catch (e) {
          /* keep default view */
        }
      })
      .catch(function (err) {
        box.innerHTML = '<p class="muted" style="padding:16px">Map data failed to load: ' + esc(err.message) + "</p>";
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
