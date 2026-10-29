import { describe, expect, it } from "bun:test";
import { EMPTY_MANIFEST, extractManifest, manifestTerms, mergeManifests, parseManifest } from "../src/kernel/manifest.ts";

describe("extractManifest", () => {
  it("extracts paths, symbols, errors, commits and tools; URLs are not paths", () => {
    const m = extractManifest([
      { role: "user", text: "Look at src/kernel/nudge.ts:83 and https://github.com/a/b.md, especially `decideNudge`.", prose: "Look at src/kernel/nudge.ts:83 and https://github.com/a/b.md, especially `decideNudge`.", isError: false },
      { role: "assistant", text: 'read {"path":"src/kernel/nudge.ts"}', prose: "", isError: false, toolCalls: [{ id: "c1", name: "read", arguments: { path: "src/kernel/nudge.ts" } }] },
      { role: "toolResult", text: "ok line\nFAIL   tests/x.test.ts > decides\n[master 3b038b3] fix", prose: "", isError: true },
    ]);
    expect(m).toEqual({
      paths: ["src/kernel/nudge.ts"],
      symbols: ["decideNudge"],
      errors: ["FAIL tests/x.test.ts > decides"],
      commits: ["3b038b3"],
      tools: ["read"],
    });
    expect(manifestTerms(m)).toEqual(["src/kernel/nudge.ts", "decideNudge", "FAIL tests/x.test.ts > decides", "3b038b3"]);
  });
  it("excludes successful tool output and captures explicit failed results", () => {
    const m = extractManifest([
      { role: "assistant", text: "tool", prose: "", isError: false, toolCalls: [{ id: "c1", name: "read", arguments: { nested: { path: "src/nested.ts" } } }] },
      { role: "toolResult", text: 'import { Error } from "../errors.ts"\nFAILED but successful output', prose: "", isError: false },
      { role: "toolResult", text: "panic: bad state in tmp/failure.log", prose: "", isError: true },
      { role: "toolResult", text: "command failed without marker", prose: "", isError: true },
    ]);
    expect(m.paths).toEqual(["src/nested.ts"]);
    expect(m.errors).toEqual(["panic: bad state in tmp/failure.log", "command failed without marker"]);
  });


  it("caps each field and doubles the caps on merge", () => {
    const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join(" ");
    const a = extractManifest([{ role: "user", text: many(50, (i) => `dir/a${String(i).padStart(2, "0")}.ts`), prose: many(50, (i) => `dir/a${String(i).padStart(2, "0")}.ts`), isError: false }]);
    const b = extractManifest([{ role: "user", text: many(50, (i) => `dir/b${String(i).padStart(2, "0")}.ts`), prose: many(50, (i) => `dir/b${String(i).padStart(2, "0")}.ts`), isError: false }]);
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
