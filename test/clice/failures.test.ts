import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRun, logFailure, type Failure } from "../../src/clice/failures.js";

test("log detector recognizes clice evidence without matching ordinary mentions or source text", () => {
  assert.equal(logFailure("[2026-09-26] [error] [thread 1] [pool.cpp:546] [anomaly:WorkerCrash] Worker SF-0")?.kind, "worker-crash");
  assert.equal(logFailure("=== CRASH STACK TRACE ===")?.kind, "crash-trace");
  assert.equal(logFailure("==123==ERROR: AddressSanitizer: heap-use-after-free")?.kind, "sanitizer");
  assert.equal(logFailure("[anomaly:ASTInvariant] failed")?.kind, "internal-anomaly");
  assert.equal(logFailure('source text: "[anomaly:WorkerCrash]"'), undefined);
  assert.equal(logFailure("error: expected a closing brace"), undefined);
});

test("runs are PASS without findings, FAIL on any server finding and ERROR on harness findings only", () => {
  const failure = (kind: Failure["kind"]): Failure => ({ kind, message: kind });
  assert.deepEqual(classifyRun([]), { status: "PASS", crashDetected: false, masterTerminationDetected: false });
  assert.equal(classifyRun([failure("cleanup-error"), failure("adapter-error")]).status, "ERROR");
  assert.equal(classifyRun([failure("cleanup-error"), failure("request-timeout")]).status, "FAIL");
  assert.equal(classifyRun([failure("worker-crash")]).crashDetected, true);
  assert.equal(classifyRun([failure("request-error")]).crashDetected, false);
  assert.equal(classifyRun([failure("abnormal-exit")]).masterTerminationDetected, true);
});
