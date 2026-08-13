import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RawLogAttempt, RawLogEntry, RawLogsPage } from "../types";
import { api } from "../api";
import { Button, Card, Select, SectionTitle, useAction } from "./ui";
import { formatRequestTime } from "../lib/format";
import { useI18n } from "../i18n";

// Auto-refresh tiers in milliseconds; `null` means polling is off.
const REFRESH_TIERS: { label: string; ms: number | null }[] = [
  { label: "Off", ms: null },
  { label: "5s", ms: 5000 },
  { label: "30s", ms: 30_000 },
  { label: "5min", ms: 300_000 },
];

// Only the newest 10 entries are kept (see `MAX_RAW_ENTRIES` in rawlog.rs),
// so listing the latest page shows everything that is stored.
const PAGE_SIZE = 10;

function formatBytes(n: number | undefined): string {
  if (n == null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id;
}

function HeadersBlock({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) {
    return <div className="text-xs text-zinc-600">—</div>;
  }
  return (
    <div className="max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-2">
      {entries.map(([name, value]) => (
        <div key={name} className="font-mono text-[11px] leading-5 text-zinc-300">
          <span className="text-zinc-500">{name}:</span> {value}
        </div>
      ))}
    </div>
  );
}

function BodyBlock({
  body,
  truncated,
  bodyBytes,
  label,
}: {
  body?: string;
  truncated?: boolean;
  bodyBytes?: number;
  label: string;
}) {
  if (body == null) {
    // The list endpoint strips bodies; only the detail fetch has them.
    return (
      <div className="text-xs text-zinc-500">
        {bodyBytes ? "…" : label}
      </div>
    );
  }
  return (
    <div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px] leading-5 text-zinc-200">
        {body}
      </pre>
      {truncated && (
        <div className="mt-1 text-[11px] text-amber-400/90">
          ⚠ {label}
        </div>
      )}
    </div>
  );
}

function AttemptBlock({
  entry,
  attempt,
  idx,
  total,
  t,
}: {
  entry: RawLogEntry;
  attempt: RawLogAttempt;
  idx: number;
  total: number;
  t: (k: string) => string;
}) {
  const statusColor =
    attempt.status != null && attempt.status >= 200 && attempt.status < 300
      ? "text-emerald-400"
      : attempt.status != null
        ? "text-amber-400"
        : "text-red-400";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md bg-indigo-500/20 px-2 py-0.5 font-medium text-indigo-300">
          {t("Attempt")} {idx + 1}/{total}
        </span>
        <span className="font-mono text-zinc-300">{attempt.provider}</span>
        <span className={`font-mono font-semibold ${statusColor}`}>
          {attempt.status ?? "—"}
        </span>
        {attempt.error && (
          <span className="font-mono text-red-400" title={attempt.error}>
            {attempt.error.length > 80 ? `${attempt.error.slice(0, 80)}…` : attempt.error}
          </span>
        )}
        <span className="ml-auto text-[10px] text-zinc-500">
          {formatBytes(attempt.bodyBytes ?? 0)}
        </span>
      </div>
      <div className="mb-1.5 truncate font-mono text-[11px] text-zinc-500" title={attempt.url}>
        {attempt.url}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            {t("Upstream headers")}
          </div>
          <HeadersBlock headers={attempt.headers} />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            {t("Upstream body")}
          </div>
          <BodyBlock
            body={attempt.body}
            truncated={attempt.bodyTruncated}
            bodyBytes={attempt.bodyBytes}
            label={t("No body captured")}
          />
        </div>
      </div>
    </div>
  );
}

export function RawLogsPanel() {
  const { t } = useI18n();
  const run = useAction();
  const [page, setPage] = useState<RawLogsPage | null>(null);
  const [refreshMs, setRefreshMs] = useState<number | null>(5000);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, RawLogEntry>>({});
  const seq = useRef(0);

  const load = useCallback(async (keepOnError = false) => {
    const id = ++seq.current;
    try {
      const next = await api.rawLogs(PAGE_SIZE, 0);
      if (id === seq.current) setPage(next);
    } catch {
      if (id === seq.current && !keepOnError) setPage(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll on the selected interval; switching tiers resets the timer and
  // switching back to Off stops it.
  useEffect(() => {
    if (refreshMs == null) return;
    const id = setInterval(() => void load(true), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, load]);

  // Group entries by requestId (one client request → one or more attempts),
  // newest request first.
  const groups = useMemo(() => {
    const map = new Map<string, RawLogEntry[]>();
    for (const entry of page?.entries ?? []) {
      const list = map.get(entry.requestId) ?? [];
      list.push(entry);
      map.set(entry.requestId, list);
    }
    return Array.from(map.entries());
  }, [page]);

  const toggleGroup = useCallback(
    async (requestId: string) => {
      if (expanded.has(requestId)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(requestId);
          return next;
        });
        return;
      }
      setExpanded((prev) => new Set(prev).add(requestId));
      // Fetch full bodies for every attempt in this group on first expand.
      const group = groups.find(([rid]) => rid === requestId)?.[1] ?? [];
      const missing = group.filter((entry) => !details[entry.id]);
      const fetched = await Promise.all(
        missing.map((entry) => api.rawLog(entry.id).catch(() => null)),
      );
      setDetails((prev) => {
        const next = { ...prev };
        missing.forEach((entry, i) => {
          if (fetched[i]) next[entry.id] = fetched[i] as RawLogEntry;
        });
        return next;
      });
    },
    [expanded, groups, details],
  );

  const clearAll = () => {
    if (!confirm(t("Clear raw logs? This permanently deletes all captured requests and responses."))) return;
    run(async () => {
      await api.clearRawLogs();
      setDetails({});
      setExpanded(new Set());
      await load();
    }, t("Cleared"));
  };

  return (
    <div>
      <SectionTitle hint={t("raw-requests.log — Web UI only")}>
        {t("Raw request & response log")}
      </SectionTitle>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          value={String(refreshMs ?? "")}
          onChange={(e) => setRefreshMs(e.target.value ? Number(e.target.value) : null)}
          className="w-32"
        >
          {REFRESH_TIERS.map(({ label, ms }) => (
            <option key={label} value={ms ?? ""}>
              {t("Auto-refresh")}: {t(label)}
            </option>
          ))}
        </Select>
        <span className="text-xs text-zinc-500">
          {t("Total")}: {page?.total ?? 0} · {t("showing latest")} {Math.min(PAGE_SIZE, page?.total ?? 0)}
        </span>
        <Button variant="danger" className="ml-auto" onClick={clearAll} disabled={(page?.total ?? 0) === 0}>
          {t("Clear all")}
        </Button>
      </div>

      {page && page.total === 0 && (
        <Card>
          <div className="py-10 text-center text-sm text-zinc-500">
            {t("No raw logs yet. Make requests through the proxy to capture raw bodies.")}
          </div>
        </Card>
      )}

      {groups.length === 0 && page && page.total > 0 && (
        <Card>
          <div className="py-10 text-center text-sm text-zinc-500">{t("Loading…")}</div>
        </Card>
      )}

      <div className="space-y-3">
        {groups.map(([requestId, entries]) => {
          const isOpen = expanded.has(requestId);
          const first = entries[0];
          const anyFailed = entries.some((e) => !e.ok || (e.attempt && !e.attempt.ok));
          return (
            <Card key={requestId} className="!p-3">
              <button
                className="flex w-full items-center gap-3 text-left"
                onClick={() => void toggleGroup(requestId)}
              >
                <span
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs ${
                    anyFailed
                      ? "bg-red-500/15 text-red-400"
                      : "bg-emerald-500/15 text-emerald-400"
                  }`}
                >
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className="shrink-0 font-mono text-xs text-zinc-400">
                  {formatRequestTime(first.ts)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-200">
                  {first.client.path}
                </span>
                <span className="hidden shrink-0 font-mono text-[10px] text-zinc-600 sm:inline" title={requestId}>
                  {shortId(requestId)}
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {entries.map((entry) => (
                    <span
                      key={entry.id}
                      className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] ${
                        entry.attempt && entry.attempt.ok
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-red-500/15 text-red-400"
                      }`}
                      title={
                        entry.attempt
                          ? `${entry.attempt.provider} ${entry.attempt.status ?? "—"}${entry.attempt.error ? ` · ${entry.attempt.error}` : ""}`
                          : (entry.error ?? "")
                      }
                    >
                      {entry.attempt ? `${entry.attempt.provider} ${entry.attempt.status ?? "—"}` : t("failed")}
                    </span>
                  ))}
                </span>
              </button>

              {isOpen && (
                <div className="mt-3 space-y-3 border-t border-white/[0.07] pt-3">
                  {(() => {
                    const detail = details[first.id] ?? first;
                    return (
                      <div className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded-md bg-zinc-500/20 px-2 py-0.5 font-medium text-zinc-300">
                            {t("Request")}
                          </span>
                          <span className="font-mono text-zinc-300">
                            {detail.client.method} {detail.client.path}
                          </span>
                          {first.error && (
                            <span className="font-mono text-red-400" title={first.error}>
                              {first.error}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-zinc-500">
                            {formatBytes(detail.client.bodyBytes ?? 0)}
                          </span>
                        </div>
                        <div className="grid gap-3 lg:grid-cols-2">
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                              {t("Request headers")}
                            </div>
                            <HeadersBlock headers={detail.client.headers} />
                          </div>
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                              {t("Request body")}
                            </div>
                            <BodyBlock
                              body={detail.client.body}
                              truncated={detail.client.bodyTruncated}
                              bodyBytes={detail.client.bodyBytes}
                              label={t("No body captured")}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {entries.map((entry, idx) => {
                    const detail = details[entry.id] ?? entry;
                    if (!detail.attempt) return <Fragment key={entry.id} />;
                    return (
                      <AttemptBlock
                        key={entry.id}
                        entry={detail}
                        attempt={detail.attempt}
                        idx={idx}
                        total={entries.length}
                        t={t}
                      />
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
