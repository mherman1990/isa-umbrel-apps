// Money: transactions, budget vs actual, per-field breakeven, and the
// workbook importer (model proposes the mapping; the farmer confirms it).

import { useEffect, useState } from "react";
import { api } from "../../app/api";

const THIS_YEAR = new Date().getFullYear();

interface MappingTab {
  sheet: string;
  kind: string;
  header_row: number;
  crop_year?: number | null;
  columns: Record<string, string>;
  notes?: string;
}

export default function MoneyScreen() {
  const [year, setYear] = useState(THIS_YEAR);
  const [summary, setSummary] = useState<any>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [flash, setFlash] = useState<string | null>(null);

  // quick-add form
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("expense");
  const [crop, setCrop] = useState("");

  // workbook import
  const [wb, setWb] = useState<any>(null);
  const [tabs, setTabs] = useState<MappingTab[]>([]);
  const [busy, setBusy] = useState(false);

  const [position, setPosition] = useState<any>(null);

  async function refresh() {
    try {
      setSummary(await api.get(`/financials/summary?year=${year}`));
      setTxns(await api.get(`/transactions?year=${year}`));
      setPosition(await api.get(`/grain/position?year=${year}`));
    } catch {
      /* offline */
    }
  }
  useEffect(() => {
    void refresh();
  }, [year]);

  async function addTxn() {
    await api.post("/transactions", {
      client_id: crypto.randomUUID(),
      occurred_on: new Date().toISOString().slice(0, 10),
      description: desc,
      kind,
      amount: Number(amount),
      crop: crop || null,
      category: "other",
    });
    setDesc("");
    setAmount("");
    setFlash("Saved");
    setTimeout(() => setFlash(null), 2000);
    await refresh();
  }

  async function uploadWorkbook(file: File) {
    setBusy(true);
    setFlash(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await api.postForm("/workbooks", form);
      setWb(res);
      setTabs((res.mapping ?? res.proposal)?.tabs ?? []);
    } catch (e: any) {
      setFlash(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    setBusy(true);
    try {
      const res = await api.post(`/workbooks/${wb.id}/confirm`, { mapping: { tabs } });
      const c = res.import_result.created;
      setFlash(
        `Imported: ${c.crop_years} crop years, ${c.transactions} transactions, ${c.budget_lines} budget lines` +
          (res.import_result.warnings.length ? ` — ${res.import_result.warnings.length} rows skipped (see below)` : ""),
      );
      setWb(res);
      await refresh();
    } catch (e: any) {
      setFlash(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="money">
      {flash && <div className="flash">{flash}</div>}
      <label>
        Crop year
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[THIS_YEAR + 1, THIS_YEAR, THIS_YEAR - 1, THIS_YEAR - 2].map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </label>

      {position?.crops?.length > 0 && (
        <div className="card">
          <h3>Grain position</h3>
          {position.crops.map((c: any) => (
            <div key={c.crop} className="crop-row">
              <strong>{c.crop}</strong>
              {c.produced_bu != null ? (
                <span className="small">
                  {c.produced_bu.toLocaleString()} bu produced · {c.in_bin_bu.toLocaleString()} in bin ·{" "}
                  {c.delivered_bu.toLocaleString()} delivered · {c.contracted_bu.toLocaleString()} contracted (
                  {c.priced_bu.toLocaleString()} priced) · {c.unpriced_bu.toLocaleString()} unpriced
                </span>
              ) : (
                <span className="small warn-text">{(c.gaps ?? []).join("; ")}</span>
              )}
              {c.posture && <span className="small">{c.posture}</span>}
            </div>
          ))}
          <p className="hint">{position.note}</p>
        </div>
      )}

      <div className="card">
        <h3>Budget vs actual</h3>
        {!summary?.crops?.length && <p className="hint">Import a workbook below or add transactions to see this.</p>}
        {summary?.crops?.map((c: any) => (
          <div key={c.crop} className="crop-row">
            <strong>{c.crop}</strong>
            <span className="small">
              {c.acres ? `${c.acres} ac · ` : ""}
              budget {c.budget_total ? `$${c.budget_total.toLocaleString()}` : "—"} · spent $
              {c.actual_spend.toLocaleString()}
              {c.income ? ` · income $${c.income.toLocaleString()}` : ""}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Breakeven by field</h3>
        <p className="hint">{summary?.note}</p>
        {summary?.fields?.map((f: any) => (
          <div key={f.field_id + f.crop} className="crop-row">
            <strong>
              {f.field_name} — {f.crop}
            </strong>
            {f.breakeven_per_bu != null ? (
              <span className="small">
                ${f.breakeven_per_bu}/bu · ${f.cost_per_acre}/ac · {f.harvested_bushels.toLocaleString()} bu
              </span>
            ) : (
              <span className="small warn-text">{(f.insufficient_data ?? []).join("; ")}</span>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Add a transaction</h3>
        <label>
          Description
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Co-op fuel" />
        </label>
        <div className="button-row">
          <label style={{ flex: 1 }}>
            Amount $
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="expense">expense</option>
              <option value="income">income</option>
            </select>
          </label>
          <label>
            Crop
            <select value={crop} onChange={(e) => setCrop(e.target.value)}>
              <option value="">—</option>
              <option value="corn">corn</option>
              <option value="soybeans">soybeans</option>
            </select>
          </label>
        </div>
        <button className="primary" disabled={!desc || !Number(amount)} onClick={addTxn}>
          Save
        </button>
      </div>

      <div className="card">
        <h3>Import your Excel workbook</h3>
        <p className="hint">
          Your crop plan and budget probably already live in Excel — don't retype them. Upload the
          workbook, check what the AI thinks each tab means, correct anything wrong, and import.
        </p>
        <label className="capture-alt">
          {busy ? "Working…" : "Choose workbook (.xlsx)"}
          <input
            type="file"
            accept=".xlsx,.xlsm"
            hidden
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && uploadWorkbook(e.target.files[0])}
          />
        </label>

        {wb && tabs.length > 0 && (
          <div className="mapping-review">
            <h4>Review the mapping</h4>
            {tabs.map((t, i) => (
              <div key={t.sheet} className="mapping-tab">
                <strong>{t.sheet}</strong>
                <label>
                  This tab is…
                  <select
                    value={t.kind}
                    onChange={(e) => setTabs(tabs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}
                  >
                    <option value="crop_plan">crop plan / rotation</option>
                    <option value="transactions">transactions</option>
                    <option value="budget">budget ($/ac)</option>
                    <option value="ignore">skip this tab</option>
                  </select>
                </label>
                {t.kind !== "ignore" && (
                  <p className="small">
                    columns: {Object.entries(t.columns ?? {}).map(([c, r]) => `${c}→${r}`).join(", ") || "none mapped"}
                    {t.notes ? ` · ${t.notes}` : ""}
                  </p>
                )}
              </div>
            ))}
            <button className="primary" disabled={busy} onClick={confirmImport}>
              Looks right — import
            </button>
            {wb.import_result?.warnings?.length > 0 && (
              <details>
                <summary className="small">{wb.import_result.warnings.length} skipped rows</summary>
                <ul className="small">
                  {wb.import_result.warnings.map((w: string, i: number) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Transactions ({txns.length})</h3>
        <ul className="list">
          {txns.slice(0, 30).map((t) => (
            <li key={t.id}>
              <strong>
                {t.kind === "income" ? "+" : "−"}${t.amount.toLocaleString()} {t.description}
              </strong>
              <span className="small">
                {t.occurred_on} · {t.category}
                {t.crop ? ` · ${t.crop}` : ""}
                {t.imported ? " · imported" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
