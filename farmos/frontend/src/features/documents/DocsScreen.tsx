// Document vault — every routed paper record, linked to its original image.

import { useEffect, useState } from "react";
import { api, getToken } from "../../app/api";

interface Doc {
  id: string;
  doc_type: string;
  title: string;
  extracted: Record<string, any> | null;
  created_at: string;
}

const TYPES = ["", "receipt", "scale_ticket", "seed_tag", "applicator_record", "lease", "fsa_form", "insurance", "soil_test", "contract", "other"];

export default function DocsScreen() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .get(`/documents${filter ? `?doc_type=${filter}` : ""}`)
      .then(setDocs)
      .catch(() => {});
  }, [filter]);

  async function viewFile(id: string) {
    // fetch with the device token, then open as a blob URL
    const res = await fetch(`/api/v1/documents/${id}/file`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  }

  return (
    <div className="docs">
      <label>
        Filter by type
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t || "all documents"}
            </option>
          ))}
        </select>
      </label>
      {docs.length === 0 && (
        <div className="empty">
          Snap a photo of any paper — scale ticket, receipt, seed tag, applicator record — and it lands
          here, parsed.
        </div>
      )}
      {docs.map((d) => (
        <div className="card" key={d.id}>
          <div className="card-head">
            <span className="tag">{d.doc_type}</span>
            <span className="small">{new Date(d.created_at).toLocaleDateString()}</span>
          </div>
          <h3>{d.title}</h3>
          {d.extracted === null && <p className="small">extraction awaiting your confirmation in the Inbox</p>}
          {open === d.id && d.extracted && (
            <dl className="kv">
              {Object.entries(d.extracted).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="button-row">
            {d.extracted && (
              <button className="linkish" onClick={() => setOpen(open === d.id ? null : d.id)}>
                {open === d.id ? "Hide details" : "Details"}
              </button>
            )}
            <button className="linkish" onClick={() => viewFile(d.id)}>
              Original
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
