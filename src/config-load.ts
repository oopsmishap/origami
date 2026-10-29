import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ConfigError, mergeConfigLayers, validateResolved } from "./config.ts";
import type { OrigamiConfig } from "./config.ts";

interface YamlParseFn {
  (text: string): unknown;
}

function resolveYamlParse(): YamlParseFn | null {
  const bun = (globalThis as { Bun?: { YAML?: { parse?: YamlParseFn } } }).Bun;
  return bun?.YAML?.parse ?? null;
}

function readIfExists(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  } catch {
    return null;
  }
}

export function loadLayer(file: string): { file: string; raw: unknown } | null {
  const text = readIfExists(file);
  if (text === null) return null;
  const parse = resolveYamlParse();
  if (!parse) throw new ConfigError(file, "Bun.YAML is unavailable; cannot parse origami.yml");
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(file, `YAML parse error: ${msg}`);
  }
  return { file, raw };
}

export function loadOrigamiConfig(paths: { agentDir: string; projectDir: string }): OrigamiConfig {
  const agentFile = `${paths.agentDir}/origami.yml`;
  const projectFile = `${paths.projectDir}/.omp/origami.yml`;
  const agentLayer = loadLayer(agentFile);
  const projectLayer = loadLayer(projectFile);
  const layers = [agentLayer, projectLayer].filter((l): l is { file: string; raw: unknown } => l !== null);
  const resolved = mergeConfigLayers(layers);
  return validateResolved(resolved);
}
export function serializeYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function saveConfigFile(file: string, config: Partial<OrigamiConfig>): void {
  const dir = file.replace(/[/\\][^/\\]+$/, "");
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const text = serializeYaml(config as Record<string, unknown>);
  writeFileSync(file, text, "utf-8");
}
