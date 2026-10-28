import { describe, expect, it } from "bun:test";
import { decodeImageDims, estimateImageBlockTokens, pixelTileEstimate } from "../src/kernel/image-tokens.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { TokenLedger } from "../src/kernel/tokens.ts";

describe("Vision & Thinking Token Realism (Billion-Context #488, #767, #1320, #1843)", () => {
  it("calculates realistic tile tokens for different image dimensions", () => {
    // 512x512: short side scaled to 768 -> 768x768 -> 2x2 = 4 tiles -> 85 + 170*4 = 765 tokens
    expect(pixelTileEstimate(512, 512)).toBe(765);

    // 1920x1080 (1080p): 4x3 = 12 tiles -> 85 + 170*12 = 2125 tokens
    expect(pixelTileEstimate(1920, 1080)).toBe(2125);

    // Capped long side 4096x2048 -> long side capped to 2048, short side 1024 -> 4x2 = 8 tiles -> 85 + 170*8 = 1445 tokens
    expect(pixelTileEstimate(4096, 2048)).toBe(1445);
  });

  it("decodes PNG dimensions from leading bytes", () => {
    // Build a minimal 24-byte PNG header: 8-byte magic + 4-byte chunk len + "IHDR" + 4-byte width (800) + 4-byte height (600)
    const buf = Buffer.alloc(24);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
    buf.write("IHDR", 12, "ascii");
    buf.writeUInt32BE(800, 16);
    buf.writeUInt32BE(600, 20);

    const b64 = buf.toString("base64");
    const dims = decodeImageDims(b64);
    expect(dims).toEqual({ w: 800, h: 600 });
  });

  it("populates imageTokens on KernelMessage and ledger reflects image cost", () => {
    // 1920x1080 PNG header
    const buf = Buffer.alloc(24);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    buf.writeUInt32BE(1920, 16);
    buf.writeUInt32BE(1080, 20);
    const b64 = buf.toString("base64");

    const rawMessage = {
      role: "user",
      content: [
        { type: "text", text: "Look at this screenshot:" },
        { type: "image", data: b64, mimeType: "image/png" },
      ],
    };

    const kMsg = messageFacts(rawMessage);
    expect(kMsg).not.toBeNull();
    expect(kMsg?.imageTokens).toBe(2125);

    const ledger = new TokenLedger("claude-3-7-sonnet", null);
    const tokens = ledger.countMessage(kMsg!);
    // Message overhead (4) + text tokens (~7) + vision tokens (2125) >= 2130
    expect(tokens).toBeGreaterThan(2130);
  });

  it("accurately counts tokens in thinking and redacted_thinking blocks", () => {
    const rawThinkingMsg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me think about how to refactor this architecture carefully.\n".repeat(20) },
        { type: "text", text: "Here is the plan." },
      ],
    };

    const kMsg = messageFacts(rawThinkingMsg);
    expect(kMsg).not.toBeNull();
    const ledger = new TokenLedger("claude-3-7-sonnet", null);
    const tokens = ledger.countMessage(kMsg!);
    // 20 repetitions of thinking string should be hundreds of tokens
    expect(tokens).toBeGreaterThan(250);

    const rawRedactedMsg = {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "a".repeat(4000) },
        { type: "text", text: "Done." },
      ],
    };
    const kRedacted = messageFacts(rawRedactedMsg);
    expect(kRedacted).not.toBeNull();
    const redactedTokens = ledger.countMessage(kRedacted!);
    // 4000 chars of encrypted data should be ~1000 tokens
    expect(redactedTokens).toBeGreaterThan(950);
  });
});
