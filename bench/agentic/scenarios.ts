/**
 * Benchmark scenarios across 4 modes (+ combined `all`) and 5 context intensity scales.
 *
 * Modes:
 * 1. "programming": Build a feature-rich Pac-Man arcade game + modular engine/stages/specs.
 * 2. "research": Security audit of planted vulnerabilities + progressive defense-in-depth hardening.
 * 3. "general": Production TypeScript numerical, linear-algebra, and data-structures platform.
 * 4. "memory": Stratified session-only factual & override needles + progressive microservice tasks.
 * 5. "all": Combined multi-phase marathon across all four engineering disciplines.
 *
 * Scales & Stratified Needle Counts:
 * - low:      20 turns   (memory/all: 4 needles,  domain modes: 2 needles)
 * - medium:   60 turns   (memory/all: 8 needles,  domain modes: 4 needles)
 * - high:     150 turns  (memory/all: 14 needles, domain modes: 6 needles)
 * - insane:   300 turns  (memory/all: 20 needles, domain modes: 10 needles)
 * - marathon: 1500 turns (memory/all: 32 needles, domain modes: 16 needles)
 *
 * Core Invariants:
 * 1. 100% Unique Work: Every turn up to marathon (1,500 turns) delivers a unique, concrete
 *    deliverable so models never short-circuit with "already completed in step [#mXXXXXX]".
 * 2. Zero Turn-1 Freebies: Needles are never planted on Turn 1 (which is head-pinned).
 * 3. Deep-Horizon Lag (>= 45%): Every probe occurs at least `floor(0.45 * totalTurns)` turns
 *    after its authoritative planting/override turn, defeating recency-only FIFO windows.
 * 4. Temporal Overrides (~25%): Every 4th needle plants an initial value early, supersedes it
 *    later with an updated directive, and probes for the current active setting.
 */

import { Sandbox } from "./sandbox.ts";

export type ScenarioMode = "programming" | "research" | "general" | "memory" | "all";
export type ContextScale = "low" | "medium" | "high" | "insane" | "marathon";

export const SCALE_TURNS: Record<ContextScale, number> = {
  low: 20,
  medium: 60,
  high: 150,
  insane: 300,
  marathon: 1500
};

/** Sub-linear stratified needle counts for `memory` and `all` modes. */
export const SCALE_NEEDLE_COUNTS: Record<ContextScale, number> = {
  low: 4,
  medium: 8,
  high: 14,
  insane: 20,
  marathon: 32
};

/** Sub-linear stratified probe counts for `programming`, `research`, and `general` modes. */
export const SCALE_DOMAIN_PROBE_COUNTS: Record<ContextScale, number> = {
  low: 2,
  medium: 4,
  high: 6,
  insane: 10,
  marathon: 16
};

export interface ScenarioTurn {
  turnIndex: number;
  userMessage: string;
  isProbe?: boolean;
  probeId?: string;
  expectedKeywords?: string[];
  staleKeywords?: string[];
}

export type RubricEvaluationKind = "sync" | "async-container" | "async-report" | "probe";

export interface ScenarioRubricItem {
  id: string;
  name: string;
  weight: number;
  kind?: RubricEvaluationKind;
  check?: (sandbox: Sandbox, finalReport?: string) => boolean;
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

export interface NeedleSpec {
  key: string;
  probeId: string;
  symbol: string;
  fact: string;
  question: string;
  answer: string[];
  expectedKeywords: string[];
  /** Present on ~25% of needles: early directive later superseded by `fact`. */
  initialFact?: string;
  staleKeywords?: string[];
}

interface ScheduledNeedleEvents {
  /** Map from turnIndex -> briefing paragraph(s) prepended to that turn's workspace task. */
  briefingsByTurn: Map<number, string[]>;
  /** Map from turnIndex -> recall probe definition. */
  probesByTurn: Map<number, { probeId: string; question: string; expectedKeywords: string[]; staleKeywords?: string[] }>;
}

/**
 * Deterministic deep-horizon needle scheduler:
 * - Zero Turn-1 placements (all plantings, overrides, and probes live at turn >= 2).
 * - Probes span `[ceil(0.58 * totalTurns) .. totalTurns - 1]`.
 * - Authoritative plantings/overrides span `[2 .. floor(0.50 * totalTurns)]` with guaranteed
 *   `probeTurn - authoritativeTurn >= floor(0.45 * totalTurns)`.
 * - Override needles first plant `initialFact` strictly earlier in `[2 .. authoritativeTurn - 1]`.
 */
export function scheduleStratifiedNeedles(totalTurns: number, needles: readonly NeedleSpec[]): ScheduledNeedleEvents {
  const count = needles.length;
  const briefingsByTurn = new Map<number, string[]>();
  const probesByTurn = new Map<number, { probeId: string; question: string; expectedKeywords: string[]; staleKeywords?: string[] }>();
  if (count === 0 || totalTurns < 6) return { briefingsByTurn, probesByTurn };

  const minLag = Math.floor(totalTurns * 0.45);
  const usedProbeTurns = new Set<number>();
  const usedPlantTurns = new Set<number>();

  const probeStart = Math.max(4, Math.ceil(totalTurns * 0.58));
  const probeEnd = Math.max(probeStart, totalTurns - 1);

  const probeTurns: number[] = [];
  for (let i = 0; i < count; i++) {
    const ideal = count === 1
      ? probeEnd
      : Math.round(probeStart + (i * (probeEnd - probeStart)) / (count - 1));
    let t = Math.min(totalTurns, Math.max(4, ideal));
    while (usedProbeTurns.has(t) && t < totalTurns) t++;
    while (usedProbeTurns.has(t) && t > 3) t--;
    usedProbeTurns.add(t);
    probeTurns.push(t);
  }
  probeTurns.sort((a, b) => a - b);

  const plantCeiling = Math.max(2, Math.floor(totalTurns * 0.50));
  const authoritativeTurns: number[] = [];

  for (let i = 0; i < count; i++) {
    const maxAllowed = Math.max(2, Math.min(plantCeiling, probeTurns[i]! - minLag));
    const minAllowed = needles[i]!.initialFact ? 3 : 2;
    const ideal = count === 1
      ? minAllowed
      : Math.round(minAllowed + (i * Math.max(0, maxAllowed - minAllowed)) / (count - 1));
    let t = Math.min(maxAllowed, Math.max(minAllowed, ideal));
    while ((usedPlantTurns.has(t) || usedProbeTurns.has(t)) && t > minAllowed) t--;
    while ((usedPlantTurns.has(t) || usedProbeTurns.has(t)) && t < maxAllowed) t++;
    usedPlantTurns.add(t);
    authoritativeTurns.push(t);
  }

  const pushBriefing = (turn: number, text: string) => {
    const list = briefingsByTurn.get(turn);
    if (list) list.push(text);
    else briefingsByTurn.set(turn, [text]);
  };

  for (let i = 0; i < count; i++) {
    const needle = needles[i]!;
    const authTurn = authoritativeTurns[i]!;
    const probeTurn = probeTurns[i]!;

    if (needle.initialFact) {
      let initTurn = Math.max(2, Math.min(authTurn - 1, Math.round(2 + (authTurn - 2) * 0.4)));
      while ((usedPlantTurns.has(initTurn) || usedProbeTurns.has(initTurn)) && initTurn > 2) initTurn--;
      while ((usedPlantTurns.has(initTurn) || usedProbeTurns.has(initTurn)) && initTurn < authTurn - 1) initTurn++;
      if (initTurn >= 2 && initTurn < authTurn && !usedProbeTurns.has(initTurn)) {
        usedPlantTurns.add(initTurn);
        pushBriefing(
          initTurn,
          `SESSION GOVERNANCE BRIEFING [${needle.symbol}] (retain in conversation memory ONLY — NEVER write operational credentials, headers, limits, or dates into repository files): ${needle.initialFact}`
        );
      }
      pushBriefing(
        authTurn,
        `POLICY OVERRIDE DIRECTIVE [${needle.symbol}] (SUPERSEDES earlier ${needle.symbol} setting; retain in conversation memory ONLY — do NOT write into repository files): ${needle.fact}`
      );
    } else {
      pushBriefing(
        authTurn,
        `SESSION GOVERNANCE BRIEFING [${needle.symbol}] (retain in conversation memory ONLY — NEVER write operational credentials, headers, limits, or dates into repository files): ${needle.fact}`
      );
    }

    probesByTurn.set(probeTurn, {
      probeId: needle.probeId,
      question: `Recall check [${needle.symbol}]: ${needle.question}`,
      expectedKeywords: [...needle.expectedKeywords],
      ...(needle.staleKeywords ? { staleKeywords: [...needle.staleKeywords] } : {})
    });
  }

  return { briefingsByTurn, probesByTurn };
}

// ============================================================================
// Stratified 32-Needle Catalog (75% Static + 25% Temporal Overrides)
// ============================================================================

export const MEMORY_NEEDLE_CATALOG: readonly NeedleSpec[] = [
  {
    key: "replica-password",
    probeId: "needle-staging-replica",
    symbol: "STAGING_REPLICA_DB_CONFIG",
    fact: "The staging database port is 9432 and replica password is 'Krypton-7729-Beta'.",
    question: "What is the staging database port and replica password?",
    answer: ["9432", "Krypton-7729-Beta"],
    expectedKeywords: ["9432", "Krypton-7729-Beta"]
  },
  {
    key: "header-invariant",
    probeId: "needle-header-invariant",
    symbol: "EDGE_ORIGIN_HEADER_POLICY",
    fact: "Architectural invariant: all API responses must include header 'X-Origin-Zone: eu-west-1a'.",
    question: "What exact header name and value must all API responses include?",
    answer: ["X-Origin-Zone", "eu-west-1a"],
    expectedKeywords: ["X-Origin-Zone", "eu-west-1a"]
  },
  {
    key: "deprecation-date",
    probeId: "needle-deprecation-date",
    symbol: "V1_ENDPOINT_SUNSET_DATE",
    fact: "The deprecation date for v1 endpoints is set to 2027-04-15 by user directive.",
    question: "What is the exact deprecation date set for v1 endpoints?",
    answer: ["2027-04-15"],
    expectedKeywords: ["2027-04-15"]
  },
  {
    key: "ingest-batch-cap",
    probeId: "needle-ingest-batch-cap",
    symbol: "INGEST_MAX_BATCH_BYTES",
    initialFact: "Initial ingestion payload ceiling: `INGEST_MAX_BATCH_BYTES` is set to 65536 bytes.",
    fact: "Updated ingestion payload ceiling: `INGEST_MAX_BATCH_BYTES` is lowered from 65536 to 18432 bytes effective immediately.",
    question: "What is the current active byte limit for `INGEST_MAX_BATCH_BYTES` after any policy override?",
    answer: ["18432"],
    expectedKeywords: ["18432"],
    staleKeywords: ["65536"]
  },
  {
    key: "dlq-kafka-topic",
    probeId: "needle-dlq-kafka-topic",
    symbol: "ORDERS_DLQ_KAFKA_TOPIC",
    fact: "Poisoned order events must route to dead-letter Kafka topic 'dlq.orders.v3.quarantine'.",
    question: "What exact dead-letter Kafka topic receives poisoned order events?",
    answer: ["dlq.orders.v3.quarantine"],
    expectedKeywords: ["dlq.orders.v3.quarantine"]
  },
  {
    key: "kms-cmk-alias",
    probeId: "needle-kms-cmk-alias",
    symbol: "LEDGER_KMS_CMK_ALIAS",
    fact: "Envelope encryption for ledger snapshots uses KMS alias 'alias/prod-ledger-cmk-409'.",
    question: "What exact KMS alias is designated for ledger snapshot envelope encryption?",
    answer: ["alias/prod-ledger-cmk-409"],
    expectedKeywords: ["alias/prod-ledger-cmk-409"]
  },
  {
    key: "redis-sentinel-quorum",
    probeId: "needle-redis-sentinel-quorum",
    symbol: "REDIS_SENTINEL_QUORUM_SPEC",
    fact: "Redis failover requires sentinel quorum 5 on cluster 'sentinel-amber-91'.",
    question: "What sentinel quorum count and cluster name govern Redis failover?",
    answer: ["5", "sentinel-amber-91"],
    expectedKeywords: ["5", "sentinel-amber-91"]
  },
  {
    key: "webhook-skew-window",
    probeId: "needle-webhook-skew-window",
    symbol: "WEBHOOK_CLOCK_SKEW_SEC",
    initialFact: "Initial webhook replay tolerance: `WEBHOOK_CLOCK_SKEW_SEC` is set to 300 seconds.",
    fact: "Tightened webhook replay tolerance: `WEBHOOK_CLOCK_SKEW_SEC` is reduced from 300 seconds to 75 seconds.",
    question: "What is the current active tolerance in seconds for `WEBHOOK_CLOCK_SKEW_SEC`?",
    answer: ["75"],
    expectedKeywords: ["75"],
    staleKeywords: ["300"]
  },
  {
    key: "canary-cohort-header",
    probeId: "needle-canary-cohort-header",
    symbol: "CANARY_COHORT_HEADER_SPEC",
    fact: "Synthetic canary traffic carries header 'X-Canary-Cohort: cobalt-17'.",
    question: "What header name and cohort identifier mark synthetic canary traffic?",
    answer: ["X-Canary-Cohort", "cobalt-17"],
    expectedKeywords: ["X-Canary-Cohort", "cobalt-17"]
  },
  {
    key: "audit-worm-bucket",
    probeId: "needle-audit-worm-bucket",
    symbol: "AUDIT_WORM_S3_BUCKET",
    fact: "Immutable compliance logs archive to S3 bucket 's3://acme-sec-worm-vault-08'.",
    question: "Which exact S3 bucket URI stores immutable compliance logs?",
    answer: ["s3://acme-sec-worm-vault-08"],
    expectedKeywords: ["acme-sec-worm-vault-08"]
  },
  {
    key: "grpc-keepalive-interval",
    probeId: "needle-grpc-keepalive-interval",
    symbol: "GRPC_MESH_KEEPALIVE_MS",
    fact: "Internal gRPC mesh channels use keepalive ping interval 45000ms under profile 'GRPC-KA-45'.",
    question: "What keepalive ping interval and profile code apply to internal gRPC mesh channels?",
    answer: ["45000", "GRPC-KA-45"],
    expectedKeywords: ["45000", "GRPC-KA-45"]
  },
  {
    key: "tenant-burst-ceiling",
    probeId: "needle-tenant-burst-ceiling",
    symbol: "TENANT_BURST_RPM_CAP",
    initialFact: "Initial per-tenant burst ceiling: `TENANT_BURST_RPM_CAP` is 1200 requests/minute.",
    fact: "Revised per-tenant burst ceiling: `TENANT_BURST_RPM_CAP` is lowered from 1200 to 420 requests/minute.",
    question: "What is the current active requests/minute limit for `TENANT_BURST_RPM_CAP`?",
    answer: ["420"],
    expectedKeywords: ["420"],
    staleKeywords: ["1200"]
  },
  {
    key: "otlp-collector-host",
    probeId: "needle-otlp-collector-host",
    symbol: "OTLP_TRACE_COLLECTOR_ADDR",
    fact: "Distributed traces export via gRPC to 'otel-ingest.internal:4317'.",
    question: "What exact host and port receive exported distributed OTLP traces?",
    answer: ["otel-ingest.internal:4317"],
    expectedKeywords: ["otel-ingest.internal", "4317"]
  },
  {
    key: "jwt-active-kid",
    probeId: "needle-jwt-active-kid",
    symbol: "JWT_SIGNING_ACTIVE_KID",
    fact: "Access tokens are signed with Ed25519 key slot 'kid-ed25519-2026q4-b7'.",
    question: "What exact `kid` key-slot identifier signs access tokens?",
    answer: ["kid-ed25519-2026q4-b7"],
    expectedKeywords: ["kid-ed25519-2026q4-b7"]
  },
  {
    key: "pg-statement-timeout",
    probeId: "needle-pg-statement-timeout",
    symbol: "PG_OLTP_STATEMENT_TIMEOUT_MS",
    fact: "OLTP Postgres read/write sessions enforce a hard `statement_timeout` of 12500ms.",
    question: "What exact `statement_timeout` in milliseconds is enforced on OLTP Postgres sessions?",
    answer: ["12500"],
    expectedKeywords: ["12500"]
  },
  {
    key: "breaker-error-threshold",
    probeId: "needle-breaker-error-threshold",
    symbol: "BREAKER_TRIP_ERROR_PCT",
    initialFact: "Initial circuit-breaker policy: `BREAKER_TRIP_ERROR_PCT` trips open at 55% error rate.",
    fact: "Updated circuit-breaker policy: `BREAKER_TRIP_ERROR_PCT` now trips open at 22% error rate instead of 55%.",
    question: "At what exact error-rate percentage does `BREAKER_TRIP_ERROR_PCT` currently trip open?",
    answer: ["22%"],
    expectedKeywords: ["22"],
    staleKeywords: ["55"]
  },
  {
    key: "graphql-persisted-salt",
    probeId: "needle-graphql-persisted-salt",
    symbol: "GQL_PERSISTED_QUERY_SALT",
    fact: "Persisted GraphQL query hashes prepend domain salt 'PQ-SALT-8831-ZETA'.",
    question: "What exact domain salt string is prepended to persisted GraphQL query hashes?",
    answer: ["PQ-SALT-8831-ZETA"],
    expectedKeywords: ["PQ-SALT-8831-ZETA"]
  },
  {
    key: "dr-failover-region",
    probeId: "needle-dr-failover-region",
    symbol: "DR_STANDBY_REGION_CODE",
    fact: "Warm disaster-recovery standby runs in region 'ap-northeast-3b' with RPO 15s.",
    question: "Which exact cloud region code hosts the warm disaster-recovery standby?",
    answer: ["ap-northeast-3b"],
    expectedKeywords: ["ap-northeast-3b"]
  },
  {
    key: "idempotency-ttl",
    probeId: "needle-idempotency-ttl",
    symbol: "IDEMPOTENCY_KEY_TTL_SPEC",
    fact: "Mutation idempotency keys are retained for 86400 seconds under policy 'idem-24h-strict'.",
    question: "How many seconds are mutation idempotency keys retained, and what is the policy name?",
    answer: ["86400", "idem-24h-strict"],
    expectedKeywords: ["86400", "idem-24h-strict"]
  },
  {
    key: "worker-drain-timeout",
    probeId: "needle-worker-drain-timeout",
    symbol: "WORKER_SIGTERM_DRAIN_SEC",
    initialFact: "Initial shutdown grace period: `WORKER_SIGTERM_DRAIN_SEC` waits 60 seconds before SIGKILL.",
    fact: "Updated shutdown grace period: `WORKER_SIGTERM_DRAIN_SEC` is shortened from 60 seconds to 25 seconds.",
    question: "How many seconds does `WORKER_SIGTERM_DRAIN_SEC` currently wait before SIGKILL?",
    answer: ["25"],
    expectedKeywords: ["25"],
    staleKeywords: ["60"]
  },
  {
    key: "mtls-spiffe-domain",
    probeId: "needle-mtls-spiffe-domain",
    symbol: "MESH_SPIFFE_TRUST_DOMAIN",
    fact: "Workload mTLS X.509 certificates validate against trust domain 'spiffe://prod.mesh.internal'.",
    question: "What exact SPIFFE trust domain URI validates workload mTLS certificates?",
    answer: ["spiffe://prod.mesh.internal"],
    expectedKeywords: ["spiffe://prod.mesh.internal"]
  },
  {
    key: "billing-settlement-cron",
    probeId: "needle-billing-settlement-cron",
    symbol: "BILLING_SETTLEMENT_UTC_WINDOW",
    fact: "Nightly ledger settlement executes at '03:40 UTC' under lock key 'settle-lock-0340'.",
    question: "At what exact UTC time and lock key does nightly ledger settlement run?",
    answer: ["03:40", "settle-lock-0340"],
    expectedKeywords: ["03:40", "settle-lock-0340"]
  },
  {
    key: "search-shard-topology",
    probeId: "needle-search-shard-topology",
    symbol: "SEARCH_INDEX_SHARD_SPEC",
    fact: "Document search partitions across 19 primary shards using hash ring 'murmur3-128-v2'.",
    question: "How many primary shards and which hash-ring identifier partition document search?",
    answer: ["19", "murmur3-128-v2"],
    expectedKeywords: ["19", "murmur3-128-v2"]
  },
  {
    key: "sse-stream-cap",
    probeId: "needle-sse-stream-cap",
    symbol: "MAX_CONCURRENT_SSE_PER_USER",
    initialFact: "Initial streaming quota: `MAX_CONCURRENT_SSE_PER_USER` permits 12 concurrent SSE connections.",
    fact: "Revised streaming quota: `MAX_CONCURRENT_SSE_PER_USER` is capped at 4 concurrent SSE connections instead of 12.",
    question: "What is the current active connection limit for `MAX_CONCURRENT_SSE_PER_USER`?",
    answer: ["4"],
    expectedKeywords: ["4"],
    staleKeywords: ["12"]
  },
  {
    key: "flag-bootstrap-checksum",
    probeId: "needle-flag-bootstrap-checksum",
    symbol: "FEATURE_FLAG_SEED_SHA256",
    fact: "Offline feature-flag bootstrap snapshot is pinned to digest 'sha256:9f4c2e11b8'.",
    question: "What exact SHA-256 digest pins the offline feature-flag bootstrap snapshot?",
    answer: ["sha256:9f4c2e11b8"],
    expectedKeywords: ["9f4c2e11b8"]
  },
  {
    key: "pagerduty-routing-key",
    probeId: "needle-pagerduty-routing-key",
    symbol: "SEV1_PAGERDUTY_ROUTING_CODE",
    fact: "SEV-1 paging alerts dispatch with routing key 'PD-ESC-5519-SEV1'.",
    question: "What exact routing key dispatches SEV-1 paging alerts?",
    answer: ["PD-ESC-5519-SEV1"],
    expectedKeywords: ["PD-ESC-5519-SEV1"]
  },
  {
    key: "multipart-chunk-bytes",
    probeId: "needle-multipart-chunk-bytes",
    symbol: "BLOB_MULTIPART_CHUNK_BYTES",
    fact: "Large object uploads segment into 8388608-byte parts under profile 'chunk-8mib-crc32c'.",
    question: "What exact byte size and profile name govern large object multipart uploads?",
    answer: ["8388608", "chunk-8mib-crc32c"],
    expectedKeywords: ["8388608", "chunk-8mib-crc32c"]
  },
  {
    key: "session-idle-eviction",
    probeId: "needle-session-idle-eviction",
    symbol: "AUTH_SESSION_IDLE_TTL_SEC",
    initialFact: "Initial session idle policy: `AUTH_SESSION_IDLE_TTL_SEC` expires inactive sessions after 7200 seconds.",
    fact: "Security-tightened session policy: `AUTH_SESSION_IDLE_TTL_SEC` now expires inactive sessions after 1800 seconds instead of 7200.",
    question: "After how many seconds of inactivity does `AUTH_SESSION_IDLE_TTL_SEC` currently expire sessions?",
    answer: ["1800"],
    expectedKeywords: ["1800"],
    staleKeywords: ["7200"]
  },
  {
    key: "schema-compat-mode",
    probeId: "needle-schema-compat-mode",
    symbol: "PROTO_REGISTRY_COMPAT_MODE",
    fact: "Protobuf schema registry enforces compatibility level 'BACKWARD_TRANSITIVE' on namespace 'core.v2'.",
    question: "What compatibility level and namespace are enforced on the Protobuf schema registry?",
    answer: ["BACKWARD_TRANSITIVE", "core.v2"],
    expectedKeywords: ["BACKWARD_TRANSITIVE", "core.v2"]
  },
  {
    key: "clickhouse-retention-days",
    probeId: "needle-clickhouse-retention-days",
    symbol: "CLICKHOUSE_RAW_TTL_DAYS",
    fact: "Raw telemetry rows in ClickHouse retain for 365 days under policy 'ch-ttl-365d-zstd'.",
    question: "For how many days and under what policy name are ClickHouse telemetry rows retained?",
    answer: ["365", "ch-ttl-365d-zstd"],
    expectedKeywords: ["365", "ch-ttl-365d-zstd"]
  },
  {
    key: "outbox-poll-cadence",
    probeId: "needle-outbox-poll-cadence",
    symbol: "OUTBOX_RELAY_POLL_SPEC",
    fact: "Transactional outbox workers poll every 250ms claiming 'batch-128-locked' slices.",
    question: "What poll interval and batch profile string configure transactional outbox workers?",
    answer: ["250ms", "batch-128-locked"],
    expectedKeywords: ["250", "batch-128-locked"]
  },
  {
    key: "freeze-change-ticket",
    probeId: "needle-freeze-change-ticket",
    symbol: "PROD_FREEZE_EXEMPTION_TICKET",
    initialFact: "Initial release-freeze exception ticket for hotfixes: 'CHG-2026-4410-TEMP'.",
    fact: "Superseded release-freeze exception ticket: 'CHG-2026-4410-TEMP' is revoked and replaced by 'CHG-2026-9942-LOCK'.",
    question: "What is the current valid release-freeze exception ticket (`CHG-2026-...`) after revocation?",
    answer: ["CHG-2026-9942-LOCK"],
    expectedKeywords: ["CHG-2026-9942-LOCK"],
    staleKeywords: ["CHG-2026-4410-TEMP"]
  }
];

/** Default 3-needle baseline preserved for standalone transcript evaluation callers without a scale. */
export const MEMORY_NEEDLES = MEMORY_NEEDLE_CATALOG.slice(0, 3);

export function getMemoryNeedlesForScale(scale: ContextScale): readonly NeedleSpec[] {
  return MEMORY_NEEDLE_CATALOG.slice(0, SCALE_NEEDLE_COUNTS[scale]);
}

export function getDomainNeedlesForScale(mode: "programming" | "research" | "general", scale: ContextScale): readonly NeedleSpec[] {
  const count = SCALE_DOMAIN_PROBE_COUNTS[scale];
  // Offset into catalog per domain while keeping distinct symbols & 25% overrides
  const startOffset = mode === "programming" ? 4 : mode === "research" ? 12 : 20;
  const selected: NeedleSpec[] = [];
  for (let i = 0; i < count; i++) {
    const base = MEMORY_NEEDLE_CATALOG[(startOffset + i) % MEMORY_NEEDLE_CATALOG.length]!;
    selected.push({
      ...base,
      probeId: `${mode}-${base.probeId}`
    });
  }
  return selected;
}

// ============================================================================
// 1. Programming Mode: Feature-Rich Pac-Man Arcade Engine & Modular Expansion
// ============================================================================

export const PACMAN_FEATURES = [
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

const PACMAN_CORE_MILESTONES: readonly string[] = [
  "Create `index.html`, `style.css`, and `game.js` with an HTML5 `<canvas>` and a `requestAnimationFrame` game loop rendering a 28x31 Pac-Man tile maze.",
  "Implement Pac-Man entity state, ArrowUp/ArrowDown/ArrowLeft/ArrowRight and WASD (`KeyW`/`KeyA`/`KeyS`/`KeyD`) input listeners, buffered cornering, and wall tile collision in `game.js`.",
  "Populate maze corridors with standard pellets (10 pts) and 4 corner power pellets (50 pts), updating live score and clearing eaten tiles in `game.js`.",
  "Implement Blinky (red chaser targeting Pac-Man's current tile) and Pinky (pink ambusher targeting 4 tiles ahead of Pac-Man's facing direction) in `game.js`.",
  "Implement Inky (cyan vector flanker combining Blinky's position and 2 tiles ahead of Pac-Man) and Clyde (orange wanderer chasing beyond 8 tiles and scattering to bottom-left when closer) in `game.js`.",
  "Implement Power Pellet frightened mode: ghosts turn blue, reverse direction, move at reduced speed, and award 200/400/800/1600 cascading points when eaten.",
  "Add the 3-lives system, Pac-Man collision death sequence, ghost house respawn timer, and full Game Over / Victory overlay screens with keyboard restart.",
  "Add level progression (`nextLevel`) when all pellets are cleared, resetting the board while scaling Pac-Man/ghost speeds and shortening frightened duration.",
  "Persist `highScore` in `localStorage` across sessions and render a live arcade HUD in `index.html`/`game.js` showing score, high score, level, and remaining lives.",
  "Synthesize zero-asset Web Audio API sound effects (`AudioContext` oscillators/gain envelopes) for pellet waka-waka, power energizer siren, ghost eat, and extra life.",
  "Add warp tunnel wraparound on the middle horizontal corridor with ghost tunnel speed penalty and smooth sprite mouth-chomp animation frames.",
  "Implement global scatter/chase wave scheduling (7s scatter / 20s chase phases) with forced ghost direction reversal on phase transitions.",
  "Add bonus fruit spawning below the ghost house at 70 and 170 pellets eaten (cherry, strawberry, orange, apple, melon, galaxian, bell, key) with floating point popups.",
  "Add touch/swipe gesture controls and responsive viewport scaling in `style.css` and `game.js` while keeping keyboard controls intact.",
  "Add pause/resume (`KeyP`/`Escape`), deterministic reset state cleanup, and run `check_work` to verify `index.html`, `style.css`, and `game.js` integration."
];

interface EngineSubsystemSpec {
  slug: string;
  exportName: string;
  domain: string;
  algorithms: readonly [string, string, string, string, string, string];
}

const PACMAN_SUBSYSTEMS: readonly EngineSubsystemSpec[] = [
  {
    slug: "fixed-timestep",
    exportName: "FixedTimestepClock",
    domain: "deterministic 60Hz accumulator loop",
    algorithms: [
      "create `src/engine/fixed-timestep.js` exporting `FixedTimestepClock` with accumulator clamping (`maxSubSteps = 5`) and interpolation alpha",
      "add frame-time ring-buffer percentiles (`p50`, `p95`, `p99` ms) and jitter detection to `src/engine/fixed-timestep.js`",
      "add deterministic tick replay stepping (`stepExact(ticks)`) and pause-safe delta sanitization to `src/engine/fixed-timestep.js`",
      "add slow-motion and turbo time-scale multipliers with smooth ramp transitions in `src/engine/fixed-timestep.js`",
      "create `tests/engine/fixed-timestep.spec.js` verifying spiral-of-death clamping, zero-delta frames, and exact tick counts",
      "document frame-pacing invariants and integration hooks in `docs/engine/fixed-timestep.md` and wire exports in `src/engine/index.js`"
    ]
  },
  {
    slug: "tile-collision",
    exportName: "TileCollisionMap",
    domain: "sub-tile hitbox and ghost-house gate collision",
    algorithms: [
      "create `src/engine/tile-collision.js` exporting `TileCollisionMap` with bitmask wall lookup, ghost-door one-way traversal, and tunnel bounds",
      "add centerline snap tolerance and pre-turn cornering window calculation (`canTurnAt(px, py, dir)`) to `src/engine/tile-collision.js`",
      "add occupancy spatial index (`entitiesAtTile(col, row)`) for O(1) Pac-Man vs ghost tile-overlap queries in `src/engine/tile-collision.js`",
      "add upward-turn restriction zones matching arcade red-zone intersections above the ghost house in `src/engine/tile-collision.js`",
      "create `tests/engine/tile-collision.spec.js` testing wall blocking, ghost gate exit vs re-entry, and wraparound coordinates",
      "add ASCII maze validator `validateMazeTopology(lines)` in `src/engine/tile-collision.js` checking reachability of all pellets"
    ]
  },
  {
    slug: "ghost-targeting",
    exportName: "GhostTargetingSuite",
    domain: "arcade-accurate target tile calculators",
    algorithms: [
      "create `src/engine/ghost-targeting.js` exporting pure target calculators `targetBlinky`, `targetPinky`, `targetInky`, and `targetClyde`",
      "add Cruise Elroy tier-1 and tier-2 speed/scatter override logic for Blinky based on remaining pellet thresholds in `src/engine/ghost-targeting.js`",
      "add deterministic tie-breaking priority (`UP > LEFT > DOWN > RIGHT`) at intersections without reverse-turn violation in `src/engine/ghost-targeting.js`",
      "add frightened PRNG direction selector using a seedable Mulberry32 generator in `src/engine/ghost-targeting.js`",
      "create `tests/engine/ghost-targeting.spec.js` asserting exact target coordinates for all 4 ghosts across cardinal directions",
      "add debug overlay vector descriptors `buildTargetVectors(state)` in `src/engine/ghost-targeting.js` for AI visualization"
    ]
  },
  {
    slug: "ghost-house-fsm",
    exportName: "GhostHouseController",
    domain: "pen release counters and eaten-eyes return state machine",
    algorithms: [
      "create `src/engine/ghost-house-fsm.js` exporting `GhostHouseController` with personal dot counters (Pinky=0, Inky=30, Clyde=60) and global counter after life loss",
      "add starvation timer release (4s / 3s idle without pellet consumption forces next ghost exit) to `src/engine/ghost-house-fsm.js`",
      "add eaten-eyes rapid return navigation to pen entrance `(13, 11)` and regeneration state transition in `src/engine/ghost-house-fsm.js`",
      "add level-table lookup for pen dot limits across levels 1 through 21+ in `src/engine/ghost-house-fsm.js`",
      "create `tests/engine/ghost-house-fsm.spec.js` verifying personal vs global dot counter handoff on player death",
      "export serialized snapshot `toJSON()` / `fromJSON()` on `GhostHouseController` in `src/engine/ghost-house-fsm.js`"
    ]
  },
  {
    slug: "replay-codec",
    exportName: "ReplayCodec",
    domain: "compact input-stream recording and deterministic playback",
    algorithms: [
      "create `src/engine/replay-codec.js` exporting `ReplayRecorder` and `ReplayPlayer` using delta-tick run-length encoding of directional inputs",
      "add CRC32 state-hash checkpointing every 300 ticks in `src/engine/replay-codec.js` to detect playback desynchronization",
      "add base64url compact serialization and header metadata (seed, startLevel, finalScore, tickCount) to `src/engine/replay-codec.js`",
      "add seek-to-tick fast-forward simulation helper `seekReplay(player, targetTick, stepFn)` in `src/engine/replay-codec.js`",
      "create `tests/engine/replay-codec.spec.js` testing round-trip encoding, RLE compression ratio, and desync detection",
      "add highlight bookmark extraction (`extractMilestones`) for ghost-quad-combos and level clears in `src/engine/replay-codec.js`"
    ]
  },
  {
    slug: "particle-fx",
    exportName: "ParticlePool",
    domain: "zero-allocation object-pooled canvas particles and score popups",
    algorithms: [
      "create `src/engine/particle-fx.js` exporting pre-allocated `ParticlePool` (`capacity = 256`) for pellet sparks, energizer rings, and death bursts",
      "add `ScorePopupManager` in `src/engine/particle-fx.js` rendering rising `200`/`400`/`800`/`1600` and fruit bonus labels with ease-out alpha",
      "add screen-shake trauma decay (`applyCameraShake(ctx, trauma)`) with reduced-motion accessibility bypass in `src/engine/particle-fx.js`",
      "add maze-clear white/blue border flash animation state machine to `src/engine/particle-fx.js`",
      "create `tests/engine/particle-fx.spec.js` verifying pool ring recycling when burst count exceeds capacity",
      "add render-batch grouping by fillStyle in `src/engine/particle-fx.js` to minimize 2D context state switches"
    ]
  },
  {
    slug: "audio-mixer",
    exportName: "ArcadeSoundMixer",
    domain: "Web Audio API multi-channel procedural synth",
    algorithms: [
      "create `src/engine/audio-mixer.js` exporting `ArcadeSoundMixer` with master/sfx/siren gain buses and mute persistence",
      "implement dual-pitch alternating waka-waka triangle-wave synth (`playPelletChomp(parity)`) in `src/engine/audio-mixer.js`",
      "implement tempo-scaled background siren oscillator whose frequency rises as remaining pellets drop below 64/32/16 in `src/engine/audio-mixer.js`",
      "implement frequency-sweep arpeggios for `playGhostEaten()`, `playPacManDeath()`, and `playExtraLife()` in `src/engine/audio-mixer.js`",
      "create `tests/engine/audio-mixer.spec.js` using a mock `AudioContext` to verify node scheduling and cleanup on stop",
      "add dynamic compressor/limiter parameter calculation and tab-visibility auto-suspend/resume in `src/engine/audio-mixer.js`"
    ]
  },
  {
    slug: "attract-ai",
    exportName: "AttractModeBot",
    domain: "autonomous Pac-Man attract-screen survival agent",
    algorithms: [
      "create `src/engine/attract-ai.js` exporting `AttractModeBot` using multi-source BFS danger-distance maps from active ghosts",
      "add power-pellet baiting heuristic to `AttractModeBot` in `src/engine/attract-ai.js` when Blinky or Pinky enters within 5 tiles",
      "add frightened-ghost pursuit scoring weighted by combo value and remaining frightened ticks in `src/engine/attract-ai.js`",
      "add dead-end corridor detection (`computeChokepoints(maze)`) so `AttractModeBot` avoids pincer traps in `src/engine/attract-ai.js`",
      "create `tests/engine/attract-ai.spec.js` verifying bot escapes surrounded corridors and prioritizes adjacent energizers",
      "add idle-timeout attract-screen launcher (`IdleAttractController`) transitioning cleanly back to title on key/touch input in `src/engine/attract-ai.js`"
    ]
  },
  {
    slug: "achievements",
    exportName: "AchievementTracker",
    domain: "event-driven arcade badge unlocking and toast queue",
    algorithms: [
      "create `src/engine/achievements.js` exporting `AchievementTracker` evaluating rules like `GHOST_QUAD_1600`, `PACIFIST_CLEAR`, and `NO_DEATH_LV5`",
      "add persistent unlock timestamps, progress counters, and corrupt-JSON recovery for `localStorage` in `src/engine/achievements.js`",
      "add non-blocking HUD toast notification queue (`ToastQueue`) with priority coalescing in `src/engine/achievements.js`",
      "add per-run telemetry summary (`computeRunGrade(stats)`) awarding S/A/B/C/D arcade ranks in `src/engine/achievements.js`",
      "create `tests/engine/achievements.spec.js` testing idempotent badge unlocking, progress persistence, and rank boundaries",
      "add exportable Markdown/JSON run scorecard formatter `formatScorecard(stats, unlocks)` in `src/engine/achievements.js`"
    ]
  },
  {
    slug: "palette-themes",
    exportName: "ThemeRegistry",
    domain: "accessible colorblind-safe and retro CRT palette presets",
    algorithms: [
      "create `src/engine/palette-themes.js` exporting `ThemeRegistry` with Classic 1980, Deuteranopia High-Contrast, Tritanopia Neon, and Monochrome Amber themes",
      "add WCAG relative-luminance contrast ratio calculator `contrastRatio(hexA, hexB)` enforcing >= 4.5:1 wall/pellet legibility in `src/engine/palette-themes.js`",
      "add distinct ghost shape/pattern secondary indicators (stripes, crown, diamond, dots) for colorblind accessibility in `src/engine/palette-themes.js`",
      "add runtime CSS custom-property synchronizer and `prefers-contrast` / `prefers-reduced-motion` media query hooks in `src/engine/palette-themes.js`",
      "create `tests/engine/palette-themes.spec.js` asserting all registered themes pass minimum contrast thresholds",
      "add custom user theme validation and import/export schema in `src/engine/palette-themes.js`"
    ]
  }
];

const STAGE_THEMES = [
  "Classic Arcade", "Twin Warp", "Spiral Vault", "Crossfire", "Diamond Chamber",
  "Split Bastion", "Labyrinth", "Twin Bridges", "Outer Ring", "Reactor Core",
  "Mirror Citadels", "Gauntlet", "Pinwheel", "Catacombs", "Hyper Tunnel",
  "Prism Grid", "Clockwork", "Switchback", "Starlight", "Omega Nexus"
];

function buildProgrammingWorkPrompt(workIndex: number): string {
  if (workIndex < PACMAN_CORE_MILESTONES.length) {
    return PACMAN_CORE_MILESTONES[workIndex]!;
  }
  const offset = workIndex - PACMAN_CORE_MILESTONES.length;
  const subsystemSteps = PACMAN_SUBSYSTEMS.length * 6;
  if (offset < subsystemSteps) {
    const subIdx = Math.floor(offset / 6);
    const stepIdx = offset % 6;
    const sub = PACMAN_SUBSYSTEMS[subIdx]!;
    return `Engine subsystem [${sub.slug} · step ${stepIdx + 1}/6] (${sub.domain}): ${sub.algorithms[stepIdx]!}.`;
  }

  const stageOffset = offset - subsystemSteps;
  const kind = stageOffset % 3;
  const serial = Math.floor(stageOffset / 3) + 1;
  const tag = String(serial).padStart(3, "0");
  const theme = STAGE_THEMES[(serial - 1) % STAGE_THEMES.length]!;
  const baseSpeed = (0.78 + ((serial % 15) * 0.015)).toFixed(3);
  const frightSec = Math.max(1, 8 - (serial % 7));
  const elroyDots = 20 + ((serial * 7) % 50);
  const warpRow = 9 + ((serial * 3) % 11);

  if (kind === 0) {
    return `Author custom stage module \`src/stages/stage-${tag}.js\` ("${theme} #${serial}") exporting \`STAGE_${tag}\` with a symmetric 28x31 ASCII layout, warp tunnel on row ${warpRow}, base speed factor ${baseSpeed}, frightened duration ${frightSec}s, and Cruise Elroy threshold at ${elroyDots} dots, then register \`STAGE_${tag}\` in \`src/stages/manifest.js\`.`;
  }
  if (kind === 1) {
    return `Create deterministic stage validator test \`tests/stages/stage-${tag}.test.js\` that imports \`STAGE_${tag}\` from \`src/stages/stage-${tag}.js\`, verifies horizontal mirror symmetry, confirms zero unreachable pellet islands via flood-fill from spawn \`(13, 23)\`, and checks warp-row ${warpRow} exit alignment.`;
  }
  return `Implement telemetry & balance profile \`src/telemetry/balance-${tag}.js\` exporting \`evaluateStage${tag}Balance(stage)\` to compute shortest pellet-clear lower bound, intersection density, dead-end ratio, and ghost pressure score for \`STAGE_${tag}\` ("${theme} #${serial}"), appending its summary entry to \`docs/STAGE_CATALOG.md\`.`;
}

export const programmingScenario: ScenarioDefinition = {
  mode: "programming",
  title: "Pac-Man Feature-Rich Arcade Game",
  systemTaskBrief: [
    "You are an expert game developer building a complete, feature-rich Pac-Man arcade game and modular engine in the workspace.",
    "Deliver a playable HTML/Canvas/JS implementation across `index.html`, `game.js`, and `style.css`, plus modular `src/engine/`, `src/stages/`, and `tests/` components as requested.",
    "Retain any session-only governance briefings in conversation memory without writing them to files, and execute each turn's new engineering deliverable using workspace tools."
  ].join(" "),

  seedWorkspace(sandbox: Sandbox): void {
    sandbox.write(
      "README.md",
      `# Pac-Man Project\n\nBuild a complete HTML5 Canvas Pac-Man game with full ghost AI, scoring, levels, and modular engine subsystems.\n`
    );
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const needles = getDomainNeedlesForScale("programming", scale);
    const { briefingsByTurn, probesByTurn } = scheduleStratifiedNeedles(totalTurns, needles);
    const turns: ScenarioTurn[] = [];
    let workIndex = 0;

    for (let t = 1; t <= totalTurns; t++) {
      const probe = probesByTurn.get(t);
      if (probe) {
        turns.push({
          turnIndex: t,
          userMessage: probe.question,
          isProbe: true,
          probeId: probe.probeId,
          expectedKeywords: probe.expectedKeywords,
          ...(probe.staleKeywords ? { staleKeywords: probe.staleKeywords } : {})
        });
        continue;
      }
      const workPrompt = buildProgrammingWorkPrompt(workIndex++);
      const briefings = briefingsByTurn.get(t);
      turns.push({
        turnIndex: t,
        userMessage: briefings ? `${briefings.join("\n\n")}\n\nWorkspace Task [Turn ${t}]: ${workPrompt}` : workPrompt
      });
    }

    return turns;
  },

  rubric: PACMAN_FEATURES.map((feat) => ({
    id: feat.id,
    name: feat.name,
    weight: 1,
    kind: "async-container" as const
  })),

  verifyWorkspace(sandbox: Sandbox): string {
    const hasHtml = sandbox.exists("index.html");
    const hasJs = sandbox.exists("game.js");
    const hasCss = sandbox.exists("style.css");
    let jsSize = 0;
    if (hasJs) {
      try {
        jsSize = sandbox.read("game.js").length;
      } catch {}
    }
    return [
      "Pac-Man Workspace Status:",
      `[${hasHtml ? "x" : " "}] index.html`,
      `[${hasJs ? "x" : " "}] game.js (${jsSize} bytes)`,
      `[${hasCss ? "x" : " "}] style.css`,
      "Note: Functional features verified via Playwright in isolated container."
    ].join("\n");
  }
};

// ============================================================================
// 2. Research Mode: Vulnerability Research & Defense-in-Depth Hardening
// ============================================================================

export const PLANTED_VULNS = [
  { id: "vuln-sql", name: "SQL Injection in User Search", file: "src/db/users.js", kw: ["sql", "injection", "query", "raw", "concatenate"] },
  { id: "vuln-traversal", name: "Path Traversal in File Downloader", file: "src/api/files.js", kw: ["traversal", "path", "../", "arbitrary"] },
  { id: "vuln-rce", name: "Command Injection in Image Converter", file: "src/utils/media.js", kw: ["command", "exec", "injection", "spawn"] },
  { id: "vuln-secret", name: "Hardcoded API Key and JWT Secret", file: "src/config/auth.js", kw: ["hardcoded", "secret", "jwt", "key"] },
  { id: "vuln-xss", name: "Stored XSS in Comment Handler", file: "src/api/comments.js", kw: ["xss", "script", "escape", "sanitize"] },
  { id: "vuln-auth", name: "Broken Object Level Authorization (BOLA)", file: "src/api/orders.js", kw: ["bola", "idor", "authorization", "ownership"] }
];

const RESEARCH_CORE_TASKS: readonly string[] = [
  "Begin the security audit. Use `list_files` and `grep` to inventory `src/` and initialize `AUDIT_REPORT.md` with an Executive Summary and Attack Surface Matrix.",
  "Audit `src/db/users.js` for SQL injection vulnerabilities, document root cause, exploit payload, and parameterized-query remediation in `AUDIT_REPORT.md`, and remediate `src/db/users.js`.",
  "Audit `src/api/files.js` for path traversal flaws, document `../` escape vectors and canonical root-prefix containment in `AUDIT_REPORT.md`, and patch `src/api/files.js`.",
  "Audit `src/utils/media.js` for shell command injection in `convertImage`, document `execFile` argument-array remediation in `AUDIT_REPORT.md`, and patch `src/utils/media.js`.",
  "Inspect `src/config/auth.js`, document the hardcoded JWT/API credential vulnerability and `process.env` secret-loading fix in `AUDIT_REPORT.md`, and refactor `src/config/auth.js` to load secrets strictly from environment variables.",
  "Audit `src/api/comments.js` for stored XSS in `renderComment`, document context-aware HTML entity escaping in `AUDIT_REPORT.md`, and patch `src/api/comments.js`.",
  "Audit `src/api/orders.js` for Broken Object Level Authorization (BOLA/IDOR) in `getOrder`, document caller ownership verification (`req.user.id === order.ownerId`) in `AUDIT_REPORT.md`, and patch `src/api/orders.js`.",
  "Verify `AUDIT_REPORT.md` covers all six `src/` findings with severity ratings, root causes, and concrete remediation guidance using `check_work`."
];

const SECURITY_CONTROLS: readonly { slug: string; cwe: string; title: string; exportFn: string }[] = [
  { slug: "ssrf-guard", cwe: "CWE-918", title: "Outbound URL & Private CIDR SSRF Blocker", exportFn: "validateOutboundUrl" },
  { slug: "proto-shield", cwe: "CWE-1321", title: "Deep Merge Prototype Pollution Sanitizer", exportFn: "safeDeepMerge" },
  { slug: "jwt-verifier", cwe: "CWE-347", title: "Strict Algorithm-Pinned JWT Claims Verifier", exportFn: "verifyPinnedJwt" },
  { slug: "hmac-webhook", cwe: "CWE-294", title: "Constant-Time HMAC-SHA256 & Replay Nonce Guard", exportFn: "verifyWebhookSignature" },
  { slug: "csrf-token", cwe: "CWE-352", title: "Signed Double-Submit CSRF Token Validator", exportFn: "verifyCsrfRequest" },
  { slug: "graphql-cost", cwe: "CWE-400", title: "GraphQL AST Query Depth & Complexity Limiter", exportFn: "analyzeQueryComplexity" },
  { slug: "redos-safe", cwe: "CWE-1333", title: "Linear-Time Input Pattern & Length Gate", exportFn: "validateSafePattern" },
  { slug: "csp-builder", cwe: "CWE-693", title: "Per-Request Nonce Content-Security-Policy Builder", exportFn: "buildStrictCspHeader" },
  { slug: "rbac-policy", cwe: "CWE-285", title: "Tenant-Scoped RBAC & Resource Ownership Policy Engine", exportFn: "authorizeResourceAction" },
  { slug: "pii-redactor", cwe: "CWE-532", title: "Structured Log Secret & PII Field Redactor", exportFn: "redactSensitiveLog" },
  { slug: "upload-sniffer", cwe: "CWE-434", title: "Magic-Byte MIME Sniffer & Filename Sanitizer", exportFn: "validateUploadedBuffer" },
  { slug: "session-rotator", cwe: "CWE-384", title: "Privilege-Escalation Session ID Rotator", exportFn: "rotateAuthenticatedSession" },
  { slug: "pkce-verifier", cwe: "CWE-346", title: "OAuth2 S256 PKCE & State Nonce Validator", exportFn: "verifyPkceExchange" },
  { slug: "xml-safe-parser", cwe: "CWE-611", title: "External-Entity-Disabled XML/plist Sanitizer", exportFn: "rejectExternalEntities" },
  { slug: "deser-allowlist", cwe: "CWE-502", title: "Schema-Allowlisted JSON Envelope Deserializer", exportFn: "parseTrustedEnvelope" },
  { slug: "audit-hashchain", cwe: "CWE-353", title: "Tamper-Evident SHA-256 Audit Log Hash Chain", exportFn: "appendAuditChainEntry" },
  { slug: "rate-bucket", cwe: "CWE-799", title: "Sliding-Window AuthBruteForce Lockout Limiter", exportFn: "checkAuthAttemptBudget" },
  { slug: "redirect-guard", cwe: "CWE-601", title: "Same-Origin & Allowlist Open-Redirect Filter", exportFn: "sanitizeReturnToPath" },
  { slug: "header-sanitizer", cwe: "CWE-113", title: "CRLF HTTP Response Splitting Header Validator", exportFn: "assertCleanHeaderValue" },
  { slug: "zip-slip-guard", cwe: "CWE-22", title: "Archive Entry Zip-Slip & Compression-Bomb Guard", exportFn: "validateArchiveEntries" }
];

function buildResearchWorkPrompt(workIndex: number): string {
  if (workIndex < RESEARCH_CORE_TASKS.length) {
    return RESEARCH_CORE_TASKS[workIndex]!;
  }
  const offset = workIndex - RESEARCH_CORE_TASKS.length;
  const phase = offset % 4;
  const serial = Math.floor(offset / 4) + 1;
  const ctrl = SECURITY_CONTROLS[(serial - 1) % SECURITY_CONTROLS.length]!;
  const round = Math.floor((serial - 1) / SECURITY_CONTROLS.length) + 1;
  const modId = round === 1 ? ctrl.slug : `${ctrl.slug}-v${round}`;
  const tag = String(serial).padStart(3, "0");

  if (phase === 0) {
    return `Security Hardening [#${tag} · ${ctrl.cwe}]: Implement \`src/security/${modId}.js\` exporting \`${ctrl.exportFn}\` (${ctrl.title}, profile rev ${round}) with explicit input validation, deterministic error codes, and zero external dependencies.`;
  }
  if (phase === 1) {
    return `Adversarial Regression Suite [#${tag} · ${ctrl.cwe}]: Create \`tests/security/${modId}.test.js\` exercising \`${ctrl.exportFn}\` from \`src/security/${modId}.js\` against bypass payloads (null bytes, Unicode normalization, boundary overflows, case-folding tricks) and benign baseline inputs.`;
  }
  if (phase === 2) {
    return `Threat Model & Advisory [#${tag} · ${ctrl.cwe}]: Author \`docs/advisories/ADV-${tag}-${modId}.md\` documenting threat actor preconditions, trust boundaries, STRIDE classification, and residual risk controls for \`src/security/${modId}.js\`.`;
  }
  return `Policy Scanner Rule [#${tag} · ${ctrl.cwe}]: Implement static-check helper \`src/scanners/rule-${tag}-${modId}.js\` exporting \`scanFor${ctrl.exportFn[0]!.toUpperCase()}${ctrl.exportFn.slice(1)}Bypass(sourceText, filePath)\` to flag unsafe patterns across JS files and append a summary row under '## Security Scanners' in \`AUDIT_REPORT.md\` using \`edit_file\` (preserving all initial vulnerability findings in \`AUDIT_REPORT.md\`).`;
}

export const researchScenario: ScenarioDefinition = {
  mode: "research",
  title: "Application Security Vulnerability Audit",
  systemTaskBrief: [
    "You are a principal security engineer conducting a thorough code audit and progressive security hardening of a web application in the workspace.",
    "Examine all source files in `src/`, identify planted vulnerabilities, maintain `AUDIT_REPORT.md` with root causes and remediations (preserving all initial vulnerability findings as new scanner rules are added), retain session-only governance briefings in memory, and build defense-in-depth security modules on each turn."
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
    const needles = getDomainNeedlesForScale("research", scale);
    const { briefingsByTurn, probesByTurn } = scheduleStratifiedNeedles(totalTurns, needles);
    const turns: ScenarioTurn[] = [];
    let workIndex = 0;

    for (let t = 1; t <= totalTurns; t++) {
      const probe = probesByTurn.get(t);
      if (probe) {
        turns.push({
          turnIndex: t,
          userMessage: probe.question,
          isProbe: true,
          probeId: probe.probeId,
          expectedKeywords: probe.expectedKeywords,
          ...(probe.staleKeywords ? { staleKeywords: probe.staleKeywords } : {})
        });
        continue;
      }
      const workPrompt = buildResearchWorkPrompt(workIndex++);
      const briefings = briefingsByTurn.get(t);
      turns.push({
        turnIndex: t,
        userMessage: briefings ? `${briefings.join("\n\n")}\n\nWorkspace Task [Turn ${t}]: ${workPrompt}` : workPrompt
      });
    }

    return turns;
  },

  rubric: PLANTED_VULNS.map((vuln) => ({
    id: vuln.id,
    name: vuln.name,
    weight: 1,
    check: (sandbox: Sandbox) => {
      try {
        if (!sandbox.exists("AUDIT_REPORT.md")) return false;
        const report = sandbox.read("AUDIT_REPORT.md").toLowerCase();
        const fileName = vuln.file.split("/").pop()!.toLowerCase();
        const mentionsFile = report.includes(fileName) || report.includes(vuln.file.toLowerCase());
        const hasKeyword = vuln.kw.some((k) => report.includes(k.toLowerCase()));
        const hasFix = report.includes("remediation") || report.includes("mitigation") || report.includes("fix") || report.includes("patch") || report.includes("prepared") || report.includes("parameter");
        return mentionsFile && hasKeyword && hasFix;
      } catch {
        return false;
      }
    }
  })),

  verifyWorkspace(sandbox: Sandbox): string {
    const hasReport = sandbox.exists("AUDIT_REPORT.md");
    if (!hasReport) return "Security Audit: AUDIT_REPORT.md not yet created.";
    let report = "";
    try { report = sandbox.read("AUDIT_REPORT.md"); } catch {}
    const lines = report.split("\n");
    const headingCount = lines.filter((l) => /^#+\s+/i.test(l.trim())).length;
    const hasExecSummary = /executive\s+summary|overview/i.test(report);
    const hasRemediation = /remediation|mitigation|patch/i.test(report);
    return [
      "Security Audit Report Progress:",
      `[${hasReport ? "x" : " "}] AUDIT_REPORT.md present (${report.length} bytes)`,
      `[${hasExecSummary ? "x" : " "}] Executive summary / overview`,
      `[${headingCount > 2 ? "x" : " "}] Vulnerability findings sections (${headingCount} sections)`,
      `[${hasRemediation ? "x" : " "}] Remediation / mitigation guidance`
    ].join("\n");
  }
};

// ============================================================================
// 3. General Mode: Production TypeScript Numerical & Data Platform
// ============================================================================

const GENERAL_CORE_TASKS: readonly string[] = [
  "Inspect `package.json` and expand `src/index.ts` with finite-number validation plus `subtract`, `multiply`, and safe `divide`.",
  "Create `src/errors.ts` exporting custom `MathError`, `DimensionMismatchError`, and `SingularMatrixError` classes with structured `code` fields.",
  "Implement `src/matrix.ts` exporting dense 2D `matrixAdd`, `matrixMultiply`, `matrixTranspose`, and `matrixIdentity` using `DimensionMismatchError`.",
  "Create `src/validate.ts` exporting `assertFiniteVector`, `assertRectangularMatrix`, and `assertSameShape` input guards and integrate them into `src/matrix.ts`.",
  "Update `docs/ARCHITECTURE.md` with a comprehensive architectural specification covering module boundaries, matrix algorithms, complexity guarantees, and usage examples.",
  "Create `tests/matrix.test.ts` with unit tests covering `matrixAdd`, `matrixMultiply`, `matrixTranspose`, identity invariants, and dimension mismatch errors.",
  "Implement compressed sparse row (`CSRMatrix`) representation in `src/sparse.ts` with `fromDense`, `toDense`, and `csrMatVec`.",
  "Update `package.json` `exports` map to expose `.`, `./matrix`, `./sparse`, `./validate`, and `./errors`, and re-export public APIs from `src/index.ts`."
];

const GENERAL_MODULES: readonly { dir: string; slug: string; fnName: string; desc: string }[] = [
  { dir: "linalg", slug: "lu-decomp", fnName: "luDecompose", desc: "partial-pivoting PA=LU factorization with forward/back substitution solver" },
  { dir: "linalg", slug: "qr-householder", fnName: "qrHouseholder", desc: "Householder reflection QR decomposition and least-squares solver" },
  { dir: "linalg", slug: "cholesky", fnName: "choleskyFactor", desc: "symmetric positive-definite LL^T Cholesky factorization" },
  { dir: "linalg", slug: "conjugate-grad", fnName: "conjugateGradient", desc: "iterative sparse symmetric positive-definite linear solver with tolerance & maxIter" },
  { dir: "linalg", slug: "power-eigen", fnName: "dominantEigenpair", desc: "Rayleigh-quotient power & inverse-iteration eigenpair estimator" },
  { dir: "linalg", slug: "tridiagonal", fnName: "solveTridiagonal", desc: "O(n) Thomas algorithm solver for diagonally dominant tridiagonal systems" },
  { dir: "linalg", slug: "kronecker", fnName: "kroneckerProduct", desc: "block Kronecker tensor product and vectorization (`vec`/`unvec`) operators" },
  { dir: "linalg", slug: "norms", fnName: "matrixNorms", desc: "Frobenius, L1, L-infinity, and condition-number lower-bound estimators" },
  { dir: "stats", slug: "welford", fnName: "OnlineStatsAccumulator", desc: "numerically stable Welford streaming mean, variance, skewness, and mergeable state" },
  { dir: "stats", slug: "quantiles", fnName: "exactAndP2Quantiles", desc: "linear-interpolated exact quantiles and streaming P-square percentile estimator" },
  { dir: "stats", slug: "ols-regression", fnName: "fitOrdinaryLeastSquares", desc: "QR-backed ordinary least squares with R^2, residuals, and standard errors" },
  { dir: "stats", slug: "ridge-regression", fnName: "fitRidgeRegression", desc: "L2-regularized Tikhonov linear regression with cross-validation score" },
  { dir: "stats", slug: "autocorr", fnName: "autocorrelationSeries", desc: "lag-k autocorrelation, covariance matrix, and Durbin-Watson statistic" },
  { dir: "numeric", slug: "autodiff-dual", fnName: "DualNumber", desc: "forward-mode automatic differentiation dual arithmetic (`sin`, `cos`, `exp`, `log`, `pow`)" },
  { dir: "numeric", slug: "rk4-ode", fnName: "integrateRK4", desc: "4th-order Runge-Kutta and adaptive Dormand-Prince RK45 ODE initial-value integrator" },
  { dir: "numeric", slug: "root-brent", fnName: "brentRoot", desc: "bracketed Brent-Dekker hybrid secant/bisection root finder" },
  { dir: "numeric", slug: "simpson-quad", fnName: "adaptiveSimpson", desc: "recursive adaptive Simpson numerical quadrature with error bound" },
  { dir: "numeric", slug: "fft-radix2", fnName: "fftRadix2", desc: "Cooley-Tukey iterative bit-reversed radix-2 complex FFT and inverse FFT" },
  { dir: "numeric", slug: "chebyshev", fnName: "chebyshevInterpolate", desc: "Chebyshev-node barycentric polynomial interpolation avoiding Runge oscillation" },
  { dir: "numeric", slug: "nelder-mead", fnName: "minimizeNelderMead", desc: "derivative-free simplex optimization with reflection, expansion, and contraction" },
  { dir: "structs", slug: "ring-buffer", fnName: "TypedRingBuffer", desc: "power-of-two Float64 circular sliding window with O(1) push/pop/at" },
  { dir: "structs", slug: "fenwick-tree", fnName: "FenwickTree", desc: "1-indexed binary indexed tree for O(log n) point updates and prefix/range sums" },
  { dir: "structs", slug: "disjoint-set", fnName: "DisjointSetUnion", desc: "path-compressed union-by-rank disjoint set forest with component sizes" },
  { dir: "structs", slug: "lru-cache", fnName: "DeterministicLruCache", desc: "doubly-linked-list O(1) LRU cache with hit/miss/eviction counters" },
  { dir: "structs", slug: "interval-tree", fnName: "AugmentedIntervalTree", desc: "augmented max-endpoint BST supporting stabbing and overlap range queries" }
];

function buildGeneralWorkPrompt(workIndex: number): string {
  if (workIndex < GENERAL_CORE_TASKS.length) {
    return GENERAL_CORE_TASKS[workIndex]!;
  }
  const offset = workIndex - GENERAL_CORE_TASKS.length;
  const phase = offset % 4;
  const serial = Math.floor(offset / 4) + 1;
  const mod = GENERAL_MODULES[(serial - 1) % GENERAL_MODULES.length]!;
  const gen = Math.floor((serial - 1) / GENERAL_MODULES.length) + 1;
  const fileSlug = gen === 1 ? mod.slug : `${mod.slug}-ext${gen}`;
  const tag = String(serial).padStart(3, "0");

  if (phase === 0) {
    return `Module Implementation [#${tag}]: Create \`src/${mod.dir}/${fileSlug}.ts\` exporting \`${mod.fnName}${gen > 1 ? `Ext${gen}` : ""}\` (${mod.desc}, capability tier ${gen}) with strict TypeScript types and \`MathError\` validation.`;
  }
  if (phase === 1) {
    return `Unit Verification [#${tag}]: Create \`tests/${mod.dir}/${fileSlug}.test.ts\` testing \`src/${mod.dir}/${fileSlug}.ts\` across analytical reference cases, boundary inputs, NaN/Infinity rejection, and numerical precision tolerances.`;
  }
  if (phase === 2) {
    return `Batch & TypedArray Adapter [#${tag}]: Extend \`src/${mod.dir}/${fileSlug}.ts\` with a zero-copy \`Float64Array\` batch helper \`run${mod.fnName[0]!.toUpperCase()}${mod.fnName.slice(1)}Batch${gen > 1 ? `Ext${gen}` : ""}\` and export its signature from \`src/${mod.dir}/index.ts\`.`;
  }
  return `Architecture RFC [#${tag}]: Create \`docs/rfcs/RFC-${tag}-${fileSlug}.md\` documenting algorithmic complexity, numerical stability bounds, memory layout, and API contract for \`src/${mod.dir}/${fileSlug}.ts\`, and link it in \`docs/ARCHITECTURE.md\`.`;
}

export const generalScenario: ScenarioDefinition = {
  mode: "general",
  title: "General Software Engineering Session",
  systemTaskBrief: [
    "You are an autonomous senior engineer building and expanding a production TypeScript numerical and data-structures library.",
    "Retain any session-only governance briefings in conversation memory without writing them to files, and author complete, modular TypeScript deliverables on every turn."
  ].join(" "),

  seedWorkspace(sandbox: Sandbox): void {
    sandbox.write("package.json", JSON.stringify({ name: "core-lib", version: "1.0.0" }, null, 2));
    sandbox.write("src/index.ts", `export function calculate(a: number, b: number): number {\n  return a + b;\n}\n`);
    sandbox.write("docs/ARCHITECTURE.md", `# System Architecture\nInitial architecture specification.\n`);
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const needles = getDomainNeedlesForScale("general", scale);
    const { briefingsByTurn, probesByTurn } = scheduleStratifiedNeedles(totalTurns, needles);
    const turns: ScenarioTurn[] = [];
    let workIndex = 0;

    for (let t = 1; t <= totalTurns; t++) {
      const probe = probesByTurn.get(t);
      if (probe) {
        turns.push({
          turnIndex: t,
          userMessage: probe.question,
          isProbe: true,
          probeId: probe.probeId,
          expectedKeywords: probe.expectedKeywords,
          ...(probe.staleKeywords ? { staleKeywords: probe.staleKeywords } : {})
        });
        continue;
      }
      const workPrompt = buildGeneralWorkPrompt(workIndex++);
      const briefings = briefingsByTurn.get(t);
      turns.push({
        turnIndex: t,
        userMessage: briefings ? `${briefings.join("\n\n")}\n\nWorkspace Task [Turn ${t}]: ${workPrompt}` : workPrompt
      });
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
// 4. Memory Mode: Stratified Deep-Horizon & Override Needle Recall
// ============================================================================

const MEMORY_INIT_TASKS: readonly string[] = [
  "Workspace Initialization [Turn 1]: Create `src/config/env-schema.ts` exporting `parseRuntimeEnv(env: Record<string, string | undefined>)` that validates `SERVICE_NAME`, `LOG_LEVEL`, and `WORKER_CONCURRENCY` with sensible defaults.",
  "Create `src/middleware/request-id.ts` exporting `attachCorrelationId(headers: Record<string, string>)` generating deterministic or UUIDv4 `x-request-id` values when absent.",
  "Create `src/health/readiness.ts` exporting `evaluateReadiness(checks: Record<string, () => boolean>)` returning aggregate `healthy`/`degraded` status and per-subsystem results."
];

const MEMORY_PLATFORM_MODULES: readonly { domain: string; slug: string; exportSym: string; summary: string }[] = [
  { domain: "routing", slug: "radix-router", exportSym: "RadixRouter", summary: "parameterized `:id` and wildcard `*` path segment HTTP route matcher" },
  { domain: "resilience", slug: "circuit-breaker", exportSym: "CircuitBreaker", summary: "closed/open/half-open failure-threshold state machine with cooldown timer" },
  { domain: "resilience", slug: "retry-backoff", exportSym: "computeJitteredBackoff", summary: "decorrelated exponential backoff schedule with retry-budget enforcement" },
  { domain: "resilience", slug: "bulkhead", exportSym: "BulkheadSemaphore", summary: "bounded concurrency permit pool with bounded FIFO wait queue and timeout rejection" },
  { domain: "ratelimit", slug: "token-bucket", exportSym: "TokenBucketLimiter", summary: "monotonic refill-rate token bucket per client key with `retryAfterMs` calculation" },
  { domain: "ratelimit", slug: "sliding-log", exportSym: "SlidingWindowCounter", summary: "sub-window weighted sliding-window request rate estimator" },
  { domain: "caching", slug: "singleflight", exportSym: "SingleFlightGroup", summary: "in-flight promise coalescer preventing thundering-herd duplicate backend loads" },
  { domain: "caching", slug: "ttl-store", exportSym: "TieredTtlCache", summary: "stale-while-revalidate in-memory TTL cache with soft and hard expiration" },
  { domain: "messaging", slug: "event-bus", exportSym: "TypedEventBus", summary: "topic subscription dispatcher with wildcard listeners and dead-letter capture" },
  { domain: "messaging", slug: "outbox-relay", exportSym: "TransactionalOutbox", summary: "idempotent outbox batch claimer with lease expiration and retry count" },
  { domain: "observability", slug: "trace-context", exportSym: "W3CTraceParent", summary: "W3C `traceparent` `00-<traceId>-<spanId>-<flags>` parser and child-span generator" },
  { domain: "observability", slug: "histogram", exportSym: "HdrBucketHistogram", summary: "logarithmic latency bucket histogram computing p50, p90, p99, and sum/count" },
  { domain: "observability", slug: "structured-logger", exportSym: "JsonLogSink", summary: "level-filtered structured JSON logger with child context bindings" },
  { domain: "data", slug: "cursor-pager", exportSym: "CursorPaginator", summary: "opaque base64url keyset pagination encoder/decoder with sort-tiebreaker cursor" },
  { domain: "data", slug: "schema-validator", exportSym: "compileObjectSchema", summary: "declarative runtime field validator returning path-prefixed validation issues" },
  { domain: "data", slug: "migration-runner", exportSym: "MigrationPlanner", summary: "checksum-verified ordered migration planner detecting out-of-order or altered steps" },
  { domain: "tenancy", slug: "quota-ledger", exportSym: "TenantQuotaLedger", summary: "multi-tenant daily/monthly usage quota tracker with soft-warn and hard-cap thresholds" },
  { domain: "tenancy", slug: "feature-flags", exportSym: "FeatureFlagEvaluator", summary: "deterministic FNV-1a percentage rollout and tenant-allowlist flag evaluator" },
  { domain: "jobs", slug: "cron-parser", exportSym: "parseCronSchedule", summary: "5-field cron expression parser computing `nextRunAfter(timestamp)`" },
  { domain: "jobs", slug: "dag-scheduler", exportSym: "TaskDagRunner", summary: "topological dependency wave executor surfacing cycle errors and upstream failures" },
  { domain: "streams", slug: "ndjson-framer", exportSym: "NdjsonLineFramer", summary: "chunked streaming newline-delimited JSON parser handling split multi-chunk lines" },
  { domain: "streams", slug: "backpressure-queue", exportSym: "BoundedAsyncQueue", summary: "high/low watermark async iterator queue with producer backpressure" },
  { domain: "authz", slug: "scope-matcher", exportSym: "matchOAuthScopes", summary: "hierarchical `resource:action` scope matcher supporting read/write supersets" },
  { domain: "authz", slug: "api-key-ring", exportSym: "ApiKeyRing", summary: "prefix-indexed SHA-256 hashed API key verifier supporting zero-downtime key rotation" },
  { domain: "sync", slug: "vector-clock", exportSym: "VectorClock", summary: "causal partial-order vector clock (`increment`, `merge`, `compare` concurrent vs happens-before)" }
];

function buildMemoryWorkPrompt(workIndex: number): string {
  if (workIndex < MEMORY_INIT_TASKS.length) {
    return MEMORY_INIT_TASKS[workIndex]!;
  }
  const offset = workIndex - MEMORY_INIT_TASKS.length;
  const phase = offset % 4;
  const serial = Math.floor(offset / 4) + 1;
  const mod = MEMORY_PLATFORM_MODULES[(serial - 1) % MEMORY_PLATFORM_MODULES.length]!;
  const rev = Math.floor((serial - 1) / MEMORY_PLATFORM_MODULES.length) + 1;
  const fileSlug = rev === 1 ? mod.slug : `${mod.slug}-v${rev}`;
  const sym = rev === 1 ? mod.exportSym : `${mod.exportSym}V${rev}`;
  const tag = String(serial).padStart(3, "0");

  if (phase === 0) {
    return `Platform Task [#${tag}A · ${mod.domain}]: Create \`src/${mod.domain}/${fileSlug}.ts\` exporting \`${sym}\` (${mod.summary}, revision ${rev}) with complete TypeScript interfaces and deterministic behavior.`;
  }
  if (phase === 1) {
    return `Platform Task [#${tag}B · ${mod.domain}]: Create unit test suite \`tests/${mod.domain}/${fileSlug}.test.ts\` verifying \`${sym}\` from \`src/${mod.domain}/${fileSlug}.ts\` across happy paths, boundary conditions, and error states.`;
  }
  if (phase === 2) {
    return `Platform Task [#${tag}C · ${mod.domain}]: Wire \`${sym}\` into \`src/${mod.domain}/index.ts\` and add health/diagnostic snapshot helper \`inspect${sym}(instance)\` in \`src/${mod.domain}/${fileSlug}.ts\`.`;
  }
  return `Platform Task [#${tag}D · ${mod.domain}]: Author operational runbook \`docs/runbooks/RB-${tag}-${fileSlug}.md\` covering failure modes, alert thresholds, and recovery steps for \`${sym}\` (\`src/${mod.domain}/${fileSlug}.ts\`).`;
}

export const memoryScenario: ScenarioDefinition = {
  mode: "memory",
  title: "Stratified Long-Session Factual & Override Needle Recall",
  systemTaskBrief: [
    "You are an autonomous backend engineer managing a long-running platform engineering session.",
    "Retain critical operational briefings, credentials, headers, limits, and policy overrides in your session memory (NEVER write them to repository files), always honoring the latest override when a policy is superseded, while implementing each turn's new TypeScript platform module."
  ].join(" "),

  seedWorkspace(sandbox: Sandbox): void {
    sandbox.write("README.md", "# Platform Core Service\n\nModular TypeScript backend service workspace.\n");
    sandbox.write("src/service.ts", "// Core service entrypoint\nexport function start(): { started: boolean } {\n  return { started: true };\n}\n");
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const needles = getMemoryNeedlesForScale(scale);
    const { briefingsByTurn, probesByTurn } = scheduleStratifiedNeedles(totalTurns, needles);
    const turns: ScenarioTurn[] = [];
    let workIndex = 0;

    for (let t = 1; t <= totalTurns; t++) {
      const probe = probesByTurn.get(t);
      if (probe) {
        turns.push({
          turnIndex: t,
          userMessage: probe.question,
          isProbe: true,
          probeId: probe.probeId,
          expectedKeywords: probe.expectedKeywords,
          ...(probe.staleKeywords ? { staleKeywords: probe.staleKeywords } : {})
        });
        continue;
      }

      const workPrompt = buildMemoryWorkPrompt(workIndex++);
      const briefings = briefingsByTurn.get(t);
      turns.push({
        turnIndex: t,
        userMessage: briefings
          ? `${briefings.join("\n\n")}\n\nWorkspace Task [Turn ${t}]: ${workPrompt}`
          : workPrompt
      });
    }

    return turns;
  },

  rubric: MEMORY_NEEDLE_CATALOG.map((n) => ({
    id: n.key,
    name: `Recall Needle: ${n.key}`,
    weight: 1,
    kind: "probe"
  })),

  verifyWorkspace(): string {
    return "Memory scenario: evaluated via stratified deep-horizon & override recall probes.";
  }
};

// ============================================================================
// 5. All Mode: Full-Spectrum Multi-Discipline Marathon
// ============================================================================

export const allScenario: ScenarioDefinition = {
  mode: "all",
  title: "Full-Spectrum Agentic Marathon (Programming + Research + General + Memory)",
  systemTaskBrief:
    "You are an expert software engineer and security researcher operating in a long-lived project environment.\n" +
    "Across this continuous session, you will tackle all engineering disciplines:\n" +
    "1. Programming: Build a complete Pac-Man game with HTML5 Canvas, collision, scoring, and ghost AI.\n" +
    "2. Security Research: Audit, exploit, and patch high-severity vulnerabilities in an Express API server.\n" +
    "3. General Engineering: Implement a high-performance linear algebra and matrix mathematics library.\n" +
    "4. Memory & Reliability: Retain session-only operational parameters and policy overrides (honoring latest overrides; never writing secrets to files).\n" +
    "Every turn assigns new engineering deliverables—use your tools to inspect, author, test, and maintain code across all files.",

  seedWorkspace(sandbox: Sandbox): void {
    programmingScenario.seedWorkspace(sandbox);
    researchScenario.seedWorkspace(sandbox);
    generalScenario.seedWorkspace(sandbox);
    memoryScenario.seedWorkspace(sandbox);
  },

  generateTurns(scale: ContextScale): ScenarioTurn[] {
    const totalTurns = SCALE_TURNS[scale];
    const needles = getMemoryNeedlesForScale(scale);
    const { briefingsByTurn, probesByTurn } = scheduleStratifiedNeedles(totalTurns, needles);
    const turns: ScenarioTurn[] = [];

    const p1End = Math.max(2, Math.floor(totalTurns * 0.28));
    const p2End = Math.max(p1End + 1, Math.floor(totalTurns * 0.55));
    const p3End = Math.max(p2End + 1, Math.floor(totalTurns * 0.80));

    let progWork = 0;
    let resWork = 0;
    let genWork = 0;
    let memWork = 0;

    for (let t = 1; t <= totalTurns; t++) {
      const probe = probesByTurn.get(t);
      if (probe) {
        turns.push({
          turnIndex: t,
          userMessage: probe.question,
          isProbe: true,
          probeId: probe.probeId,
          expectedKeywords: probe.expectedKeywords,
          ...(probe.staleKeywords ? { staleKeywords: probe.staleKeywords } : {})
        });
        continue;
      }

      let workPrompt: string;
      if (t <= p1End) {
        workPrompt = `[Programming Phase] ${buildProgrammingWorkPrompt(progWork++)}`;
      } else if (t <= p2End) {
        workPrompt = `[Security Research Phase] ${buildResearchWorkPrompt(resWork++)}`;
      } else if (t <= p3End) {
        workPrompt = `[General Engineering Phase] ${buildGeneralWorkPrompt(genWork++)}`;
      } else {
        workPrompt = `[Platform Integration Phase] ${buildMemoryWorkPrompt(memWork++)}`;
      }

      const briefings = briefingsByTurn.get(t);
      turns.push({
        turnIndex: t,
        userMessage: briefings
          ? `${briefings.join("\n\n")}\n\nWorkspace Task [Turn ${t}]: ${workPrompt}`
          : workPrompt
      });
    }

    return turns;
  },

  rubric: [
    ...programmingScenario.rubric,
    ...researchScenario.rubric,
    ...generalScenario.rubric,
    ...memoryScenario.rubric
  ],

  verifyWorkspace(sandbox: Sandbox): string {
    const r1 = programmingScenario.verifyWorkspace(sandbox);
    const r2 = researchScenario.verifyWorkspace(sandbox);
    const r3 = generalScenario.verifyWorkspace(sandbox);
    return `=== ALL MODES VERIFICATION ===\n${r1}\n${r2}\n${r3}`;
  }
};

export const SCENARIO_REGISTRY: Record<ScenarioMode, ScenarioDefinition> = {
  programming: programmingScenario,
  research: researchScenario,
  general: generalScenario,
  memory: memoryScenario,
  all: allScenario
};
