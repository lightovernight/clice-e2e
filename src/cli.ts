import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { exitCodes } from "./clice/failures.js";
import { runE2e } from "./e2e.js";
import { defaultOutputDirectory, loadLocalConfig, localConfigName, projectFor, sequenceSourceFile } from "./local-config.js";
import { defaultProbes, isProbeName, probeNames, type ProbeName } from "./lsp/probes.js";
import type { ReplaySettings } from "./replay/config.js";
import { runReplay, type ReplayResult } from "./replay/runner.js";
import { generateSequence } from "./sequence/sequence-file.js";

/**
 *   node dist/src/cli.js generate <file.cpp> [-o sequence.jsonl]
 *   node dist/src/cli.js replay   <sequence.jsonl> --project … --compile-commands … --clice … -o <dir>
 *   node dist/src/cli.js e2e      <file.cpp>       (same options as replay)
 *
 * The four path options of replay / e2e may come from `clice-e2e.json` instead (see local-config.ts).
 *
 * Exit codes: 0 PASS, 1 FAIL (clice misbehaved), 2 ERROR (input, environment or this tool).
 */

const overview = `Usage: node dist/src/cli.js <command> [options]   (or: npm run <command> -- [options])

Commands:
  generate <file.cpp>        Generate and verify a character-level edit sequence (JSONL).
  replay <sequence.jsonl>    Replay a saved sequence against clice.
  e2e <file.cpp>             generate + replay in one run.

Run a command with --help for its options.
`;

const generateUsage = `Usage: npm run generate -- <file.cpp> [-o <sequence.jsonl>]
Without -o, JSONL is written to stdout and statistics to stderr. Existing output files are not overwritten.
`;

function replayUsage(command: "replay" | "e2e"): string {
  const input = command === "e2e" ? "file.cpp" : "sequence.jsonl";
  return `Usage: npm run ${command} -- <${input}> [--project <directory>] [--compile-commands <path>] [--clice <executable>] [-o <new-directory>]
${command === "e2e" ? "Generate and verify an edit sequence, then replay it against clice.\n" : ""}The four path options are required unless ${localConfigName} in the working directory supplies them:
"clice", "outputRoot" (runs go to <outputRoot>/<time>-<name>) and "projects" (root + compileCommands,
chosen by which root contains the source file). Create the file with: npm run setup
Options:
  --config PATH          Read defaults from this file instead of ./${localConfigName}.
  --max-steps N          Replay only the first N operations (default: all).
  --probes METHODS       Comma-separated request names, or all.
  --include-checks MODE  skip (default) or character; include characters are always sent.
  --typing MODE          serial (default): wait for all probes after every keystroke. burst: send the
                         keystrokes of a word without waiting, cancel some requests, and require
                         success only at token boundaries; clice runs with its default worker counts.
  --seed N               Which requests a burst cancels (default: 1).
  --record MODE          failure (default): a passing run keeps only result.json, run.json and
                         its inputs; a failing run keeps the events before and after the failure,
                         clice logs and the cache. full: keep every event and file of every run.
  --request-timeout N    Per-operation request timeout in ms (default: 30000).
  --run-timeout N        Overall replay timeout in ms (default: 900000).
  -h, --help             Show this help.
Output directories must not exist. Source files are never written.
Exit codes: 0 = PASS, 1 = FAIL, 2 = setup or runner ERROR.
Default probes: ${defaultProbes.join(",")}
Available probes: ${probeNames.join(",")}
`;
}

class UsageError extends Error {}

async function generate(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    output: { type: "string", short: "o" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) { process.stdout.write(generateUsage); return 0; }
  const [input] = positionals;
  if (!input || positionals.length !== 1) throw new UsageError(generateUsage);

  const { header, summary, chunks } = await generateSequence(input);
  if (values.output) {
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await pipeline(Readable.from(chunks()), createWriteStream(output, { flags: "wx" }));
  } else {
    await pipeline(Readable.from(chunks()), process.stdout);
  }
  process.stderr.write(`Verified: ${summary.insertions} insertions, ${summary.cursorMoves} cursor moves, ` +
    `${header.regionCount} regions, ${header.issues.length} parser issues.\n`);
  return 0;
}

function parseProbes(value: string | undefined): ProbeName[] {
  if (value === "all") return [...probeNames];
  return (value ?? defaultProbes.join(",")).split(",").map((name) => {
    if (!isProbeName(name)) throw new UsageError(`Unsupported probe: ${name}`);
    return name;
  });
}

function parseNumber(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new UsageError(`--${option} must be an integer.`);
  return number;
}

async function replay(command: "replay" | "e2e", args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: "string" },
    "compile-commands": { type: "string" },
    clice: { type: "string" },
    output: { type: "string", short: "o" },
    config: { type: "string" },
    "max-steps": { type: "string" },
    probes: { type: "string" },
    "include-checks": { type: "string" },
    record: { type: "string" },
    typing: { type: "string" },
    seed: { type: "string" },
    "request-timeout": { type: "string" },
    "run-timeout": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) { process.stdout.write(replayUsage(command)); return 0; }
  const [input] = positionals;
  if (!input || positionals.length !== 1) throw new UsageError(replayUsage(command));

  const config = await loadLocalConfig(values.config);
  const sourceFile = command === "e2e" ? input : await sequenceSourceFile(input);
  const defaults = sourceFile === undefined ? undefined : projectFor(config, sourceFile);
  const project = values.project ?? defaults?.root;
  const compileCommands = values["compile-commands"] ?? defaults?.compileCommands;
  const clice = values.clice ?? config.clice;
  const output = values.output ?? (config.outputRoot === undefined ? undefined : defaultOutputDirectory(config.outputRoot, sourceFile ?? input));
  if (!project || !compileCommands || !clice || !output) {
    const missing = [["--project", project], ["--compile-commands", compileCommands], ["--clice", clice], ["-o", output]]
      .filter(([, value]) => !value).map(([option]) => option);
    throw new UsageError(`Missing ${missing.join(", ")}. Pass the option, or set a default in ${localConfigName} (npm run setup).\n\n${replayUsage(command)}`);
  }
  const includeChecks = values["include-checks"] ?? "skip";
  if (includeChecks !== "skip" && includeChecks !== "character") throw new UsageError(`Unsupported include checks mode: ${includeChecks}`);
  const recording = values.record ?? "failure";
  if (recording !== "failure" && recording !== "full") throw new UsageError(`Unsupported record mode: ${recording}`);
  const typing = values.typing ?? "serial";
  if (typing !== "serial" && typing !== "burst") throw new UsageError(`Unsupported typing mode: ${typing}`);
  const seed = parseNumber(values.seed, "seed");
  const maxSteps = parseNumber(values["max-steps"], "max-steps");
  const requestTimeoutMs = parseNumber(values["request-timeout"], "request-timeout");
  const runTimeoutMs = parseNumber(values["run-timeout"], "run-timeout");

  const settings: ReplaySettings = {
    projectRoot: project, compileCommandsPath: compileCommands, cliceExecutable: clice, outputDirectory: output,
    probes: parseProbes(values.probes), includeChecks, recording, typing,
    ...(seed !== undefined ? { seed } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
    onProgress: ({ appliedSteps, totalSteps }) => process.stderr.write(`Replaying ${appliedSteps}/${totalSteps} operations...\n`),
  };
  let result: ReplayResult;
  if (command === "e2e") {
    process.stderr.write("Generating and verifying the edit sequence before replay...\n");
    result = await runE2e({ ...settings, sourceFile: input });
  } else {
    result = await runReplay({ ...settings, sequencePath: input });
  }
  process.stdout.write(JSON.stringify(summarize(result), null, 2) + "\n");
  return exitCodes[result.status];
}

function summarize(result: ReplayResult) {
  const { status, crashDetected, includeChecks, completedSteps, requestedSteps, totalSteps, completeSource,
    probedSteps, skippedIncludeSteps, firstFailure, outputDirectory } = result;
  return { status, crashDetected, includeChecks, completedSteps, requestedSteps, totalSteps, completeSource,
    probedSteps, skippedIncludeSteps, firstFailure, sequencePath: join(outputDirectory, "sequence.jsonl"), outputDirectory };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "generate": return await generate(args);
      case "replay":
      case "e2e": return await replay(command, args);
      case "-h":
      case "--help": process.stdout.write(overview); return 0;
      default: throw new UsageError(command === undefined ? overview : `Unknown command: ${command}\n\n${overview}`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`.replace(/\n+$/, "\n"));
    return exitCodes.ERROR;
  }
}

process.exitCode = await main(process.argv.slice(2));
