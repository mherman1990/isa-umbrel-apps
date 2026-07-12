import { useEffect, useState } from "react";
import CaptureScreen from "../features/capture/CaptureScreen";
import DocsScreen from "../features/documents/DocsScreen";
import FieldsScreen from "../features/fields/FieldsScreen";
import InboxScreen from "../features/inbox/InboxScreen";
import Onboarding from "../features/onboarding/Onboarding";
import ProgramsScreen from "../features/programs/ProgramsScreen";
import SettingsScreen from "../features/settings/SettingsScreen";
import { api, getToken } from "./api";
import { drainQueue, pendingCount } from "../offline/queue";

type Tab = "capture" | "inbox" | "fields" | "docs" | "programs" | "settings";

export default function App() {
  const [ready, setReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [tab, setTab] = useState<Tab>("capture");
  const [badges, setBadges] = useState<{ inbox: number; pending: number; backupWarn: boolean }>({
    inbox: 0,
    pending: 0,
    backupWarn: false,
  });

  async function checkStatus() {
    const pending = await pendingCount();
    try {
      const s = await api.get("/sync/status");
      setBadges({
        inbox: s.inbox_count,
        pending: pending + s.pending_captures,
        backupWarn: !s.backup_configured || (s.backup_age_hours ?? Infinity) > 168,
      });
    } catch {
      setBadges((b) => ({ ...b, pending }));
    }
  }

  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setNeedsOnboarding(true);
        setReady(true);
        return;
      }
      try {
        const profile = await api.get("/profile");
        setNeedsOnboarding(!profile.onboarding_completed);
      } catch (e: any) {
        if (e.status === 401) setNeedsOnboarding(true);
      }
      setReady(true);
      void drainQueue();
      void checkStatus();
    })();
    const t = setInterval(checkStatus, 20000);
    return () => clearInterval(t);
  }, []);

  if (!ready) return null;
  if (needsOnboarding)
    return (
      <Onboarding
        onDone={() => {
          setNeedsOnboarding(false);
          void checkStatus();
        }}
      />
    );

  return (
    <div className="app">
      <main className="main">
        {tab === "capture" && <CaptureScreen onSaved={checkStatus} />}
        {tab === "inbox" && <InboxScreen />}
        {tab === "fields" && <FieldsScreen />}
        {tab === "docs" && <DocsScreen />}
        {tab === "programs" && <ProgramsScreen />}
        {tab === "settings" && <SettingsScreen />}
      </main>
      {badges.pending > 0 && <div className="sync-banner">⏳ {badges.pending} item(s) waiting to sync/parse</div>}
      <nav className="tabbar">
        <TabButton label="Log" icon="🎙" active={tab === "capture"} onClick={() => setTab("capture")} />
        <TabButton label="Inbox" icon="📥" badge={badges.inbox} active={tab === "inbox"} onClick={() => setTab("inbox")} />
        <TabButton label="Fields" icon="🗺" active={tab === "fields"} onClick={() => setTab("fields")} />
        <TabButton label="Docs" icon="📄" active={tab === "docs"} onClick={() => setTab("docs")} />
        <TabButton label="Programs" icon="💵" active={tab === "programs"} onClick={() => setTab("programs")} />
        <TabButton label="Settings" icon="⚙️" warn={badges.backupWarn} active={tab === "settings"} onClick={() => setTab("settings")} />
      </nav>
    </div>
  );
}

function TabButton({
  label,
  icon,
  active,
  onClick,
  badge,
  warn,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  warn?: boolean;
}) {
  return (
    <button className={`tab ${active ? "active" : ""}`} onClick={onClick}>
      <span className="tab-icon">
        {icon}
        {badge ? <span className="badge">{badge}</span> : null}
        {warn ? <span className="badge warn-badge">!</span> : null}
      </span>
      <span className="tab-label">{label}</span>
    </button>
  );
}
