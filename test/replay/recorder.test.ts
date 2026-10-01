import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Recorder } from "../../src/replay/recorder.js";
import { withTempDir } from "../helpers/temp.js";

const readIndexes = async (directory: string): Promise<number[]> =>
  (await readFile(join(directory, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { index: number }).index);
const unexpected = (failure: { message: string }): never => assert.fail(failure.message);

test("failure recording writes nothing until asked, then the recent events and all later ones", () => withTempDir("clice-recorder-test-", async (directory) => {
  const recorder = new Recorder(directory, () => ({ step: 1 }), unexpected, "failure");
  for (let count = 0; count < 450; count++) recorder.record("lsp.receive", { id: count });
  assert.deepEqual(await readIndexes(directory), [], "A healthy run writes no events.");

  recorder.keepEvents();
  recorder.record("finding", { kind: "worker-crash" });
  recorder.keepEvents();
  recorder.record("process.exit", {});
  recorder.close();
  const indexes = await readIndexes(directory);
  assert.equal(indexes.length, 402, "The last 400 events before the failure, then everything after it.");
  assert.deepEqual([indexes[0], indexes.at(-1)], [51, 452]);
}));

test("full recording writes every event immediately", () => withTempDir("clice-recorder-test-", async (directory) => {
  const recorder = new Recorder(directory, () => ({}), unexpected, "full");
  recorder.record("lsp.receive", { id: 1 });
  assert.deepEqual(await readIndexes(directory), [1]);
  recorder.close();
}));
