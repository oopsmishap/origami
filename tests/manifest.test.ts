import { describe, expect, it } from "bun:test";
import { EMPTY_MANIFEST, extractManifest, manifestTerms, mergeManifests, parseManifest } from "../src/kernel/manifest.ts";

describe("extractManifest", () => {
  it("extracts paths, symbols, errors, commits and tools; URLs are not paths", () => {
    const m = extractManifest([
      { role: "user", text: "Look at src/kernel/nudge.ts:83 and https://github.com/a/b.md, especially `decideNudge`." },
      { role: "assistant", text: 'read {"path":"src/kernel/nudge.ts"}', toolCalls: [{ id: "c1", name: "read" }] },
      { role: "toolResult", text: "ok line\nFAIL   tests/x.test.ts > decides\n[master 3b038b3] fix" },
    ]);
    expect(m).toEqual({
      paths: ["src/kernel/nudge.ts", "tests/x.test.ts"],
      symbols: ["decideNudge"],
      errors: ["FAIL tests/x.test.ts > decides"],
      commits: ["3b038b3"],
      tools: ["read"],
    });
    expect(manifestTerms(m)).toEqual(["src/kernel/nudge.ts", "tests/x.test.ts", "decideNudge", "FAIL tests/x.test.ts > decides", "3b038b3"]);
  });

  it("caps each field and doubles the caps on merge", () => {
    const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join(" ");
    const a = extractManifest([{ role: "user", text: many(50, (i) => `dir/a${String(i).padStart(2, "0")}.ts`) }]);
    const b = extractManifest([{ role: "user", text: many(50, (i) => `dir/b${String(i).padStart(2, "0")}.ts`) }]);
    expect(a.paths).toHaveLength(40);
    const merged = mergeManifests([a, b, EMPTY_MANIFEST]);
    expect(merged.paths).toHaveLength(80);
    expect(merged.paths[0]).toBe("dir/a00.ts");
  });

  it("parses persisted manifests and rejects malformed ones", () => {
    expect(parseManifest('{"paths":["a/b.ts"]}')).toEqual({ ...EMPTY_MANIFEST, paths: ["a/b.ts"] });
    expect(parseManifest({ paths: [1] })).toBeUndefined();
    expect(parseManifest("not json")).toBeUndefined();
  });
});
