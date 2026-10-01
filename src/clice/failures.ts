import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * What can go wrong in a run, how clice reports it, and how a run is classified.
 *
 * Server failures (FAIL): clice crashed, misbehaved or broke the protocol.
 * Harness failures (ERROR): the input, the environment or this tool is at fault.
 */

export type FailureKind =
  // Server-side
  | "worker-crash" | "internal-anomaly" | "crash-trace" | "sanitizer"
  | "unexpected-exit" | "abnormal-exit" | "process-error"
  | "request-error" | "request-timeout" | "protocol-error" | "connection-closed" | "run-timeout"
  // Harness-side
  | "environment-error" | "adapter-error" | "cleanup-error" | "recording-error" | "interrupted";

export interface Failure {
  kind: FailureKind;
  message: string;
  evidence?: unknown;
}

/** Where failures and events from a run are delivered. */
export interface RunObserver {
  record(kind: string, data: unknown): void;
  report(failure: Failure): void;
}

const harnessKinds: ReadonlySet<FailureKind> = new Set(["adapter-error", "environment-error", "recording-error", "cleanup-error", "interrupted"]);
const crashKinds: ReadonlySet<FailureKind> = new Set(["worker-crash", "crash-trace", "sanitizer"]);
const masterTerminationKinds: ReadonlySet<FailureKind> = new Set(["unexpected-exit", "abnormal-exit"]);

export type RunStatus = "PASS" | "FAIL" | "ERROR";

export function classifyRun(failures: readonly Failure[]): {
  status: RunStatus; crashDetected: boolean; masterTerminationDetected: boolean;
} {
  const serverFailure = failures.some((failure) => !harnessKinds.has(failure.kind));
  return {
    status: failures.length === 0 ? "PASS" : serverFailure ? "FAIL" : "ERROR",
    crashDetected: failures.some((failure) => crashKinds.has(failure.kind)),
    masterTerminationDetected: failures.some((failure) => masterTerminationKinds.has(failure.kind)),
  };
}

export const exitCodes: Record<RunStatus, number> = { PASS: 0, FAIL: 1, ERROR: 2 };

// ---------------------------------------------------------------------------------------------
// Detection in clice output. Only log lines are inspected, never diagnostics or source text.

/** clice's `[anomaly:Kind]` marker, as sent in window/logMessage or written to logs. */
export function anomalyFailure(message: string): Failure | undefined {
  const anomaly = /^\[anomaly:([A-Za-z]+)\](?:\s|$)/.exec(message)?.[1];
  if (!anomaly) return undefined;
  return { kind: anomaly === "WorkerCrash" ? "worker-crash" : "internal-anomaly", message, evidence: { anomaly } };
}

const sanitizerLine = /^(?:==\d+==\s*)?(?:ERROR|WARNING|SUMMARY): (?:AddressSanitizer|UndefinedBehaviorSanitizer|ThreadSanitizer|MemorySanitizer|LeakSanitizer):/;

/** One stderr or log-file line; leading `[timestamp] [level] ...` prefixes are skipped. */
export function logFailure(line: string): Failure | undefined {
  const payload = line.replace(/^(?:\[(?!anomaly:)[^\]\r\n]*\]\s*)+/, "").trim();
  const anomaly = anomalyFailure(payload);
  if (anomaly) return anomaly;
  if (payload === "=== CRASH STACK TRACE ===") return { kind: "crash-trace", message: payload };
  if (sanitizerLine.test(payload) || payload.startsWith("AddressSanitizer:DEADLYSIGNAL")) return { kind: "sanitizer", message: payload };
  return undefined;
}

/** Scan every `*.log` under clice's logging directory after the run. */
export async function scanServerLogs(directory: string, report: (failure: Failure) => void): Promise<void> {
  let files: string[];
  try { files = await readdir(directory, { recursive: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const relative of files.filter((file) => file.endsWith(".log"))) {
    const path = join(directory, relative);
    const input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let number = 0;
    try {
      for await (const line of lines) {
        number++;
        const finding = logFailure(line);
        if (finding) report({ ...finding, evidence: { source: "server-log", path, line: number, detail: finding.evidence } });
      }
    } finally { lines.close(); input.destroy(); }
  }
}
