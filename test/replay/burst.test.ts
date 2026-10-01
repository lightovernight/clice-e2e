import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runReplay, type ReplayOptions, type ReplayResult } from "../../src/replay/runner.js";
import { randomSource, typingGroups } from "../../src/replay/typing.js";
import { generateEdits, planEdits } from "../../src/sequence/generator.js";
import { generateSequence } from "../../src/sequence/sequence-file.js";
import type { EditOperation } from "../../src/sequence/types.js";
import { fakeBurstClice } from "../helpers/paths.js";
import { readEvents, withTempDir, writeProject } from "../helpers/temp.js";

const source = "int value_one = 1;\n    int value_two = value_one;\n";
const textOf = (group: readonly EditOperation[]): string => group.map((operation) => operation.type === "insert" ? operation.text : "<move>").join("");

test("bursts are whole words and whitespace runs; everything else stands alone", () => {
  const operations = [...generateEdits(planEdits(source))];
  const groups = typingGroups(operations, () => true);
  assert.deepEqual(groups.flat(), operations, "Grouping keeps every operation, in order.");
  assert.deepEqual(groups.map(textOf),
    ["int", " ", "value_one", " ", "=", " ", "1", ";", "\n    ", "int", " ", "value_two", " ", "=", " ", "value_one", ";", "\n"]);

  const unprobed = typingGroups(operations, (operation) => operation.type !== "insert" || operation.sourceOffset >= 4);
  assert.deepEqual(unprobed.slice(0, 5).map(textOf), ["i", "n", "t", " ", "value_one"], "Operations that are not probed are never part of a burst.");

  const long = [...generateEdits(planEdits("x".repeat(70)))];
  assert.deepEqual(typingGroups(long, () => true).map((group) => group.length), [32, 32, 6]);
  // A word typed around an existing character (the cursor moved) is not one left-to-right run.
  const shell = [...generateEdits(planEdits("void f(){ab}"))];
  assert(typingGroups(shell, () => true).every((group) => group.every((operation, index) =>
    index === 0 || (operation.type === "insert" && operation.offset === (group[index - 1] as typeof operation).offset + 1))));
});

test("the random source is reproducible from its seed", () => {
  const draw = (seed: number): number[] => { const next = randomSource(seed); return Array.from({ length: 5 }, next); };
  assert.deepEqual(draw(7), draw(7));
  assert.notDeepEqual(draw(7), draw(8));
  assert(draw(7).every((value) => value >= 0 && value < 1));
});

async function burst(scenario: string, overrides: Partial<ReplayOptions>, check: (result: ReplayResult, directory: string, output: string) => Promise<void>) {
  return withTempDir("clice-burst-test-", async (directory) => {
    const project = await writeProject(directory, source);
    const sequencePath = join(directory, "sequence.jsonl");
    await writeFile(sequencePath, (await generateSequence(project.sourceFile)).text());
    const result = await runReplay({
      sequencePath, projectRoot: directory, compileCommandsPath: project.compileCommandsPath,
      cliceExecutable: process.execPath, serverArgs: [fakeBurstClice, scenario], outputDirectory: project.outputDirectory,
      typing: "burst", recording: "full", requestTimeoutMs: 5000, shutdownTimeoutMs: 2000, ...overrides,
    } as ReplayOptions);
    await check(result, directory, project.outputDirectory);
  });
}

test("burst typing: superseded and cancelled requests may be declined, token boundaries must succeed", { timeout: 60000 },
  () => burst("healthy", {}, async (result, directory, output) => {
    assert.equal(result.status, "PASS", JSON.stringify(result.findings));
    assert.equal(result.typing, "burst");
    assert.equal(await readFile(join(directory, "received.cpp"), "utf8"), source);
    assert.equal(result.completedSteps, result.totalSteps);
    assert.equal(result.probedSteps, 18, "One checked probe group per burst.");
    // 32 of the 50 keystrokes are followed by another keystroke of the same burst, with two probes each.
    assert.equal(result.unawaitedProbes, 64);
    assert(result.cancelledProbes > 0 && result.cancelledProbes < result.unawaitedProbes);
    assert(result.declinedProbes > 0 && result.declinedProbes <= result.unawaitedProbes);
    assert.equal(result.successfulProbes + result.declinedProbes, (18 + 1) * 2 + 64, "Every request was answered exactly once.");

    const events = await readEvents(output);
    const cancels = events.filter((event) => event.kind === "lsp.send" && event.data.method === "$/cancelRequest");
    assert.equal(cancels.length, result.cancelledProbes);
    const declined = events.filter((event) => event.kind === "request.end" && event.data.status === "declined");
    assert.equal(declined.length, result.declinedProbes);
    assert(declined.some((event) => event.data.code === -32800) && declined.some((event) => event.data.code === -32801));

    const again = await readFile(join(output, "run.json"), "utf8");
    assert.equal(JSON.parse(again).seed, 1);
  }));

test("burst typing: the seed selects which requests are cancelled", { timeout: 60000 }, async () => {
  const cancelled: string[] = [];
  for (const seed of [1, 1, 2]) {
    await burst("healthy", { seed }, async (_result, _directory, output) => {
      const ids = (await readEvents(output)).filter((event) => event.kind === "lsp.send" && event.data.method === "$/cancelRequest")
        .map((event) => event.data.params.id as number);
      cancelled.push(ids.join(","));
    });
  }
  assert.equal(cancelled[0], cancelled[1]);
  assert.notEqual(cancelled[0], cancelled[2]);
});

test("burst typing: a request that is never answered fails the run", { timeout: 60000 },
  () => burst("lost", { requestTimeoutMs: 400 }, async (result) => {
    assert.equal(result.status, "FAIL");
    assert.equal(result.firstFailure?.kind, "request-timeout");
    assert(result.completedSteps < result.totalSteps);
  }));

test("burst typing: a crash caused by a superseded request is detected", { timeout: 60000 },
  () => burst("crash", {}, async (result) => {
    assert.equal(result.status, "FAIL");
    assert.equal(result.crashDetected, true);
    assert(result.completedSteps < result.totalSteps);
  }));

test("burst typing: declining the probes at a token boundary is a failure", { timeout: 60000 },
  () => burst("decline-all", {}, async (result) => {
    assert.equal(result.status, "FAIL");
    assert.equal(result.firstFailure?.kind, "request-error");
  }));

test("serial typing never sends an unawaited or cancelled request", { timeout: 60000 },
  () => burst("healthy", { typing: "serial" }, async (result) => {
    assert.equal(result.status, "PASS", JSON.stringify(result.findings));
    assert.deepEqual([result.unawaitedProbes, result.cancelledProbes, result.declinedProbes], [0, 0, 0]);
    assert.equal(result.probedSteps, result.totalSteps);
  }));
