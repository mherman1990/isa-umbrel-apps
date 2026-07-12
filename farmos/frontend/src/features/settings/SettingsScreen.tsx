// Settings: spend meter + cap, API key, backup status + recovery-phrase
// ceremony, device pairing, and the "what leaves this box" disclosure.

import { useEffect, useState } from "react";
import { api, setToken } from "../../app/api";

export default function SettingsScreen() {
  const [profile, setProfile] = useState<any>(null);
  const [spend, setSpend] = useState<any>(null);
  const [backup, setBackup] = useState<any>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [privacy, setPrivacy] = useState<any>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [cap, setCap] = useState("");
  const [repo, setRepo] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function refresh() {
    try {
      const [p, s, b, d, pr] = await Promise.all([
        api.get("/profile"),
        api.get("/spend"),
        api.get("/system/backup"),
        api.get("/auth/devices"),
        api.get("/system/privacy"),
      ]);
      setProfile(p);
      setSpend(s);
      setBackup(b);
      setDevices(d);
      setPrivacy(pr);
      setCap(String(p.monthly_spend_cap_usd ?? 20));
    } catch {
      /* offline */
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function saveKey() {
    await api.put("/profile", { anthropic_api_key: apiKey });
    setApiKey("");
    setFlash("API key saved (stored on this box only)");
    await refresh();
  }

  async function saveCap() {
    await api.put("/profile", { monthly_spend_cap_usd: Number(cap) });
    setFlash("Spend cap updated");
    await refresh();
  }

  async function configureBackup() {
    const res = await api.post("/system/backup/config", { repos: [repo] });
    if (res.recovery_phrase) setPhrase(res.recovery_phrase);
    setFlash("Backup destination saved");
    await refresh();
  }

  async function mintPairCode() {
    const res = await api.post("/auth/pairing-codes", { role: "operator" });
    setPairCode(res.code);
  }

  const pct = spend?.cap_usd ? Math.min(100, (spend.month_to_date_usd / spend.cap_usd) * 100) : 0;

  return (
    <div className="settings">
      {flash && <div className="flash">{flash}</div>}

      <div className="card">
        <h3>AI spend this month</h3>
        {spend ? (
          <>
            <div className="meter">
              <div className="meter-fill" style={{ width: `${pct}%` }} />
            </div>
            <p>
              <strong>${spend.month_to_date_usd.toFixed(2)}</strong> of ${spend.cap_usd?.toFixed(2) ?? "—"} cap
            </p>
            <label>
              Monthly hard cap (USD)
              <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
            </label>
            <button onClick={saveCap}>Update cap</button>
            <p className="hint">
              At the cap, capture keeps working — parsing waits until next month or a higher cap.
            </p>
          </>
        ) : (
          <p className="hint">—</p>
        )}
      </div>

      <div className="card">
        <h3>Your AI key</h3>
        <p className="hint">
          Farm OS uses your own Anthropic API key. It is stored on this box and never leaves it.
          {profile?.anthropic_key_set ? " A key is configured." : " No key yet — parsing is paused."}
        </p>
        <label>
          Anthropic API key
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" />
        </label>
        <button className="primary" disabled={!apiKey} onClick={saveKey}>
          Save key
        </button>
      </div>

      <div className="card">
        <h3>Backups</h3>
        {backup?.configured ? (
          <p>
            Last backup:{" "}
            {backup.age_hours == null ? (
              <strong className="bad">never</strong>
            ) : (
              <strong className={backup.age_hours > 168 ? "bad" : backup.age_hours > 36 ? "warn-text" : ""}>
                {backup.age_hours < 48 ? `${Math.round(backup.age_hours)}h ago` : `${Math.round(backup.age_hours / 24)}d ago`}
              </strong>
            )}
          </p>
        ) : (
          <p className="hint">
            Not configured. Your records live on one small computer — give them a second home. A USB drive
            path (e.g. /backup-usb/farmos) or your own S3 bucket (s3:s3.amazonaws.com/bucket/farmos) both
            work; backups are encrypted before they leave this box.
          </p>
        )}
        <label>
          Destination
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/backup-usb/farmos or s3:…" />
        </label>
        <button className="primary" disabled={!repo} onClick={configureBackup}>
          Save destination
        </button>
        {backup?.configured && <button onClick={() => api.post("/system/backup/run")}>Run backup now</button>}
        {phrase && (
          <div className="phrase-ceremony">
            <h4>Write this recovery phrase down — it is shown once.</h4>
            <code className="phrase">{phrase}</code>
            <p className="hint">
              Backups are useless without it. Keep it on paper, not on this device.
            </p>
            <button className="primary" onClick={() => setPhrase(null)}>
              I wrote it down
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Devices</h3>
        <ul className="list">
          {devices.map((d) => (
            <li key={d.id}>
              <strong>{d.device_name}</strong>
              <span className="small">
                {d.revoked ? "revoked" : d.last_seen_at ? `seen ${new Date(d.last_seen_at).toLocaleString()}` : "never seen"}
              </span>
              {!d.revoked && (
                <button className="danger small-btn" onClick={() => api.del(`/auth/devices/${d.id}`).then(refresh)}>
                  revoke
                </button>
              )}
            </li>
          ))}
        </ul>
        <button onClick={mintPairCode}>Pair a new phone</button>
        {pairCode && (
          <p>
            On the new device, open this app's address and enter code <strong className="paircode">{pairCode}</strong>{" "}
            (valid 10 minutes).
          </p>
        )}
      </div>

      {privacy && (
        <div className="card">
          <h3>What leaves this box</h3>
          {privacy.outbound.map((o: any, i: number) => (
            <div key={i} className="privacy-row">
              <strong>{o.destination}</strong>
              <p className="small">{o.payload}</p>
            </div>
          ))}
          <ul className="small">
            {privacy.never.map((n: string, i: number) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        className="linkish"
        onClick={() => {
          setToken(null);
          location.reload();
        }}
      >
        Sign out on this device
      </button>
    </div>
  );
}
