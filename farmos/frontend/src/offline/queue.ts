// Offline capture queue (Dexie/IndexedDB).
//
// The rule that matters: a capture is written HERE first, always — even
// with full bars — then drained to the server. Never lose a record because
// the field had no signal. Items leave the queue only on a server
// "created" or "duplicate" response.

import Dexie, { type Table } from "dexie";
import { api, getToken } from "../app/api";

export interface QueuedCapture {
  client_id: string;
  kind: "voice" | "photo" | "file";
  mime_type: string;
  captured_at: string; // device clock at record time
  gps_lat?: number;
  gps_lon?: number;
  provenance: "captured" | "imported";
  blob: Blob;
  attempts: number;
}

class FarmDB extends Dexie {
  captures!: Table<QueuedCapture, string>;
  constructor() {
    super("farmos");
    this.version(1).stores({ captures: "client_id" });
  }
}

export const db = new FarmDB();

export async function enqueueCapture(item: Omit<QueuedCapture, "attempts">) {
  await db.captures.add({ ...item, attempts: 0 });
  // Ask the browser to keep our storage; best-effort (iOS Safari may still
  // evict — the visible pending badge is the honest mitigation).
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  void drainQueue();
}

export async function pendingCount(): Promise<number> {
  return db.captures.count();
}

let draining = false;

export async function drainQueue(): Promise<void> {
  if (draining || !navigator.onLine || !getToken()) return;
  draining = true;
  try {
    const items = await db.captures.toArray();
    for (const item of items) {
      try {
        const form = new FormData();
        form.set("file", item.blob, `capture.${item.mime_type.split("/")[1] ?? "bin"}`);
        form.set("client_id", item.client_id);
        form.set("kind", item.kind);
        form.set("captured_at", item.captured_at);
        form.set("provenance", item.provenance);
        if (item.gps_lat !== undefined) form.set("gps_lat", String(item.gps_lat));
        if (item.gps_lon !== undefined) form.set("gps_lon", String(item.gps_lon));
        await api.postForm("/captures", form); // 201 created or 200 duplicate — both fine
        await db.captures.delete(item.client_id);
      } catch (err: any) {
        if (err?.status && err.status >= 400 && err.status < 500 && err.status !== 401) {
          // Rejected outright (bad payload) — keep it but stop retry-looping this pass.
          await db.captures.update(item.client_id, { attempts: item.attempts + 1 });
        }
        // network/5xx/401: leave in queue, next drain retries
        break;
      }
    }
  } finally {
    draining = false;
  }
}

// Drain on reconnect and when the app comes back to the foreground.
window.addEventListener("online", () => void drainQueue());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void drainQueue();
});
setInterval(() => void drainQueue(), 60_000);
