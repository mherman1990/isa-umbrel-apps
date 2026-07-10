/* bbmap.js — renders The Bean Brief's Iowa Political Map with Leaflet.
 *
 * The /map page emits a #ia-map container and a <script id="mapdata"> JSON blob with the
 * candidate/incumbent join { house, senate, congress, statewide } keyed by district number.
 * This draws a CARTO light basemap, loads the vendored Iowa boundary GeoJSON from
 * /assets/geo/*.geojson, colors each political district by which parties filed for 2026,
 * and wires a layer control: one boundary at a time (Counties / House / Senate / Congress)
 * plus toggleable Soil & Water Conservation District and HUC8 watershed overlays.
 *
 * Vendored/static (no build step). Loaded after leaflet.js on the /map page.
 */
(function () {
  if (typeof L === "undefined") return;

  var TONE = { R: "#C0392B", D: "#2C6FB0", contested: "#8E44AD", other: "#7F8C8D", none: "#E3E7EA" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

  function popupHtml(title, d) {
    var h = '<div class="pop-title">' + esc(title) + "</div>";
    if (!d || !d.cands || !d.cands.length) {
      return h + '<div class="muted">No candidate on file for 2026.</div>';
    }
    h += '<ul class="pop-cands">';
    d.cands.forEach(function (c) {
      var p = String(c.party || "?").toLowerCase();
      h +=
        '<li><span class="cand"><span class="pdot p-' + esc(p) + '"></span>' +
        esc(c.name) +
        ' <span class="muted">(' + esc(c.party || "?") + ")</span>" +
        (c.inc ? ' <span class="incflag">★ incumbent</span>' : "") +
        "</span></li>";
    });
    return h + "</ul>";
  }

  // A choropleth boundary layer joined to the candidate data by feature.properties.key.
  function districtLayer(geo, dict) {
    var gj = L.geoJSON(geo, {
      style: function (f) {
        var d = dict[f.properties.key];
        return { color: "#5a6b7a", weight: 1, fillColor: TONE[d ? d.tone : "none"], fillOpacity: 0.6 };
      },
      onEachFeature: function (f, layer) {
        var d = dict[f.properties.key];
        var title = (d && d.n) || f.properties.name;
        layer.bindPopup(popupHtml(title, d), { maxWidth: 320 });
        layer.on("mouseover", function () {
          layer.setStyle({ weight: 2.5, fillOpacity: 0.78 });
          layer.bringToFront();
        });
        layer.on("mouseout", function () {
          gj.resetStyle(layer);
        });
      },
    });
    return gj;
  }

  // A plain reference boundary (counties) — light fill, name-only popup.
  function referenceLayer(geo) {
    var gj = L.geoJSON(geo, {
      style: { color: "#8a97a3", weight: 1, fillColor: "#c9d3dc", fillOpacity: 0.15 },
      onEachFeature: function (f, layer) {
        layer.bindPopup('<div class="pop-title">' + esc(f.properties.name) + "</div>");
        layer.on("mouseover", function () {
          layer.setStyle({ weight: 2, fillOpacity: 0.3 });
        });
        layer.on("mouseout", function () {
          gj.resetStyle(layer);
        });
      },
    });
    return gj;
  }

  // An outline overlay (SWCD / HUC8) — no fill, distinct stroke, drawn in a higher pane.
  function overlayLayer(geo, color, pane, labeler) {
    return L.geoJSON(geo, {
      pane: pane,
      style: { color: color, weight: 1.4, fill: true, fillOpacity: 0.04, fillColor: color },
      onEachFeature: function (f, layer) {
        layer.bindPopup('<div class="pop-title">' + esc(labeler(f.properties)) + "</div>");
      },
    });
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
        "<h4>2026 filings by district</h4>" +
        '<div class="row"><span class="sw" style="background:' + TONE.contested + '"></span>Contested (R &amp; D)</div>' +
        '<div class="row"><span class="sw" style="background:' + TONE.R + '"></span>R candidate only</div>' +
        '<div class="row"><span class="sw" style="background:' + TONE.D + '"></span>D candidate only</div>' +
        '<div class="row"><span class="sw" style="background:' + TONE.other + '"></span>Other party only</div>' +
        '<div class="row"><span class="sw" style="background:' + TONE.none + '"></span>No candidate</div>' +
        '<h4 style="margin-top:6px">Overlays</h4>' +
        '<div class="row"><span class="sw" style="background:#6B8E23"></span>SWCD boundary</div>' +
        '<div class="row"><span class="sw" style="background:#2E86AB"></span>HUC8 watershed</div>';
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

    // A higher pane so the SWCD/HUC8 outlines sit above the filled district polygons.
    map.createPane("overlaysHi");
    map.getPane("overlaysHi").style.zIndex = 450;

    legend().addTo(map);

    var G = "/assets/geo/";
    Promise.all([
      loadJSON(G + "counties.geojson"),
      loadJSON(G + "house.geojson"),
      loadJSON(G + "senate.geojson"),
      loadJSON(G + "congress.geojson"),
      loadJSON(G + "swcd.geojson"),
      loadJSON(G + "huc8.geojson"),
    ])
      .then(function (geo) {
        var counties = referenceLayer(geo[0]);
        var house = districtLayer(geo[1], data.house);
        var senate = districtLayer(geo[2], data.senate);
        var congress = districtLayer(geo[3], data.congress);
        var swcd = overlayLayer(geo[4], "#6B8E23", "overlaysHi", function (p) {
          return p.name;
        });
        var huc8 = overlayLayer(geo[5], "#2E86AB", "overlaysHi", function (p) {
          return p.name + " — HUC8 " + p.key;
        });

        house.addTo(map); // default political boundary

        L.control
          .layers(
            { Counties: counties, "Iowa House": house, "Iowa Senate": senate, "U.S. Congress": congress },
            { "Soil & Water Cons. Districts": swcd, "HUC8 Watersheds": huc8 },
            { collapsed: false }
          )
          .addTo(map);

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
