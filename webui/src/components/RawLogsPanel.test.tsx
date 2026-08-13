import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RawLogsPanel } from "./RawLogsPanel";
import { LanguageProvider } from "../i18n";
import { ToastProvider } from "./ui";
import { api } from "../api";
import type { RawLogEntry, RawLogsPage } from "../types";

function renderPanel() {
  return render(
    <LanguageProvider configLang="en">
      <ToastProvider>
        <RawLogsPanel />
      </ToastProvider>
    </LanguageProvider>,
  );
}

const listEntry: RawLogEntry = {
  id: "e1",
  requestId: "req-1",
  ts: "2026-08-12T09:38:15.000Z",
  ok: true,
  client: {
    ts: "2026-08-12T09:38:15.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    headers: { authorization: "Bearer ***" },
    bodyBytes: 42,
  },
  attempt: {
    provider: "opencode",
    url: "https://opencode.ai/v1/chat/completions",
    status: 200,
    ok: true,
    headers: { "content-type": "text/event-stream" },
    bodyBytes: 1234,
  },
};

const detailEntry: RawLogEntry = {
  ...listEntry,
  client: {
    ...listEntry.client,
    body: '{"model":"opencode/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}',
    bodyTruncated: false,
  },
  attempt: {
    ...listEntry.attempt!,
    body: 'data: {"id":"chunk-1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    bodyTruncated: false,
  },
};

describe("RawLogsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the empty state when no entries exist", async () => {
    vi.spyOn(api, "rawLogs").mockResolvedValue({ total: 0, entries: [] });
    renderPanel();
    expect(
      await screen.findByText(
        "No raw logs yet. Make requests through the proxy to capture raw bodies.",
      ),
    ).toBeInTheDocument();
  });

  it("lists groups and expands into request + upstream raw bodies", async () => {
    vi.spyOn(api, "rawLogs").mockResolvedValue({
      total: 1,
      entries: [listEntry],
    } satisfies RawLogsPage);
    const detail = vi.spyOn(api, "rawLog").mockResolvedValue(detailEntry);

    renderPanel();
    // Group row shows path + attempt chip.
    expect(await screen.findByText("/v1/chat/completions")).toBeInTheDocument();
    expect(screen.getByText("opencode 200")).toBeInTheDocument();

    // Expand: detail is fetched and raw bodies render.
    fireEvent.click(screen.getByRole("button", { name: /▸/ }));
    await waitFor(() => expect(detail).toHaveBeenCalledWith("e1"));
    expect(await screen.findByText("Request body")).toBeInTheDocument();
    expect(screen.getByText("Upstream body")).toBeInTheDocument();
    expect(screen.getByText(/deepseek-v4-flash/)).toBeInTheDocument();
    expect(screen.getByText(/chatcmpl|chunk-1/)).toBeInTheDocument();

    // Masked auth header is shown, not the raw secret.
    expect(screen.getByText("Bearer ***")).toBeInTheDocument();
  });
});
