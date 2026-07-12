// Confirmation inbox: Confirm / Fix / Discard. Shows the model's own
// uncertainty honestly; ambiguities render as questions the farmer answers
// before confirm is allowed.

import { useEffect, useState } from "react";
import { api } from "../../app/api";

interface InboxItem {
  id: string;
  state: string;
  target_type: string;
  extracted: Record<string, any>;
  confidence: number;
  ambiguities: { key: string; question: string; options?: string[] }[];
  capture: { id: string; kind: string; captured_at: string; transcript: string | null };
}

const TYPE_LABEL: Record<string, string> = {
  field_operation: "Field operation",
  input_inventory: "Inventory",
  equipment_issue: "Equipment",
  note: "Note",
  document: "Document",
};

export default function InboxScreen() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [fields, setFields] = useState<{ id: string; name: string | null; tract_number: string; field_number: string }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [inbox, flds] = await Promise.all([api.get("/inbox?state=pending"), api.get("/fields")]);
      setItems(inbox);
      setFields(flds);
    } catch {
      /* offline — the badge on the tab already says so */
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  async function confirm(item: InboxItem, payload?: Record<string, any>) {
    setError(null);
    try {
      await api.post(`/inbox/${item.id}/confirm`, { final_payload: payload ?? null });
      setEditing(null);
      await refresh();
    } catch (e: any) {
      setError(e.message);
      if (payload === undefined) {
        // server demanded a fix (unresolved ambiguity) — open the editor
        setEditing(item.id);
        setDraft({ ...item.extracted });
      }
    }
  }

  async function reject(item: InboxItem) {
    await api.post(`/inbox/${item.id}/reject`);
    await refresh();
  }

  if (items.length === 0)
    return <div className="empty">Inbox is clear. New captures show up here after parsing.</div>;

  return (
    <div className="inbox">
      {error && <div className="error-banner">{error}</div>}
      {items.map((item) => (
        <div className="card" key={item.id}>
          <div className="card-head">
            <span className={`tag tag-${item.target_type}`}>{TYPE_LABEL[item.target_type] ?? item.target_type}</span>
            <span className="confidence">{Math.round(item.confidence * 100)}% sure</span>
          </div>
          {item.capture.transcript && <blockquote className="transcript">“{item.capture.transcript}”</blockquote>}
          <dl className="kv">
            {Object.entries(item.extracted).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
          {item.ambiguities.length > 0 && (
            <div className="ambiguities">
              {item.ambiguities.map((a) => (
                <div key={a.key} className="ambiguity">
                  ❓ {a.question}
                </div>
              ))}
            </div>
          )}
          {editing === item.id ? (
            <div className="editor">
              {item.target_type === "field_operation" && (
                <label>
                  Which field?
                  <select
                    value={draft.field_id ?? ""}
                    onChange={(e) => setDraft({ ...draft, field_id: e.target.value })}
                  >
                    <option value="">— pick a field —</option>
                    {fields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name ?? `T${f.tract_number}/F${f.field_number}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {item.ambiguities
                .filter((a) => a.key !== "field_id")
                .map((a) => (
                  <label key={a.key}>
                    {a.question}
                    {a.options?.length ? (
                      <select
                        value={draft[a.key] ?? ""}
                        onChange={(e) => setDraft({ ...draft, [a.key]: e.target.value })}
                      >
                        <option value="">— choose —</option>
                        {a.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={draft[a.key] ?? ""} onChange={(e) => setDraft({ ...draft, [a.key]: e.target.value })} />
                    )}
                  </label>
                ))}
              <label>
                Notes
                <input value={draft.notes ?? ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              </label>
              <div className="button-row">
                <button className="primary" onClick={() => confirm(item, draft)}>
                  Save record
                </button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="button-row">
              <button className="primary" onClick={() => confirm(item)}>
                ✓ Confirm
              </button>
              <button
                onClick={() => {
                  setEditing(item.id);
                  setDraft({ ...item.extracted });
                }}
              >
                ✎ Fix
              </button>
              <button className="danger" onClick={() => reject(item)}>
                ✕ Discard
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
