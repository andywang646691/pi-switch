import { useEffect, useState } from "react";
import type { AppState, DaemonResult } from "../types";
import { api } from "../api";
import { Badge, Button, Card } from "./ui";
import { useI18n } from "../i18n";

export function HomePanel({
  state,
  onNavigate,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  onNavigate: (k: any) => void;
}) {
  const { t } = useI18n();
  const [proxy, setProxy] = useState<DaemonResult | null>(null);
  const profiles = Object.entries(state.profiles);
  const exposedCount = profiles.filter(([, p]) => (p.exposedModels?.length ?? 0) > 0).length;

  useEffect(() => {
    api.proxyStatus().then(setProxy).catch(() => setProxy(null));
  }, []);

  const workflow = [
    "Add profiles & set API keys",
    "Expose models to pi (per profile)",
    "Optionally set failover rules",
    "Start the proxy — pi routes by profile/model",
  ];

  return (
    <div className="space-y-5">
      <section className="hero-panel relative overflow-hidden rounded-3xl border border-indigo-400/15 p-6 sm:p-8">
        <div className="hero-glow" />
        <div className="relative max-w-2xl">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-300/20 bg-indigo-300/10 px-3 py-1 text-[11px] font-medium text-indigo-200">
            <span className="status-dot" /> Gateway online
          </div>
          <h2 className="text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">{t("Overview")}</h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400">
            {t("CLI / TUI / WebUI share one Rust core")}. Configure providers, expose models, and keep your gateway resilient.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => onNavigate("profiles")}>{t("Manage profiles")}</Button>
            <Button variant="ghost" onClick={() => onNavigate("proxy")}>{t("Proxy control")}</Button>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("Profiles")} value={String(profiles.length)} />
        <Stat label={t("Exposed")} value={String(exposedCount)} />
        <Stat label={t("Current")} value={state.current || "—"} />
        <Stat label={t("Proxy")} value={proxy?.running ? t("running") : t("stopped")} tone={proxy?.running ? "green" : "zinc"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <Card>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-zinc-100">{t("Gateway workflow")}</div>
              <div className="mt-1 text-xs text-zinc-500">A clean path from provider to production traffic</div>
            </div>
            <span className="text-xl text-indigo-300">↗</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {workflow.map((item, i) => (
              <div key={item} className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-black/10 p-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-indigo-400/10 text-xs font-semibold text-indigo-300">0{i + 1}</span>
                <span className="text-sm leading-5 text-zinc-400">
                  {t(item)}
                  {i === 3 && <code className="mt-1 block text-[11px] text-indigo-300/80">profile/model</code>}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <div className="mb-5 text-sm font-semibold text-zinc-100">{t("Current selection")}</div>
          {state.current ? (
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-zinc-600">{t("Active profile:")}</div>
              <div className="mt-2 flex items-center gap-2"><span className="text-2xl font-semibold text-white">{state.current}</span><Badge tone="indigo">active</Badge></div>
              <div className="mt-6 border-t border-white/[0.07] pt-4 text-xs text-zinc-500">{t("Provider id:")} <span className="text-zinc-300">{state.settings.providerPrefix}</span></div>
            </div>
          ) : <div className="text-sm text-zinc-500">{t("No profile selected yet.")}</div>}
          {proxy && <div className="mt-4 text-xs leading-5 text-zinc-600">{proxy.message}</div>}
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "zinc",
}: {
  label: string;
  value: string;
  tone?: "zinc" | "green";
}) {
  return (
    <Card className="py-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">{label}</div>
      <div className={(tone === "green" ? "text-emerald-300" : "text-zinc-100") + " mt-2 truncate text-2xl font-semibold tracking-tight"}>{value}</div>
    </Card>
  );
}
