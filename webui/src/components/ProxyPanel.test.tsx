import { describe, expect, it } from "vitest";
import { providerServesRule } from "./ProxyPanel";
import type { ProviderProfile, RuleMatch } from "../types";

function profile(exposedModels?: string[], modelMap?: Record<string, unknown>): ProviderProfile {
  return {
    api: "openai-completions",
    baseUrl: "https://up.test/v1",
    apiKey: "k",
    models: [],
    proxy: false,
    ...(exposedModels ? { exposedModels } : {}),
    ...(modelMap ? { modelMap } : {}),
  };
}

const lunaRule: RuleMatch = { modelPrefix: "gpt-5.6-luna" };

describe("providerServesRule", () => {
  it("accepts a provider exposing a matching model", () => {
    expect(providerServesRule(profile(["gpt-5.6-luna"]), lunaRule)).toBe(true);
  });

  it("accepts a modelMap entry even without exposedModels", () => {
    expect(
      providerServesRule(profile(undefined, { "gpt-5.6-luna": "luna-upstream" }), lunaRule),
    ).toBe(true);
  });

  it("rejects a provider whose exposed models do not match the rule", () => {
    expect(providerServesRule(profile(["gpt-5.6-terra", "gpt-5.6-sol"]), lunaRule)).toBe(false);
  });

  it("rejects a missing profile", () => {
    expect(providerServesRule(undefined, lunaRule)).toBe(false);
  });

  it("honours modelContains as well", () => {
    const rule: RuleMatch = { modelContains: "deepseek" };
    expect(providerServesRule(profile(["deepseek-v4-pro"]), rule)).toBe(true);
    expect(providerServesRule(profile(["gpt-5.6-luna"]), rule)).toBe(false);
  });

  it("does not judge rules with empty match conditions", () => {
    expect(providerServesRule(profile(["gpt-5.6-luna"]), {})).toBe(true);
    expect(providerServesRule(undefined, {})).toBe(true);
  });
});
