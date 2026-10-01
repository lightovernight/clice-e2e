import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { CancellationTokenSource, LSPErrorCodes, ResponseError, type ServerCapabilities } from "vscode-languageserver-protocol/node.js";
import { classifyRun, scanServerLogs, type RunStatus } from "../clice/failures.js";
import { CliceProcess, type ExitStatus } from "../clice/process.js";
import { cleanupWindowsWorkers } from "../clice/windows/workers.js";
import { offsetAt, positionAt } from "../lsp/positions.js";
import { acceptsProbeResult, clientCapabilities, probeMethod, probeParams, supportsProbe, type ProbeName } from "../lsp/probes.js";
import { rangeContaining } from "../sequence/cpp-syntax.js";
import type { EditOperation, InsertOperation, SourceRange } from "../sequence/types.js";
import { StoppedError, TimeoutError, withTimeout } from "../util/async.js";
import { isRecord, prettyJson } from "../util/json.js";
import { sha256 } from "../util/text.js";
import { resolveReplayConfig, type IncludeChecks, type ReplayConfig, type ReplayOptions, type ReplaySettings } from "./config.js";
import { ReplayContext, type Finding, type RunStats } from "./context.js";
import { Declined, LspSession, type CallOptions } from "./session.js";
import { randomSource, typingGroups, type Typing } from "./typing.js";

export type { ReplayOptions, ReplaySettings } from "./config.js";

export interface ReplayResult extends RunStats {
  status: RunStatus;
  masterPid: number | undefined;
  crashDetected: boolean;
  masterTerminationDetected: boolean;
  probes: readonly ProbeName[];
  includeChecks: IncludeChecks;
  typing: Typing;
  seed: number;
  requestedSteps: number;
  totalSteps: number;
  completeSource: boolean;
  finalVersion: number;
  finalHash: string;
  firstFailure: Finding | null;
  findings: Finding[];
  exitStatus: ExitStatus | null;
  forcedCleanup: boolean;
  recordingComplete: boolean;
  durationMs: number;
  outputDirectory: string;
}

const progressIntervalMs = 5000;
/** Share of unawaited probes that are cancelled after the next edit. */
const cancelProbability = 0.25;

/**
 * Replay an edit sequence against clice, one operation at a time:
 *
 *   initialize → didOpen("") → probe → for each operation: [didChange] → probe → … → shutdown
 *
 * After every probed step, all selected probes are sent concurrently and must all succeed
 * before the next edit (`burst` typing relaxes this inside a word, see `type`).
 * The first failure stops the run; cleanup still collects late evidence.
 * Input errors throw before the output directory is created; everything later is in the result.
 */
export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const config = await resolveReplayConfig(options);
  await mkdir(dirname(config.outputDirectory), { recursive: true });
  await mkdir(config.outputDirectory); // Refuse to mix a run with old output, caches or crash logs.
  return new ReplayRun(config, options.onProgress).execute();
}

class ReplayRun {
  private readonly ctx: ReplayContext;
  private readonly clice: CliceProcess;
  private readonly session: LspSession;
  private initialized = false;
  private opened = false;
  /** What the server has received, rebuilt from the actual didChange payloads. */
  private wireText = "";
  private beforeText = "";
  private runTimer: NodeJS.Timeout | undefined;
  private progressAt = performance.now();
  private readonly random: () => number;

  constructor(private readonly config: ReplayConfig, private readonly onProgress: ReplaySettings["onProgress"]) {
    const ctx = this.ctx = new ReplayContext(config.outputDirectory, config.recording);
    this.saveInputs();
    this.clice = new CliceProcess({
      runtime: config.runtime.path, args: config.serverArgs, cwd: config.projectRoot,
      observer: ctx, onStderr: (chunk) => ctx.recorder.appendStderr(chunk),
    });
    this.session = new LspSession(this.clice, ctx);
    this.random = randomSource(config.seed);
  }

  async execute(): Promise<ReplayResult> {
    this.watchInterruptsAndDeadline();
    try {
      await this.drive();
    } catch (error) {
      this.reportUncaught(error);
    } finally {
      await this.cleanup();
    }
    if (this.config.recording === "failure" && this.ctx.findings.length === 0) await this.discardEvidence();
    return this.writeResult();
  }

  // --- the run --------------------------------------------------------------------------------

  private async drive(): Promise<void> {
    const { ctx, config } = this;
    ctx.throwIfStopped();
    ctx.phase = "initialize";
    await this.initialize();
    await this.session.notify("textDocument/didOpen",
      { textDocument: { uri: config.documentUri, languageId: "cpp", version: 0, text: "" } }, config.timeouts.request);
    this.opened = true;

    ctx.phase = "initial-probe";
    await this.probe(config.timeouts.initialProbe);

    ctx.phase = "replay";
    const operations = config.sequence.operations.slice(0, config.requestedSteps);
    const groups = config.typing === "burst"
      ? typingGroups(operations, (operation) => !this.includeRange(operation))
      : operations.map((operation) => [operation]);
    for (const group of groups) await this.type(group);
    assert.equal(this.wireText, ctx.document.text, "Final wire mirror mismatch.");
    if (config.requestedSteps === config.sequence.operations.length) ctx.document.verify(config.sequence.source);
  }

  private async initialize(): Promise<void> {
    const { config, ctx } = this;
    const rootUri = pathToFileURL(config.projectRoot).href;
    const result = await this.session.request("initialize", {
      processId: process.pid, rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(config.projectRoot) }],
      capabilities: clientCapabilities,
      initializationOptions: config.initializationOptions,
    }, config.timeouts.initialize);
    this.initialized = true;
    if (!isRecord(result) || !isRecord(result.capabilities)) throw new Error("initialize returned no capabilities.");
    ctx.recorder.save("initialize.json", prettyJson(result));
    const capabilities = result.capabilities as ServerCapabilities;
    const sync = capabilities.textDocumentSync;
    const incrementalSync = sync === 2 || (isRecord(sync) && sync.openClose === true && sync.change === 2);
    if ((capabilities.positionEncoding ?? "utf-16") !== "utf-16" || !incrementalSync ||
      config.probes.some((name) => !supportsProbe(name, capabilities))) {
      ctx.report({ kind: "environment-error", message: "Server must support UTF-16, incremental open/change/close and all selected probes." });
      throw new StoppedError();
    }
    await this.session.notify("initialized", {}, config.timeouts.request);
  }

  private includeRange(operation: EditOperation): SourceRange | undefined {
    return operation.type === "insert" ? rangeContaining(this.config.includeRanges, operation.sourceOffset) : undefined;
  }

  /**
   * Apply one group of operations; serial typing has one operation per group.
   *
   * Within a burst, the probes after every operation but the last are sent without waiting:
   * the next edit follows at once, some of them are cancelled, and the server may answer them
   * with a result, ContentModified or (if cancelled) RequestCancelled. The group completes
   * when every request has been answered and the probes after its last operation succeeded.
   */
  private async type(group: readonly EditOperation[]): Promise<void> {
    const { ctx, config } = this;
    const unawaited: Promise<{ error: unknown } | undefined>[] = [];
    const settled = (probe: Promise<void>) => probe.then(() => undefined, (error: unknown) => ({ error }));
    let cancelAfterNextEdit: CancellationTokenSource[] = [];
    let probed = false;
    try {
      for (const [index, operation] of group.entries()) {
        ctx.throwIfStopped();
        const include = this.includeRange(operation);
        ctx.step = ctx.stats.appliedSteps + 1;
        this.beforeText = ctx.document.text;
        ctx.record("operation.begin", operation);
        if (operation.type === "insert") {
          await this.insert(operation);
        } else {
          ctx.document.apply(operation);
          ctx.stats.appliedSteps++;
        }
        ctx.record("operation.applied", operation);
        for (const source of cancelAfterNextEdit) source.cancel();
        cancelAfterNextEdit = [];
        if (include) {
          ctx.stats.skippedIncludeSteps++;
          ctx.record("probe.skipped", { reason: "include", sourceRange: include });
        } else if (index < group.length - 1) {
          unawaited.push(settled(this.probe(config.timeouts.request, cancelAfterNextEdit)));
        } else {
          unawaited.push(settled(this.probe(config.timeouts.request)));
          probed = true;
        }
      }
    } finally {
      // Every wait must finish before the next group or cleanup starts.
      const failure = (await Promise.all(unawaited)).find((outcome) => outcome !== undefined);
      if (failure) throw failure.error;
    }
    if (probed) ctx.stats.probedSteps++;
    ctx.stats.completedSteps += group.length;
    ctx.record("operation.complete", { probed, operations: group.length });
    this.reportProgress();
  }

  /** Send one character, checking the payload against an independent mirror of the wire text. */
  private async insert(operation: InsertOperation): Promise<void> {
    const { ctx, config } = this;
    const position = positionAt(this.beforeText, operation.offset);
    const wireOffset = offsetAt(this.wireText, position);
    assert.equal(wireOffset, operation.offset, "Wire offset differs from the operation.");
    const next = this.wireText.slice(0, wireOffset) + operation.text + this.wireText.slice(wireOffset);
    ctx.document.apply(operation);
    ctx.stats.appliedSteps++;
    assert.equal(next, ctx.document.text, "LSP mirror differs from local document.");
    await this.session.notify("textDocument/didChange", {
      textDocument: { uri: config.documentUri, version: operation.version },
      contentChanges: [{ range: { start: position, end: position }, text: operation.text }],
    }, config.timeouts.request);
    this.wireText = next;
    ctx.stats.changesSent++;
  }

  /**
   * Send every selected probe concurrently against the same snapshot; all must succeed.
   * With `cancellable` the caller will edit again before the replies arrive: the server may
   * then decline a request, and the token sources of the requests to cancel are appended to it.
   */
  private async probe(timeoutMs: number, cancellable?: CancellationTokenSource[]): Promise<void> {
    const { ctx, config, session } = this;
    const document = { uri: config.documentUri, text: ctx.document.text, cursor: ctx.document.state.cursor };
    const began = performance.now();
    let succeeded = false;
    ctx.record("probe.begin", { methods: config.probes, awaited: !cancellable });
    const run = async (name: ProbeName): Promise<void> => {
      try {
        let options: CallOptions = {};
        if (cancellable) {
          ctx.stats.unawaitedProbes++;
          options = { tolerate: [LSPErrorCodes.ContentModified] };
          if (this.random() < cancelProbability) {
            const source = new CancellationTokenSource();
            cancellable.push(source);
            ctx.stats.cancelledProbes++;
            options = { tolerate: [LSPErrorCodes.ContentModified, LSPErrorCodes.RequestCancelled], cancellation: source.token };
          }
        }
        const result = await session.request(probeMethod(name), probeParams(name, document), timeoutMs, options);
        if (result instanceof Declined) {
          ctx.stats.declinedProbes++;
          return;
        }
        if (!acceptsProbeResult(name, result)) {
          ctx.report({ kind: "protocol-error", message: `Invalid ${name} result shape.`, evidence: { method: probeMethod(name), result } });
          throw new StoppedError();
        }
        ctx.stats.successfulProbes++;
        ctx.stats.successfulProbesByMethod[name] = (ctx.stats.successfulProbesByMethod[name] ?? 0) + 1;
      } catch (error) {
        // Failures of our own (e.g. building params) must also stop the sibling waits at once.
        if (!ctx.stopped) ctx.report({ kind: "adapter-error", message: String(error), evidence: { method: name } });
        throw error;
      }
    };
    try {
      // allSettled, not all: every sibling wait must finish before the document changes
      // or cleanup starts, so no probe callback leaks into the next step.
      const results = await Promise.allSettled(config.probes.map(run));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      ctx.throwIfStopped();
      succeeded = true;
    } finally {
      ctx.record("probe.end", { status: succeeded ? "success" : "failed", durationMs: performance.now() - began });
    }
  }

  private reportProgress(): void {
    if (performance.now() - this.progressAt < progressIntervalMs) return;
    this.onProgress?.({ appliedSteps: this.ctx.stats.appliedSteps, totalSteps: this.config.requestedSteps });
    this.progressAt = performance.now();
  }

  private reportUncaught(error: unknown): void {
    const { ctx } = this;
    if (error instanceof TimeoutError) {
      if (!ctx.stopped) ctx.report({ kind: "request-timeout", message: error.message });
    } else if (!(error instanceof StoppedError) && !(error instanceof ResponseError)) {
      // Request failures were already reported by the session; anything else is our bug.
      ctx.report({ kind: "adapter-error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  }

  // --- setup and teardown ---------------------------------------------------------------------

  private saveInputs(): void {
    const { config, ctx } = this;
    const { sequence, compileCommands, runtime } = config;
    ctx.recorder.save("sequence.jsonl", sequence.raw);
    ctx.recorder.save("original.cpp", sequence.source);
    ctx.recorder.save("compile_commands.json", compileCommands.raw);
    ctx.recorder.save("run.json", prettyJson({
      createdAt: new Date().toISOString(),
      runtime: runtime.path, runtimeVersion: runtime.version, runtimeHash: runtime.hash, args: config.serverArgs,
      node: process.version, platform: process.platform,
      project: config.projectRoot, sourceFile: sequence.header.sourceFile, sourceHash: sha256(sequence.source),
      sequencePath: config.sequencePath, sequenceHash: sequence.hash,
      compileCommandsPath: compileCommands.path, compileCommandsHash: compileCommands.hash, compileCommand: compileCommands.entry,
      timeouts: config.timeouts, probes: config.probes, includeChecks: config.includeChecks, includeRanges: config.includeRanges,
      recording: config.recording, typing: config.typing, seed: config.seed,
      requestedSteps: config.requestedSteps, totalSteps: sequence.operations.length,
      initializationOptions: config.initializationOptions,
    }));
  }

  private readonly interrupt = (): void => this.ctx.report({ kind: "interrupted", message: "Replay interrupted by the user." });

  private watchInterruptsAndDeadline(): void {
    process.once("SIGINT", this.interrupt);
    process.once("SIGTERM", this.interrupt);
    this.runTimer = setTimeout(() => this.ctx.report({ kind: "run-timeout", message: "Run exceeded the configured deadline." }),
      this.config.timeouts.run);
  }

  private async cleanup(): Promise<void> {
    const { ctx, config, clice, session } = this;
    ctx.phase = "cleanup";
    clearTimeout(this.runTimer);
    await this.shutdown();
    await this.cleanupWorkers();
    try { await scanServerLogs(join(config.outputDirectory, "server-logs"), ctx.report); }
    catch (error) { ctx.report({ kind: "recording-error", message: `Server logs could not be scanned: ${String(error)}` }); }
    try {
      const current = sha256((await readFile(config.sequence.header.sourceFile)).toString("utf8"));
      assert.equal(current, config.sequence.header.target.sha256, "Source changed during replay.");
    } catch (error) { ctx.report({ kind: "environment-error", message: String(error) }); }

    ctx.recorder.save("current.cpp", ctx.document.text);
    ctx.recorder.save("before-last-operation.cpp", this.beforeText);
    ctx.recorder.save("operations.jsonl", config.sequence.operations.slice(0, ctx.stats.appliedSteps)
      .map((operation) => JSON.stringify(operation) + "\n").join(""));
    session.dispose();
    clice.dispose();
    process.off("SIGINT", this.interrupt);
    process.off("SIGTERM", this.interrupt);
    ctx.phase = "complete";
    const { appliedSteps, completedSteps, probedSteps, skippedIncludeSteps, successfulProbes } = ctx.stats;
    ctx.record("run.complete", { appliedSteps, completedSteps, probedSteps, skippedIncludeSteps, successfulProbes });
    ctx.recorder.close();
  }

  /** Graceful LSP shutdown, falling back to killing the master. Listeners stay active throughout. */
  private async shutdown(): Promise<void> {
    const { ctx, clice, session, config: { timeouts, documentUri } } = this;
    const cleanup = { cleanup: true };
    try {
      if (clice.alive && clice.pid) {
        if (!this.initialized) throw new Error("Initialization incomplete; forced cleanup required.");
        if (this.opened) await session.notify("textDocument/didClose", { textDocument: { uri: documentUri } }, timeouts.shutdown, cleanup);
        assert.equal(await session.request("shutdown", undefined, timeouts.shutdown, cleanup), null, "shutdown must return null.");
        clice.expectExit();
        session.expectClose();
        await session.notify("exit", undefined, timeouts.shutdown, cleanup);
      }
      await withTimeout(clice.closed, timeouts.shutdown, "process close");
    } catch (error) {
      ctx.report({ kind: "cleanup-error", message: String(error) });
      // EOF commonly precedes Node's exit event. Do not mask a real exit as our own kill.
      if (session.transportClosed && clice.alive) await withTimeout(clice.closed, 250, "exit after EOF").catch(() => {});
      if (clice.alive) clice.forceKill();
      await withTimeout(clice.closed, timeouts.shutdown, "forced process close")
        .catch((closeError: unknown) => ctx.report({ kind: "cleanup-error", message: String(closeError) }));
    }
  }

  private async cleanupWorkers(): Promise<void> {
    const { ctx, clice, config } = this;
    if (!clice.pid) return;
    try {
      const remaining = await cleanupWindowsWorkers(clice.pid, clice.startedAt, config.runtime.path, join(config.outputDirectory, "server-logs"));
      ctx.record("cleanup.workers", { remaining });
      if (remaining.length) ctx.report({ kind: "cleanup-error", message: "Workers remained after master exit; terminated owned workers.", evidence: remaining });
    } catch (error) {
      ctx.report({ kind: "cleanup-error", message: String(error) });
    }
  }

  /**
   * Nothing failed, so the failure scene, clice's logs and its cache (the bulk of a run's
   * size) explain nothing. run.json, sequence.jsonl and result.json still identify the run.
   */
  private async discardEvidence(): Promise<void> {
    for (const name of ["events.jsonl", "stderr.log", "server-logs", "cache", "compile_commands.json",
      "current.cpp", "before-last-operation.cpp", "operations.jsonl"]) {
      // Best effort: a file that is still locked stays behind and does not change the result.
      await rm(join(this.config.outputDirectory, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  private async writeResult(): Promise<ReplayResult> {
    const { ctx, config, clice } = this;
    const totalSteps = config.sequence.operations.length;
    const { status, crashDetected, masterTerminationDetected } = classifyRun(ctx.findings);
    const result: ReplayResult = {
      status, masterPid: clice.pid, crashDetected, masterTerminationDetected,
      probes: config.probes, includeChecks: config.includeChecks, typing: config.typing, seed: config.seed,
      requestedSteps: config.requestedSteps, totalSteps,
      ...ctx.stats,
      completeSource: ctx.stats.completedSteps === totalSteps,
      finalVersion: ctx.document.state.version, finalHash: sha256(ctx.document.text),
      firstFailure: ctx.findings[0] ?? null, findings: ctx.findings,
      exitStatus: clice.exitStatus, forcedCleanup: clice.forcedCleanup, recordingComplete: !ctx.recorder.error,
      durationMs: performance.now() - ctx.started, outputDirectory: config.outputDirectory,
    };
    await writeFile(join(config.outputDirectory, "result.json"), prettyJson(result), { flag: "wx" });
    return result;
  }
}
