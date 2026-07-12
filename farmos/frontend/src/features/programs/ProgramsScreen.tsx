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
