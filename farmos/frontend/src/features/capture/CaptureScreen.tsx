// The big "+" — hold to talk, release to save. One hand, gloves on, no
// menus. The 45 seconds is the farmer's time talking, not time operating
// the app. Photos and files land through the same screen.

import { useEffect, useRef, useState } from "react";
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

  async function savePhotoOrFile(file: File, source: "camera" | "roll" | "file") {
    const gps = await currentGps();
    await enqueueCapture({
      client_id: newId(),
      kind: file.type.startsWith("image/") ? "photo" : "file",
      mime_type: file.type || "application/octet-stream",
      captured_at: new Date().toISOString(),
      gps_lat: gps.lat,
      gps_lon: gps.lon,
      // In-app camera capture is verifier-grade; camera-roll/file imports
      // carry editable metadata and are graded honestly (spec: Provenance).
      provenance: source === "camera" ? "captured" : "imported",
      blob: file,
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
    </div>
  );
}
