import { useEffect, useState } from "react";
import type { AppState, DaemonResult, FailoverRule, ProviderProfile, RuleMatch } from "../types";
import { api } from "../api";
import { Badge, Button, Card, Field, Input, SectionTitle } from "./ui";
import { useAction } from "./ui";
import { useI18n } from "../i18n";

/**
 * Whether a profile can serve a rule's model conditions: the forwarding path
 * (`effective_model_for`) accepts a model via an exact `exposedModels` hit or
 * a `modelMap` entry, so a rule provider with neither matching any model the
 * rule matches is silently skipped on every request. Mirrors the Rust-side
 * `node_unserviceable` judgement (monitor.rs). Empty match conditions are not
 * judged (the rule never routes anything).
 */
export function providerServesRule(
  profile: ProviderProfile | undefined,
  match: RuleMatch,
): boolean {
  if (!match.modelPrefix && !match.modelContains) return true;
  if (!profile) return false;
  const models = new Set<string>([
    ...(profile.exposedModels ?? []),
    ...Object.keys(profile.modelMap ?? {}),
  ]);
  for (const m of models) {
    if (match.modelPrefix && !m.startsWith(match.modelPrefix)) continue;
    if (match.modelContains && !m.includes(match.modelContains)) continue;
    return true;
  }
  return false;
}

function MoveIcon({ direction }: { direction: "up" | "down" }) {
  return <svg className="control-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={direction === "up" ? "M8 12V4m-3 3 3-3 3 3" : "M8 4v8m-3-3 3 3 3-3"} /></svg>;
}
function CloseIcon() {
  return <svg className="control-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>;
}

export function ProxyPanel({
  state,
  refresh,
}: {
  state: AppState;
  refresh: () => Promise<void>;
}) {
  const run = useAction();
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonResult | null>(null);
  const [host, setHost] = useState(state.settings.proxy.host);
  const [port, setPort] = useState(String(state.settings.proxy.port));

  const loadStatus = async () => {
    try {
      setStatus(await api.proxyStatus());
    } catch {
      setStatus(null);
    }
  };
  useEffect(() => {
    void loadStatus();
  }, []);

  return (
    <div>
      <SectionTitle hint={t("routes by profile/model in the request body")}>{t("Proxy")}</SectionTitle>

      <Card className="mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge tone={status?.running ? "green" : "zinc"}>
              {status?.running ? t("running") : t("stopped")}
            </Badge>
            {status?.running && (
              <span className="text-sm text-zinc-400">
                PID {status.pid} · http://{status.host}:{status.port}
              </span>
            )}
          </div>
          <Button onClick={() => void loadStatus()}>{t("Refresh")}</Button>
        </div>
        {status?.message && <div className="mt-2 text-xs text-zinc-500">{status.message}</div>}

        <div className="mt-4 grid gap-x-4 sm:grid-cols-2">
          <Field label={t("Proxy host")}>
            <Input value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label={t("Proxy port")}>
            <Input value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={status?.running}
            onClick={() =>
              run(
                () => api.proxyStart(host.trim(), parseInt(port, 10) || undefined),
                t("Proxy started"),
                loadStatus,
              )
            }
          >
            {t("Start")}
          </Button>
          <Button
            variant="danger"
            disabled={!status?.running}
            onClick={() => run(() => api.proxyStop(), t("Proxy stopped"), loadStatus)}
          >
            {t("Stop")}
          </Button>
        </div>
      </Card>

      <RulesEditor state={state} refresh={refresh} />
    </div>
  );
}

function RulesEditor({
  state,
  refresh,
}: {
  state: AppState;
  refresh: () => Promise<void>;
}) {
  const run = useAction();
  const { t } = useI18n();
  const [rules, setRules] = useState<FailoverRule[]>(state.settings.proxy.rules ?? []);
  const [editing, setEditing] = useState<FailoverRule | null>(null);
  const [editingIdx, setEditingIdx] = useState(-1);

  const nonProxy = Object.entries(state.profiles)
    .filter(([, p]) => !p.proxy)
    .map(([n]) => n);

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    setRules(next);
  };

  const openEdit = (rule: FailoverRule | null, idx: number) => {
    setEditingIdx(idx);
    setEditing(
      rule
        ? { name: rule.name ?? "", match: { ...rule.match }, providers: [...rule.providers] }
        : { name: "", match: { modelPrefix: "", modelContains: "" }, providers: [] }
    );
  };

  const commitEdit = () => {
    if (!editing) return;
    const cleaned: FailoverRule = {
      name: editing.name?.trim() || undefined,
      match: {
        modelPrefix: editing.match?.modelPrefix?.trim() || undefined,
        modelContains: editing.match?.modelContains?.trim() || undefined,
      },
      providers: editing.providers,
    };
    const next = editingIdx < 0 ? [...rules, cleaned] : [...rules];
    if (editingIdx >= 0) next[editingIdx] = cleaned;
    setRules(next);
    setEditing(null);
  };

  const toggleProvider = (name: string) => {
    if (!editing) return;
    const providers = editing.providers.includes(name)
      ? editing.providers.filter((p) => p !== name)
      : [...editing.providers, name];
    setEditing({ ...editing, providers });
  };

  const providerMove = (i: number, d: number) => {
    if (!editing) return;
    const j = i + d;
    const providers = [...editing.providers];
    if (j < 0 || j >= providers.length) return;
    [providers[i], providers[j]] = [providers[j], providers[i]];
    setEditing({ ...editing, providers });
  };

  const conditionText = (r: FailoverRule) => {
    const parts = [];
    if (r.match?.modelPrefix) parts.push(`prefix:${r.match.modelPrefix}`);
    if (r.match?.modelContains) parts.push(`contains:${r.match.modelContains}`);
    return parts.length ? parts.join(" & ") : "match:*";
  };

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-200"><span className="section-kicker" />{t("Failover rules")}</div>
      <div className="mb-3 text-xs text-zinc-500">
        {t("Rule-based, provider-level failover: the first matching rule decides the provider chain, tried in order. Proxy profiles are excluded.")}
      </div>

      <div className="space-y-1">
        {rules.length === 0 && (
          <div className="text-sm text-zinc-500">{t("No failover rules configured.")}</div>
        )}
        {rules.map((rule, i) => (
          <div
            key={i}
            className="failover-row flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.018] px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <span className="text-zinc-200">
                <span className="mr-2 text-zinc-500">{i + 1}.</span>
                {rule.name || `(rule ${i + 1})`}
              </span>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
                <span>[{conditionText(rule)}] →</span>
                {rule.providers.length === 0 && <span>(no providers)</span>}
                {rule.providers.map((name, pidx) => {
                  const serves = providerServesRule(state.profiles[name], rule.match);
                  return (
                    <span key={name} className="inline-flex items-center gap-1">
                      {pidx > 0 && <span className="text-zinc-600">→</span>}
                      <span className={serves ? "text-zinc-300" : "text-amber-300"}>{name}</span>
                      {!serves && (
                        <Badge tone="amber" >
                          {t("No exposed model matches this rule")}
                        </Badge>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="flex gap-1">
              <button aria-label="Edit" className="icon-button" onClick={() => openEdit(rule, i)}>✎</button>
              <button aria-label="Move up" className="icon-button" onClick={() => move(i, -1)}><MoveIcon direction="up" /></button>
              <button aria-label="Move down" className="icon-button" onClick={() => move(i, 1)}><MoveIcon direction="down" /></button>
              <button aria-label="Remove" className="icon-button danger" onClick={() => setRules(rules.filter((_, x) => x !== i))}><CloseIcon /></button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <Field label={t("Rule name (optional)")}>
            <Input
              value={editing.name ?? ""}
              placeholder={t("e.g. deepseek-primary")}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>
          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("Model prefix")}>
              <Input
                value={editing.match?.modelPrefix ?? ""}
                placeholder="gpt-"
                onChange={(e) => setEditing({ ...editing, match: { ...editing.match, modelPrefix: e.target.value } })}
              />
            </Field>
            <Field label={t("Model contains")}>
              <Input
                value={editing.match?.modelContains ?? ""}
                placeholder="deepseek"
                onChange={(e) => setEditing({ ...editing, match: { ...editing.match, modelContains: e.target.value } })}
              />
            </Field>
          </div>
          <div className="mb-2 text-xs font-medium text-zinc-300">{t("Provider chain (order = failover order)")}</div>
          <div className="mb-1 space-y-1">
            {editing.providers.length === 0 && (
              <div className="text-xs text-zinc-500">{t("No providers selected.")}</div>
            )}
            {editing.providers.map((name, i) => (
              <div key={name} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-zinc-950/40 px-2 py-1 text-sm">
                <span className="flex items-center gap-2 text-zinc-200">
                  <span>{i + 1}. {name}</span>
                  {!providerServesRule(state.profiles[name], editing.match) && (
                    <Badge tone="amber" >{t("No exposed model matches this rule")}</Badge>
                  )}
                </span>
                <div className="flex gap-1">
                  <button aria-label="Move up" className="icon-button" onClick={() => providerMove(i, -1)}><MoveIcon direction="up" /></button>
                  <button aria-label="Move down" className="icon-button" onClick={() => providerMove(i, 1)}><MoveIcon direction="down" /></button>
                  <button aria-label="Remove" className="icon-button danger" onClick={() => toggleProvider(name)}><CloseIcon /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="mb-3">
            <select
              className="rounded-md border border-white/10 bg-zinc-950/60 px-2 py-1.5 text-sm text-zinc-100"
              value=""
              onChange={(e) => {
                if (e.target.value && editing && !editing.providers.includes(e.target.value)) {
                  setEditing({ ...editing, providers: [...editing.providers, e.target.value] });
                }
              }}
            >
              <option value="">+ add provider…</option>
              {nonProxy
                .filter((n) => !editing.providers.includes(n))
                .map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={commitEdit}>
              {t("Done")}
            </Button>
            <Button onClick={() => setEditing(null)}>{t("Cancel")}</Button>
          </div>
        </div>
      )}

      {!editing && (
        <div className="mt-3 flex items-center gap-2">
          <Button onClick={() => openEdit(null, -1)}>{t("Add rule")}</Button>
          <Button variant="primary" onClick={() => run(() => api.setRules(rules), t("Rules saved"), refresh)}>
            {t("Save rules")}
          </Button>
        </div>
      )}
    </Card>
  );
}
