import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Run `body` in a fresh temp directory, then delete it (and only it). */
export async function withTempDir<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    const target = await realpath(directory);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert(basename(target).startsWith(prefix));
    await rm(target, { recursive: true, force: true });
  }
}

export interface TestProject {
  readonly directory: string;
  readonly sourceFile: string;
  readonly compileCommandsPath: string;
  readonly outputDirectory: string;
}

/** A project directory with one source file and a compilation database for it. */
export async function writeProject(directory: string, source: string, fileName = "source.cpp"): Promise<TestProject> {
  const sourceFile = join(directory, fileName);
  const compileCommandsPath = join(directory, "compile_commands.json");
  await writeFile(sourceFile, source);
  await writeFile(compileCommandsPath, JSON.stringify([{ directory, file: sourceFile, arguments: ["clang++", "-c", sourceFile] }]));
  return { directory, sourceFile, compileCommandsPath, outputDirectory: join(directory, "run") };
}

export interface RecordedEvent {
  kind: string;
  phase: string;
  step: number;
  activeRequests: { traceId: number; id: number | string | null; method: string }[];
  // Payloads vary by kind; tests read the fields they know.
  data: any;
}

export async function readEvents(outputDirectory: string): Promise<RecordedEvent[]> {
  const text = await readFile(join(outputDirectory, "events.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as RecordedEvent);
}
