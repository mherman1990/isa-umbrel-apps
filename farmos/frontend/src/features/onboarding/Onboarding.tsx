// First-run: bootstrap or pair, then the farm-profile wizard every other
// module reads from. Target: fresh install → onboarded in under 30 min
// (most of that is the farmers.gov export, which Fields handles any time).

import { useState } from "react";
import { api, setToken } from "../../app/api";

const CROPS = ["corn", "soybeans", "wheat", "oats", "hay"];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"new" | "pair" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [pairCodeInput, setPairCodeInput] = useState("");
  const [operation, setOperation] = useState("");
  const [county, setCounty] = useState("");
  const [crops, setCrops] = useState<Record<string, { acres: number }>>({});
  const [beginning, setBeginning] = useState(false);
  const [tillage, setTillage] = useState("");
  const [coverCrops, setCoverCrops] = useState<boolean | null>(null);
  const [enrolled, setEnrolled] = useState("");
  const [apiKey, setApiKey] = useState("");

  async function doBootstrap() {
    setError(null);
    try {
      const res = await api.post("/auth/bootstrap", { display_name: name, device_name: `${name}'s device` });
      setToken(res.token);
      setStep(2);
    } catch (e: any) {
      setError(e.status === 409 ? "This Farm OS is already set up — choose 'Pair this phone' instead." : e.message);
    }
  }

  async function doPair() {
    setError(null);
    try {
      const res = await api.post("/auth/pair", { code: pairCodeInput, device_name: name || "New device" });
      setToken(res.token);
      onDone(); // paired devices skip the farm wizard — the farm exists
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function saveProfile() {
    setError(null);
    try {
      await api.put("/profile", {
        operation_name: operation,
        state_code: "IA",
        county_ansi_code: county || null,
        crops,
        beginning_farmer: beginning,
        tillage_system: tillage || null,
        practice_history: {
          cover_crops: coverCrops ?? undefined,
          enrolled_cover_crop_programs: enrolled
            ? enrolled.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
        },
        ...(apiKey ? { anthropic_api_key: apiKey } : {}),
      });
      await api.post("/profile/complete");
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="onboarding">
      <h1>🌱 Farm OS</h1>
      {error && <div className="error-banner">{error}</div>}

      {step === 0 && (
        <div className="card">
          <h3>Welcome</h3>
          <p>Your farm records, on your own box. Nothing here phones home.</p>
          <div className="button-col">
            <button
              className="primary"
              onClick={() => {
                setMode("new");
                setStep(1);
              }}
            >
              Set up a new farm
            </button>
            <button
              onClick={() => {
                setMode("pair");
                setStep(1);
              }}
            >
              Pair this phone to an existing farm
            </button>
          </div>
        </div>
      )}

      {step === 1 && mode === "new" && (
        <div className="card">
          <h3>Who's the owner?</h3>
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Matt" />
          </label>
          <button className="primary" disabled={!name} onClick={doBootstrap}>
            Continue
          </button>
        </div>
      )}

      {step === 1 && mode === "pair" && (
        <div className="card">
          <h3>Pair this device</h3>
          <p className="hint">On an already-paired device: Settings → Pair a new phone.</p>
          <label>
            6-digit code
            <input inputMode="numeric" maxLength={6} value={pairCodeInput} onChange={(e) => setPairCodeInput(e.target.value)} />
          </label>
          <label>
            This device's name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dad's phone" />
          </label>
          <button className="primary" disabled={pairCodeInput.length !== 6} onClick={doPair}>
            Pair
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h3>The operation</h3>
          <label>
            Farm name
            <input value={operation} onChange={(e) => setOperation(e.target.value)} placeholder="Lazy H Farms" />
          </label>
          <label>
            Iowa county ANSI code (3 digits, optional)
            <input inputMode="numeric" maxLength={3} value={county} onChange={(e) => setCounty(e.target.value)} placeholder="153" />
          </label>
          <fieldset>
            <legend>Crops & acres</legend>
            {CROPS.map((c) => (
              <label key={c} className="inline">
                {c}
                <input
                  inputMode="numeric"
                  placeholder="acres"
                  value={crops[c]?.acres ?? ""}
                  onChange={(e) => {
                    const next = { ...crops };
                    const v = Number(e.target.value);
                    if (e.target.value && v > 0) next[c] = { acres: v };
                    else delete next[c];
                    setCrops(next);
                  }}
                />
              </label>
            ))}
          </fieldset>
          <button className="primary" disabled={!operation} onClick={() => setStep(3)}>
            Continue
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>Practice history</h3>
          <p className="hint">Five quick questions — this powers the program finder.</p>
          <label className="inline">
            <input type="checkbox" checked={beginning} onChange={(e) => setBeginning(e.target.checked)} />
            Beginning farmer (first 10 years)
          </label>
          <label>
            Tillage system
            <select value={tillage} onChange={(e) => setTillage(e.target.value)}>
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
              value={coverCrops === null ? "" : coverCrops ? "yes" : "no"}
              onChange={(e) => setCoverCrops(e.target.value === "" ? null : e.target.value === "yes")}
            >
              <option value="">— pick —</option>
              <option value="yes">Yes / planning to</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            Cover-crop programs you're already enrolled in (comma separated, blank if none)
            <input value={enrolled} onChange={(e) => setEnrolled(e.target.value)} placeholder="" />
          </label>
          <button className="primary" onClick={() => setStep(4)}>
            Continue
          </button>
        </div>
      )}

      {step === 4 && (
        <div className="card">
          <h3>AI key (optional now)</h3>
          <p className="hint">
            Voice notes are transcribed on this box for free. Turning them into records uses your own
            Anthropic API key — typically a few dollars a month, with a hard cap you control. You can add
            it later in Settings.
          </p>
          <label>
            Anthropic API key
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-… (optional)" />
          </label>
          <button className="primary" onClick={saveProfile}>
            Finish setup
          </button>
        </div>
      )}
    </div>
  );
}
