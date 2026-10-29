import { describe, expect, it } from "bun:test";
import { ConfigError, PRESETS, applyOverrides, configFromPreset, mergeConfigLayers, validateResolved } from "../src/config.ts";

const balanced = () => configFromPreset("balanced");

describe("presets", () => {
  it("locks the three preset values", () => {
    expect(PRESETS.balanced).toEqual({ growthStep: 50000, compressibleFloor: 22500, emergencyFillPct: 0.85, elideFillPct: 0.95, protectedTailMessages: 5, protectedTailTokens: 5000, tier2MassTokens: 15000, tier3MassTokens: 22500, minFoldBenefitTokens: 5000, minFoldBenefitWindowPct: 0.01, blockMatureFolds: 2, minFoldFillPct: 0.45, minFoldFillCapTokens: 160000 });
    expect(PRESETS.lean).toEqual({ growthStep: 20000, compressibleFloor: 10000, emergencyFillPct: 0.8, elideFillPct: 0.92, protectedTailMessages: 4, protectedTailTokens: 3000, tier2MassTokens: 8000, tier3MassTokens: 12000, minFoldBenefitTokens: 2000, minFoldBenefitWindowPct: 0.005, blockMatureFolds: 1, minFoldFillPct: 0.3, minFoldFillCapTokens: 100000 });
    expect(PRESETS.relaxed).toEqual({ growthStep: 100000, compressibleFloor: 40000, emergencyFillPct: 0.9, elideFillPct: 0.97, protectedTailMessages: 8, protectedTailTokens: 10000, tier2MassTokens: 30000, tier3MassTokens: 45000, minFoldBenefitTokens: 10000, minFoldBenefitWindowPct: 0.01, blockMatureFolds: 3, minFoldFillPct: 0.55, minFoldFillCapTokens: 200000 });
  });

  it("completes each preset into a full config", () => {
    const cfg = configFromPreset("lean");
    expect(cfg.preset).toBe("lean");
    expect(cfg.growthStep).toBe(20000);
    expect(cfg.subagentActivateTokens).toBe(40000);
    expect(cfg.language).toBe("preserve");
  });
});

describe("applyOverrides", () => {
  it("applies known keys", () => {
    const cfg = applyOverrides(balanced(), { growthStep: 60000 }, "f.yml");
    expect(cfg.growthStep).toBe(60000);
    expect(cfg.compressibleFloor).toBe(22500);
  });

  it("rejects unknown keys loudly with the file path", () => {
    expect(() => applyOverrides(balanced(), { nope: 1 }, "f.yml")).toThrow(ConfigError);
    try {
      applyOverrides(balanced(), { nope: 1 }, "f.yml");
    } catch (e) {
      expect((e as ConfigError).file).toBe("f.yml");
      expect((e as ConfigError).message).toContain("nope");
    }
  });

  it("rejects non-positive and invalid values", () => {
    expect(() => applyOverrides(balanced(), { growthStep: 0 }, "f.yml")).toThrow(ConfigError);
    expect(() => applyOverrides(balanced(), { growthStep: -5 }, "f.yml")).toThrow(ConfigError);
    expect(() => applyOverrides(balanced(), { growthStep: "x" }, "f.yml")).toThrow(ConfigError);
    expect(() => applyOverrides(balanced(), { emergencyFillPct: 1.5 }, "f.yml")).toThrow(ConfigError);
    expect(() => applyOverrides(balanced(), { elideFillPct: 0 }, "f.yml")).toThrow(ConfigError);
    expect(() => applyOverrides(balanced(), { language: "klingon" }, "f.yml")).toThrow(ConfigError);
    expect(() => applyOverrides(balanced(), { preset: "turbo" }, "f.yml")).toThrow(ConfigError);
  });

  it("switching preset resets preset keys but keeps explicit overrides", () => {
    const cfg = applyOverrides(applyOverrides(balanced(), { growthStep: 60000 }, "a.yml"), { preset: "lean" }, "b.yml");
    expect(cfg.growthStep).toBe(20000);
  });
});

describe("mergeConfigLayers", () => {
  it("later layers win over earlier ones", () => {
    const merged = mergeConfigLayers([
      { file: "a.yml", raw: PRESETS.lean },
      { file: "b.yml", raw: { growthStep: 30000 } },
      { file: "c.yml", raw: { growthStep: 40000 } },
    ]);
    expect(merged.growthStep).toBe(40000);
    expect(merged.compressibleFloor).toBe(10000);
  });
});

describe("validateResolved", () => {
  it("rejects floor at or above step", () => {
    expect(() => validateResolved({ ...balanced(), compressibleFloor: 60000, growthStep: 50000 })).toThrow(ConfigError);
    expect(() => validateResolved({ ...balanced(), compressibleFloor: 50000, growthStep: 50000 })).toThrow(ConfigError);
  });

  it("rejects elide pct at or below emergency pct", () => {
    expect(() => validateResolved({ ...balanced(), emergencyFillPct: 0.95, elideFillPct: 0.95 })).toThrow(ConfigError);
    expect(() => validateResolved({ ...balanced(), emergencyFillPct: 0.95, elideFillPct: 0.9 })).toThrow(ConfigError);
  });

  it("accepts every preset as-is", () => {
    for (const name of ["balanced", "lean", "relaxed"] as const) {
      expect(() => validateResolved(configFromPreset(name))).not.toThrow();
    }
  });
});