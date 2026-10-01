import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Failure } from "../clice/failures.js";

/**
 * `failure`: events stay in memory until something fails; a passing run writes none.
 * `full`: every event is written as it happens (about 70 KB per replayed step).
 */
export type Recording = "failure" | "full";

/** Events kept in memory in `failure` mode: roughly the last 30 steps. */
const recentEventLimit = 400;

/**
 * Writes a run's evidence into its output directory: `events.jsonl` (events with the run
 * context at that moment), `stderr.log` (raw clice stderr) and named artifacts.
 * Writes are synchronous. The first write error is reported once; later writes are skipped.
 *
 * In `failure` mode `events.jsonl` starts with the events leading up to the first failure
 * and continues with everything after it, so late evidence is still captured.
 */
export class Recorder {
  private readonly started = performance.now();
  private readonly events: number;
  private readonly stderr: number;
  private readonly recent: string[] = [];
  private writing: boolean;
  private index = 0;
  error: string | undefined;

  constructor(readonly directory: string, private readonly context: () => object,
    private readonly onError: (failure: Failure) => void, recording: Recording = "full") {
    this.writing = recording === "full";
    this.events = openSync(join(directory, "events.jsonl"), "wx");
    try { this.stderr = openSync(join(directory, "stderr.log"), "wx"); }
    catch (error) { closeSync(this.events); throw error; }
  }

  record(kind: string, data: unknown): void {
    this.guard(() => {
      const line = JSON.stringify({
        index: ++this.index, time: new Date().toISOString(), elapsedMs: performance.now() - this.started,
        ...this.context(), kind, data,
      }) + "\n";
      if (this.writing) writeFileSync(this.events, line);
      else if (this.recent.push(line) > recentEventLimit) this.recent.shift();
    });
  }

  /** A failure happened: write the buffered events and every event from now on. */
  keepEvents(): void {
    if (this.writing) return;
    this.writing = true;
    this.guard(() => writeFileSync(this.events, this.recent.join("")));
    this.recent.length = 0;
  }

  appendStderr(chunk: Buffer): void {
    this.guard(() => {
      for (let offset = 0; offset < chunk.length;) offset += writeSync(this.stderr, chunk, offset);
    });
  }

  /** Artifacts are never overwritten. */
  save(name: string, content: string | Buffer): void {
    this.guard(() => writeFileSync(join(this.directory, name), content, { flag: "wx" }));
  }

  close(): void {
    // Closing must still be attempted after a write error.
    for (const fd of [this.events, this.stderr]) {
      try { closeSync(fd); }
      catch (error) { this.fail(error); }
    }
  }

  private guard(action: () => void): void {
    if (this.error) return;
    try { action(); }
    catch (error) { this.fail(error); }
  }

  private fail(error: unknown): void {
    this.error ??= String(error);
    this.onError({ kind: "recording-error", message: String(error) });
  }
}
