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
  const [scheduleF, setScheduleF] = useState<any>(null);
  const [cashFlow, setCashFlow] = useState<any>(null);
  const [fields, setFields] = useState<any[]>([]);

  // inline transaction allocation editor
  const [editId, setEditId] = useState<string | null>(null);
  const [editCat, setEditCat] = useState("");
  const [editCrop, setEditCrop] = useState("");
  const [editField, setEditField] = useState("");

  // operating-line add forms
  const [loanName, setLoanName] = useState("");
  const [loanLimit, setLoanLimit] = useState("");
  const [evLoan, setEvLoan] = useState("");
  const [evType, setEvType] = useState("draw");
  const [evAmount, setEvAmount] = useState("");

  async function refresh() {
    try {
      setSummary(await api.get(`/financials/summary?year=${year}`));
      setTxns(await api.get(`/transactions?year=${year}`));
      setPosition(await api.get(`/grain/position?year=${year}`));
      setScheduleF(await api.get(`/financials/schedule-f?year=${year}`));
      setCashFlow(await api.get(`/financials/cash-flow?year=${year}`));
      setFields(await api.get(`/fields`));
    } catch {
      /* offline */
    }
  }

  function startEdit(t: any) {
    setEditId(t.id);
    setEditCat(t.category === "other" ? "" : t.category || "");
    setEditCrop(t.crop || "");
    setEditField(t.field_id || "");
  }

  async function saveAllocation() {
    await api.patch(`/transactions/${editId}`, {
      category: editCat || "other",
      crop: editCrop || null,
      field_id: editField || null,
    });
    setEditId(null);
    await refresh();
  }

  async function addLoan() {
    await api.post("/operating-loans", {
      client_id: crypto.randomUUID(),
      name: loanName,
      credit_limit_usd: Number(loanLimit),
      crop_year: year,
    });
    setLoanName("");
    setLoanLimit("");
    await refresh();
  }

  async function addLoanEvent() {
    await api.post(`/operating-loans/${evLoan}/events`, {
      client_id: crypto.randomUUID(),
      occurred_on: new Date().toISOString().slice(0, 10),
      event_type: evType,
      amount: Number(evAmount),
    });
    setEvAmount("");
    await refresh();
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

  async function exportLenderPacket() {
    try {
      const html = await api.getText(`/financials/lender-packet?year=${year}&format=html`);
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      setFlash(e.message);
    }
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

      {scheduleF && (scheduleF.income_lines.length > 0 || scheduleF.expense_lines.length > 0 ||
        scheduleF.uncategorized.expense.length > 0 || scheduleF.uncategorized.income.length > 0) && (
        <div className="card">
          <h3>Schedule F ({scheduleF.form.tax_year})</h3>
          <div className="crop-row">
            <strong>Net farm profit</strong>
            <span className="small">
              ${scheduleF.totals.net_farm_profit.toLocaleString()} (income $
              {scheduleF.totals.gross_income.toLocaleString()} − expenses $
              {scheduleF.totals.total_expenses.toLocaleString()})
            </span>
          </div>
          {!scheduleF.complete && <p className="hint warn-text">{scheduleF.note}</p>}
          <details>
            <summary className="small">
              {scheduleF.income_lines.length + scheduleF.expense_lines.length} lines
              {scheduleF.uncategorized.expense.length + scheduleF.uncategorized.income.length > 0
                ? ` · ${scheduleF.uncategorized.expense.length + scheduleF.uncategorized.income.length} uncategorized`
                : ""}
            </summary>
            <ul className="small list">
              {scheduleF.income_lines.map((l: any) => (
                <li key={`i${l.line}`}>
                  <strong>Ln {l.line}</strong> {l.name}: +${l.amount.toLocaleString()}
                </li>
              ))}
              {scheduleF.expense_lines.map((l: any) => (
                <li key={`e${l.line}`}>
                  <strong>Ln {l.line}</strong> {l.name}: −${l.amount.toLocaleString()}
                </li>
              ))}
              {[...scheduleF.uncategorized.income, ...scheduleF.uncategorized.expense].map((u: any) => (
                <li key={`u${u.category}`} className="warn-text">
                  uncategorized “{u.category}”: ${u.amount.toLocaleString()} — assign a category to include it
                </li>
              ))}
            </ul>
          </details>
          <p className="hint">
            Line map: {scheduleF.form.form} v{scheduleF.form.version}
            {scheduleF.form.stale ? ` · unverified since ${scheduleF.form.verify_by}` : ""}
          </p>
        </div>
      )}

      <div className="card">
        <h3>Lender packet</h3>
        <p className="hint">
          A printable income statement + enterprise detail + grain position for {year}, assembled
          from your records. It states plainly what it can’t show (there’s no balance sheet yet).
          Open it and print to PDF.
        </p>
        <button className="primary" onClick={exportLenderPacket}>
          Export lender packet ({year})
        </button>
      </div>

      {cashFlow && (
        <div className="card">
          <h3>Cash-flow projection ({year})</h3>
          <div className="crop-row">
            <strong>Peak operating need</strong>
            <span className="small">
              ${cashFlow.peak_operating_need_usd.toLocaleString()} · planned out $
              {cashFlow.planned_outflow_total.toLocaleString()} · planned in $
              {cashFlow.planned_inflow_total.toLocaleString()}
            </span>
          </div>
          <table className="cashflow">
            <thead>
              <tr>
                <th>Mo</th>
                <th className="num">Plan net</th>
                <th className="num">Cumulative</th>
                <th className="num">Actual net</th>
              </tr>
            </thead>
            <tbody>
              {cashFlow.months
                .filter((m: any) => m.planned_in || m.planned_out || m.actual_in || m.actual_out)
                .map((m: any) => (
                  <tr key={m.month}>
                    <td>{m.label}</td>
                    <td className="num">{m.planned_net.toLocaleString()}</td>
                    <td className={"num" + (m.cumulative_planned_net < 0 ? " warn-text" : "")}>
                      {m.cumulative_planned_net.toLocaleString()}
                    </td>
                    <td className="num">{m.actual_net ? m.actual_net.toLocaleString() : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {cashFlow.gaps && (
            <ul className="small warn-text">
              {cashFlow.gaps.map((g: string, i: number) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          )}
          <p className="hint">
            Outflow spreads your budget by typical Iowa timing (pack {cashFlow.timing_pack.version}
            {cashFlow.timing_pack.stale ? `, unverified since ${cashFlow.timing_pack.verify_by}` : ""}); inflow
            counts only priced contracts. {cashFlow.even_spread_categories.length > 0
              ? `Even-spread (no timing): ${cashFlow.even_spread_categories.join(", ")}.`
              : ""}
          </p>
        </div>
      )}

      {cashFlow && (
        <div className="card">
          <h3>Operating line</h3>
          {cashFlow.operating_line.loans.length === 0 && (
            <p className="hint">No operating line recorded for {year}. Add one to track draws vs. the projected need.</p>
          )}
          {cashFlow.operating_line.loans.map((l: any) => (
            <div key={l.id} className="crop-row">
              <strong>{l.name}</strong>
              <span className={"small" + (l.over_limit ? " warn-text" : "")}>
                ${l.outstanding_balance_usd.toLocaleString()} drawn of $
                {l.credit_limit_usd.toLocaleString()} · ${l.available_usd.toLocaleString()} available
                {l.over_limit ? " · OVER LIMIT" : ""}
              </span>
            </div>
          ))}
          <div className="button-row">
            <label style={{ flex: 1 }}>
              New line name
              <input value={loanName} onChange={(e) => setLoanName(e.target.value)} placeholder="FCS operating line" />
            </label>
            <label>
              Limit $
              <input inputMode="decimal" value={loanLimit} onChange={(e) => setLoanLimit(e.target.value)} />
            </label>
            <button className="primary" disabled={!loanName || !Number(loanLimit)} onClick={addLoan}>
              Add line
            </button>
          </div>
          {cashFlow.operating_line.loans.length > 0 && (
            <div className="button-row">
              <label style={{ flex: 1 }}>
                Line
                <select value={evLoan} onChange={(e) => setEvLoan(e.target.value)}>
                  <option value="">—</option>
                  {cashFlow.operating_line.loans.map((l: any) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select value={evType} onChange={(e) => setEvType(e.target.value)}>
                  <option value="draw">draw</option>
                  <option value="paydown">paydown</option>
                  <option value="interest">interest</option>
                </select>
              </label>
              <label>
                Amount $
                <input inputMode="decimal" value={evAmount} onChange={(e) => setEvAmount(e.target.value)} />
              </label>
              <button className="primary" disabled={!evLoan || !Number(evAmount)} onClick={addLoanEvent}>
                Record
              </button>
            </div>
          )}
          <p className="hint">Balances are derived from the draw/paydown ledger, never entered directly.</p>
        </div>
      )}

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
        <p className="hint">Tap a transaction to assign its category, crop, and field — that’s what fills in Schedule F and per-field breakeven.</p>
        <ul className="list">
          {txns.slice(0, 40).map((t) => (
            <li key={t.id}>
              <div className="txn-head" onClick={() => (editId === t.id ? setEditId(null) : startEdit(t))}>
                <strong>
                  {t.kind === "income" ? "+" : "−"}${t.amount.toLocaleString()} {t.description}
                </strong>
                <span className="small">
                  {t.occurred_on} · {t.category}
                  {t.crop ? ` · ${t.crop}` : ""}
                  {t.field_id ? " · field-tagged" : ""}
                  {t.imported ? " · imported" : ""}
                </span>
              </div>
              {editId === t.id && (
                <div className="alloc-editor button-row">
                  <label style={{ flex: 1 }}>
                    Category
                    <input value={editCat} onChange={(e) => setEditCat(e.target.value)} placeholder="seed, fertilizer…" />
                  </label>
                  <label>
                    Crop
                    <select value={editCrop} onChange={(e) => setEditCrop(e.target.value)}>
                      <option value="">—</option>
                      <option value="corn">corn</option>
                      <option value="soybeans">soybeans</option>
                    </select>
                  </label>
                  <label>
                    Field
                    <select value={editField} onChange={(e) => setEditField(e.target.value)}>
                      <option value="">—</option>
                      {fields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name || `T${f.tract_number}/F${f.field_number}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" onClick={saveAllocation}>
                    Save
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
