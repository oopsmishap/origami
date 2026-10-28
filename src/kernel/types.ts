export type KernelRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "custom"
  | "developer"
  | "system";

export interface KernelMessage {
  role: KernelRole;
  toolCallId?: string;
  toolCallIds?: string[];
  contentHash: string;
  signedThinking: boolean;
  text: string;
  bytes: number;
}

export interface BoundMessage extends KernelMessage {
  index: number;
  ref: string;
  ephemeral: boolean;
  turn: number;
}

export interface RefRange {
  start: string;
  end: string;
}

export interface Block {
  id: string;
  tier: 1 | 2 | 3;
  ranges: RefRange[];
  topic: string;
  summary: string;
  children: string[];
  superseded: boolean;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: number;
}

export function parseRef(ref: string): number {
  const m = /^m(\d{5,})$/.exec(ref);
  if (!m) throw new Error(`invalid ref: ${ref}`);
  return Number.parseInt(m[1]!, 10);
}

export function formatRef(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ref number: ${n}`);
  return `m${String(n).padStart(5, "0")}`;
}

export function parseRangeSpec(spec: string): RefRange {
  const i = spec.indexOf("..");
  if (i < 0) {
    const r = { start: spec, end: spec };
    parseRef(r.start);
    return r;
  }
  const start = spec.slice(0, i);
  const end = spec.slice(i + 2);
  const a = parseRef(start);
  const b = parseRef(end);
  if (a > b) throw new Error(`reversed range: ${spec}`);
  return { start, end };
}