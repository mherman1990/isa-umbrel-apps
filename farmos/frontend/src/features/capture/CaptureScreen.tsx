// The big "+" — hold to talk, release to save. One hand, gloves on, no
// menus. The 45 seconds is the farmer's time talking, not time operating
// the app. Photos and files land through the same screen.

import { useEffect, useRef, useState } from "react";
import { api } from "../../app/api";
import { enqueueCapture, pendingCount } from "../../offline/queue";

const MAX_SECONDS = 45;

function newId(): string {
  return crypto.randomUUID();
}

async function currentGps(): Promise<{ lat?: number; lon?: number }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve({}),
      { timeout: 3000, maximumAge: 60000 },
    );
  });
}

export default function CaptureScreen({ onSaved }: { onSaved: () => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [pending, setPending] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number>();

  useEffect(() => {
    const t = setInterval(() => pendingCount().then(setPending), 2000);
    return () => clearInterval(t);
  }, []);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = [];
      rec.ondataavailable = (e) => chunks.current.push(e.data);
      rec.onstop = () => void saveVoice(mime, stream);
      rec.start();
      recorder.current = rec;
      setRecording(true);
      setSeconds(0);
      timer.current = window.setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) stopRecording();
          return s + 1;
        });
      }, 1000);
    } catch {
      setFlash("Microphone unavailable — check permissions");
    }
  }

  function stopRecording() {
    clearInterval(timer.current);
    recorder.current?.stop();
    setRecording(false);
  }

  async function saveVoice(mime: string, stream: MediaStream) {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks.current, { type: mime });
    if (blob.size === 0) return;
    const gps = await currentGps();
    await enqueueCapture({
      client_id: newId(),
      kind: "voice",
      mime_type: mime,
      captured_at: new Date().toISOString(),
      gps_lat: gps.lat,
      gps_lon: gps.lon,
      provenance: "captured",
      blob,
    });
    setFlash("Saved — will sync and parse");
    setTimeout(() => setFlash(null), 2500);
    onSaved();
  }

  async function toJpegIfNeeded(file: File): Promise<{ blob: Blob; mime: string }> {
    // Server-side routing supports jpeg/png/webp/gif/pdf; iOS camera-roll
    // picks can be HEIC — re-encode via canvas so nothing dead-ends.
    const ok = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
    if (ok.includes(file.type) || !file.type.startsWith("image/")) return { blob: file, mime: file.type };
    try {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d")!.drawImage(bmp, 0, 0);
      const blob: Blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.85),
      );
      return { blob, mime: "image/jpeg" };
    } catch {
      return { blob: file, mime: file.type }; // server will fail it honestly
    }
  }

  async function savePhotoOrFile(file: File, source: "camera" | "roll" | "file") {
    const gps = await currentGps();
    const { blob, mime } = await toJpegIfNeeded(file);
    await enqueueCapture({
      client_id: newId(),
      kind: mime.startsWith("image/") ? "photo" : "file",
      mime_type: mime || "application/octet-stream",
      captured_at: new Date().toISOString(),
      gps_lat: gps.lat,
      gps_lon: gps.lon,
      // In-app camera capture is verifier-grade; camera-roll/file imports
      // carry editable metadata and are graded honestly (spec: Provenance).
      provenance: source === "camera" ? "captured" : "imported",
      blob,
    });
    setFlash("Saved — will sync and parse");
    setTimeout(() => setFlash(null), 2500);
    onSaved();
  }

  return (
    <div className="capture-screen">
      {pending > 0 && <div className="pending-badge">{pending} waiting to sync</div>}
      <button
        className={`mic-button ${recording ? "recording" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          if (!recording) void startRecording();
        }}
        onPointerUp={() => recording && stopRecording()}
        onPointerLeave={() => recording && stopRecording()}
        aria-label="Hold to record a voice log"
      >
        {recording ? `${MAX_SECONDS - seconds}s` : "HOLD\nTO TALK"}
      </button>
      <p className="hint">
        {recording
          ? "Talking… release to save"
          : "Hold, say everything — field work, breakdowns, inventory — release."}
      </p>
      <div className="capture-row">
        <label className="capture-alt">
          📷 Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => e.target.files?.[0] && savePhotoOrFile(e.target.files[0], "camera")}
          />
        </label>
        <label className="capture-alt">
          🖼 Roll
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => e.target.files?.[0] && savePhotoOrFile(e.target.files[0], "roll")}
          />
        </label>
        <label className="capture-alt">
          📄 File
          <input
            type="file"
            hidden
            onChange={(e) => e.target.files?.[0] && savePhotoOrFile(e.target.files[0], "file")}
          />
        </label>
      </div>
      {flash && <div className="flash">{flash}</div>}
      <MorningBrief />
      <AskBox />
    </div>
  );
}

function AskBox() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<{ role: string; content: string }[]>([]);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setQuestion("");
    const history = thread;
    setThread([...history, { role: "user", content: q }]);
    try {
      const res = await api.post("/assistant/chat", { question: q, history });
      setThread((t) => [...t, { role: "assistant", content: res.answer }]);
    } catch (e: any) {
      setThread((t) => [...t, { role: "assistant", content: `⚠️ ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card ask-card">
      <button className="linkish" onClick={() => setOpen(!open)}>
        💬 {open ? "Hide" : "Ask about your farm"}
      </button>
      {open && (
        <div>
          <p className="hint">
            Answers come from your own records, with sources — and an honest "not recorded" when it isn't.
          </p>
          {thread.map((m, i) => (
            <div key={i} className={m.role === "user" ? "chat-user" : "chat-assistant"}>
              {m.content}
            </div>
          ))}
          <label>
            <input
              value={question}
              placeholder="What did we spray on the home eighty?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && ask()}
            />
          </label>
          <button className="primary" disabled={busy || !question.trim()} onClick={ask}>
            {busy ? "Thinking…" : "Ask"}
          </button>
        </div>
      )}
    </div>
  );
}

function MorningBrief() {
  const [brief, setBrief] = useState<any>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    api.get("/brief/latest").then(setBrief).catch(() => {});
  }, []);

  if (!brief?.available) return null;
  return (
    <div className="card brief-card">
      <button className="linkish" onClick={() => setShow(!show)}>
        ☀️ {show ? "Hide" : "Show"} morning brief ({brief.brief_date})
      </button>
      {show && (
        <div className="brief-body">
          {brief.body_md.split("\n").map((line: string, i: number) =>
            line.startsWith("#") ? (
              <strong key={i} style={{ display: "block", marginTop: 8 }}>
                {line.replace(/^#+\s*/, "")}
              </strong>
            ) : (
              <div key={i}>{line}</div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
