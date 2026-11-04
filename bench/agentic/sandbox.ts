/**
 * Sandboxed in-memory filesystem for agentic benchmark runs.
 *
 * All tool-visible filesystem operations (read, write, replace/edit, list, grep)
 * execute strictly within an isolated in-memory `memfs` volume per run. The
 * volume is NOT unioned with the host filesystem, guaranteeing that benchmark
 * tools cannot access host files, nor follow host symlinks or junctions to escape.
 *
 * NOTE ON CODE EXECUTION:
 * While `Sandbox` isolates tool filesystem operations from the host, `memfs`
 * does NOT provide OS-level or process-level isolation for running arbitrary
 * untrusted code. Any actual execution of model-generated code (e.g. browser
 * tests, Playwright, or test suites) MUST run in an isolated execution environment
 * such as an unprivileged, network-disabled container or isolated subprocess boundary.
 *
 * Existing configurable `workspaceDir` serves as the input/output contract:
 * - Initialization: If `workspaceDir` exists on host, `importFromDisk` imports
 *   normal files into `memfs`, skipping host symlinks and junctions.
 * - Export: `exportToDisk` safely materializes the in-memory files to host disk
 *   or an evaluation root, refusing to write through host symlinks.
 * - Snapshot: `getSnapshot()` provides memory-safe exports for evaluation.
 */

import {
  existsSync as hostExistsSync,
  lstatSync as hostLstatSync,
  mkdirSync as hostMkdirSync,
  readFileSync as hostReadFileSync,
  readdirSync as hostReaddirSync,
  writeFileSync as hostWriteFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { Volume } from "memfs";

export class SandboxEscapeError extends Error {
  constructor(path: string) {
    super(`path escapes sandbox workspace: ${path}`);
    this.name = "SandboxEscapeError";
  }
}

export class SandboxIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxIoError";
  }
}

/** Hard ceiling on bytes any single tool result may return to the model. */
export const TOOL_RESULT_LIMIT = 24_000;

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

function clip(text: string, limit = TOOL_RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated: ${text.length - limit} more characters]`;
}

export class Sandbox {
  readonly root: string;
  readonly vol: InstanceType<typeof Volume>;
  private readonly modified = new Set<string>();
  private readonly importedHashes = new Map<string, string>();

  constructor(root: string) {
    this.root = resolve(root);
    this.vol = new Volume();
    this.vol.mkdirSync(this.root, { recursive: true });

    if (hostExistsSync(this.root)) {
      this.importFromDisk(this.root);
    }
  }

  /** Resolve a tool-supplied path, rejecting anything outside the workspace. */
  resolvePath(p: string): string {
    const raw = (p ?? "").trim();
    if (raw.length === 0) throw new SandboxIoError("path must not be empty");
    if (raw.includes("\0")) throw new SandboxIoError("path contains NUL byte");

    // Reject UNC and Windows device paths
    if (raw.startsWith("\\\\") || raw.startsWith("//")) {
      throw new SandboxEscapeError(raw);
    }
    if (process.platform !== "win32" && (win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw))) {
      throw new SandboxEscapeError(raw);
    }
    // Reject Windows drive-relative paths (e.g. "C:file.txt")
    if (/^[a-zA-Z]:[^\\/]/.test(raw)) {
      throw new SandboxEscapeError(raw);
    }
    const target = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw);
    const rel = relative(this.root, target);

    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
      return target;
    }
    if (rel.length === 0) {
      return target;
    }
    throw new SandboxEscapeError(raw);
  }

  /** True when `p` resolves inside the workspace. */
  contains(p: string): boolean {
    try {
      this.resolvePath(p);
      return true;
    } catch {
      return false;
    }
  }

  /** True when `p` resolves inside the workspace AND exists in the in-memory volume. */
  exists(p: string): boolean {
    try {
      const target = this.resolvePath(p);
      return this.vol.existsSync(target);
    } catch {
      return false;
    }
  }

  /** Read a file from the sandboxed in-memory filesystem. */
  read(p: string, offset = 0, limit?: number): string {
    const target = this.resolvePath(p);
    if (!this.vol.existsSync(target)) throw new SandboxIoError(`no such file: ${p}`);

    const st = this.vol.statSync(target);
    if (st.isDirectory()) throw new SandboxIoError(`is a directory: ${p}`);

    const rawContent = this.vol.readFileSync(target, "utf8") as string;
    const lines = rawContent.split("\n");
    const start = Math.max(0, offset);
    const end = limit !== undefined ? Math.min(lines.length, start + limit) : lines.length;
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`)
      .join("\n");
    return clip(`# ${p} (lines ${start + 1}-${end} of ${lines.length})\n${body}`);
  }

  /** Write a file to the sandboxed in-memory filesystem. */
  write(p: string, content: string): { path: string; bytes: number; lines: number } {
    const target = this.resolvePath(p);
    const previous = this.vol.existsSync(target) ? this.vol.readFileSync(target, "utf8") as string : undefined;
    this.vol.mkdirSync(dirname(target), { recursive: true });
    this.vol.writeFileSync(target, content, { encoding: "utf8" });
    if (previous !== content) this.modified.add(relative(this.root, target).split("\\").join("/"));
    return { path: p, bytes: Buffer.byteLength(content, "utf8"), lines: content.split("\n").length };
  }

  /** Replace the single occurrence of `oldText` with `newText`. Ambiguity is an error. */
  replace(p: string, oldText: string, newText: string): { path: string; occurrences: number } {
    const target = this.resolvePath(p);
    if (!this.vol.existsSync(target)) throw new SandboxIoError(`no such file: ${p}`);

    const source = this.vol.readFileSync(target, "utf8") as string;
    const occurrences = source.split(oldText).length - 1;
    if (occurrences === 0) throw new SandboxIoError(`old text not found in ${p}`);
    if (occurrences > 1) {
      throw new SandboxIoError(
        `old text is ambiguous in ${p} (${occurrences} matches); narrow the search text`
      );
    }

    const updated = source.replace(oldText, newText);
    this.vol.writeFileSync(target, updated, { encoding: "utf8" });
    if (updated !== source) this.modified.add(relative(this.root, target).split("\\").join("/"));
    return { path: p, occurrences };
  }

  /** List directory contents within the in-memory volume. */
  list(p = "."): string {
    const target = this.resolvePath(p);
    if (!this.vol.existsSync(target)) throw new SandboxIoError(`no such directory: ${p}`);

    const rows: string[] = [];
    const rootSt = this.vol.statSync(target);
    const visitedInodes = new Set<number>([Number(rootSt.ino)]);

    const walk = (dir: string) => {
      if (rows.length > 400) return;
      const entries = (this.vol.readdirSync(dir) as string[]).sort();
      for (const name of entries) {
        if (rows.length > 400) return;
        const child = join(dir, name);
        const rel = relative(this.root, child).split("\\").join("/");
        const lst = this.vol.lstatSync(child);
        if (lst.isSymbolicLink()) {
          let st;
          try {
            st = this.vol.statSync(child);
          } catch {
            continue;
          }
          const ino = Number(st.ino);
          if (st.isDirectory()) {
            if (visitedInodes.has(ino)) {
              rows.push(`${rel}/ -> [cycle]`);
              continue;
            }
            visitedInodes.add(ino);
            rows.push(`${rel}/`);
            walk(child);
            visitedInodes.delete(ino);
          } else {
            rows.push(`${rel}  (${st.size} bytes)`);
          }
          continue;
        }
        const ino = Number(lst.ino);
        if (lst.isDirectory()) {
          visitedInodes.add(ino);
          rows.push(`${rel}/`);
          walk(child);
          visitedInodes.delete(ino);
        } else {
          rows.push(`${rel}  (${lst.size} bytes)`);
        }
      }
    };

    if (rootSt.isDirectory()) {
      walk(target);
    } else {
      rows.push(`${relative(this.root, target).split("\\").join("/")}  (${rootSt.size} bytes)`);
    }

    return clip(rows.length > 0 ? rows.join("\n") : "(empty)");
  }

  /** Search text matching regex across files in the in-memory volume. */
  grep(pattern: string, p = "."): string {
    const regex = new RegExp(pattern, "i");
    const target = this.resolvePath(p);
    if (!this.vol.existsSync(target)) throw new SandboxIoError(`no such file or directory: ${p}`);

    const matches: GrepMatch[] = [];
    const rootSt = this.vol.statSync(target);
    const visitedInodes = new Set<number>([Number(rootSt.ino)]);

    const walk = (dir: string) => {
      if (matches.length >= 200) return;
      const entries = (this.vol.readdirSync(dir) as string[]).sort();
      for (const name of entries) {
        if (matches.length >= 200) return;
        const child = join(dir, name);
        const lst = this.vol.lstatSync(child);
        if (lst.isSymbolicLink()) {
          let st;
          try {
            st = this.vol.statSync(child);
          } catch {
            continue;
          }
          const ino = Number(st.ino);
          if (st.isDirectory() && !visitedInodes.has(ino)) {
            visitedInodes.add(ino);
            walk(child);
            visitedInodes.delete(ino);
          }
          continue;
        }
        const ino = Number(lst.ino);
        if (lst.isDirectory()) {
          visitedInodes.add(ino);
          walk(child);
          visitedInodes.delete(ino);
          continue;
        }
        if (lst.size > 2_000_000) continue;
        const rel = relative(this.root, child).split("\\").join("/");
        const lines = (this.vol.readFileSync(child, "utf8") as string).split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            matches.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 300) });
            if (matches.length >= 200) return;
          }
        }
      }
    };

    if (rootSt.isDirectory()) {
      walk(target);
    } else {
      const rel = relative(this.root, target).split("\\").join("/");
      const lines = (this.vol.readFileSync(target, "utf8") as string).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matches.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 300) });
        }
      }
    }

    if (matches.length === 0) return "(no matches)";
    return clip(
      matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") +
        (matches.length >= 200 ? "\n… [match cap reached]" : "")
    );
  }

  /**
   * Safe initialization boundary:
   * Import normal files from a host directory into the in-memory volume.
   * Host symlinks and junctions are explicitly skipped to eliminate escape vectors.
   */
  importFromDisk(sourceDir = this.root): void {
    const hostRoot = resolve(sourceDir);
    if (!hostExistsSync(hostRoot)) return;

    const walkHost = (dir: string) => {
      let entries: string[];
      try {
        entries = hostReaddirSync(dir).sort();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SandboxIoError(`failed to read host directory ${dir}: ${msg}`);
      }

      for (const name of entries) {
        const hostChild = join(dir, name);
        let lst;
        try {
          lst = hostLstatSync(hostChild);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new SandboxIoError(`failed to inspect host path ${hostChild}: ${msg}`);
        }

        // Explicitly skip host symlinks/junctions
        if (lst.isSymbolicLink()) {
          continue;
        }

        if (lst.isDirectory()) {
          walkHost(hostChild);
        } else if (lst.isFile()) {
          const rel = relative(hostRoot, hostChild);
          const memTarget = resolve(this.root, rel);
          try {
            const content = hostReadFileSync(hostChild);
            this.vol.mkdirSync(dirname(memTarget), { recursive: true });
            this.vol.writeFileSync(memTarget, content);
            if (hostRoot === this.root) {
              this.importedHashes.set(rel.split("\\").join("/"), createHash("sha256").update(content).digest("hex"));
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new SandboxIoError(`failed to import file ${hostChild}: ${msg}`);
          }
        }
      }
    };

    const rootSt = hostLstatSync(hostRoot);
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
      throw new SandboxIoError(`workspace root must be a directory, not a symlink: ${hostRoot}`);
    }
    walkHost(hostRoot);
  }

  /**
   * Safe export boundary:
   * Materialize all files from the in-memory volume to a target host directory.
   * Refuses to write through existing host symlinks and validates bounds.
   */
  exportToDisk(targetDir = this.root, options: { overwrite?: boolean; onlyChanged?: boolean } = {}): void {
    const hostTargetRoot = resolve(targetDir);
    const overwrite = options.overwrite ?? true;
    try {
      const rootLst = hostLstatSync(hostTargetRoot);
      if (rootLst.isSymbolicLink()) {
        throw new SandboxIoError(`refusing to export through host symlink: ${hostTargetRoot}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hostMkdirSync(hostTargetRoot, { recursive: true });
    }

    const files = options.onlyChanged ? [...this.modified] : [...this.filePaths(this.root)];
    const targets = files.map((relPath) => {
      const hostDest = resolve(hostTargetRoot, relPath);
      const checkRel = relative(hostTargetRoot, hostDest);
      if (checkRel.startsWith("..") || isAbsolute(checkRel)) {
        throw new SandboxEscapeError(`export target escapes root: ${relPath}`);
      }

      let current = hostDest;
      let destExists = false;
      while (current.length >= hostTargetRoot.length) {
        let stat;
        try {
          stat = hostLstatSync(current);
          if (current === hostDest) destExists = true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (stat?.isSymbolicLink()) {
          throw new SandboxIoError(`refusing to export through host symlink: ${current}`);
        }
        if (current === hostTargetRoot) break;
        current = dirname(current);
      }

      if (destExists && !overwrite) throw new SandboxIoError(`file already exists: ${relPath}`);
      const exists = destExists;
      if (options.onlyChanged && hostTargetRoot === this.root) {
        const original = this.importedHashes.get(relPath);
        const currentHash = exists ? createHash("sha256").update(hostReadFileSync(hostDest)).digest("hex") : undefined;
        if (original !== currentHash) {
          throw new SandboxIoError(`workspace file changed since import: ${relPath}`);
        }
      }
      return { relPath, hostDest };
    });

    for (const { relPath, hostDest } of targets) {
      const content = this.vol.readFileSync(resolve(this.root, relPath)) as Buffer;
      hostMkdirSync(dirname(hostDest), { recursive: true });
      hostWriteFileSync(hostDest, content);
      if (hostTargetRoot === this.root) {
        this.importedHashes.set(relPath, createHash("sha256").update(content).digest("hex"));
        this.modified.delete(relPath);
      }
    }
  }

  /**
   * Return a snapshot dictionary mapping forward-slash workspace-relative paths
   * to their UTF-8 string file contents at any depth.
   */
  getSnapshot(): Record<string, string> {
    const snapshot: Record<string, string> = Object.create(null);
    for (const rel of this.filePaths(this.root)) {
      snapshot[rel] = this.vol.readFileSync(resolve(this.root, rel), "utf8") as string;
    }
    return snapshot;
  }

  private *filePaths(dir: string): Generator<string> {
    for (const name of (this.vol.readdirSync(dir) as string[]).sort()) {
      const child = join(dir, name);
      const st = this.vol.lstatSync(child);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) yield* this.filePaths(child);
      else if (st.isFile()) yield relative(this.root, child).split("\\").join("/");
    }
  }
}
