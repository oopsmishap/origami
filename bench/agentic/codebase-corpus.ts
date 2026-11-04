/**
 * Realistic Large Codebase Corpus Generator for Agentic Context Benchmarks.
 * Generates structured, authentic multi-module software project context
 * (AST parsers, math compute engines, API endpoints, ADRs, database schemas)
 * to seed context windows at 50k, 100k, 150k, or 200k tokens from Turn 1.
 */

import { MEMORY_NEEDLES } from "./scenarios.ts";

export interface CodebaseCorpusOptions {
  targetTokens: number;
  includeNeedles?: boolean;
}

export function generateCodebaseCorpus(targetTokens: number): string {
  if (targetTokens <= 0) return "";

  const sections: string[] = [
    "# PROJECT REPOSITORY CONTEXT & CODEBASE BASELINE",
    "You are working in a large monorepo enterprise software system.",
    "Below is the complete architectural baseline, multi-module source code, API schemas, and architectural decision records (ADRs).",
    "All implementations, configuration keys, database invariants, and system parameters below are authoritative.",
    ""
  ];

  // 1. Architectural Invariants & ADRs with embedded needles
  sections.push(
    "## MODULE 1: ARCHITECTURAL DECISION RECORDS (ADRs)",
    "### ADR-001: Distributed Storage & Database Replica Topology",
    `Status: Accepted | Date: 2026-03-15 | Author: Core Infra Team`,
    `The staging database replica connection configuration is strictly defined as follows:`,
    `- Staging replica database host: ${MEMORY_NEEDLES[0]?.answer[0] ?? "staging-db-replica-01.internal"}`,
    `- Staging replica database port: ${MEMORY_NEEDLES[0]?.answer[1] ?? "5432"}`,
    `- Staging replica database password: ${MEMORY_NEEDLES[0]?.answer[2] ?? "P@ssw0rdReplicaSecure99"}`,
    `- Connection pool min: 10, max: 100, idle timeout: 30000ms.`,
    `- Strict SSL mode required with verified CA certificate authority.`,
    "",
    "### ADR-002: Global Gateway Invariant & Compliance Response Header",
    `Status: Accepted | Date: 2026-04-10 | Author: Security Architecture`,
    `All gateway API responses across all environments must inject the compliance trace header:`,
    `- Header Name: "${MEMORY_NEEDLES[1]?.answer[0] ?? "X-Audit-Compliance-Tag"}"`,
    `- Invariant Value: "${MEMORY_NEEDLES[1]?.answer[1] ?? "iso-27001-secops-enforced"}"`,
    `Any service failing to append this exact header will be rejected by the ingress proxy.`,
    "",
    "### ADR-003: Legacy V1 Deprecation Sunset Schedule",
    `Status: Accepted | Date: 2026-05-20 | Author: API Platform Group`,
    `- Sunset Schedule: ${MEMORY_NEEDLES[2]?.answer.join(" ") ?? "December 31 2026"}`,
    `All client integrations must cut over to /api/v2 before this date.`,
    ""
  );

  // 2. Multi-module Codebase Modules
  const baseModuleTemplates = [
    generateApiModuleCode(),
    generateMatrixComputeCode(),
    generateAstCompilerCode(),
    generateAuthMiddlewareCode(),
    generateDatabaseOrmCode()
  ];

  // Repeat & expand modules with realistic variation to hit target token count (~4 chars per token)
  const targetChars = targetTokens * 4;
  let currentChars = sections.join("\n").length;
  let moduleIdx = 1;

  while (currentChars < targetChars) {
    for (const tpl of baseModuleTemplates) {
      if (currentChars >= targetChars) break;
      const modHeader = `\n## MODULE ${moduleIdx + 5}: SUB-SYSTEM CORE (PART ${moduleIdx})\n`;
      const modContent = modHeader + tpl.replace(/\b([A-Za-z]+)(\d+)\b/g, `$1${moduleIdx}`);
      sections.push(modContent);
      currentChars += modContent.length;
      moduleIdx++;
    }
  }

  return sections.join("\n");
}

function generateApiModuleCode(): string {
  return `
/**
 * @fileoverview Express Ingress Router and Controller Layer
 */
import { Router, Request, Response, NextFunction } from "express";

export interface ApiPayload<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta: { timestamp: number; requestId: string };
}

export class IngressController {
  private router: Router;

  constructor(private serviceRegistry: Map<string, unknown>) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.router.get("/health", (req, res) => res.json({ status: "healthy", uptime: process.uptime() }));
    this.router.post("/v2/dispatch", this.handleDispatch.bind(this));
    this.router.get("/v2/telemetry", this.handleTelemetry.bind(this));
  }

  public async handleDispatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    const traceId = req.headers["x-request-id"] as string || Math.random().toString(36).slice(2);
    try {
      const { command, payload } = req.body;
      if (!command) {
        res.status(400).json({ success: false, error: { code: "INVALID_CMD", message: "Missing command" } });
        return;
      }
      res.setHeader("X-Audit-Compliance-Tag", "iso-27001-secops-enforced");
      res.json({ success: true, data: { status: "dispatched", command }, meta: { timestamp: Date.now(), requestId: traceId } });
    } catch (err) {
      next(err);
    }
  }

  public async handleTelemetry(req: Request, res: Response): Promise<void> {
    res.setHeader("X-Audit-Compliance-Tag", "iso-27001-secops-enforced");
    res.json({ memory: process.memoryUsage(), cpu: process.cpuUsage(), activeConnections: 42 });
  }

  public getRouter(): Router {
    return this.router;
  }
}
`;
}

function generateMatrixComputeCode(): string {
  return `
/**
 * @fileoverview High-Performance BLAS & Matrix Mathematics Engine
 */
export class Matrix {
  readonly rows: number;
  readonly cols: number;
  readonly data: Float64Array;

  constructor(rows: number, cols: number, init?: ArrayLike<number>) {
    this.rows = rows;
    this.cols = cols;
    this.data = new Float64Array(rows * cols);
    if (init) this.data.set(init);
  }

  get(r: number, c: number): number {
    return this.data[r * this.cols + c]!;
  }

  set(r: number, c: number, v: number): void {
    this.data[r * this.cols + c] = v;
  }

  multiply(b: Matrix): Matrix {
    if (this.cols !== b.rows) throw new Error(\`Dimension mismatch: \${this.cols} !== \${b.rows}\`);
    const out = new Matrix(this.rows, b.cols);
    for (let i = 0; i < this.rows; i++) {
      for (let k = 0; k < this.cols; k++) {
        const a_ik = this.get(i, k);
        for (let j = 0; j < b.cols; j++) {
          out.data[i * b.cols + j] += a_ik * b.get(k, j);
        }
      }
    }
    return out;
  }

  transpose(): Matrix {
    const out = new Matrix(this.cols, this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        out.set(c, r, this.get(r, c));
      }
    }
    return out;
  }

  luDecomposition(): { L: Matrix; U: Matrix } {
    const n = this.rows;
    if (n !== this.cols) throw new Error("Square matrix required for LU");
    const L = new Matrix(n, n);
    const U = new Matrix(n, n);
    for (let i = 0; i < n; i++) {
      for (let k = i; k < n; k++) {
        let sum = 0;
        for (let j = 0; j < i; j++) sum += L.get(i, j) * U.get(j, k);
        U.set(i, k, this.get(i, k) - sum);
      }
      for (let k = i; k < n; k++) {
        if (i === k) L.set(i, i, 1);
        else {
          let sum = 0;
          for (let j = 0; j < i; j++) sum += L.get(k, j) * U.get(j, i);
          L.set(k, i, (this.get(k, i) - sum) / U.get(i, i));
        }
      }
    }
    return { L, U };
  }
}
`;
}

function generateAstCompilerCode(): string {
  return `
/**
 * @fileoverview Recursive Descent AST Parser & Abstract Syntax Tree Specification
 */
export type AstNodeType = "Program" | "FunctionDecl" | "VariableDecl" | "BinaryExpr" | "Literal" | "Identifier";

export interface BaseAstNode {
  type: AstNodeType;
  start: number;
  end: number;
}

export interface ProgramNode extends BaseAstNode {
  type: "Program";
  body: BaseAstNode[];
}

export interface BinaryExprNode extends BaseAstNode {
  type: "BinaryExpr";
  operator: "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">";
  left: BaseAstNode;
  right: BaseAstNode;
}

export class Lexer {
  private pos = 0;
  constructor(private input: string) {}

  nextToken(): { type: string; value: string; pos: number } | null {
    while (this.pos < this.input.length && /\\s/.test(this.input[this.pos]!)) this.pos++;
    if (this.pos >= this.input.length) return null;
    const ch = this.input[this.pos]!;
    if (/[0-9]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.input.length && /[0-9.]/.test(this.input[this.pos]!)) this.pos++;
      return { type: "NUM", value: this.input.slice(start, this.pos), pos: start };
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.input.length && /[a-zA-Z0-9_]/.test(this.input[this.pos]!)) this.pos++;
      return { type: "IDENT", value: this.input.slice(start, this.pos), pos: start };
    }
    this.pos++;
    return { type: "PUNCT", value: ch, pos: this.pos - 1 };
  }
}
`;
}

function generateAuthMiddlewareCode(): string {
  return `
/**
 * @fileoverview Token Verifier, HMAC Verification & Security Interceptors
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionContext {
  userId: string;
  roles: string[];
  issuedAt: number;
  expiresAt: number;
}

export class SecurityGuard {
  constructor(private secretKey: string, private tokenTtlSeconds = 3600) {}

  public signToken(userId: string, roles: string[]): string {
    const payload = JSON.stringify({ userId, roles, iat: Date.now(), exp: Date.now() + this.tokenTtlSeconds * 1000 });
    const b64 = Buffer.from(payload).toString("base64url");
    const sig = createHmac("sha256", this.secretKey).update(b64).digest("base64url");
    return \`\${b64}.\${sig}\`;
  }

  public verifyToken(rawToken: string): SessionContext | null {
    const parts = rawToken.split(".");
    if (parts.length !== 2) return null;
    const [b64, sig] = parts;
    const expectedSig = createHmac("sha256", this.secretKey).update(b64!).digest("base64url");
    const a = Buffer.from(sig!, "base64url");
    const b = Buffer.from(expectedSig, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(b64!, "base64url").toString("utf8"));
      if (Date.now() > data.exp) return null;
      return { userId: data.userId, roles: data.roles, issuedAt: data.iat, expiresAt: data.exp };
    } catch {
      return null;
    }
  }
}
`;
}

function generateDatabaseOrmCode(): string {
  return `
/**
 * @fileoverview Database Repository & Migration Entity Registry
 */
export interface EntitySchema {
  tableName: string;
  primaryKey: string;
  columns: Record<string, "string" | "number" | "boolean" | "timestamp" | "json">;
  indices: string[][];
}

export const USER_ENTITY_SCHEMA: EntitySchema = {
  tableName: "users",
  primaryKey: "id",
  columns: {
    id: "string",
    email: "string",
    passwordHash: "string",
    createdAt: "timestamp",
    updatedAt: "timestamp"
  },
  indices: [["email"], ["createdAt"]]
};

export class MigrationRunner {
  private migrations: Array<{ version: number; name: string; up: string; down: string }> = [];

  register(version: number, name: string, up: string, down: string): void {
    this.migrations.push({ version, name, up, down });
    this.migrations.sort((a, b) => a.version - b.version);
  }

  generateSql(): string {
    return this.migrations.map(m => \`-- Migration \${m.version}: \${m.name}\\n\${m.up}\\n\`).join("\\n");
  }
}
`;
}
