import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { logFailure, type RunObserver } from "./failures.js";

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CliceProcessOptions {
  runtime: string;
  args: readonly string[];
  cwd: string;
  observer: RunObserver;
  /** Raw stderr bytes, for the run's stderr.log. */
  onStderr(chunk: Buffer): void;
}

/**
 * The clice master process: spawn, stderr crash detection and exit classification.
 * Any exit is a failure unless it follows `expectExit()` with code 0, or `forceKill()`.
 * A recovered worker crash stays a failure even when the master later exits cleanly.
 */
export class CliceProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Wall-clock spawn time; also bounds which processes can belong to this run. */
  readonly startedAt = Date.now();
  readonly closed: Promise<void>;
  exitStatus: ExitStatus | null = null;
  forcedCleanup = false;
  private plannedExit = false;
  private hasClosed = false;
  private readonly observer: RunObserver;
  private readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly onError: (error: Error) => void;

  constructor({ runtime, args, cwd, observer, onStderr }: CliceProcessOptions) {
    this.observer = observer;
    this.child = spawn(runtime, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    observer.record("process.spawn", { pid: this.child.pid, runtime, args, startedAt: this.startedAt });

    this.onExit = (code, signal) => {
      const { plannedExit, forcedCleanup } = this;
      observer.record("process.exit", { code, signal, plannedExit, forcedCleanup });
      if (forcedCleanup || (plannedExit && code === 0 && signal === null)) return;
      observer.report({ kind: plannedExit ? "abnormal-exit" : "unexpected-exit", message: "clice master exited.", evidence: { code, signal } });
    };
    this.onError = (error) => observer.report({ kind: "process-error", message: error.message });
    this.child.on("exit", this.onExit);
    this.child.on("error", this.onError);
    this.closed = new Promise((resolve) => this.child.once("close", (code, signal) => {
      this.hasClosed = true;
      this.exitStatus = { code, signal };
      observer.record("process.close", this.exitStatus);
      resolve();
    }));
    this.watchStderr(onStderr);
  }

  get pid(): number | undefined { return this.child.pid; }

  get alive(): boolean {
    return !this.hasClosed && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** The next exit is requested (after LSP `exit`); only a clean exit is accepted. */
  expectExit(): void { this.plannedExit = true; }

  forceKill(): void {
    this.forcedCleanup = true;
    this.observer.record("cleanup.force", { masterPid: this.child.pid });
    this.child.kill("SIGKILL");
  }

  /** Stop classifying exits and release local pipes, even if a broken child kept them open. */
  dispose(): void {
    this.child.off("exit", this.onExit);
    this.child.off("error", this.onError);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  /** Crash markers can be split across chunks; inspect complete lines only. */
  private watchStderr(onStderr: (chunk: Buffer) => void): void {
    const decoder = new StringDecoder("utf8");
    let tail = "";
    const inspect = (text: string, end = false): void => {
      tail += text;
      const lines = tail.split(/\r?\n/);
      tail = end ? "" : lines.pop() ?? "";
      for (const line of lines) {
        const failure = logFailure(line);
        if (failure) this.observer.report({ ...failure, evidence: { source: "stderr", detail: failure.evidence } });
      }
    };
    this.child.stderr.on("data", (chunk: Buffer) => { onStderr(chunk); inspect(decoder.write(chunk)); });
    this.child.stderr.on("end", () => inspect(decoder.end(), true));
    this.child.stderr.on("error", (error) => this.observer.report({ kind: "recording-error", message: `stderr: ${String(error)}` }));
  }
}
