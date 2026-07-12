// Leaflet boundary editor. Offline blank canvas by default (existing
// boundaries only); an opt-in toggle adds Esri aerial imagery — external tile
// requests that reveal the field location, so it's OFF until the farmer asks
// for it (disclosed in Settings → what leaves this box).

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import { api } from "../../app/api";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export default function FieldMap({ fields, onChange }: { fields: any[]; onChange: () => void }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const group = useRef<L.FeatureGroup | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const editing = useRef<any>(null);
  const [imagery, setImagery] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const farmId = fields.find((f) => f.farm_id)?.farm_id as string | undefined;

  // init once
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { center: [42.02, -93.62], zoom: 13 });
    map.current = m;
    group.current = L.featureGroup().addTo(m);
    const pm = (m as any).pm;
    pm.addControls({
      position: "topleft",
      drawMarker: false, drawCircle: false, drawCircleMarker: false, drawPolyline: false,
      drawRectangle: false, drawText: false, cutPolygon: false, rotateMode: false, dragMode: false,
      editMode: false, removalMode: false,
    });
    pm.setGlobalOptions({ allowSelfIntersection: false });
    m.on("pm:create", async (e: any) => {
      const geometry = e.layer.toGeoJSON().geometry;
      e.layer.remove(); // re-render from the server after create
      await createField(geometry);
    });
    setTimeout(() => m.invalidateSize(), 0);
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (re)render field polygons whenever the list changes
  useEffect(() => {
    const g = group.current, m = map.current;
    if (!g || !m) return;
    g.clearLayers();
    editing.current = null;
    setSelected(null);
    fields.forEach((f) => {
      if (!f.boundary) return;
      const gj = L.geoJSON(f.boundary, { style: { color: "#1b5e20", weight: 2, fillOpacity: 0.15 } });
      const label = f.name ?? `T${f.tract_number}/F${f.field_number}`;
      gj.bindTooltip(`${label} · ${f.acres ?? "?"} ac`);
      gj.on("click", () => beginEdit(f, gj.getLayers()[0]));
      g.addLayer(gj);
    });
    const b = g.getBounds();
    if (b.isValid()) m.fitBounds(b, { padding: [20, 20] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields]);

  // opt-in imagery
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (imagery && !tiles.current) {
      tiles.current = L.tileLayer(ESRI, { attribution: "Imagery © Esri", maxZoom: 19 }).addTo(m);
      tiles.current.bringToBack();
    } else if (!imagery && tiles.current) {
      m.removeLayer(tiles.current);
      tiles.current = null;
    }
  }, [imagery]);

  function beginEdit(field: any, layer: any) {
    if (editing.current) editing.current.pm?.disable();
    editing.current = layer;
    layer.pm?.enable({ allowSelfIntersection: false });
    setSelected(field);
  }

  async function saveSelected() {
    if (!selected || !editing.current) return;
    try {
      const geometry = editing.current.toGeoJSON().geometry;
      const res = await api.put(`/fields/${selected.id}/boundary`, { geometry });
      setFlash(`Saved ${res.name ?? "field"} — ${res.acres} ac`);
      editing.current = null;
      setSelected(null);
      onChange();
    } catch (e: any) {
      setFlash(e.message);
    }
  }

  async function createField(geometry: any) {
    if (!farmId) {
      setFlash("Import or create a farm first, then you can draw new fields.");
      onChange();
      return;
    }
    const tract = window.prompt("Tract number for the new field?");
    if (tract === null) return onChange();
    const fieldNo = window.prompt("Field number?");
    if (fieldNo === null) return onChange();
    const name = window.prompt("Name (optional)?") || undefined;
    try {
      const res = await api.post("/fields", {
        farm_id: farmId, tract_number: tract, field_number: fieldNo, name, geometry,
      });
      setFlash(`Created ${res.name ?? "field"} — ${res.acres} ac`);
    } catch (e: any) {
      setFlash(e.message);
    }
    onChange();
  }

  return (
    <div className="card">
      <h3>Field map &amp; boundary editor</h3>
      <p className="hint">
        Tap a field to edit its outline (drag the dots), then Save. Use the polygon tool to draw a new
        field. {imagery ? "Aerial imagery is on." : "Blank canvas — fully offline."}
      </p>
      <label className="inline">
        <input type="checkbox" checked={imagery} onChange={(e) => setImagery(e.target.checked)} />
        Aerial imagery (sends the map location to Esri — off by default)
      </label>
      <div ref={mapEl} style={{ height: 380, borderRadius: 8, overflow: "hidden", background: "#e8eae6" }} />
      {flash && <p className="small">{flash}</p>}
      {selected && (
        <div className="button-row">
          <span className="small">
            Editing <strong>{selected.name ?? `T${selected.tract_number}/F${selected.field_number}`}</strong> — drag vertices
          </span>
          <button className="primary" onClick={saveSelected}>Save outline</button>
          <button
            onClick={() => {
              editing.current?.pm?.disable();
              editing.current = null;
              setSelected(null);
              onChange();
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
