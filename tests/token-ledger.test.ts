import { describe, expect, it } from "bun:test";
import { TokenLedger } from "../src/kernel/tokens.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

function message(text: string, hash: string): KernelMessage {
  return { role: "user", contentHash: hash, signedThinking: false, text, prose: text, isError: false, bytes: text.length };
}

describe("TokenLedger", () => {
  it("counts a message consistently and memoizes by content hash", () => {
    const ledger = new TokenLedger("test", null);
    const msg = message("hello world", "h1");
    const first = ledger.countMessage(msg);
    const again = ledger.countMessage(message("hello world", "h1"));
    expect(again).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  it("does not retain message bodies in the memo", () => {
    const ledger = new TokenLedger("test", null);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2_000; i++) {
      // Fresh 4 KB body per iteration: nothing but the memo could keep it alive.
      ledger.countMessage(message("x".repeat(4_000) + i, `h${i}`));
    }
    Bun.gc(true);
    const retained = process.memoryUsage().heapUsed - before;

    // 2,000 × 4 KB = 8 MB of input; a text-keyed memo retains nearly all of it.
    expect(retained).toBeLessThan(2 * 1024 * 1024);
  });

  it("keeps distinct texts distinct", () => {
    const ledger = new TokenLedger("test", null);
    expect(ledger.countText("a".repeat(1_000))).toBe(250);
    expect(ledger.countText("b".repeat(1_600))).toBe(400);
  });
});
