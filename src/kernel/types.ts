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
  /** Tool calls an assistant message makes (id and tool name). */
  toolCalls?: { id: string; name: string }[];
  contentHash: string;
  signedThinking: boolean;
  text: string;
  bytes: number;
  imageTokens?: number;
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

/**
 * Block lifecycle:
 * - `active`: rendered in place of the refs it covers.
 * - `consumed`: folded into a higher block (`consumedBy`); not rendered.
 * - `unfolded`: explicitly restored; its covered content renders as children or raw messages.
 */
export type BlockStatus = "active" | "consumed" | "unfolded";

export interface Block {
  id: string;
  tier: 1 | 2 | 3;
  /** Effective message ranges: everything this block stands in for, including consumed children. */
  ranges: RefRange[];
  topic: string;
  summary: string;
  /** Direct child block ids consumed by this block. */
  children: string[];
  status: BlockStatus;
  consumedBy: string | null;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: number;
  /** Newest message ref present when the fold happened; baseline for growth accounting. */
  anchorRef: string | null;
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