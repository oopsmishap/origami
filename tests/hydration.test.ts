import { describe, expect, it } from "bun:test";
import { formatHydration, matchHydration } from "../src/kernel/hydration.ts";
import { EMPTY_MANIFEST } from "../src/kernel/manifest.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { Block, KernelMessage } from "../src/kernel/types.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";

const sampleBlock: Block = {
  id: "b40",
  tier: 1,
  ranges: [{ start: "m04675", end: "m04978" }],
  topic: "v0.4.1 Release, Semantic Slicing & Roadmap to v0.5.0",
  summary:
    "- Config Endpoints: added GET /api/config and POST /api/config with validation and YAML persistence.\n- Semantic Slicing: authored src/kernel/semantic-boundary.ts for task milestones.\n- Verification: 234 tests pass across 43 files.",
  children: [],
  status: "active",
  consumedBy: null,
  tokensBefore: 5000,
  tokensAfter: 500,
  createdAt: 100,
  anchorRef: "m04978",
  manifest: {
    ...EMPTY_MANIFEST,
    paths: ["src/config.ts", "src/kernel/ledger.ts", "src/config-load.ts"],
    symbols: ["OrigamiConfig", "saveConfigFile", "NON_NEGATIVE_INT_KEYS"],
    errors: ["ConfigError: unknown config key"],
    commits: ["48389e0"],
    tools: ["edit", "bash"],
  },
  ledger: [
    {
      id: "l1",
      kind: "decision",
      text: "Disciplined versioning cadence: maintain v0.4.x for surface parity, reserve v0.5.0 for autonomous lifecycle",
      ref: "m04650",
    },
    {
      id: "l2",
      kind: "constraint",
      text: "NON_NEGATIVE_INT_KEYS must include cooldownTurns and hydrationMaxBlocks",
      ref: "m04655",
    },
    {
      id: "l3",
      kind: "objective",
      text: "Implement JIT reactive hydration before autonomous compaction",
      ref: "m04985",
    },
  ],
};

describe("reactive hydration kernel", () => {
  it("matches path in probe and extracts relevant ledger decisions and constraints", () => {
    const matches = matchHydration({
      blocks: [sampleBlock],
      probe: 'editing src/config.ts to add new setting',
      maxBlocks: 2,
      mode: "full",
    });

    expect(matches.length).toBe(1);
    const m = matches[0]!;
    expect(m.blockId).toBe("b40");
    expect(m.coverage).toBe("m04675..m04978");
    expect(m.matched).toContain("src/config.ts");
    expect(m.ledger.length).toBeGreaterThan(0);
    // Prioritizes constraints/decisions
    expect(m.ledger.some((r) => r.kind === "constraint")).toBe(true);
    expect(m.ledger.some((r) => r.kind === "decision")).toBe(true);
    expect(m.ghostPointers).toContain("b40#m04650");

    const formatted = formatHydration(matches);
    expect(formatted).toContain("[origami hydration] Active context matches folded history:");
    expect(formatted).toContain('b40 (m04675..m04978) "v0.4.1 Release, Semantic Slicing & Roadmap to v0.5.0"');
    expect(formatted).toContain("[decision] Disciplined versioning cadence");
    expect(formatted).toContain("Ghost pointers:");
    expect(formatted).toContain("b40#m04650");
  });

  it("matches symbol and excerpts relevant summary clauses", () => {
    const matches = matchHydration({
      blocks: [sampleBlock],
      probe: 'check if OrigamiConfig is exported properly',
      maxBlocks: 2,
      mode: "full",
    });

    expect(matches.length).toBe(1);
    expect(matches[0]!.matched).toContain("OrigamiConfig");
  });

  it("supports mode: pointers without full ledger", () => {
    const matches = matchHydration({
      blocks: [sampleBlock],
      probe: 'referencing src/kernel/ledger.ts',
      maxBlocks: 1,
      mode: "pointers",
    });

    expect(matches.length).toBe(1);
    expect(matches[0]!.ledger.length).toBe(0);
    expect(matches[0]!.ghostPointers.length).toBeGreaterThan(0);
  });

  it("skips consumed or excluded blocks", () => {
    const consumedBlock: Block = { ...sampleBlock, status: "consumed" };
    const matches = matchHydration({
      blocks: [consumedBlock],
      probe: 'src/config.ts',
      maxBlocks: 2,
    });
    expect(matches.length).toBe(0);

    const excludedMatches = matchHydration({
      blocks: [sampleBlock],
      probe: 'src/config.ts',
      exclude: new Set(["b40"]),
      maxBlocks: 2,
    });
    expect(excludedMatches.length).toBe(0);
  });
});

describe("engine reactive hydration integration", () => {
  it("reactively hydrates on matching turn, respects quiet turns, and honors hydration config toggle", () => {
    const entries: { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content: string } }[] = [];
    const push = (role: string, content: string) => entries.push({ type: "message", id: `e${entries.length}`, message: { role, content } });
    for (let t = 0; t < 4; t++) {
      push("user", `early turn ${t} edits src/config.ts ${"detail ".repeat(200)}`);
      push("assistant", `done ${t} ${"reply ".repeat(200)}`);
    }

    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "hydration-session",
        appendEvent: (op) => entries.push({ type: "custom", id: `j${entries.length}`, customType: JOURNAL_ENTRY_TYPE, data: op }),
        saveArtifact: async () => "/tmp/x",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries,
      modelId: "test",
      config: {
        ...configFromPreset("balanced"),
        protectedTailMessages: 0,
        protectedTailTokens: 0,
        minFoldBenefitTokens: 0,
        minFoldBenefitWindowPct: 0,
        hydration: true,
      },
    });

    const sync = () => {
      engine.refresh(entries);
      engine.ingest(entries.map((e) => (e.message ? messageFacts(e.message) : null)).filter((f): f is KernelMessage => f !== null));
    };
    sync();

    const refs = engine.bound.map((m) => m.ref);
    const res = engine.executeFold({
      folds: [
        {
          range: `${refs[2]}..${refs[5]}`,
          topic: "Config architecture",
          summary: "Added configuration presets and validation in src/config.ts.",
          keep: [
            { kind: "constraint", text: "NON_NEGATIVE_INT_KEYS must be non-negative integers" },
            { kind: "decision", text: "Store preset configuration in PRESETS record" },
          ],
        },
      ],
    });
    expect(res.ok).toBe(true);

    // Turn touching the folded file
    push("user", "We need to check src/config.ts again");
    sync();

    const hydrated = engine.hydrationText();
    expect(hydrated).not.toBeNull();
    expect(hydrated).toContain("[origami hydration]");
    expect(hydrated).toContain("src/config.ts");
    expect(hydrated).toContain("NON_NEGATIVE_INT_KEYS must be non-negative integers");

    // Second turn on same file within quietTurns should be quiet
    push("assistant", "ok");
    push("user", "Still working on src/config.ts");
    sync();
    expect(engine.hydrationText()).toBeNull();

    // Disable hydration in config and verify it returns null
    engine.config = { ...engine.config, hydration: false };
    expect(engine.hydrationText()).toBeNull();
  });

  it("never re-injects a block into the turn that folded it, ignores import paths, and keeps a note for the rest of its turn", () => {
    const entries: { type: string; id: string; customType?: string; data?: unknown; message?: Record<string, unknown> }[] = [];
    const push = (message: Record<string, unknown>) => entries.push({ type: "message", id: `e${entries.length}`, message });
    for (let t = 0; t < 4; t++) {
      push({ role: "user", content: `turn ${t} edits src/config.ts ${"detail ".repeat(200)}` });
      push({ role: "assistant", content: `done ${t} ${"reply ".repeat(200)}` });
    }
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "hydration-fold-turn",
        appendEvent: (op) => entries.push({ type: "custom", id: `j${entries.length}`, customType: JOURNAL_ENTRY_TYPE, data: op }),
        saveArtifact: async () => "/tmp/x",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0, hydration: true },
    });
    const sync = () => {
      engine.refresh(entries);
      engine.ingest(entries.map((e) => (e.message ? messageFacts(e.message) : null)).filter((f): f is KernelMessage => f !== null));
    };
    sync();
    const refs = engine.bound.map((m) => m.ref);

    // The folding turn: the fold call names the range and its result echoes the block's paths.
    push({ role: "user", content: "wrap up the config work" });
    push({ role: "assistant", content: [{ type: "toolCall", id: "f1", name: "fold", arguments: { range: `${refs[2]}..${refs[5]}`, topic: "Config", summary: "src/config.ts presets" } }] });
    sync();
    const res = engine.executeFold({ folds: [{ range: `${refs[2]}..${refs[5]}`, topic: "Config", summary: "Presets in src/config.ts." }] });
    expect(res.ok).toBe(true);
    push({ role: "toolResult", toolCallId: "f1", toolName: "fold", content: [{ type: "text", text: "b1 (tier 1) · Config · src/config.ts" }] });
    sync();
    expect(engine.hydrationText()).toBeNull();
    expect(engine.recallHintText()).toBeNull();

    // A later turn that only reads a file importing "../src/config.ts" is not a match.
    push({ role: "assistant", content: "done" });
    push({ role: "user", content: "look at the loader" });
    push({ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "lib/loader.ts" } }] });
    push({ role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: 'import { x } from "../src/config.ts";' }] });
    sync();
    expect(engine.hydrationText()).toBeNull();

    // Real work on the folded file hydrates; later tool steps of the same turn resend the identical
    // note (tail notes are not persisted), and the next unrelated turn drops it.
    push({ role: "assistant", content: "ok" });
    push({ role: "user", content: "check src/config.ts again" });
    sync();
    const note = engine.hydrationText();
    expect(note).toContain("[origami hydration]");
    push({ role: "assistant", content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/config.ts" } }] });
    push({ role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "export const PRESETS = {}" }] });
    sync();
    expect(engine.hydrationText()).toBe(note);
    push({ role: "assistant", content: "done" });
    push({ role: "user", content: "now something unrelated" });
    sync();
    expect(engine.hydrationText()).toBeNull();
  });

  it("matches only what the user and assistant wrote or passed to tools, never tool output or plain words", () => {
    const entries: { type: string; id: string; customType?: string; data?: unknown; message?: Record<string, unknown> }[] = [];
    const push = (message: Record<string, unknown>) => entries.push({ type: "message", id: `e${entries.length}`, message });
    for (let t = 0; t < 4; t++) {
      push({ role: "user", content: `turn ${t} tunes src/kernel/nudge.ts, \`decideNudge\` and \`false\` ${"detail ".repeat(200)}` });
      push({ role: "assistant", content: `done ${t} ${"reply ".repeat(200)}` });
    }
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "hydration-provenance",
        appendEvent: (op) => entries.push({ type: "custom", id: `j${entries.length}`, customType: JOURNAL_ENTRY_TYPE, data: op }),
        saveArtifact: async () => "/tmp/x",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0, hydration: true },
    });
    const sync = () => {
      engine.refresh(entries);
      engine.ingest(entries.map((e) => (e.message ? messageFacts(e.message) : null)).filter((f): f is KernelMessage => f !== null));
    };
    sync();
    const refs = engine.bound.map((m) => m.ref);
    expect(engine.executeFold({ folds: [{ range: `${refs[2]}..${refs[5]}`, topic: "Nudge", summary: "Tuned src/kernel/nudge.ts decideNudge." }] }).ok).toBe(true);
    expect(engine.state.tree.live()[0]!.manifest!.symbols).toEqual(["decideNudge"]);
    push({ role: "assistant", content: "done" });

    // A command naming the folded file, and output mentioning it and the word false, is not work on it.
    push({ role: "user", content: "run the suite" });
    push({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "bun test && grep -n x src/kernel/nudge.ts" } }] });
    push({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "src/kernel/nudge.ts: decideNudge returned false" }] });
    sync();
    expect(engine.hydrationText()).toBeNull();
    expect(engine.recallHintText()).toBeNull();

    // Passing the file as a path argument is.
    push({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/kernel/nudge.ts" } }] });
    sync();
    expect(engine.hydrationText()).toContain("matches: src/kernel/nudge.ts");
  });
});
