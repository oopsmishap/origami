export type Preset = "balanced" | "lean" | "relaxed";

export interface OrigamiConfig {
  preset: Preset;
  growthStep: number;
  compressibleFloor: number;
  subagentActivateTokens: number;
  emergencyFillPct: number;
  elideFillPct: number;
  language: "preserve" | "english";
}

export const PRESETS: Record<Preset, Pick<OrigamiConfig, "growthStep" | "compressibleFloor" | "emergencyFillPct" | "elideFillPct">> = {
  balanced: { growthStep: 50000, compressibleFloor: 22500, emergencyFillPct: 0.85, elideFillPct: 0.95 },
  lean: { growthStep: 20000, compressibleFloor: 10000, emergencyFillPct: 0.8, elideFillPct: 0.92 },
  relaxed: { growthStep: 100000, compressibleFloor: 40000, emergencyFillPct: 0.9, elideFillPct: 0.97 },
};

export const DEFAULT_SUBACTIVATE_TOKENS = 40000;

export function configFromPreset(preset: Preset): OrigamiConfig {
  return { preset, subagentActivateTokens: DEFAULT_SUBACTIVATE_TOKENS, language: "preserve", ...PRESETS[preset] };
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