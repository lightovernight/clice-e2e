import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runE2e, type E2eOptions } from "../src/e2e.js";
import { probeNames } from "../src/lsp/probes.js";
import { loadCompileCommands } from "../src/replay/compile-commands.js";
import { generateSequence, loadSequence } from "../src/sequence/sequence-file.js";
import { fakeClice } from "./helpers/paths.js";
import { withTempDir, writeProject } from "./helpers/temp.js";

const source = '﻿// 中文😀\r\nstruct C{int f(){return 1;} int g(){return 2;}};\r\n';

/** A healthy fake clice with all probes; individual tests override what they need. */
async function fixture(body: (options: E2eOptions) => Promise<void>): Promise<void> {
  return withTempDir("clice-e2e-test-", async (directory) => {
    const project = await writeProject(directory, source, "源文件 with spaces.cpp");
    await body({
      sourceFile: project.sourceFile, projectRoot: directory, compileCommandsPath: project.compileCommandsPath,
      cliceExecutable: process.execPath, serverArgs: [fakeClice, "all-healthy"], outputDirectory: project.outputDirectory,
      probes: probeNames, requestTimeoutMs: 5000, shutdownTimeoutMs: 2000, recording: "full",
    });
  });
}

const missingRuntime = (options: E2eOptions): E2eOptions => ({ ...options, cliceExecutable: join(options.projectRoot, "missing-runtime") });

test("e2e generates the standalone sequence and completes all replay checks", { timeout: 30000 }, () => fixture(async (options) => {
  const expected = (await generateSequence(options.sourceFile)).text();
  const result = await runE2e(options);
  assert.equal(result.status, "PASS", JSON.stringify(result.findings));
  assert.equal(result.completeSource, true);
  assert.equal(result.successfulProbes, (result.totalSteps + 1) * 9);
  const savedSequence = join(options.outputDirectory, "sequence.jsonl");
  assert.equal(await readFile(savedSequence, "utf8"), expected);
  assert.equal((await loadSequence(savedSequence)).operations.length, result.totalSteps);
  const metadata = JSON.parse(await readFile(join(options.outputDirectory, "run.json"), "utf8")) as { sequencePath: string };
  assert.equal(metadata.sequencePath, savedSequence, "Generated sequence metadata must point to the retained artifact.");
  assert.equal(await readFile(join(options.outputDirectory, "current.cpp"), "utf8"), source);
  assert.equal(await readFile(join(options.projectRoot, "received.cpp"), "utf8"), source);
  assert.equal(await readFile(options.sourceFile, "utf8"), source);
}));

test("e2e stops on a completion worker crash and retains the full reproduction sequence", { timeout: 30000 }, () => fixture(async (options) => {
  const result = await runE2e({ ...options, serverArgs: [fakeClice, "completion-worker"] });
  assert.equal(result.status, "FAIL");
  assert.equal(result.crashDetected, true);
  assert.equal(result.appliedSteps, 2);
  assert.equal(result.completeSource, false);
  assert.equal(result.exitStatus?.code, 0, "A healthy master exit must not mask a worker crash.");
  assert.equal((await loadSequence(join(options.outputDirectory, "sequence.jsonl"))).operations.length, result.totalSteps);
  assert.equal(await readFile(options.sourceFile, "utf8"), source);
}));

test("e2e generates the full sequence when replay is limited", { timeout: 30000 }, () => fixture(async (options) => {
  const result = await runE2e({ ...options, maxSteps: 3 });
  assert.equal(result.status, "PASS");
  assert.equal(result.completedSteps, 3);
  assert.equal(result.completeSource, false);
  assert(result.totalSteps > result.completedSteps);
  assert.equal((await loadSequence(join(options.outputDirectory, "sequence.jsonl"))).source, source);
}));

test("e2e rejects invalid source before accessing the runtime", () => fixture(async (options) => {
  await writeFile(options.sourceFile, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(runE2e(missingRuntime(options)), /UTF-8/);
  await assert.rejects(stat(options.outputDirectory), { code: "ENOENT" });
  await assert.rejects(stat(join(options.projectRoot, "received.cpp")), { code: "ENOENT" });
}));

test("e2e rejects an empty compilation database before starting clice", () => fixture(async (options) => {
  await writeFile(options.compileCommandsPath, "[]");
  await assert.rejects(runE2e(missingRuntime(options)), /at least one compile command/);
  await assert.rejects(stat(options.outputDirectory), { code: "ENOENT" });
}));

test("e2e lets clice resolve header commands and sends the unchanged project database", { timeout: 30000 }, () => fixture(async (options) => {
  const sourceFile = join(options.projectRoot, "library.h");
  const header = "#pragma once\ninline int answer() { return 42; }\n";
  await writeFile(sourceFile, header);
  const originalDatabase = await readFile(options.compileCommandsPath, "utf8");
  const result = await runE2e({ ...options, sourceFile });
  assert.equal(result.status, "PASS", JSON.stringify(result.findings));
  assert.equal(result.completeSource, true);
  assert.equal(await readFile(join(options.projectRoot, "received.cpp"), "utf8"), header);
  assert.equal(await readFile(join(options.outputDirectory, "compile_commands.json"), "utf8"), originalDatabase);
  assert.equal(await readFile(options.compileCommandsPath, "utf8"), originalDatabase);
  const metadata = JSON.parse(await readFile(join(options.outputDirectory, "run.json"), "utf8")) as {
    sourceFile: string; compileCommand: unknown; initializationOptions: { rules: { compile_commands: string[] }[] };
  };
  assert.equal(metadata.sourceFile, sourceFile);
  assert.equal(metadata.compileCommand, null);
  assert.deepEqual(metadata.initializationOptions.rules, [{ compile_commands: [options.compileCommandsPath] }]);
  assert.equal(await readFile(sourceFile, "utf8"), header);
}));

test("compilation database validation permits inference but still rejects malformed entries", () => fixture(async (options) => {
  const direct = await loadCompileCommands(options.compileCommandsPath, options.sourceFile);
  assert.notEqual(direct.entry, null);
  const inferred = await loadCompileCommands(options.compileCommandsPath, join(options.projectRoot, "new-file.cpp"));
  assert.equal(inferred.entry, null);
  await writeFile(options.compileCommandsPath, JSON.stringify([{ directory: options.projectRoot, file: "donor.cpp", arguments: [] }]));
  await assert.rejects(loadCompileCommands(options.compileCommandsPath, join(options.projectRoot, "header.h")), /Invalid compile command/);
}));

test("e2e refuses existing output and preserves source files", () => fixture(async (options) => {
  await mkdir(options.outputDirectory);
  const previous = join(options.outputDirectory, "result.json");
  await writeFile(previous, "previous result");
  await assert.rejects(runE2e(options), { code: "EEXIST" });
  assert.equal(await readFile(previous, "utf8"), "previous result");
  assert.deepEqual(await readdir(options.outputDirectory), ["result.json"]);
  assert.equal(await readFile(options.sourceFile, "utf8"), source);
}));
