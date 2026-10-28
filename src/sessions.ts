import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { OrigamiConfig } from "./config.ts";
import type { StatusReport } from "./engine.ts";
import { openDb, type OrigamiDb } from "./persist/db.ts";
import type { OrigamiRuntime } from "./runtime.ts";

/** Agent identity as reported by the host (`ctx.agent`), normalized. */
export interface AgentInfo {
  kind: "main" | "sub";
  /** Host registry id, e.g. "Main" or "0-Explore". */
  id: string;
  name: string;
  depth: number;
  /** Registry id of the spawning agent, if any. */
  parentId: string | null;
}

export type SessionPhase = "active" | "dormant" | "ended";

export interface SessionRecord {
  readonly sessionId: string;
  readonly agent: AgentInfo;
  /** Resolved once at registration so later agent-id reuse cannot re-parent it. */
  readonly parentSessionId: string | null;
  readonly startedAt: number;
  /** Null once the session has ended; ended records keep `lastStatus` for display. */
  runtime: OrigamiRuntime | null;
  config: OrigamiConfig;
  ctx: ExtensionContext | null;
  /** False when before_agent_start skipped the doctrine (dormant subagent); context carries it instead. */
  doctrineInSystemPrompt: boolean;
  dormant: boolean;
  lastActivityAt: number;
  endedAt: number | null;
  lastStatus: StatusReport | null;
}

export interface SessionSummary {
  sessionId: string;
  agent: AgentInfo;
  parentSessionId: string | null;
  /** Depth in the origami session tree (0 = root). */
  level: number;
  phase: SessionPhase;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  occupancyPct: number;
  usedTokens: number;
  windowTokens: number;
  activeBlocks: number;
}

export interface SessionTreeNode extends SessionSummary {
  children: SessionTreeNode[];
}

/** `sessionId` is null for registry-wide events. */
export type RegistryListener = (event: string, sessionId: string | null, data: unknown) => void;

export interface RegisterInput {
  sessionId: string;
  agent: AgentInfo;
  runtime: OrigamiRuntime;
  config: OrigamiConfig;
  ctx: ExtensionContext | null;
}

/** Ended sessions kept for the UI before the oldest are forgotten. */
const MAX_ENDED = 32;

export function agentInfoFrom(ctx: Pick<ExtensionContext, "agent">): AgentInfo {
  const a = ctx.agent;
  return { kind: a.kind, id: a.id, name: a.name, depth: a.depth, parentId: a.parentId ?? null };
}

/** Short human label: "main" for the root agent, the agent definition name otherwise. */
export function sessionDisplayName(agent: AgentInfo): string {
  return agent.kind === "main" ? "main" : agent.name || agent.id;
}

/**
 * Process-wide view of every origami session (main agent and subagents).
 *
 * UIs read from here instead of "whichever runtime fired a hook last", so a
 * subagent turn never steals the dashboard or status chip from its parent.
 */
export class SessionRegistry {
  #records = new Map<string, SessionRecord>();
  #listeners = new Set<RegistryListener>();
  #db: { path: string; db: OrigamiDb; refs: number } | null = null;
  /** Single dashboard slot shared by every extension instance in the process. */
  dashboard: { url: string; stop(): void } | null = null;

  register(input: RegisterInput): SessionRecord {
    const existing = this.#records.get(input.sessionId);
    if (existing && existing.endedAt === null) return existing;
    const now = Date.now();
    const record: SessionRecord = {
      sessionId: input.sessionId,
      agent: input.agent,
      parentSessionId: this.#resolveParent(input.agent, input.sessionId),
      startedAt: now,
      runtime: input.runtime,
      config: input.config,
      ctx: input.ctx,
      doctrineInSystemPrompt: false,
      dormant: input.agent.kind === "sub",
      lastActivityAt: now,
      endedAt: null,
      lastStatus: null,
    };
    this.#records.delete(input.sessionId);
    this.#records.set(input.sessionId, record);
    this.emit("sessions", input.sessionId, { change: "started" });
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.#records.get(sessionId);
  }

  /** Live (not ended) record, or undefined. */
  live(sessionId: string): SessionRecord | undefined {
    const r = this.#records.get(sessionId);
    return r && r.endedAt === null ? r : undefined;
  }

  all(): SessionRecord[] {
    return [...this.#records.values()];
  }

  /** Record activity; snapshots status so ended sessions stay displayable. */
  touch(sessionId: string, patch: { ctx?: ExtensionContext; dormant?: boolean; status?: StatusReport } = {}): void {
    const r = this.live(sessionId);
    if (!r) return;
    r.lastActivityAt = Date.now();
    if (patch.ctx) r.ctx = patch.ctx;
    if (patch.status) r.lastStatus = patch.status;
    if (patch.dormant !== undefined && patch.dormant !== r.dormant) {
      r.dormant = patch.dormant;
      this.emit("sessions", sessionId, { change: patch.dormant ? "dormant" : "active" });
    }
  }

  end(sessionId: string): SessionRecord | undefined {
    const r = this.live(sessionId);
    if (!r) return undefined;
    if (r.runtime) {
      try {
        r.lastStatus = r.runtime.engine.status();
      } catch {
        // keep the last snapshot
      }
    }
    r.runtime = null;
    r.ctx = null;
    r.endedAt = Date.now();
    this.#forgetOldEnded();
    this.emit("sessions", sessionId, { change: "ended" });
    return r;
  }

  hasLive(): boolean {
    for (const r of this.#records.values()) if (r.endedAt === null) return true;
    return false;
  }

  /** Walk parents up to the top-most known ancestor. */
  rootOf(sessionId: string): SessionRecord | undefined {
    let r = this.#records.get(sessionId);
    const seen = new Set<string>();
    while (r?.parentSessionId && !seen.has(r.sessionId)) {
      seen.add(r.sessionId);
      const parent = this.#records.get(r.parentSessionId);
      if (!parent) break;
      r = parent;
    }
    return r;
  }

  /** Default UI focus: newest live main session, else newest live session, else newest record. */
  primary(): SessionRecord | undefined {
    const records = [...this.#records.values()].sort((a, b) => b.startedAt - a.startedAt);
    return (
      records.find((r) => r.endedAt === null && r.agent.kind === "main") ??
      records.find((r) => r.endedAt === null) ??
      records[0]
    );
  }

  /** Live sessions descending from `sessionId` (excluding itself). */
  descendants(sessionId: string): SessionRecord[] {
    const out: SessionRecord[] = [];
    const queue = [sessionId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const r of this.#records.values()) {
        if (r.parentSessionId === id && r.sessionId !== sessionId) {
          out.push(r);
          queue.push(r.sessionId);
        }
      }
    }
    return out;
  }

  summary(r: SessionRecord): SessionSummary {
    let status = r.lastStatus;
    if (r.runtime) {
      try {
        status = r.runtime.engine.status();
      } catch {
        // fall back to the last snapshot
      }
    }
    return {
      sessionId: r.sessionId,
      agent: r.agent,
      parentSessionId: r.parentSessionId,
      level: this.#level(r),
      phase: r.endedAt !== null ? "ended" : r.dormant ? "dormant" : "active",
      startedAt: r.startedAt,
      lastActivityAt: r.lastActivityAt,
      endedAt: r.endedAt,
      occupancyPct: status?.occupancyPct ?? 0,
      usedTokens: status?.usedTokens ?? 0,
      windowTokens: status?.windowTokens ?? 0,
      activeBlocks: status?.blocks.filter((b) => b.status === "active").length ?? 0,
    };
  }

  /** Roots (sessions without a known parent) with children nested, oldest first. */
  tree(): SessionTreeNode[] {
    const nodes = new Map<string, SessionTreeNode>();
    const ordered = [...this.#records.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const r of ordered) nodes.set(r.sessionId, { ...this.summary(r), children: [] });
    const roots: SessionTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentSessionId ? nodes.get(node.parentSessionId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  /** Depth-first flattening of `tree()` — the display order for list UIs. */
  flatTree(): SessionSummary[] {
    const out: SessionSummary[] = [];
    const walk = (nodes: SessionTreeNode[]) => {
      for (const { children, ...summary } of nodes) {
        out.push(summary);
        walk(children);
      }
    };
    walk(this.tree());
    return out;
  }

  subscribe(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: string, sessionId: string | null, data: unknown): void {
    for (const listener of this.#listeners) {
      try {
        listener(event, sessionId, data);
      } catch {
        // a broken listener must not break the agent loop
      }
    }
  }

  /**
   * One shared database handle per process. `onOpen` runs only when the handle
   * is actually opened (recovery notices, retention pruning).
   */
  acquireDb(path: string, onOpen?: (db: OrigamiDb) => void): OrigamiDb {
    if (this.#db && this.#db.path === path) {
      this.#db.refs++;
      return this.#db.db;
    }
    if (this.#db) throw new Error(`origami: database already open at ${this.#db.path}`);
    const db = openDb(path);
    this.#db = { path, db, refs: 1 };
    onOpen?.(db);
    return db;
  }

  releaseDb(db: OrigamiDb): void {
    if (!this.#db || this.#db.db !== db) return;
    this.#db.refs--;
    if (this.#db.refs > 0) return;
    this.#db = null;
    try {
      db.close();
    } catch {
      // ignore close error on shutdown
    }
  }

  /** Any open db handle (for UIs that need history without a live session). */
  sharedDb(): OrigamiDb | null {
    return this.#db?.db ?? null;
  }

  #resolveParent(agent: AgentInfo, selfId: string): string | null {
    if (agent.kind !== "sub" || !agent.parentId) return null;
    let best: SessionRecord | undefined;
    for (const r of this.#records.values()) {
      if (r.sessionId === selfId || r.agent.id !== agent.parentId) continue;
      // Prefer a live parent; among equals the newest wins.
      const rank = (x: SessionRecord) => (x.endedAt === null ? 1 : 0);
      if (!best || rank(r) > rank(best) || (rank(r) === rank(best) && r.startedAt >= best.startedAt)) best = r;
    }
    return best?.sessionId ?? null;
  }

  #level(r: SessionRecord): number {
    let level = 0;
    let cur = r;
    const seen = new Set<string>();
    while (cur.parentSessionId && !seen.has(cur.sessionId)) {
      seen.add(cur.sessionId);
      const parent = this.#records.get(cur.parentSessionId);
      if (!parent) break;
      level++;
      cur = parent;
    }
    return level;
  }

  #forgetOldEnded(): void {
    const ended = [...this.#records.values()]
      .filter((r) => r.endedAt !== null)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const r of ended.slice(0, Math.max(0, ended.length - MAX_ENDED))) this.#records.delete(r.sessionId);
  }
}

const REGISTRY_KEY = Symbol.for("origami.sessionRegistry");

/**
 * The process-global registry. Keyed on a well-known symbol so every copy of
 * this module (one per loaded extension instance) shares one view.
 */
export function sessionRegistry(): SessionRegistry {
  const g = globalThis as Record<symbol, unknown>;
  let reg = g[REGISTRY_KEY];
  if (!(reg instanceof SessionRegistry)) {
    // A different module copy may own the slot; reuse it if it quacks right.
    if (reg && typeof (reg as SessionRegistry).register === "function") return reg as SessionRegistry;
    reg = new SessionRegistry();
    g[REGISTRY_KEY] = reg;
  }
  return reg as SessionRegistry;
}
