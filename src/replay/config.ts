import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { defaultProbes, isProbeName, type ProbeName } from "../lsp/probes.js";
import { findIncludeRanges } from "../sequence/cpp-syntax.js";
import { loadSequence, parseSequence, type LoadedSequence } from "../sequence/sequence-file.js";
import type { SourceRange } from "../sequence/types.js";
import { isValidTimeout } from "../util/async.js";
import { sha256 } from "../util/text.js";
import { loadCompileCommands, type CompileCommands } from "./compile-commands.js";
import type { Recording } from "./recorder.js";
import type { Typing } from "./typing.js";

const execFileAsync = promisify(execFile);

export type IncludeChecks = "skip" | "character";

/** User-facing replay settings; everything except paths has a default. */
export interface ReplaySettings {
  projectRoot: string;
  compileCommandsPath: string;
  cliceExecutable: string;
  /** Must not exist yet; a run never mixes with old output, caches or crash logs. */
  outputDirectory: string;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  initialProbeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  runTimeoutMs?: number;
  /** Replay only the first N operations (default: all). */
  maxSteps?: number;
  probes?: readonly ProbeName[];
  /** `skip`: include-directive characters are still sent, but not probed. */
  includeChecks?: IncludeChecks;
  /** What a run leaves on disk (default: `failure`, evidence only when something failed). */
  recording?: Recording;
  /** `burst` sends the keystrokes of a word without waiting and keeps the default worker counts of clice. */
  typing?: Typing;
  /** Decides which unawaited requests a burst cancels (default: 1). */
  seed?: number;
  /** Transport injection for protocol tests. The CLI always launches `clice serve`. */
  serverArgs?: readonly string[];
  onProgress?: (progress: { appliedSteps: number; totalSteps: number }) => void;
}

export type ReplayOptions = ReplaySettings & (
  | { sequencePath: string; sequence?: never }
  | { sequence: Buffer; sequencePath?: never }
);

export interface Timeouts {
  readonly request: number;
  readonly initialize: number;
  readonly initialProbe: number;
  readonly shutdown: number;
  readonly run: number;
}

/** Fully validated inputs for one run. Building it has no side effects on disk. */
export interface ReplayConfig {
  readonly sequence: LoadedSequence;
  /** The given sequence file, or the copy saved in the output directory. */
  readonly sequencePath: string;
  readonly documentUri: string;
  readonly projectRoot: string;
  readonly compileCommands: CompileCommands;
  readonly runtime: { readonly path: string; readonly version: string; readonly hash: string };
  readonly serverArgs: readonly string[];
  readonly outputDirectory: string;
  readonly requestedSteps: number;
  readonly probes: readonly ProbeName[];
  readonly includeChecks: IncludeChecks;
  readonly includeRanges: readonly SourceRange[];
  readonly recording: Recording;
  readonly typing: Typing;
  readonly seed: number;
  readonly timeouts: Timeouts;
  readonly initializationOptions: object;
}

/** Validate everything that can be checked before the output directory exists. */
export async function resolveReplayConfig(options: ReplayOptions): Promise<ReplayConfig> {
  const sequence = options.sequence === undefined
    ? await loadSequence(resolve(options.sequencePath))
    : await parseSequence(options.sequence);
  const projectRoot = resolve(options.projectRoot);
  assert((await stat(projectRoot)).isDirectory(), "Project root is not a directory.");
  const compileCommands = await loadCompileCommands(resolve(options.compileCommandsPath), sequence.header.sourceFile);
  const runtimePath = resolve(options.cliceExecutable);
  assert((await stat(runtimePath)).isFile(), "Runtime executable is not a file.");
  const outputDirectory = resolve(options.outputDirectory);

  const requestedSteps = options.maxSteps ?? sequence.operations.length;
  const probes = options.probes ?? defaultProbes;
  const includeChecks = options.includeChecks ?? "skip";
  assert(probes.length > 0 && new Set(probes).size === probes.length && probes.every(isProbeName), "Invalid or duplicate probe methods.");
  assert(includeChecks === "skip" || includeChecks === "character", "Invalid include checks mode.");
  const recording = options.recording ?? "failure";
  assert(recording === "failure" || recording === "full", "Invalid recording mode.");
  const typing = options.typing ?? "serial";
  assert(typing === "serial" || typing === "burst", "Invalid typing mode.");
  const seed = options.seed ?? 1;
  assert(Number.isSafeInteger(seed) && seed >= 0, "Invalid seed.");
  assert(Number.isSafeInteger(requestedSteps) && requestedSteps >= 0 && requestedSteps <= sequence.operations.length, "Invalid maxSteps.");
  const timeouts: Timeouts = {
    request: options.requestTimeoutMs ?? 30000,
    initialize: options.initializeTimeoutMs ?? 30000,
    initialProbe: options.initialProbeTimeoutMs ?? 60000,
    shutdown: options.shutdownTimeoutMs ?? 10000,
    run: options.runTimeoutMs ?? 900000,
  };
  assert(Object.values(timeouts).every(isValidTimeout), "Invalid timeout.");

  const version = (await execFileAsync(runtimePath, ["--version"], { windowsHide: true, timeout: 10000 })).stdout.trim();
  const hash = sha256(await readFile(runtimePath));

  return {
    sequence,
    sequencePath: options.sequencePath === undefined ? join(outputDirectory, "sequence.jsonl") : resolve(options.sequencePath),
    documentUri: pathToFileURL(sequence.header.sourceFile).href,
    projectRoot,
    compileCommands,
    runtime: { path: runtimePath, version, hash },
    serverArgs: [...(options.serverArgs ?? ["serve"])],
    outputDirectory,
    requestedSteps,
    probes,
    includeChecks,
    includeRanges: includeChecks === "skip" ? findIncludeRanges(sequence.source) : [],
    recording,
    typing,
    seed,
    timeouts,
    // A focused editing setup: no background indexing, caches and logs private to this run.
    // Serial typing pins one worker of each kind, so a crash is always in the same two logs;
    // burst typing exercises concurrency and keeps the default worker counts of clice.
    initializationOptions: {
      project: {
        cache_dir: join(outputDirectory, "cache"), logging_dir: join(outputDirectory, "server-logs"), enable_indexing: false,
        ...(typing === "serial"
          ? { stateful_worker_count: 1, stateless_worker_count: 1, min_stateless_worker_count: 1, max_stateless_worker_count: 1 }
          : {}),
      },
      rules: [{ compile_commands: [compileCommands.path] }],
    },
  };
}
