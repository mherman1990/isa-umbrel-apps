// Field registry + CLU import (preview → apply) + recent operations.

import { useEffect, useState } from "react";
import { api, getToken } from "../../app/api";

interface FieldRow {
  id: string;
  name: string | null;
  tract_number: string;
  field_number: string;
  acres: number | null;
  source: string;
}

interface PreviewRow {
  row: number;
  farm_number: string | null;
  tract_number: string | null;
  field_number: string | null;
  acres: number | null;
  gis_acres: number | null;
  verdict: string;
  warnings: string[];
}

export default function FieldsScreen() {
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [preview, setPreview] = useState<{ import_id: string; rows: PreviewRow[] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ops, setOps] = useState<any[]>([]);
  const [rotation, setRotation] = useState<any>(null);

  async function refresh() {
    try {
      setFields(await api.get("/fields"));
      setOps(await api.get("/operations"));
      setRotation(await api.get("/rotation"));
    } catch {
      /* offline */
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await api.postForm("/fields/import", form);
      setPreview(res);
      setSelected(new Set(res.rows.filter((r: PreviewRow) => r.verdict === "new").map((r: PreviewRow) => r.row)));
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post(`/fields/import/${preview.import_id}/apply`, {
        accepted_rows: [...selected],
      });
      setMessage(`Imported ${res.created} fields`);
      setPreview(null);
      await refresh();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadShapefile() {
    const res = await fetch("/api/v1/fields/export", { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) {
      setMessage("Nothing to export yet");
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "farmos-fields.zip";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function print578(year: number) {
    let rows: any[];
    try {
      rows = await api.get(`/crop-years?year=${year}&format=fsa578`);
    } catch (e: any) {
      setMessage(e.message);
      return;
    }
    if (!rows.length) {
      setMessage(`No ${year} crop records yet — add crop years or import your crop plan.`);
      return;
    }
    const cols = ["FarmNumber", "TractNumber", "FieldNumber", "CropName", "IntendedUse",
                  "ReportedAcreage", "OriginalPlantedDate", "ProducerShare", "IrrigationPractice"];
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><title>Acreage report ${year}</title>
      <style>body{font-family:sans-serif;font-size:12px}table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #999;padding:4px 6px;text-align:left}h1{font-size:18px}
      .warn{color:#b00;font-size:11px}</style>
      <h1>Acreage report worksheet — crop year ${year}</h1>
      <p>Prepared with Farm OS for the FSA-578. Rows flagged below need attention before filing.</p>
      <table><tr>${cols.map((c) => `<th>${c}</th>`).join("")}<th>Needs attention</th></tr>
      ${rows
        .map(
          (r) =>
            `<tr>${cols.map((c) => `<td>${r[c] ?? ""}</td>`).join("")}<td class="warn">${(r.incomplete ?? []).join("; ")}</td></tr>`,
        )
        .join("")}</table>
      <p>Generated ${new Date().toLocaleString()} — worksheet only; official certification happens with FSA.</p>`);
    w.document.close();
    w.print();
  }

  async function rename(f: FieldRow) {
    const name = prompt(`Nickname for T${f.tract_number}/F${f.field_number}?`, f.name ?? "");
    if (name === null) return;
    await api.patch(`/fields/${f.id}`, { name });
    await refresh();
  }

  return (
    <div className="fields">
      {message && <div className="flash">{message}</div>}

      <div className="card">
        <h3>Import field boundaries</h3>
        <p className="hint">
          Export your boundaries from farmers.gov (Farm Records → Maps → export shapefile or GeoJSON) and
          drop the file here. That seeds your FSA farm/tract/field numbers in one shot.
        </p>
        <label className="capture-alt">
          {busy ? "Working…" : "Choose export file (.zip / .geojson)"}
          <input
            type="file"
            accept=".zip,.geojson,.json"
            hidden
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
      </div>

      {preview && (
        <div className="card">
          <h3>Review before import</h3>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>Farm</th>
                <th>Tract</th>
                <th>Field</th>
                <th>Acres</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.row} className={r.warnings.length ? "warn" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.row)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        e.target.checked ? next.add(r.row) : next.delete(r.row);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td>{r.farm_number ?? "—"}</td>
                  <td>{r.tract_number ?? "—"}</td>
                  <td>{r.field_number ?? "—"}</td>
                  <td>{r.acres ?? r.gis_acres ?? "—"}</td>
                  <td className="small">{r.verdict === "matches_existing" ? "already have" : r.warnings.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="button-row">
            <button className="primary" disabled={busy || selected.size === 0} onClick={apply}>
              Import {selected.size} fields
            </button>
            <button onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Fields ({fields.length})</h3>
        {fields.length === 0 && <p className="hint">No fields yet — import above.</p>}
        <ul className="list">
          {fields.map((f) => (
            <li key={f.id} onClick={() => rename(f)}>
              <strong>{f.name ?? "(tap to name)"}</strong>
              <span className="small">
                T{f.tract_number}/F{f.field_number} · {f.acres ?? "?"} ac · {f.source}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Acreage report (FSA-578 prep)</h3>
        <p className="hint">
          A print-ready summary of what you'd report — flags anything the county office would ask
          about before you're sitting at the desk. Also exports your boundaries as a shapefile
          farmers.gov can import back.
        </p>
        <div className="button-row">
          <button onClick={() => print578(new Date().getFullYear())}>Print {new Date().getFullYear()} report</button>
          <button onClick={downloadShapefile}>Export boundaries (.zip)</button>
        </div>
      </div>

      {rotation && rotation.years.length > 0 && (
        <div className="card">
          <h3>Rotation</h3>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Field</th>
                  {rotation.years.map((y: number) => (
                    <th key={y}>{y}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rotation.fields
                  .filter((f: any) => Object.values(f.crops).some(Boolean))
                  .map((f: any) => (
                    <tr key={f.field_id}>
                      <td>
                        {f.field_name}
                        {f.acres ? <span className="small"> {f.acres}ac</span> : null}
                      </td>
                      {rotation.years.map((y: number) => (
                        <td key={y}>{f.crops[String(y)] ?? "—"}</td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Recent operations</h3>
        {ops.length === 0 && <p className="hint">Confirmed field work shows up here.</p>}
        <ul className="list">
          {ops.slice(0, 20).map((o) => (
            <li key={o.id}>
              <strong>{o.op_type}</strong>
              <span className="small">
                {new Date(o.occurred_at).toLocaleDateString()} ·{" "}
                {o.products.map((p: any) => p.name).join(", ") || o.notes || ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
