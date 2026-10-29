/**
 * Benchmark scenarios across 4 modes and 4 context intensity scales:
 *
 * Modes:
 * 1. "programming": Build a feature-rich Pac-Man game in HTML/Canvas/JS.
 * 2. "research": Security audit of a pre-seeded codebase with planted vulnerabilities.
 * 3. "general": Long single session covering refactoring, documentation, and features.
 * 4. "memory": Factual needles planted early with recall probes evaluated across turns.
 *
 * Scales:
 * - low:    20 turns
 * - medium: 60 turns
 * - high:   150 turns
 * - insane: 300 turns
 */

import { Sandbox } from "./sandbox.ts";

export type ScenarioMode = "programming" | "research" | "general" | "memory";
export type ContextScale = "low" | "medium" | "high" | "insane";

export const SCALE_TURNS: Record<ContextScale, number> = {
  low: 20,
  medium: 60,
  high: 150,
  insane: 300
};

export interface ScenarioTurn {
  turnIndex: number;
  userMessage: string;
  isProbe?: boolean;
  probeId?: string;
  expectedKeywords?: string[];
}

export interface ScenarioRubricItem {
  id: string;
  name: string;
  weight: number;
  check: (sandbox: Sandbox, finalReport?: string) => boolean;
}

export interface ScenarioDefinition {
  mode: ScenarioMode;
  title: string;
  systemTaskBrief: string;
  seedWorkspace: (sandbox: Sandbox) => void;
  generateTurns: (scale: ContextScale) => ScenarioTurn[];
  rubric: ScenarioRubricItem[];
  verifyWorkspace: (sandbox: Sandbox) => string;
}

// ============================================================================
// 1. Programming Mode: Feature-Rich Pac-Man Game
// ============================================================================

const PACMAN_FEATURES = [
  { id: "canvas", name: "Canvas & Game Loop", kw: ["canvas", "requestAnimationFrame"] },
  { id: "maze", name: "Maze Grid & Walls", kw: ["maze", "grid", "wall", "map"] },
  { id: "pacman", name: "Pac-Man Entity & Movement", kw: ["pacman", "direction", "move", "speed"] },
  { id: "pellets", name: "Pellet Eating & Scoring", kw: ["pellet", "dot", "score"] },
  { id: "power-pellets", name: "Power Pellets & Energizer", kw: ["power", "energizer", "frightened", "blue"] },
  { id: "ghost-blinky", name: "Blinky Ghost AI (Shadow/Chaser)", kw: ["blinky", "red", "target", "chase"] },
  { id: "ghost-pinky", name: "Pinky Ghost AI (Speedy/Ambusher)", kw: ["pinky", "pink", "ambush", "ahead"] },
  { id: "ghost-inky", name: "Inky Ghost AI (Bashful/Flanker)", kw: ["inky", "cyan", "flank", "vector"] },
  { id: "ghost-clyde", name: "Clyde Ghost AI (Pokey/Wanderer)", kw: ["clyde", "orange", "distance", "scatter"] },
  { id: "lives", name: "Lives & Respawn System", kw: ["lives", "death", "respawn", "reset"] },
  { id: "levels", name: "Level Progression & Speedup", kw: ["level", "nextLevel", "difficulty", "clear"] },
  { id: "high-score", name: "High Score & LocalStorage", kw: ["localStorage", "highScore", "best"] },
  { id: "audio", name: "Sound Effects (Web Audio API)", kw: ["AudioContext", "sound", "beep", "sfx"] },
  { id: "controls", name: "Arrow Keys & WASD Controls", kw: ["ArrowUp", "ArrowDown", "KeyW", "KeyA", "addEventListener"] },
  { id: "game-over", name: "Game Over & Victory Screens", kw: ["game over", "win", "victory", "restart"] }
];

export const programmingScenario: ScenarioDefinition = {
  mode: "programming",
  title: "Pac-Man Feature-Rich Arcade Game",
  systemTaskBrief: [
    "You are an expert game developer building a complete, feature-rich Pac-Man arcade game in the workspace.",
    "Deliver a playable HTML/Canvas/JS implementation across `index.html`, `game.js`, and `style.css`.",
    "Implement core game loop, maze grid, tile collision, Pac-Man animation, all four ghost AI personalities (Blinky, Pinky, Inky, Clyde),",
    "pellets, power pellets with frightened mode, score tracking, high score via localStorage, levels, and controls."
  ].join(" "),

  seedWorkspace(sandbox: Sandbox): void {
    sandbox.write(
      "README.md",
      `# Pac-Man Project\n\nBuild a complete HTML5 Canvas Pac-Man game with full ghost AI, scoring, and levels.\n`
    );
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const turns: ScenarioTurn[] = [
      {
        turnIndex: 1,
        userMessage: "Let's build a feature-rich Pac-Man arcade game. Start by creating `index.html`, `style.css`, and the core `game.js` canvas setup with maze grid rendering."
      }
    ];

    const milestones = [
      "Now add Pac-Man player controls (arrow keys and WASD) with smooth tile-aligned movement and collision against maze walls.",
      "Add pellets and power pellets scattered through the maze corridors. Pac-Man should eat them to increase score.",
      "Implement the four ghost personalities: Blinky (direct chase), Pinky (ambush ahead), Inky (flanking vector), and Clyde (scatter when close).",
      "Add Power Pellet frightened mode: ghosts turn blue, become vulnerable to being eaten, and yield bonus points.",
      "Implement player lives (3 lives), death animation, ghost respawn chamber, and game over screen.",
      "Add level progression: clearing all pellets advances to the next level with increased ghost speed.",
      "Add local storage high-score persistence and visual score/lives HUD.",
      "Add Web Audio API sound effects for waka-waka pellet chomping, ghost eating, and game start.",
      "Optimize rendering and add touch/swipe controls for mobile support alongside keyboard controls."
    ];

    for (let t = 2; t <= totalTurns; t++) {
      // Intersperse milestone instructions and refinement turns
      const milestoneIdx = (t - 2) % milestones.length;
      const basePrompt = milestones[milestoneIdx]!;
      const variation = t > milestones.length ? ` (Pass ${Math.floor((t - 2) / milestones.length) + 1} polish and bugfix)` : "";

      // Probe at 50% and 90% turn intervals
      const isProbe = t === Math.floor(totalTurns * 0.5) || t === Math.floor(totalTurns * 0.9);
      if (isProbe) {
        turns.push({
          turnIndex: t,
          userMessage: "Recall check: In turn 1, what exact core files were we instructed to create for this project?",
          isProbe: true,
          probeId: `pacman-files-turn-${t}`,
          expectedKeywords: ["index.html", "game.js", "style.css"]
        });
      } else {
        turns.push({
          turnIndex: t,
          userMessage: `${basePrompt}${variation}`
        });
      }
    }

    return turns;
  },

  rubric: PACMAN_FEATURES.map((feat) => ({
    id: feat.id,
    name: feat.name,
    weight: 1,
    check: (sandbox: Sandbox) => {
      try {
        const js = sandbox.read("game.js");
        const lower = js.toLowerCase();
        return feat.kw.some((k) => lower.includes(k.toLowerCase()));
      } catch {
        return false;
      }
    }
  })),

  verifyWorkspace(sandbox: Sandbox): string {
    const results: string[] = [];
    for (const feat of PACMAN_FEATURES) {
      let passed = false;
      try {
        const js = sandbox.read("game.js").toLowerCase();
        passed = feat.kw.some((k) => js.includes(k.toLowerCase()));
      } catch {}
      results.push(`[${passed ? "x" : " "}] ${feat.name}`);
    }
    return `Pac-Man Feature Checklist:\n${results.join("\n")}`;
  }
};

// ============================================================================
// 2. Research Mode: Vulnerability Research & Security Audit
// ============================================================================

const PLANTED_VULNS = [
  { id: "vuln-sql", name: "SQL Injection in User Search", file: "src/db/users.js", kw: ["sql", "injection", "query", "raw", "concatenate"] },
  { id: "vuln-traversal", name: "Path Traversal in File Downloader", file: "src/api/files.js", kw: ["traversal", "path", "../", "arbitrary"] },
  { id: "vuln-rce", name: "Command Injection in Image Converter", file: "src/utils/media.js", kw: ["command", "exec", "injection", "spawn"] },
  { id: "vuln-secret", name: "Hardcoded API Key and JWT Secret", file: "src/config/auth.js", kw: ["hardcoded", "secret", "jwt", "key"] },
  { id: "vuln-xss", name: "Stored XSS in Comment Handler", file: "src/api/comments.js", kw: ["xss", "script", "escape", "sanitize"] },
  { id: "vuln-auth", name: "Broken Object Level Authorization (BOLA)", file: "src/api/orders.js", kw: ["bola", "idor", "authorization", "ownership"] }
];

export const researchScenario: ScenarioDefinition = {
  mode: "research",
  title: "Application Security Vulnerability Audit",
  systemTaskBrief: [
    "You are a principal security engineer conducting a thorough code audit of a web application in the workspace.",
    "Examine all source files in `src/`, identify planted vulnerabilities, analyze exploitability, and compile an executive security report `AUDIT_REPORT.md`.",
    "For each finding, specify the vulnerable file, root cause, severity, proof of concept, and exact remediation patch."
  ].join(" "),

  seedWorkspace(sandbox: Sandbox): void {
    sandbox.write("README.md", "# Internal Microservice\nAuditing repository for security readiness.\n");

    sandbox.write(
      "src/db/users.js",
      `// User repository\nfunction searchUsers(term) {\n  const query = "SELECT * FROM users WHERE name LIKE '%" + term + "%';";\n  return db.executeRaw(query);\n}\nmodule.exports = { searchUsers };\n`
    );

    sandbox.write(
      "src/api/files.js",
      `// File download endpoint\nconst fs = require('fs');\nconst path = require('path');\nfunction downloadFile(req, res) {\n  const filename = req.query.name;\n  const filePath = path.join('/var/app/uploads', filename);\n  res.sendFile(filePath);\n}\nmodule.exports = { downloadFile };\n`
    );

    sandbox.write(
      "src/utils/media.js",
      `// Image conversion\nconst { exec } = require('child_process');\nfunction convertImage(inputPath, format) {\n  exec("convert " + inputPath + " out." + format, (err) => {});\n}\nmodule.exports = { convertImage };\n`
    );

    sandbox.write(
      "src/config/auth.js",
      `// Auth config\nmodule.exports = {\n  JWT_SECRET: "super-secret-production-signing-key-998811",\n  AWS_SECRET_KEY: "AKIAIOSFODNN7EXAMPLE_SECRET_DO_NOT_LEAK"\n};\n`
    );

    sandbox.write(
      "src/api/comments.js",
      `// Comments endpoint\nfunction renderComment(comment) {\n  return "<div class='comment'>" + comment.body + "</div>";\n}\nmodule.exports = { renderComment };\n`
    );

    sandbox.write(
      "src/api/orders.js",
      `// Orders endpoint\nfunction getOrder(req, res) {\n  const orderId = req.params.id;\n  const order = db.findOrder(orderId);\n  // Missing user ownership check!\n  return res.json(order);\n}\nmodule.exports = { getOrder };\n`
    );
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const turns: ScenarioTurn[] = [
      {
        turnIndex: 1,
        userMessage: "Begin the security audit. Use `list_files` and `grep` to inspect `src/` and map the attack surface."
      }
    ];

    const tasks = [
      "Analyze `src/db/users.js` for data access flaws and injection vulnerabilities.",
      "Inspect `src/api/files.js` and analyze file system interactions and path validation.",
      "Review `src/utils/media.js` for command execution vulnerabilities and child process safety.",
      "Check `src/config/auth.js` for credential handling and hardcoded secrets.",
      "Inspect `src/api/comments.js` for cross-site scripting and template injection.",
      "Review `src/api/orders.js` for authorization and access control bypasses.",
      "Write initial findings and proof-of-concept exploits into `AUDIT_REPORT.md`.",
      "Draft remediation diffs and secure coding recommendations for each identified vulnerability."
    ];

    for (let t = 2; t <= totalTurns; t++) {
      const taskIdx = (t - 2) % tasks.length;
      const prompt = tasks[taskIdx]!;

      const isProbe = t === Math.floor(totalTurns * 0.5) || t === Math.floor(totalTurns * 0.85);
      if (isProbe) {
        turns.push({
          turnIndex: t,
          userMessage: "Recall check: What hardcoded JWT_SECRET was configured in `src/config/auth.js`?",
          isProbe: true,
          probeId: `vuln-jwt-secret-turn-${t}`,
          expectedKeywords: ["super-secret-production-signing-key-998811"]
        });
      } else {
        turns.push({
          turnIndex: t,
          userMessage: prompt
        });
      }
    }

    return turns;
  },

  rubric: PLANTED_VULNS.map((vuln) => ({
    id: vuln.id,
    name: vuln.name,
    weight: 1,
    check: (sandbox: Sandbox) => {
      try {
        const report = sandbox.read("AUDIT_REPORT.md").toLowerCase();
        return vuln.kw.some((k) => report.includes(k.toLowerCase()));
      } catch {
        return false;
      }
    }
  })),

  verifyWorkspace(sandbox: Sandbox): string {
    const results: string[] = [];
    for (const v of PLANTED_VULNS) {
      let found = false;
      try {
        const report = sandbox.read("AUDIT_REPORT.md").toLowerCase();
        found = v.kw.some((k) => report.includes(k.toLowerCase()));
      } catch {}
      results.push(`[${found ? "x" : " "}] ${v.name}`);
    }
    return `Security Audit Findings:\n${results.join("\n")}`;
  }
};

// ============================================================================
// 3. General Mode: Long Single Session
// ============================================================================

export const generalScenario: ScenarioDefinition = {
  mode: "general",
  title: "General Software Engineering Session",
  systemTaskBrief: [
    "You are an autonomous senior engineer managing a production TypeScript library.",
    "Perform code migrations, write modular features, maintain architectural documentation, and verify changes across turns."
  ].join(" "),

  seedWorkspace(sandbox: Sandbox): void {
    sandbox.write("package.json", JSON.stringify({ name: "core-lib", version: "1.0.0" }, null, 2));
    sandbox.write("src/index.ts", `export function calculate(a: number, b: number): number {\n  return a + b;\n}\n`);
    sandbox.write("docs/ARCHITECTURE.md", `# System Architecture\nInitial architecture specification.\n`);
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const turns: ScenarioTurn[] = [
      {
        turnIndex: 1,
        userMessage: "Initialize the project. Add input validation and division/multiplication operations in `src/index.ts`."
      }
    ];

    const tasks = [
      "Add matrix math functions `matrixAdd` and `matrixMultiply` in `src/matrix.ts`.",
      "Document matrix operations in `docs/ARCHITECTURE.md` with usage examples.",
      "Add input vector validation in `src/validate.ts`.",
      "Add unit tests in `tests/matrix.test.ts`.",
      "Refactor error handling to use custom `MathError` class in `src/errors.ts`.",
      "Update `package.json` to export submodules.",
      "Profile matrix performance and add sparse matrix representation in `src/sparse.ts`."
    ];

    for (let t = 2; t <= totalTurns; t++) {
      const taskIdx = (t - 2) % tasks.length;
      const prompt = tasks[taskIdx]!;

      const isProbe = t === Math.floor(totalTurns * 0.5) || t === Math.floor(totalTurns * 0.9);
      if (isProbe) {
        turns.push({
          turnIndex: t,
          userMessage: "Recall check: In turn 1, what project was initialized in `package.json`?",
          isProbe: true,
          probeId: `general-pkg-turn-${t}`,
          expectedKeywords: ["core-lib", "1.0.0"]
        });
      } else {
        turns.push({
          turnIndex: t,
          userMessage: prompt
        });
      }
    }

    return turns;
  },

  rubric: [
    {
      id: "matrix-math",
      name: "Matrix Module Created",
      weight: 1,
      check: (sandbox) => sandbox.exists("src/matrix.ts")
    },
    {
      id: "architecture-docs",
      name: "Architecture Documentation Updated",
      weight: 1,
      check: (sandbox) => {
        try {
          return sandbox.read("docs/ARCHITECTURE.md").length > 100;
        } catch {
          return false;
        }
      }
    },
    {
      id: "unit-tests",
      name: "Unit Tests Added",
      weight: 1,
      check: (sandbox) => sandbox.exists("tests/matrix.test.ts")
    }
  ],

  verifyWorkspace(sandbox: Sandbox): string {
    const m = sandbox.exists("src/matrix.ts");
    const d = sandbox.exists("docs/ARCHITECTURE.md");
    const t = sandbox.exists("tests/matrix.test.ts");
    return `General Tasks Status:\n[${m ? "x" : " "}] Matrix Module\n[${d ? "x" : " "}] Architecture Docs\n[${t ? "x" : " "}] Unit Tests`;
  }
};

// ============================================================================
// 4. Memory Mode: Factual Needle Recall Over Long Horizon
// ============================================================================

const MEMORY_NEEDLES = [
  { turn: 1, fact: "The staging database port is 9432 and replica password is 'Krypton-7729-Beta'.", key: "replica-password", answer: ["9432", "Krypton-7729-Beta"] },
  { turn: 2, fact: "Architectural invariant: all API responses must include header 'X-Origin-Zone: eu-west-1a'.", key: "header-invariant", answer: ["X-Origin-Zone", "eu-west-1a"] },
  { turn: 3, fact: "The deprecation date for v1 endpoints is set to 2027-04-15 by user directive.", key: "deprecation-date", answer: ["2027-04-15"] }
];

export const memoryScenario: ScenarioDefinition = {
  mode: "memory",
  title: "Long-Session Factual Needle Recall",
  systemTaskBrief: [
    "You are an assistant managing a long-running project maintenance session.",
    "Remember critical architectural facts, deployment parameters, and directives provided in earlier turns while executing maintenance tasks."
  ].join(" "),

  seedWorkspace(sandbox: Sandbox): void {
    sandbox.write("README.md", "# Memory Recall Test Project\n");
    sandbox.write("src/service.ts", "// Service code\nexport function start() { return true; }\n");
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const turns: ScenarioTurn[] = [];

    // Turns 1-3: Plant factual needles
    turns.push({
      turnIndex: 1,
      userMessage: `Notice for our configuration: ${MEMORY_NEEDLES[0]!.fact} Please update README.md with this setup note.`
    });
    turns.push({
      turnIndex: 2,
      userMessage: `Notice: ${MEMORY_NEEDLES[1]!.fact} Implement this in src/service.ts.`
    });
    turns.push({
      turnIndex: 3,
      userMessage: `Directive: ${MEMORY_NEEDLES[2]!.fact} Document this in README.md.`
    });

    const fillerTasks = [
      "Refactor src/service.ts to use dependency injection.",
      "Add a healthcheck endpoint returning status ok.",
      "Add rate limiting middleware in src/rate-limit.ts.",
      "Write unit tests for the healthcheck.",
      "Add logging interceptor in src/logger.ts.",
      "Update README.md with build and test instructions."
    ];

    for (let t = 4; t <= totalTurns; t++) {
      // Probes at 35%, 65%, 95% intervals
      if (t === Math.floor(totalTurns * 0.35)) {
        turns.push({
          turnIndex: t,
          userMessage: "Recall check: What is the staging database port and replica password given in turn 1?",
          isProbe: true,
          probeId: "needle-staging-replica",
          expectedKeywords: MEMORY_NEEDLES[0]!.answer
        });
      } else if (t === Math.floor(totalTurns * 0.65)) {
        turns.push({
          turnIndex: t,
          userMessage: "Recall check: What exact header and value must all API responses include?",
          isProbe: true,
          probeId: "needle-header-invariant",
          expectedKeywords: MEMORY_NEEDLES[1]!.answer
        });
      } else if (t === Math.floor(totalTurns * 0.95)) {
        turns.push({
          turnIndex: t,
          userMessage: "Recall check: What is the exact deprecation date set for v1 endpoints?",
          isProbe: true,
          probeId: "needle-deprecation-date",
          expectedKeywords: MEMORY_NEEDLES[2]!.answer
        });
      } else {
        const idx = (t - 4) % fillerTasks.length;
        turns.push({
          turnIndex: t,
          userMessage: fillerTasks[idx]!
        });
      }
    }

    return turns;
  },

  rubric: MEMORY_NEEDLES.map((n) => ({
    id: n.key,
    name: `Recall Needle: ${n.key}`,
    weight: 1,
    check: () => true // Scored via probe responses
  })),

  verifyWorkspace(): string {
    return "Memory scenario: evaluated via recall probe accuracy.";
  }
};

export const SCENARIO_REGISTRY: Record<ScenarioMode, ScenarioDefinition> = {
  programming: programmingScenario,
  research: researchScenario,
  general: generalScenario,
  memory: memoryScenario
};
