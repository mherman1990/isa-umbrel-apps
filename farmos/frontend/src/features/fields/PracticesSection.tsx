// Practice inventory: what was done on which acres — the thing programs
// pay for. Logging one here is what the MRV readiness report evaluates.

import { useEffect, useState } from "react";
import { api } from "../../app/api";

const TYPES = [
  ["cover_crop", "Cover crop"],
  ["tillage", "Tillage system"],
  ["nutrient_mgmt", "Nutrient management"],
  ["edge_of_field", "Edge of field structure"],
  ["buffer", "Buffer"],
  ["waterway", "Waterway"],
  ["terrace", "Terrace"],
  ["other", "Other"],
] as const;

export default function PracticesSection({ fields }: { fields: { id: string; name: string | null }[] }) {
  const year = new Date().getFullYear() + 1; // practices are logged ahead for the coming crop year
  const [practices, setPractices] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [ptype, setPtype] = useState("cover_crop");
  const [species, setSpecies] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  async function refresh() {
    try {
      setPractices(await api.get(`/practices?crop_year=${year}`));
    } catch {
      /* offline */
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function add() {
    await api.post("/practices", {
      field_id: fieldId,
      crop_year: year,
      practice_type: ptype,
      attributes: ptype === "cover_crop" && species ? { species } : {},
    });
    setAdding(false);
    setSpecies("");
    setFlash("Practice logged — attach photos to it as you take them");
    setTimeout(() => setFlash(null), 3000);
    await refresh();
  }

  const label = (t: string) => TYPES.find(([k]) => k === t)?.[1] ?? t;

  return (
    <div className="card">
      <h3>Practices ({year})</h3>
      {flash && <div className="flash">{flash}</div>}
      {practices.length === 0 && (
        <p className="hint">
          Log what you're doing — cover crops, tillage, nutrient management. Programs pay for practices,
          and the readiness check on the Programs tab needs them recorded here.
        </p>
      )}
      <ul className="list">
        {practices.map((p) => (
          <li key={p.id}>
            <strong>
              {label(p.practice_type)}
              {p.attributes?.species ? ` — ${p.attributes.species}` : ""}
            </strong>
            <span className="small">
              {fields.find((f) => f.id === p.field_id)?.name ?? "field"} ·{" "}
              {p.evidence_count > 0 ? `${p.evidence_count} evidence item(s)` : "no evidence yet"}
            </span>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="editor">
          <label>
            Field
            <select value={fieldId} onChange={(e) => setFieldId(e.target.value)}>
              <option value="">— pick —</option>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name ?? f.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Practice
            <select value={ptype} onChange={(e) => setPtype(e.target.value)}>
              {TYPES.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {ptype === "cover_crop" && (
            <label>
              Species
              <input value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="cereal rye" />
            </label>
          )}
          <div className="button-row">
            <button className="primary" disabled={!fieldId} onClick={add}>
              Log practice
            </button>
            <button onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}>+ Log a practice</button>
      )}
    </div>
  );
}
