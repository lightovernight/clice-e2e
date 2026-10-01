import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { defaultOutputDirectory, loadLocalConfig, projectFor, sequenceSourceFile } from "../src/local-config.js";
import { cliPath } from "./helpers/paths.js";
import { withTempDir, writeProject } from "./helpers/temp.js";

test("local config resolves paths against its own directory and picks the innermost project", () => withTempDir("clice-config-test-", async (directory) => {
  const path = join(directory, "clice-e2e.json");
  await writeFile(path, JSON.stringify({ clice: "bin/clice", outputRoot: "runs", projects: [
    { root: ".", compileCommands: "compile_commands.json" },
    { root: "nested", compileCommands: "nested/build/compile_commands.json" },
  ] }));
  const config = await loadLocalConfig(path);
  assert.equal(config.clice, join(directory, "bin", "clice"));
  assert.equal(config.outputRoot, join(directory, "runs"));
  assert.equal(projectFor(config, join(directory, "a.cpp"))?.compileCommands, join(directory, "compile_commands.json"));
  assert.equal(projectFor(config, join(directory, "nested", "src", "a.cpp"))?.root, join(directory, "nested"));
  assert.equal(projectFor(config, join(directory, "..", "elsewhere.cpp")), undefined);
  assert.equal(defaultOutputDirectory(join(directory, "runs"), "src/lambda.cpp", new Date(2026, 8, 30, 15, 4, 5)),
    join(directory, "runs", "20260930-150405-lambda"));

  await writeFile(path, JSON.stringify({ projects: [{ root: "." }] }));
  await assert.rejects(loadLocalConfig(path), /compileCommands/);
  await assert.rejects(loadLocalConfig(join(directory, "missing.json")), { code: "ENOENT" });
}));

test("a sequence file names its source file in the header", () => withTempDir("clice-config-test-", async (directory) => {
  const sequence = join(directory, "sequence.jsonl");
  await writeFile(sequence, `${JSON.stringify({ type: "sequence", sourceFile: "C:/project/a.cpp" })}\n{"type":"summary"}\n`);
  assert.equal(await sequenceSourceFile(sequence), "C:/project/a.cpp");
  await writeFile(sequence, "not json\n");
  assert.equal(await sequenceSourceFile(sequence), undefined);
}));

test("e2e takes missing path options from clice-e2e.json in the working directory", () => withTempDir("clice-config-test-", async (directory) => {
  const project = await writeProject(directory, "int f(){return 1;}\n");
  const run = () => spawnSync(process.execPath, [cliPath, "e2e", project.sourceFile], { cwd: directory, encoding: "utf8", windowsHide: true });

  const withoutConfig = run();
  assert.equal(withoutConfig.status, 2);
  assert.match(withoutConfig.stderr, /Missing --project, --compile-commands, --clice, -o\./);

  await mkdir(join(directory, "runs"));
  await writeFile(join(directory, "clice-e2e.json"), JSON.stringify({ clice: "missing-clice", outputRoot: "runs",
    projects: [{ root: ".", compileCommands: "compile_commands.json" }] }));
  const withConfig = run();
  assert.equal(withConfig.status, 2, "The configured runtime does not exist.");
  assert.doesNotMatch(withConfig.stderr, /Missing --/);
  assert.match(withConfig.stderr, /missing-clice/);
  await assert.rejects(stat(join(directory, "runs", "anything")), { code: "ENOENT" });
}));
