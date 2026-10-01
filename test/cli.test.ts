import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EditBuffer } from "../src/sequence/edit-buffer.js";
import type { SequenceRecord } from "../src/sequence/types.js";
import { sha256 } from "../src/util/text.js";
import { cliPath } from "./helpers/paths.js";
import { withTempDir, writeProject } from "./helpers/temp.js";

// Run outside the checkout so a developer's clice-e2e.json cannot supply defaults.
const cli = (...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });

test("generate writes a verifiable JSONL file and refuses to overwrite files", () => withTempDir("clice-cli-test-", async (directory) => {
  const input = join(directory, "source.cpp");
  const output = join(directory, "sequence.jsonl");
  const source = '﻿// 中文😀\r\nvoid f(){ use("🧪"); }\r\n';
  await writeFile(input, source, "utf8");
  const run = cli("generate", input, "-o", output);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Verified:/);
  const jsonl = await readFile(output, "utf8");
  const records = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line) as SequenceRecord);
  const header = records[0];
  if (header?.type !== "sequence") assert.fail("Missing sequence header");
  assert.equal(header.offsetEncoding, "utf-16");
  assert.equal(header.strategy, "class-members-first");
  assert.equal(header.target.sha256, sha256(source));
  assert.equal(header.parser.cppGrammarVersion, "0.23.4");
  const buffer = new EditBuffer();
  for (const record of records) if (record.type === "insert" || record.type === "move") buffer.apply(record);
  assert.equal(buffer.text, source);
  assert.deepEqual(records.at(-1), buffer.verify(source));

  assert.equal(cli("generate", input, "-o", output).status, 2);
  assert.equal(await readFile(output, "utf8"), jsonl);
  assert.equal(cli("generate", input, "-o", input).status, 2);
  assert.equal(await readFile(input, "utf8"), source);
}));

test("generate emits clean JSONL on stdout and rejects invalid UTF-8", () => withTempDir("clice-cli-test-", async (directory) => {
  const input = join(directory, "source.cpp");
  await writeFile(input, "void f() {}");
  const run = cli("generate", input);
  assert.equal(run.status, 0, run.stderr);
  for (const line of run.stdout.trimEnd().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
  await writeFile(input, Buffer.from([0xff, 0xfe, 0x00]));
  const invalid = cli("generate", input);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /UTF-8/);
  assert.equal(invalid.stdout, "");
}));

test("commands describe their input and reject invalid invocations", () => {
  assert.equal(cli("--help").status, 0);
  assert.match(cli("--help").stdout, /generate <file\.cpp>/);
  assert.equal(cli().status, 2);
  assert.equal(cli("unknown").status, 2);
  assert.match(cli("generate", "--help").stdout, /<file\.cpp>/);
  for (const [command, input] of [["e2e", "file.cpp"], ["replay", "sequence.jsonl"]] as const) {
    const help = cli(command, "--help");
    assert.equal(help.status, 0, help.stderr);
    assert(help.stdout.includes(`<${input}>`));
    assert.equal(cli(command).status, 2);
    assert.equal(cli(command, "--no-such-option").status, 2, "Unknown options are rejected.");
  }
});

test("e2e reports a missing runtime as ERROR before creating output", () => withTempDir("clice-cli-test-", async (directory) => {
  const project = await writeProject(directory, "int f(){return 1;}\n");
  const run = cli("e2e", project.sourceFile, "--project", directory, "--compile-commands", project.compileCommandsPath,
    "--clice", join(directory, "missing-clice"), "-o", project.outputDirectory);
  assert.equal(run.status, 2, "A missing runtime is an ERROR, not a FAIL.");
  assert.equal(run.stdout, "");
  await assert.rejects(stat(project.outputDirectory), { code: "ENOENT" });
}));

test("e2e returns an error without starting replay when generation fails", () => withTempDir("clice-cli-test-", async (directory) => {
  const project = await writeProject(directory, "int x;\n");
  await writeFile(project.sourceFile, Buffer.from([0xff]));
  const result = cli("e2e", project.sourceFile, "--project", directory, "--compile-commands", project.compileCommandsPath,
    "--clice", process.execPath, "-o", project.outputDirectory);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /UTF-8/);
  assert.equal(result.stdout, "");
  await assert.rejects(stat(project.outputDirectory), { code: "ENOENT" });
}));
