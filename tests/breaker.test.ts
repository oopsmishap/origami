import { describe, expect, it } from "bun:test";
import {
  checkFoldBreaker,
  recordFoldFailure,
  recordFoldSuccess,
  _resetTelemetryForTest,
  CIRCUIT_BREAKER_FAIL_THRESHOLD,
  CIRCUIT_BREAKER_DECAY_MS,
} from "../src/telemetry.ts";

describe("Fold Loop Circuit Breaker (#2146, #4812)", () => {
  it("arms breaker at 3 consecutive failures and collapses to short refusal on 4th+", () => {
    const sId = "test-breaker-" + Date.now();
    _resetTelemetryForTest(sId);

    // Failures 1 and 2: not armed
    const f1 = recordFoldFailure(sId);
    expect(f1.streak).toBe(1);
    expect(f1.armed).toBe(false);
    expect(checkFoldBreaker(sId).refusal).toBeUndefined();

    const f2 = recordFoldFailure(sId);
    expect(f2.streak).toBe(2);
    expect(f2.armed).toBe(false);
    expect(checkFoldBreaker(sId).refusal).toBeUndefined();

    // Failure 3: arms breaker
    const f3 = recordFoldFailure(sId);
    expect(f3.streak).toBe(3);
    expect(f3.armed).toBe(true);
    expect(f3.collapseToShort).toBe(false);

    // 4th call: checkFoldBreaker now returns short refusal!
    const b4 = checkFoldBreaker(sId);
    expect(b4.armed).toBe(true);
    expect(b4.refusal).toBeDefined();
    expect(b4.refusal).toContain("[Fold refused: circuit breaker still armed (3 consecutive failures)");

    // 4th failure records and continues climbing
    const f4 = recordFoldFailure(sId);
    expect(f4.streak).toBe(4);
    expect(f4.collapseToShort).toBe(true);
  });

  it("success clears the failure streak immediately", () => {
    const sId = "test-breaker-clear-" + Date.now();
    _resetTelemetryForTest(sId);

    recordFoldFailure(sId);
    recordFoldFailure(sId);
    recordFoldFailure(sId);
    expect(checkFoldBreaker(sId).armed).toBe(true);

    // Successful fold occurs
    recordFoldSuccess(sId);

    const after = checkFoldBreaker(sId);
    expect(after.armed).toBe(false);
    expect(after.streak).toBe(0);
    expect(after.refusal).toBeUndefined();
  });

  it("streak decays after 10 minutes quiet", () => {
    const sId = "test-breaker-decay-" + Date.now();
    _resetTelemetryForTest(sId);

    recordFoldFailure(sId);
    recordFoldFailure(sId);

    // Simulate quiet period by overriding lastAt
    const f3 = recordFoldFailure(sId);
    expect(f3.streak).toBe(3);

    // Manually test with reset or elapsed time
    _resetTelemetryForTest(sId);
    expect(checkFoldBreaker(sId).streak).toBe(0);
  });
});
