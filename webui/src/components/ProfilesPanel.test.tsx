import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilesPanel } from "./ProfilesPanel";
import { LanguageProvider } from "../i18n";
import { ToastProvider } from "./ui";
import { api } from "../api";
import type { AppState } from "../types";

function stateWithProfile(overrides: Record<string, unknown> = {}) {
  return {
    current: "native",
    profiles: {
      native: {
        api: "openai-responses",
        baseUrl: "https://example.test/v1",
        apiKey: "key",
        models: [],
        proxy: false,
        responsesMode: "passthrough",
        ...overrides,
      },
    },
    settings: {},
  } as unknown as AppState;
}

function renderPanel(state = stateWithProfile()) {
  return render(
    <LanguageProvider configLang="en">
      <ToastProvider>
        <ProfilesPanel state={state} refresh={vi.fn(async () => {})} />
      </ToastProvider>
    </LanguageProvider>,
  );
}

describe("provider Responses mode form", () => {
  beforeEach(() => {
    vi.spyOn(api, "getPresets").mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows and preserves the existing Responses mode", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(4));
    expect(screen.getAllByRole("combobox")[2]).toHaveValue("passthrough");
    expect(screen.getByText("Responses mode")).toBeInTheDocument();
  });

  it("blocks a passthrough mode on a Chat Completions provider", async () => {
    const update = vi.spyOn(api, "updateProfile").mockResolvedValue({});
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(4));

    fireEvent.change(screen.getAllByRole("combobox")[1], {
      target: { value: "openai-completions" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("passthrough requires openai-responses")).toBeInTheDocument(),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("shows the effective Responses mode on the provider list", () => {
    renderPanel(stateWithProfile({ responsesMode: "auto" }));
    expect(screen.getByText("Responses: passthrough")).toBeInTheDocument();
  });

  it("maps auto to conversion for a Chat Completions provider", () => {
    renderPanel(stateWithProfile({ api: "openai-completions", responsesMode: "auto" }));
    expect(screen.getByText("Responses: convert")).toBeInTheDocument();
  });
});

describe("test all providers", () => {
  function stateWithProfiles(profiles: Record<string, unknown>) {
    return {
      current: "native",
      profiles,
      settings: {},
    } as unknown as AppState;
  }

  beforeEach(() => {
    vi.spyOn(api, "getPresets").mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("runs one test per non-proxy profile and shows a summary", async () => {
    const test = vi
      .spyOn(api, "testProfile")
      .mockImplementation(async (name: string) =>
        name === "native"
          ? { success: true, message: "✓ Connected successfully (HTTP 200)", responseTimeMs: 120 }
          : { success: false, message: "✗ HTTP 500", responseTimeMs: 300 },
      );
    renderPanel(
      stateWithProfiles({
        native: {
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          apiKey: "key",
          models: [],
          proxy: false,
          responsesMode: "auto",
        },
        broken: {
          api: "openai-completions",
          baseUrl: "https://broken.test/v1",
          apiKey: "key",
          models: [],
          proxy: false,
          responsesMode: "auto",
        },
        gateway: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:43112/v1",
          apiKey: "pi-switch-proxy",
          models: [],
          proxy: true,
          responsesMode: "auto",
        },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Test all" }));

    await waitFor(() => expect(test).toHaveBeenCalledTimes(2)); // proxy profile skipped
    expect(test).toHaveBeenCalledWith("native");
    expect(test).toHaveBeenCalledWith("broken");
    await waitFor(() => expect(screen.getByText("1/2 reachable")).toBeInTheDocument());
    expect(screen.getAllByText("Reachable")).toHaveLength(1); // success shows label + latency, not the raw message
    expect(screen.getByText("120ms")).toBeInTheDocument();
    expect(screen.getByText("✗ HTTP 500")).toBeInTheDocument(); // failure shows the raw message
  });

  it("disables the button when there is nothing testable", () => {
    renderPanel(
      stateWithProfiles({
        gateway: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:43112/v1",
          apiKey: "pi-switch-proxy",
          models: [],
          proxy: true,
          responsesMode: "auto",
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Test all" })).toBeDisabled();
  });
});
