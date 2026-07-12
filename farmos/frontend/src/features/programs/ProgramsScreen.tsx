// Program Finder — "programs worth a look", never an eligibility
// assertion. Every line shows its citation and last-verified date; stale
// rules are labeled, not hidden (Hard Requirement #6).

import { useEffect, useState } from "react";
import { api } from "../../app/api";

interface RuleView {
  rule_key: string;
  verdict: "pass" | "fail" | "unknown";
  stale: boolean;
  description: string;
  citation: string;
  source_url: string;
  last_verified: string;
}

interface ProgramView {
  program_key: string;
  name: string;
  agency: string;
  tier: string;
  summary: string;
  payment_rate: string | null;
  signup_deadline: string | null;
  source_url: string;
  last_verified: string;
  stale: boolean;
  excluded_by_rule: boolean;
  rules: RuleView[];
}

function ReadinessPanel({ programKey }: { programKey: string }) {
  const [report, setReport] = useState<any>(null);
  const [show, setShow] = useState(false);
  const year = new Date().getFullYear() + 1; // next crop year is what you're preparing evidence for

  async function load() {
    if (!show && !report) {
      try {
        setReport(await api.get(`/programs/${programKey}/readiness?crop_year=${year}`));
      } catch {
        setReport({ requirements: [] });
      }
    }
    setShow(!show);
  }

  return (
    <div>
      <button className="linkish" onClick={load}>
        {show ? "Hide" : "Check"} record readiness ({year})
      </button>
      {show && report && (
        <div>
          {report.requirements.length === 0 && (
            <p className="small">{report.note ?? "No evidence spec on file for this program yet."}</p>
          )}
          {report.requirements.map((req: any) => (
            <div key={req.req_key} className="rule rule-unknown">
              <span className="rule-verdict">📋</span>
              <div>
                <div>
                  <strong>{req.subject}</strong>
                  {req.verifier_grade_required ? " (verifier-grade photo required)" : ""}
                </div>
                {req.no_matching_practices && (
                  <div className="small warn-text">
                    No {req.practice_type.replace("_", " ")} practice recorded for {year} — log the practice first.
                  </div>
                )}
                {req.practices.map((c: any) => (
                  <div key={c.practice_id} className="small">
                    {c.field_name}:{" "}
                    {c.status === "met" ? (
                      <span>✓ have it{c.detail?.tamper_evident ? " (tamper-evident)" : ""}</span>
                    ) : c.window_closed ? (
                      <span className="warn-text">✕ missing — window closed {c.window[1]}</span>
                    ) : c.days_left != null ? (
                      <span className="warn-text">
                        needed by {c.window[1]} — {c.days_left} days left{c.status === "partial" ? ` (${c.detail?.reason})` : ""}
                      </span>
                    ) : (
                      <span className="warn-text">missing{c.status === "partial" ? ` (${c.detail?.reason})` : ""}</span>
                    )}
                  </div>
                ))}
                <div className="small">
                  {req.citation} · verified {req.last_verified}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StackingChecker({ programs }: { programs: ProgramView[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acres, setAcres] = useState("160");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      setResult(await api.get(`/programs/stacking?programs=${[...selected].join(",")}&acres=${Number(acres)}`));
    } catch (e: any) {
      setResult({ error: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Can these stack?</h3>
      <p className="hint">
        Pick programs you're weighing for the SAME acres — see which combinations are allowed, which are
        mutually exclusive, and which verified combination pays the most.
      </p>
      {programs.map((p) => (
        <label key={p.program_key} className="inline">
          <input
            type="checkbox"
            checked={selected.has(p.program_key)}
            onChange={(e) => {
              const next = new Set(selected);
              e.target.checked ? next.add(p.program_key) : next.delete(p.program_key);
              setSelected(next);
            }}
          />
          {p.name}
        </label>
      ))}
      <label>
        Acres
        <input inputMode="numeric" value={acres} onChange={(e) => setAcres(e.target.value)} />
      </label>
      <button className="primary" disabled={busy || selected.size < 2 || !Number(acres)} onClick={run}>
        Check stacking
      </button>

      {result?.error && <div className="error-banner">{result.error}</div>}
      {result?.pairs && (
        <div className="stacking-result">
          {result.best_verified_combo ? (
            <div className="flash">
              <strong>
                Best verified combination: {result.best_verified_combo.programs.join(" + ")} — $
                {result.best_verified_combo.per_acre_usd}/ac (${result.best_verified_combo.total_usd.toLocaleString()} on{" "}
                {result.acres} ac)
              </strong>
              {result.best_verified_combo.not_computable.length > 0 && (
                <div className="small">
                  plus {result.best_verified_combo.not_computable.join(", ")} — rate not computable, see program terms
                </div>
              )}
            </div>
          ) : (
            <div className="error-banner">No fully verified combination — see the pair notes below.</div>
          )}
          {result.pairs.map((p: any, i: number) => (
            <div key={i} className={`rule rule-${p.relation === "exclusive" ? "fail" : p.relation === "stackable" ? "pass" : "unknown"}`}>
              <span className="rule-verdict">{p.relation === "exclusive" ? "✕" : p.relation === "stackable" ? "✓" : "?"}</span>
              <div>
                <div>
                  <strong>{p.programs.join(" + ")}</strong>: {p.relation}
                  {p.stale ? " (rule STALE — confirm before acting)" : ""}
                </div>
                <div className="small">
                  {p.description ?? p.note}
                  {p.citation ? ` — ${p.citation}` : ""}
                  {p.last_verified ? ` · verified ${p.last_verified}` : ""}
                </div>
              </div>
            </div>
          ))}
          <p className="small">{result.disclaimer}</p>
        </div>
      )}
    </div>
  );
}

function NRateCard() {
  const [cornPrice, setCornPrice] = useState("5.00");
  const [nPrice, setNPrice] = useState("0.50");
  const [rotation, setRotation] = useState("corn_after_soybean");
  const [applied, setApplied] = useState("");
  const [result, setResult] = useState<any>(null);

  async function run() {
    const q = new URLSearchParams({ corn_price: cornPrice, n_price_per_lb: nPrice, rotation });
    if (applied) q.set("applied_n", applied);
    try {
      setResult(await api.get(`/agronomy/n-rate?${q.toString()}`));
    } catch (e: any) {
      setResult({ error: e.message });
    }
  }

  return (
    <div className="card">
      <h3>Nitrogen rate (MRTN)</h3>
      <p className="hint">
        Economically optimal corn N for your prices (Iowa State MRTN approach). A recommendation —
        confirm at the ISU calculator before applying.
      </p>
      <div className="button-row">
        <label>Corn $/bu<input inputMode="decimal" value={cornPrice} onChange={(e) => setCornPrice(e.target.value)} /></label>
        <label>N $/lb<input inputMode="decimal" value={nPrice} onChange={(e) => setNPrice(e.target.value)} /></label>
        <label>
          Rotation
          <select value={rotation} onChange={(e) => setRotation(e.target.value)}>
            <option value="corn_after_soybean">corn after soybean</option>
            <option value="corn_after_corn">corn after corn</option>
          </select>
        </label>
        <label>Applied lb/ac<input inputMode="decimal" value={applied} onChange={(e) => setApplied(e.target.value)} placeholder="opt." /></label>
      </div>
      <button className="primary" disabled={!Number(cornPrice) || !Number(nPrice)} onClick={run}>
        Calculate
      </button>
      {result?.error && <div className="error-banner">{result.error}</div>}
      {result?.mrtn_rate_lb_n != null && (
        <div className="stacking-result">
          <div className="flash">
            <strong>MRTN: {result.mrtn_rate_lb_n} lb N/ac</strong> — profitable range{" "}
            {result.profitable_range_lb_n[0]}–{result.profitable_range_lb_n[1]}; agronomic max {result.agronomic_max_lb_n}
          </div>
          {result.comparison && (
            <p className="small">
              You applied {result.comparison.applied_n_lb} lb ({result.comparison.source}) —{" "}
              {result.comparison.delta_vs_mrtn_lb > 0
                ? `${result.comparison.delta_vs_mrtn_lb} over`
                : `${-result.comparison.delta_vs_mrtn_lb} under`}
              , ${result.comparison.net_left_on_table_per_ac}/ac left on the table.
            </p>
          )}
          <p className="small">
            {result.unverified ? "Approximate coefficients · " : ""}
            <a href={result.source_url} target="_blank" rel="noreferrer">ISU calculator</a> · verified{" "}
            {result.last_verified}
            {result.stale ? " · STALE" : ""}
          </p>
        </div>
      )}
      {result?.gaps && <p className="small warn-text">{result.gaps.join("; ")}</p>}
    </div>
  );
}

export default function ProgramsScreen() {
  const [data, setData] = useState<{ disclaimer: string; pack_health: any; programs: ProgramView[] } | null>(null);
  const [nudges, setNudges] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get("/programs/matches")
      .then(setData)
      .catch((e) => setError(e.message));
    api
      .get("/nudges")
      .then((r) => setNudges(r.nudges))
      .catch(() => {});
  }, []);

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  return (
    <div className="programs">
      {nudges.map((n, i) => (
        <div key={i} className={n.severity === "high" ? "error-banner" : "flash"}>
          <strong>{n.title}</strong>
          <div className="small">{n.detail}</div>
        </div>
      ))}
      <p className="hint">{data.disclaimer}</p>
      <p className="small">
        Rule pack health: {data.pack_health.rules_current}/{data.pack_health.rules_total} rules current
      </p>
      <StackingChecker programs={data.programs} />
      <NRateCard />
      {data.programs.map((p) => (
        <div className={`card ${p.excluded_by_rule ? "muted" : ""}`} key={p.program_key}>
          <div className="card-head">
            <span className={`tag tag-${p.tier}`}>{p.agency}</span>
            {p.stale && <span className="tag tag-stale">unverified since {p.last_verified}</span>}
            {p.excluded_by_rule && <span className="tag tag-stale">likely not a fit</span>}
          </div>
          <h3>{p.name}</h3>
          {p.payment_rate && <p className="payment">{p.payment_rate}</p>}
          {p.signup_deadline && <p className="small">Signup: {p.signup_deadline}</p>}
          <p>{p.summary}</p>
          <p className="small">
            <a href={p.source_url} target="_blank" rel="noreferrer">
              Source
            </a>{" "}
            · verified {p.last_verified}
          </p>
          {p.rules.length > 0 && (
            <button className="linkish" onClick={() => setOpen(open === p.program_key ? null : p.program_key)}>
              {open === p.program_key ? "Hide" : "Show"} eligibility notes ({p.rules.length})
            </button>
          )}
          <ReadinessPanel programKey={p.program_key} />
          {open === p.program_key &&
            p.rules.map((r) => (
              <div key={r.rule_key} className={`rule rule-${r.verdict}`}>
                <span className="rule-verdict">
                  {r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✕" : "?"}
                </span>
                <div>
                  <div>{r.description}</div>
                  <div className="small">
                    {r.citation} ·{" "}
                    <a href={r.source_url} target="_blank" rel="noreferrer">
                      source
                    </a>{" "}
                    · verified {r.last_verified}
                    {r.stale && " · STALE — confirm before acting"}
                  </div>
                </div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
