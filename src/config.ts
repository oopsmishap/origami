export type Preset = "balanced" | "lean" | "relaxed";

export interface OrigamiConfig {
  preset: Preset;
  growthStep: number;
  compressibleFloor: number;
  subagentActivateTokens: number;
  emergencyFillPct: number;
  elideFillPct: number;
  /** Recent tail protected from folding: at least this many messages... */
  protectedTailMessages: number;
  /** ...and at least this many tokens, widened to whole turns. */
  protectedTailTokens: number;
  /** Active tier-1 summary mass that triggers a tier-2 promotion nudge. */
  tier2MassTokens: number;
  /** Active tier-2 summary mass that triggers a tier-3 promotion nudge. */
  tier3MassTokens: number;
  /** Minimum tokens a tier-1 fold batch must reclaim outside an emergency (floor = max of this and the window share below; both 0 disables). */
  minFoldBenefitTokens: number;
  /** ...raised to this fraction of the context window when that is larger (0 disables). */
  minFoldBenefitWindowPct: number;
  /** Fold events a block must survive before it is "old" and offered for tier promotion. */
  blockMatureFolds: number;
  /** Delete archived DB rows older than this many days on startup; 0 keeps everything. */
  retentionDays: number;
  language: "preserve" | "english";
}

type PresetKeys =
  | "growthStep"
  | "compressibleFloor"
  | "emergencyFillPct"
  | "elideFillPct"
  | "protectedTailMessages"
  | "protectedTailTokens"
  | "tier2MassTokens"
  | "tier3MassTokens"
  | "minFoldBenefitTokens"
  | "minFoldBenefitWindowPct"
  | "blockMatureFolds";

export const PRESETS: Record<Preset, Pick<OrigamiConfig, PresetKeys>> = {
  balanced: {
    growthStep: 50000,
    compressibleFloor: 22500,
    emergencyFillPct: 0.85,
    elideFillPct: 0.95,
    protectedTailMessages: 5,
    protectedTailTokens: 5000,
    tier2MassTokens: 15000,
    tier3MassTokens: 22500,
    minFoldBenefitTokens: 5000,
    minFoldBenefitWindowPct: 0.01,
    blockMatureFolds: 2,
  },
  lean: {
    growthStep: 20000,
    compressibleFloor: 10000,
    emergencyFillPct: 0.8,
    elideFillPct: 0.92,
    protectedTailMessages: 4,
    protectedTailTokens: 3000,
    tier2MassTokens: 8000,
    tier3MassTokens: 12000,
    minFoldBenefitTokens: 2000,
    minFoldBenefitWindowPct: 0.005,
    blockMatureFolds: 1,
  },
  relaxed: {
    growthStep: 100000,
    compressibleFloor: 40000,
    emergencyFillPct: 0.9,
    elideFillPct: 0.97,
    protectedTailMessages: 8,
    protectedTailTokens: 10000,
    tier2MassTokens: 30000,
    tier3MassTokens: 45000,
    minFoldBenefitTokens: 10000,
    minFoldBenefitWindowPct: 0.01,
    blockMatureFolds: 3,
  },
};

export const DEFAULT_SUBACTIVATE_TOKENS = 40000;

export function configFromPreset(preset: Preset): OrigamiConfig {
  return { preset, subagentActivateTokens: DEFAULT_SUBACTIVATE_TOKENS, retentionDays: 0, language: "preserve", ...PRESETS[preset] };
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    message: string,
    readonly line?: number,
  ) {
    super(line !== undefined ? `${file}:${line}: ${message}` : `${file}: ${message}`);
    this.name = "ConfigError";
  }
}

const NUMERIC_KEYS: Record<string, true> = {
  growthStep: true,
  compressibleFloor: true,
  subagentActivateTokens: true,
  tier2MassTokens: true,
  tier3MassTokens: true,
};

const NON_NEGATIVE_INT_KEYS: Record<string, true> = {
  protectedTailMessages: true,
  protectedTailTokens: true,
  retentionDays: true,
  minFoldBenefitTokens: true,
  blockMatureFolds: true,
};

/** Fractions in [0, 1): 0 disables the feature. */
const FRACTION_OR_ZERO_KEYS: Record<string, true> = {
  minFoldBenefitWindowPct: true,
};

const PCT_KEYS: Record<string, true> = {
  emergencyFillPct: true,
  elideFillPct: true,
};

export function applyOverrides(base: OrigamiConfig, raw: unknown, file: string): OrigamiConfig {
  if (raw === null || raw === undefined) return base;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(file, "config root must be a mapping");
  }
  const out: OrigamiConfig = { ...base };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "preset") {
      if (value !== "balanced" && value !== "lean" && value !== "relaxed") {
        throw new ConfigError(file, `invalid preset: ${String(value)}`);
      }
      const preset = value;
      Object.assign(out, configFromPreset(preset));
      out.preset = preset;
      continue;
    }
    if (key in NUMERIC_KEYS) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new ConfigError(file, `${key} must be a positive number, got ${String(value)}`);
      }
      Object.assign(out, { [key]: value });
      continue;
    }
    if (key in NON_NEGATIVE_INT_KEYS) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new ConfigError(file, `${key} must be a non-negative integer, got ${String(value)}`);
      }
      Object.assign(out, { [key]: value });
      continue;
    }
    if (key in FRACTION_OR_ZERO_KEYS) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
        throw new ConfigError(file, `${key} must be a fraction in [0, 1), got ${String(value)}`);
      }
      Object.assign(out, { [key]: value });
      continue;
    }
    if (key in PCT_KEYS) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
        throw new ConfigError(file, `${key} must be a fraction in (0, 1), got ${String(value)}`);
      }
      Object.assign(out, { [key]: value });
      continue;
    }
    if (key === "language") {
      if (value !== "preserve" && value !== "english") {
        throw new ConfigError(file, `invalid language: ${String(value)}`);
      }
      out.language = value;
      continue;
    }
    throw new ConfigError(file, `unknown config key: ${key}`);
  }
  return out;
}

export function mergeConfigLayers(layers: readonly { file: string; raw: unknown }[]): OrigamiConfig {
  let cfg = configFromPreset("balanced");
  for (const layer of layers) cfg = applyOverrides(cfg, layer.raw, layer.file);
  return cfg;
}

export function validateResolved(cfg: OrigamiConfig, file = "<resolved>"): OrigamiConfig {
  if (cfg.compressibleFloor >= cfg.growthStep) {
    throw new ConfigError(file, `compressibleFloor (${cfg.compressibleFloor}) must be below growthStep (${cfg.growthStep})`);
  }
  if (cfg.elideFillPct <= cfg.emergencyFillPct) {
    throw new ConfigError(file, `elideFillPct (${cfg.elideFillPct}) must exceed emergencyFillPct (${cfg.emergencyFillPct})`);
  }
  return cfg;
}