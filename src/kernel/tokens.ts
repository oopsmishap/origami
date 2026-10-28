import type { KernelMessage } from "./types.ts";

export type Encoding =
  | "O200kBase"
  | "Cl100kBase"
  | "ClaudeV3"
  | "ClaudeV47"
  | "ClaudeV5"
  | "ClaudeV5Sonnet"
  | "Qwen3"
  | "DeepSeekV3"
  | "KimiK2"
  | "Glm5"
  | "Jev";

export type CountFn = (input: string, encoding?: Encoding) => number;

const ESTIMATED_TOKENS_PER_UTF8_BYTE = 4;

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / ESTIMATED_TOKENS_PER_UTF8_BYTE);
}

export function pickEncoding(modelId?: string): Encoding {
  const m = (modelId ?? "").toLowerCase();
  if (m.includes("claude")) return "ClaudeV5";
  if (m.includes("kimi")) return "KimiK2";
  if (m.includes("deepseek")) return "DeepSeekV3";
  if (m.includes("qwen")) return "Qwen3";
  if (m.includes("glm")) return "Glm5";
  return "O200kBase";
}

export class TokenLedger {
  private memo = new Map<string, number>();
  private countFn: CountFn | null;
  private encoding: Encoding;

  constructor(modelId: string, countFn: CountFn | null) {
    this.countFn = countFn;
    this.encoding = pickEncoding(modelId);
  }

  countText(text: string): number {
    const key = `t\u0000${text}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    let n = estimateTokens(text);
    if (this.countFn) {
      try {
        const measured = this.countFn(text, this.encoding);
        if (Number.isFinite(measured) && measured > 0) n = measured;
      } catch {
        /* natives unavailable — keep estimate */
      }
    }
    this.memo.set(key, n);
    return n;
  }

  countMessage(msg: KernelMessage): number {
    const key = `m\u0000${msg.role}\u0000${msg.contentHash}\u0000${msg.imageTokens ?? 0}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const n = this.countText(msg.text) + PER_MESSAGE_OVERHEAD_TOKENS + (msg.imageTokens ?? 0);
    this.memo.set(key, n);
    return n;
  }

  countMessages(msgs: readonly KernelMessage[]): number {
    let total = 0;
    for (const m of msgs) total += this.countMessage(m);
    return total;
  }
}

const PER_MESSAGE_OVERHEAD_TOKENS = 4;