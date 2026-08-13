import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AppState } from "./types";
import { Button, ToastProvider, cx } from "./components/ui";
import { LanguageProvider, useI18n } from "./i18n";
import { HomePanel } from "./components/HomePanel";
import { ProfilesPanel } from "./components/ProfilesPanel";
import { ProxyPanel } from "./components/ProxyPanel";
import { PackagesPanel } from "./components/PackagesPanel";
import { StatsPanel } from "./components/StatsPanel";
import { RawLogsPanel } from "./components/RawLogsPanel";
import { BackupsPanel } from "./components/BackupsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { DoctorPanel } from "./components/DoctorPanel";

type NavKey = "home" | "profiles" | "proxy" | "packages" | "stats" | "rawlogs" | "backups" | "settings" | "doctor";

type NavIconName = "home" | "profiles" | "proxy" | "packages" | "stats" | "rawlogs" | "backups" | "settings" | "doctor";
const NAV: { key: NavKey; label: string; icon: NavIconName }[] = [
  { key: "home", label: "Home", icon: "home" },
  { key: "profiles", label: "Profiles", icon: "profiles" },
  { key: "proxy", label: "Proxy", icon: "proxy" },
  { key: "packages", label: "Packages", icon: "packages" },
  { key: "stats", label: "Stats", icon: "stats" },
  { key: "rawlogs", label: "Raw Logs", icon: "rawlogs" },
  { key: "backups", label: "Backups", icon: "backups" },
  { key: "settings", label: "Settings", icon: "settings" },
  { key: "doctor", label: "Doctor", icon: "doctor" },
];

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, string> = {
    home: "M3 10.5 12 3l9 7.5M5.5 9v10h13V9M9 19v-5h6v5",
    profiles: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0",
    proxy: "M4 8h13M14 5l3 3-3 3M20 16H7m3-3-3 3 3 3",
    packages: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9ZM4 7.5l8 4.5 8-4.5M12 12v9",
    stats: "M5 19V9M12 19V5M19 19v-7",
    rawlogs: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6",
    backups: "M4 7h16M6 3h12v18H6zM9 11h6M9 15h6",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M3 12h2M19 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M12 3v2M12 19v2",
    doctor: "M12 3v18M3 12h18M7 7l10 10M17 7 7 17",
  };
  return <svg className="nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export interface PanelProps {
  state: AppState;
  refresh: () => Promise<void>;
}

export default function App() {
  return (
    <ToastProvider>
      <ShellWithLang />
    </ToastProvider>
  );
}

function ShellWithLang() {
  const [configLang, setConfigLang] = useState<string | null>(null);
  return (
    <LanguageProvider configLang={configLang}>
      <Shell onConfigLang={setConfigLang} />
    </LanguageProvider>
  );
}

function Shell({ onConfigLang }: { onConfigLang: (lang: string | null) => void }) {
  const [nav, setNav] = useState<NavKey>("home");
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const refresh = useCallback(async () => {
    try {
      const next = await api.getState();
      setState(next);
      onConfigLang(next.settings?.language ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onConfigLang]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initConfig = useCallback(async () => {
    await api.init();
    await refresh();
  }, [refresh]);

  const activeNav = NAV.find((item) => item.key === nav) ?? NAV[0];

  return (
    <div className="app-shell flex h-full">
      <aside className="app-sidebar flex w-60 shrink-0 flex-col">
        <div className="brand-block px-5 pb-7 pt-6">
          <div className="flex items-center gap-3">
            <div className="brand-mark">π</div>
            <div>
              <div className="text-[15px] font-semibold tracking-tight text-white">pi-switch</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500">{t("control plane")}</div>
            </div>
          </div>
        </div>
        <div className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">{t("Workspace")}</div>
        <nav className="flex-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => setNav(item.key)}
              className={cx("nav-item mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm", nav === item.key && "is-active")}
            >
              <span className="nav-icon"><NavIcon name={item.icon} /></span>
              <span>{t(item.label)}</span>
              {nav === item.key && <span className="nav-active-dot ml-auto" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer mx-3 mb-4 rounded-xl px-3 py-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-300">
            <span className="status-dot" />
            {t("Core connected")}
          </div>
          <div className="text-[10px] leading-4 text-zinc-600">{t("CLI · TUI · WebUI — same core")}</div>
        </div>
      </aside>

      <main className="app-main flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-5 pb-10 pt-5 sm:px-8">
          <header className="topbar mb-8 flex items-center justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">pi-switch / {t("workspace")}</div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{t(activeNav.label)}</h1>
            </div>
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[11px] text-zinc-400 sm:flex">
              <span className="status-dot" /> {t("Local instance")}
            </div>
          </header>
          {error && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              <div className="font-medium">{t("Could not load config")}</div>
              <div className="mt-1 text-red-300/80">{error}</div>
              <Button variant="primary" className="mt-3" onClick={() => void initConfig()}>
                {t("Initialize config")}
              </Button>
            </div>
          )}

          {!state && !error && <div className="text-zinc-500">{t("Loading…")}</div>}

          {state && (
            <>
              {nav === "home" && <HomePanel state={state} refresh={refresh} onNavigate={setNav} />}
              {nav === "profiles" && <ProfilesPanel state={state} refresh={refresh} />}
              {nav === "proxy" && <ProxyPanel state={state} refresh={refresh} />}
              {nav === "packages" && <PackagesPanel refresh={refresh} />}
              {nav === "stats" && <StatsPanel state={state} refresh={refresh} />}
              {nav === "rawlogs" && <RawLogsPanel />}
              {nav === "backups" && <BackupsPanel state={state} refresh={refresh} />}
              {nav === "settings" && <SettingsPanel state={state} refresh={refresh} />}
              {nav === "doctor" && <DoctorPanel state={state} refresh={refresh} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
