// Preloaded before any test module (bunfig.toml). The extension opens
// `getAgentDir()/origami.db`; without this, tests would migrate and write the
// user's real ~/.omp/agent/origami.db while a live omp may hold it open.
// pi-utils resolves the agent dir at import time, so this must run first.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const agentDir = mkdtempSync(join(tmpdir(), "origami-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// Global hook: in a preload file it runs once, after every test file.
afterAll(() => {
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // Windows asynchronous file handle release
  }
});
