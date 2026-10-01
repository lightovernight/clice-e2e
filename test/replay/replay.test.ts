import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { positionAt } from "../../src/lsp/positions.js";
import { probeNames, type ProbeName } from "../../src/lsp/probes.js";
import { runReplay, type ReplayOptions } from "../../src/replay/runner.js";
import { EditBuffer } from "../../src/sequence/edit-buffer.js";
import { generateSequence } from "../../src/sequence/sequence-file.js";
import type { EditOperation } from "../../src/sequence/types.js";
import { fakeClice } from "../helpers/paths.js";
import { readEvents, withTempDir, writeProject, type TestProject } from "../helpers/temp.js";

const source = '﻿// 中文😀\r\nstruct C {\r\nint f(){return 1;}\r\nint g(){return 2;}\r\n};\n';

type Overrides = Partial<Omit<ReplayOptions, "sequencePath" | "sequence">>;

/** Generate a sequence for `sourceText` and replay it against the fake server in `scenario`. */
async function replayScenario(scenario: string, overrides: Overrides, check: (project: TestProject, result: Awaited<ReturnType<typeof runReplay>>) => Promise<void>, sourceText = source) {
  return withTempDir("clice-replay-test-", async (directory) => {
    const project = await writeProject(directory, sourceText);
    const sequencePath = join(directory, "sequence.jsonl");
    await writeFile(sequencePath, (await generateSequence(project.sourceFile)).text());
    const result = await runReplay({
      sequencePath, projectRoot: directory, compileCommandsPath: project.compileCommandsPath,
      cliceExecutable: process.execPath, serverArgs: [fakeClice, scenario], outputDirectory: project.outputDirectory,
      recording: "full", ...overrides,
    } as ReplayOptions);
    assert.equal(await readFile(project.sourceFile, "utf8"), sourceText, "The source file must never be written.");
    await check(project, result);
  });
}

const received = (project: TestProject): Promise<string> => readFile(join(project.directory, "received.cpp"), "utf8");

// --- serial scenarios: the fake server misbehaves on its third documentSymbol (or other) request ---

const expectedFailure: Record<string, string> = {
  worker: "worker-crash", error: "request-error", timeout: "request-timeout", exit: "unexpected-exit",
  malformed: "protocol-error", stderr: "crash-trace", "late-worker": "worker-crash", "bad-shutdown": "abnormal-exit",
  "folding-worker": "worker-crash", "completion-worker": "worker-crash", "bad-completion": "protocol-error",
};

for (const mode of ["healthy", "all-healthy", ...Object.keys(expectedFailure)]) {
  const probes: readonly ProbeName[] = ["all-healthy", "completion-worker", "bad-completion"].includes(mode) ? probeNames
    : mode === "folding-worker" ? ["documentSymbol", "foldingRange"] : ["documentSymbol"];
  const overrides: Overrides = { probes, requestTimeoutMs: mode === "timeout" ? 200 : 5000, shutdownTimeoutMs: 2000 };

  test(`LSP replay: ${mode}`, { timeout: 30000 }, () => replayScenario(mode, overrides, async (project, result) => {
    assert.equal(result.recordingComplete, true);
    if (mode === "healthy" || mode === "all-healthy") {
      assert.equal(result.status, "PASS", JSON.stringify(result.findings));
      assert.equal(result.successfulProbes, (result.totalSteps + 1) * result.probes.length);
      for (const method of result.probes) assert.equal(result.successfulProbesByMethod[method], result.totalSteps + 1);
      assert.equal(result.changesSent, [...source].length);
      assert.equal(result.completeSource, true);
      assert.equal(await received(project), source);
      assert.equal(await readFile(join(project.outputDirectory, "current.cpp"), "utf8"), source);
      assert.equal(result.crashDetected, false);
    } else {
      assert.equal(result.status, "FAIL", JSON.stringify(result));
      assert(result.findings.some((failure) => failure.kind === expectedFailure[mode]), JSON.stringify(result.findings));
      if (mode === "late-worker" || mode === "bad-shutdown") assert.equal(result.completedSteps, result.totalSteps);
      else assert(result.completedSteps < result.totalSteps, "A failed run must stop editing.");
      if (mode === "worker" || mode === "late-worker") {
        assert.equal(result.crashDetected, true);
        assert.equal(result.exitStatus?.code, 0, "Recovered worker crash must fail even with a healthy master shutdown.");
      }
      if (mode === "timeout") assert.equal(result.crashDetected, false);
      if (mode === "error") assert.match(JSON.stringify(result.findings), /preserved/);
      if (mode === "completion-worker") {
        assert(result.firstFailure?.activeRequests.some((request) => request.method === "textDocument/completion"));
        assert.equal(result.crashDetected, true);
        assert.equal(result.appliedSteps, 2, "A completion crash must prevent the next edit.");
      }
    }

    const events = await readEvents(project.outputDirectory);
    assert(events.some((event) => event.kind === "lsp.send" && event.data.method === "textDocument/documentSymbol" && typeof event.data.id === "number"));
    const shutdown = events.find((event) => event.kind === "lsp.send" && event.data.method === "shutdown");
    if (shutdown) assert(!Object.hasOwn(shutdown.data, "params"), "A no-parameter request must omit params, not send [null].");
    if (mode === "all-healthy") {
      const mirror = new EditBuffer();
      for (const event of events) {
        if (event.kind === "operation.applied") mirror.apply(event.data as EditOperation);
        if (event.kind === "lsp.send" && event.data.params?.position) {
          assert.deepEqual(event.data.params.position, positionAt(mirror.text, mirror.state.cursor), "Probe must use the current caret, including after moves.");
        }
      }
    }
  }));
}

// --- concurrent probes: the fake server answers only once all nine requests of a batch arrive ---

const parallelFailure: Record<string, string> = {
  worker: "worker-crash", error: "request-error", timeout: "request-timeout", "bad-result": "protocol-error", exit: "unexpected-exit",
};

for (const mode of ["healthy", ...Object.keys(parallelFailure)]) {
  const overrides: Overrides = { probes: probeNames, maxSteps: 3, initialProbeTimeoutMs: 2000,
    requestTimeoutMs: mode === "timeout" ? 200 : 2000, shutdownTimeoutMs: 2000 };

  test(`parallel probes: ${mode}`, { timeout: 30000 }, () => replayScenario(`parallel-${mode}`, overrides, async (project, result) => {
    assert.equal(result.recordingComplete, true);
    assert.equal(result.forcedCleanup, false);
    const events = await readEvents(project.outputDirectory);
    const batch0 = events.filter((event) => event.phase === "initial-probe");
    const sent = batch0.filter((event) => event.kind === "request.sent");
    const ended = batch0.filter((event) => event.kind === "request.end");
    assert.equal(sent.length, 9);
    assert.deepEqual(ended.map((event) => event.data.id), sent.map((event) => event.data.id).reverse(), "Responses must match their IDs when returned out of order.");
    assert.equal(Math.max(...batch0.map((event) => event.activeRequests.length)), 9);

    const inFlight = new Map<number, number | string | null | undefined>();
    for (const event of events) {
      if (event.kind === "request.begin") inFlight.set(event.data.traceId, null);
      if (event.kind === "request.sent") inFlight.set(event.data.traceId, event.data.id);
      if (event.kind === "request.end") {
        assert.equal(event.data.id, inFlight.get(event.data.traceId));
        inFlight.delete(event.data.traceId);
      }
      if (event.kind === "operation.begin" || event.kind === "probe.end") {
        assert.equal(inFlight.size, 0, "All sibling waits must finish before the batch ends or another edit starts.");
      }
      if (event.phase === "cleanup") {
        assert(event.activeRequests.every((request) => request.method === "shutdown"), "No probe callbacks may leak into cleanup.");
      }
    }
    assert.equal(inFlight.size, 0);

    if (mode === "healthy") {
      assert.equal(result.status, "PASS", JSON.stringify(result.findings));
      assert.equal(result.completedSteps, 3);
      assert.equal(result.successfulProbes, 36);
      assert.equal(result.crashDetected, false);
      return;
    }
    assert.equal(result.status, "FAIL", JSON.stringify(result.findings));
    assert.equal(result.appliedSteps, 2);
    assert.equal(result.completedSteps, 1);
    assert.equal(result.firstFailure?.step, 2);
    assert(result.findings.some((failure) => failure.kind === parallelFailure[mode]), JSON.stringify(result.findings));
    assert.equal(result.crashDetected, mode === "worker");
    assert(result.firstFailure!.activeRequests.length >= 8, "Failure evidence must retain the concurrent request snapshot.");
    for (const request of result.firstFailure!.activeRequests) {
      assert.equal(typeof request.id, "number");
      assert(events.some((event) => event.kind === "lsp.send" && event.step === 2 && event.data.id === request.id && event.data.method === request.method));
    }
    if (mode !== "exit") assert.equal(result.exitStatus?.code, 0);
  }));
}

// --- include directives: characters are always sent, probes are skipped by default ---

const includeDirectives = ['#include <vector>\r\n', '#include "local.hpp"\r\n'];
const includeSource = '﻿// 中文😀\r\n' + includeDirectives.join("") + 'int f(){return 1;}\r\n';

for (const includeChecks of ["skip", "character"] as const) {
  test(`include checks: ${includeChecks} keeps character notifications and checks ordinary code`, { timeout: 30000 },
    () => replayScenario("all-healthy", { probes: probeNames, ...(includeChecks === "character" ? { includeChecks } : {}) }, async (project, result) => {
      assert.equal(result.status, "PASS", JSON.stringify(result.findings));
      assert.equal(result.includeChecks, includeChecks);
      const skipped = includeChecks === "skip" ? [...includeDirectives.join("")].length : 0;
      assert.equal(result.skippedIncludeSteps, skipped);
      assert.equal(result.probedSteps, result.completedSteps - skipped);
      assert.equal(result.successfulProbes, (result.probedSteps + 1) * 9);
      assert.equal(result.changesSent, [...includeSource].length);
      assert.equal(await received(project), includeSource);
      const events = await readEvents(project.outputDirectory);
      const ranges = includeDirectives.map((text) => ({ start: includeSource.indexOf(text), end: includeSource.indexOf(text) + text.length }));
      for (const event of events.filter((row) => row.kind === "operation.applied")) {
        const operation = event.data as EditOperation;
        const isInclude = operation.type === "insert" && ranges.some((range) => operation.sourceOffset >= range.start && operation.sourceOffset < range.end);
        const requests = events.filter((row) => row.kind === "request.begin" && row.step === event.step && row.phase === "replay");
        assert.equal(requests.length, includeChecks === "skip" && isInclude ? 0 : 9);
      }
    }, includeSource));
}

test("an include-only prefix explicitly records zero probed steps", { timeout: 30000 },
  () => replayScenario("all-healthy", { probes: probeNames, maxSteps: 5 }, async (project, result) => {
    assert.equal(result.status, "PASS", JSON.stringify(result.findings));
    assert.equal(result.completedSteps, 5);
    assert.equal(result.skippedIncludeSteps, 5);
    assert.equal(result.probedSteps, 0);
    assert.equal(result.successfulProbes, 9, "Only the initial empty-document probe runs.");
    assert.equal(result.completeSource, false);
    assert.equal(await received(project), "#incl");
  }, "#include <vector>\nint x;\n"));

test("worker crashes are still detected while include probes are skipped", { timeout: 30000 },
  () => replayScenario("include-worker", { probes: probeNames }, async (_project, result) => {
    assert.equal(result.status, "FAIL", JSON.stringify(result.findings));
    assert.equal(result.crashDetected, true);
    assert.equal(result.probedSteps, 0);
    assert(result.skippedIncludeSteps > 0);
    assert.equal(result.exitStatus?.code, 0);
    assert.equal(result.forcedCleanup, false);
    assert(result.findings.some((finding) => finding.message.includes("include edit")));
  }, "#include <vector>\n"));

// --- default recording: evidence is kept only when something failed ---

test("a passing run leaves only what identifies it", { timeout: 30000 },
  () => replayScenario("healthy", { probes: ["documentSymbol"], recording: "failure" }, async (project, result) => {
    assert.equal(result.status, "PASS", JSON.stringify(result.findings));
    assert.deepEqual((await readdir(project.outputDirectory)).sort(),
      ["initialize.json", "original.cpp", "result.json", "run.json", "sequence.jsonl"]);
  }));

test("a failing run keeps the events around the failure and the failure scene", { timeout: 30000 },
  () => replayScenario("worker", { probes: ["documentSymbol"], recording: "failure" }, async (project, result) => {
    assert.equal(result.status, "FAIL");
    const events = await readEvents(project.outputDirectory);
    assert.equal(events[0]!.kind, "process.spawn", "A short run fits in the buffer from its first event.");
    assert(events.some((event) => event.kind === "finding" && event.data.kind === "worker-crash"));
    assert(events.some((event) => event.kind === "run.complete"), "Events after the failure are recorded too.");
    const files = await readdir(project.outputDirectory);
    for (const name of ["stderr.log", "current.cpp", "before-last-operation.cpp", "compile_commands.json"]) assert(files.includes(name), name);
  }));
