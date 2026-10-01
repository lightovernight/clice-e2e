import { setMaxListeners } from "node:events";
import { performance } from "node:perf_hooks";
import type { Failure, RunObserver } from "../clice/failures.js";
import type { ProbeName } from "../lsp/probes.js";
import { EditBuffer } from "../sequence/edit-buffer.js";
import { StoppedError } from "../util/async.js";
import { Recorder, type Recording } from "./recorder.js";

export type Phase = "starting" | "initialize" | "initial-probe" | "replay" | "cleanup" | "complete";

export interface ActiveRequest {
  readonly traceId: number;
  /** JSON-RPC id, known once the message has been written. */
  id: number | string | null;
  readonly method: string;
}

/** Where the run was when an event or failure happened. Attached to every event. */
export interface RunSnapshot {
  phase: Phase;
  step: number;
  appliedSteps: number;
  completedSteps: number;
  version: number;
  activeRequests: ActiveRequest[];
}

export type Finding = Failure & RunSnapshot & { elapsedMs: number };

export interface RunStats {
  appliedSteps: number;
  completedSteps: number;
  probedSteps: number;
  skippedIncludeSteps: number;
  changesSent: number;
  successfulProbes: number;
  /** Burst typing: requests sent without waiting, those cancelled, and those the server declined. */
  unawaitedProbes: number;
  cancelledProbes: number;
  declinedProbes: number;
  successfulProbesByMethod: Partial<Record<ProbeName, number>>;
}

/**
 * Shared state of one replay run. The first reported failure aborts `signal`: no new edit
 * or request starts afterwards, while listeners keep collecting late evidence.
 */
export class ReplayContext implements RunObserver {
  phase: Phase = "starting";
  /** One-based operation number; zero is the initial empty-document probe. */
  step = 0;
  readonly stats: RunStats = {
    appliedSteps: 0, completedSteps: 0, probedSteps: 0, skippedIncludeSteps: 0,
    changesSent: 0, successfulProbes: 0, unawaitedProbes: 0, cancelledProbes: 0, declinedProbes: 0,
    successfulProbesByMethod: {},
  };
  /** The document as the server should currently see it. */
  readonly document = new EditBuffer();
  readonly activeRequests = new Map<number, ActiveRequest>();
  readonly findings: Finding[] = [];
  readonly recorder: Recorder;
  readonly started = performance.now();
  private readonly controller = new AbortController();

  constructor(outputDirectory: string, recording: Recording) {
    // Every request in flight waits on the signal; a burst has dozens at once.
    setMaxListeners(0, this.controller.signal);
    this.recorder = new Recorder(outputDirectory, () => this.snapshot(), this.report, recording);
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get stopped(): boolean { return this.controller.signal.aborted; }

  snapshot(): RunSnapshot {
    // Copy entries: a finding must keep its original snapshot as requests finish.
    const requests = [...this.activeRequests.values()].map((request) => ({ ...request }));
    return {
      phase: this.phase, step: this.step,
      appliedSteps: this.stats.appliedSteps, completedSteps: this.stats.completedSteps,
      version: this.document.state.version,
      activeRequests: requests,
    };
  }

  // Arrow properties: these are handed out as callbacks.
  readonly record = (kind: string, data: unknown): void => {
    this.recorder.record(kind, data);
  };

  readonly report = (failure: Failure): void => {
    const finding: Finding = { ...failure, ...this.snapshot(), elapsedMs: performance.now() - this.started };
    this.findings.push(finding);
    this.recorder.keepEvents();
    this.recorder.record("finding", finding);
    this.controller.abort();
  };

  throwIfStopped(): void {
    if (this.stopped) throw new StoppedError();
  }
}
