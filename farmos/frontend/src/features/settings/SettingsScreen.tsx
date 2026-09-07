// Settings: farm profile editor, appearance (theme), spend meter + cap, API
// key, backup status + recovery-phrase ceremony, device pairing, the "what
// leaves this box" disclosure, and the guarded factory reset.

import { useEffect, useState } from "react";
import { api, setToken } from "../../app/api";
import { getTheme, setTheme, type Theme } from "../../app/theme";

const CROPS = ["corn", "soybeans", "wheat", "oats", "hay"];

// The editable slice of the farm profile — the same answers the onboarding
// wizard collects, so a farmer can correct anything after setup.
type ProfileForm = {
  operation_name: string;
  county_ansi_code: string;
  crops: Record<string, { acres: number }>;
  beginning_farmer: boolean;
  tillage_system: string;
  cover_crops: boolean | null;
  enrolled: string;
};

function toForm(p: any): ProfileForm {
  const ph = p.practice_history ?? {};
  return {
    operation_name: p.operation_name ?? "",
    county_ansi_code: p.county_ansi_code ?? "",
    crops: p.crops ?? {},
    beginning_farmer: !!p.beginning_farmer,
    tillage_system: p.tillage_system ?? "",
    cover_crops: typeof ph.cover_crops === "boolean" ? ph.cover_crops : null,
    enrolled: Array.isArray(ph.enrolled_cover_crop_programs) ? ph.enrolled_cover_crop_programs.join(", ") : "",
  };
}

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

  const [form, setForm] = useState<ProfileForm | null>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetArmed, setResetArmed] = useState(false);

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
      setForm(toForm(p));
    } catch {
      /* offline */
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  function pickTheme(t: Theme) {
    setThemeState(t);
    setTheme(t); // persists + applies to <html> immediately
  }

  async function saveProfile() {
    if (!form) return;
    await api.put("/profile", {
      operation_name: form.operation_name,
      county_ansi_code: form.county_ansi_code || null,
      crops: form.crops,
      beginning_farmer: form.beginning_farmer,
      tillage_system: form.tillage_system || null,
      practice_history: {
        ...(profile?.practice_history ?? {}),
        cover_crops: form.cover_crops ?? undefined,
        enrolled_cover_crop_programs: form.enrolled
          ? form.enrolled.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
      },
    });
    setFlash("Farm profile updated");
    await refresh();
  }

  async function doFactoryReset() {
    try {
      await api.post("/system/factory-reset", { confirm: resetConfirm.trim() });
      setToken(null);
      location.reload(); // back to first-run onboarding
    } catch (e: any) {
      setFlash(e.message || "Reset failed");
    }
  }

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

      {form && (
        <div className="card">
          <h3>Farm profile</h3>
          <p className="hint">Your setup answers. Change them any time — every screen reads from here.</p>
          <label>
            Farm name
            <input
              value={form.operation_name}
              onChange={(e) => setForm({ ...form, operation_name: e.target.value })}
              placeholder="Lazy H Farms"
            />
          </label>
          <label>
            Iowa county ANSI code (3 digits, optional)
            <input
              inputMode="numeric"
              maxLength={3}
              value={form.county_ansi_code}
              onChange={(e) => setForm({ ...form, county_ansi_code: e.target.value })}
              placeholder="153"
            />
          </label>
          <fieldset>
            <legend>Crops &amp; acres</legend>
            {CROPS.map((c) => (
              <label key={c} className="inline">
                {c}
                <input
                  inputMode="numeric"
                  placeholder="acres"
                  value={form.crops[c]?.acres ?? ""}
                  onChange={(e) => {
                    const next = { ...form.crops };
                    const v = Number(e.target.value);
                    if (e.target.value && v > 0) next[c] = { ...next[c], acres: v };
                    else delete next[c];
                    setForm({ ...form, crops: next });
                  }}
                />
              </label>
            ))}
          </fieldset>
          <label className="inline">
            <input
              type="checkbox"
              checked={form.beginning_farmer}
              onChange={(e) => setForm({ ...form, beginning_farmer: e.target.checked })}
            />
            Beginning farmer (first 10 years)
          </label>
          <label>
            Tillage system
            <select value={form.tillage_system} onChange={(e) => setForm({ ...form, tillage_system: e.target.value })}>
              <option value="">— pick —</option>
              <option value="conventional">Conventional</option>
              <option value="reduced">Reduced till</option>
              <option value="strip">Strip till</option>
              <option value="no-till">No-till</option>
            </select>
          </label>
          <label>
            Do you seed cover crops?
            <select
              value={form.cover_crops === null ? "" : form.cover_crops ? "yes" : "no"}
              onChange={(e) =>
                setForm({ ...form, cover_crops: e.target.value === "" ? null : e.target.value === "yes" })
              }
            >
              <option value="">— pick —</option>
              <option value="yes">Yes / planning to</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            Cover-crop programs you're enrolled in (comma separated)
            <input
              value={form.enrolled}
              onChange={(e) => setForm({ ...form, enrolled: e.target.value })}
              placeholder=""
            />
          </label>
          <button className="primary" disabled={!form.operation_name} onClick={saveProfile}>
            Save profile
          </button>
        </div>
      )}

      <div className="card">
        <h3>Appearance</h3>
        <p className="hint">How this app looks on this device. Saved here, not in your farm records.</p>
        <div className="segmented">
          <button className={theme === "system" ? "active" : ""} onClick={() => pickTheme("system")}>
            System
          </button>
          <button className={theme === "light" ? "active" : ""} onClick={() => pickTheme("light")}>
            Light
          </button>
          <button className={theme === "dark" ? "active" : ""} onClick={() => pickTheme("dark")}>
            Dark
          </button>
        </div>
      </div>

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

      <div className="card danger-zone">
        <h3>Factory reset</h3>
        <p className="hint">
          Erases <strong>everything</strong> on this box — every field, record, capture, money entry, paired
          device, and your API key — and returns Farm OS to first-run setup. This cannot be undone; the only way
          back is restoring from a backup. Your off-box backups are not touched.
        </p>
        {!resetArmed ? (
          <button className="danger" onClick={() => setResetArmed(true)}>
            Reset this box…
          </button>
        ) : (
          <>
            <label>
              Type <strong>RESET</strong> to confirm
              <input value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)} placeholder="RESET" />
            </label>
            <div className="button-row">
              <button className="danger" disabled={resetConfirm.trim() !== "RESET"} onClick={doFactoryReset}>
                Erase everything
              </button>
              <button
                onClick={() => {
                  setResetArmed(false);
                  setResetConfirm("");
                }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>

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
