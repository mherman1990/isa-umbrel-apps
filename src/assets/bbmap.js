/* bbmap.js — renders The Bean Brief's Iowa Political Map with Leaflet.
 *
 * The /map page emits a #ia-map container and a <script id="mapdata"> JSON blob with the
 * candidate/incumbent join { house, senate, congress, statewide }, each district keyed by number
 * as { n, incumbent:{name,party}, cands:[{name,party,inc}], tone }. This draws a muted CARTO
 * basemap, overlays crisp county lines, then lays the chosen political boundary (House / Senate /
 * Congress) translucently on top — each district shaded RED or BLUE by the seat-holder's party.
 * Hovering a district shows an info box naming the incumbent and the 2026 challenger(s); the
 * vendored Soil & Water Conservation District and HUC8 watershed overlays toggle on top.
 *
 * Vendored/static (no build step). Loaded after leaflet.js on the /map page.
 */
(function () {
  if (typeof L === "undefined") return;

  // Fill = current seat-holder's party. Red = Republican, blue = Democratic.
  var TONE = { R: "#C0392B", D: "#2C6FB0", other: "#C77D0A", none: "#CBD3DA" };

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

  // The hover/click info box: district, incumbent, and challenger(s), each labeled.
  function infoHtml(name, d) {
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
    return h;
  }

  // A choropleth political boundary joined to the candidate data by feature.properties.key.
  function districtLayer(geo, dict) {
    var gj = L.geoJSON(geo, {
      style: function (f) {
        var d = dict[f.properties.key];
        return { color: "#3f4b57", weight: 1, fillColor: TONE[d ? d.tone : "none"], fillOpacity: 0.4 };
      },
      onEachFeature: function (f, layer) {
        var d = dict[f.properties.key];
        var html = infoHtml(f.properties.name, d);
        layer.bindTooltip(html, { sticky: true, direction: "top", className: "map-tip", opacity: 1 });
        layer.bindPopup(html, { maxWidth: 300 }); // click/tap fallback (no hover on touch)
        layer.on("mouseover", function () {
          layer.setStyle({ weight: 2.5, fillOpacity: 0.6 });
          layer.bringToFront();
        });
        layer.on("mouseout", function () {
          gj.resetStyle(layer);
        });
      },
    });
    return gj;
  }

  // Always-on county lines — the reference base beneath the translucent districts. Non-interactive
  // so hover/click fall through to the political layer on top.
  function countyLines(geo) {
    return L.geoJSON(geo, {
      interactive: false,
      style: { color: "#4a5763", weight: 1, fill: false, opacity: 0.55 },
    });
  }

  // An outline overlay (SWCD / HUC8) — no meaningful fill, distinct stroke, in a higher pane.
  function overlayLayer(geo, color, pane, labeler) {
    return L.geoJSON(geo, {
      pane: pane,
      style: { color: color, weight: 1.4, fill: true, fillOpacity: 0.04, fillColor: color },
      onEachFeature: function (f, layer) {
        layer.bindPopup('<div class="pop-title">' + esc(labeler(f.properties)) + "</div>");
        layer.bindTooltip(esc(labeler(f.properties)), { sticky: true, className: "map-tip", opacity: 1 });
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
        "<h4>Seat currently held by</h4>" +
        '<div class="row"><span class="sw" style="background:' + TONE.R + '"></span>Republican</div>' +
        '<div class="row"><span class="sw" style="background:' + TONE.D + '"></span>Democrat</div>' +
        '<h4 style="margin-top:6px">Overlays</h4>' +
        '<div class="row"><span class="sw" style="border:1px solid #4a5763;background:transparent"></span>County line</div>' +
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

    // Panes: county lines sit just above the tiles; SWCD/HUC8 outlines sit above everything.
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
        var counties = countyLines(geo[0]);
        var house = districtLayer(geo[1], data.house);
        var senate = districtLayer(geo[2], data.senate);
        var congress = districtLayer(geo[3], data.congress);
        var swcd = overlayLayer(geo[4], "#6B8E23", "overlaysHi", function (p) { return p.name; });
        var huc8 = overlayLayer(geo[5], "#2E86AB", "overlaysHi", function (p) { return p.name + " — HUC8 " + p.key; });

        counties.addTo(map); // always-on base reference
        house.addTo(map); // default political boundary (translucent, over the county lines)

        L.control
          .layers(
            { "Iowa House": house, "Iowa Senate": senate, "U.S. Congress": congress },
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
