import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { generateSequence, loadSequence, parseSequence } from "../../src/sequence/sequence-file.js";
import { sha256 } from "../../src/util/text.js";
import { withTempDir } from "../helpers/temp.js";

const source = '﻿// 中文😀\r\nstruct C {\r\nint f(){return 1;}\r\nint g(){return 2;}\r\n};\n';

test("a generated sequence round-trips through the same validation as a saved file", async () => withTempDir("clice-sequence-test-", async (directory) => {
  const sourceFile = join(directory, "source.cpp");
  await writeFile(sourceFile, source);
  const generated = await generateSequence(sourceFile);
  assert.equal(generated.header.target.sha256, sha256(source));
  assert.equal(generated.text(), [...generated.chunks()].join(""), "chunks() must be repeatable.");
  const loaded = await parseSequence(Buffer.from(generated.text()));
  assert.equal(loaded.source, source);
  assert.equal(loaded.operations.filter((operation) => operation.type === "insert").length, [...source].length);
  assert.equal(loaded.hash, sha256(generated.text()));
}));

test("sequence validation rejects a changed source and a dishonest summary", async () => withTempDir("clice-sequence-test-", async (directory) => {
  const sourceFile = join(directory, "source.cpp");
  const sequencePath = join(directory, "sequence.jsonl");
  await writeFile(sourceFile, source);
  await writeFile(sequencePath, (await generateSequence(sourceFile)).text());
  const original = await readFile(sequencePath, "utf8");

  await writeFile(sequencePath, original.replace('"verified":true', '"verified":false'));
  await assert.rejects(loadSequence(sequencePath), /summary/);
  await writeFile(sequencePath, original);
  await writeFile(sourceFile, source + " ");
  await assert.rejects(loadSequence(sequencePath), /changed/);
}));

test("sequence validation rejects reused source characters", async () => withTempDir("clice-sequence-test-", async (directory) => {
  const sourceFile = join(directory, "source.cpp");
  await writeFile(sourceFile, "ab");
  const lines = (await generateSequence(sourceFile)).text().trimEnd().split("\n");
  const second = JSON.parse(lines[2]!) as { sourceOffset: number };
  second.sourceOffset = 0;
  lines[2] = JSON.stringify(second);
  await assert.rejects(parseSequence(Buffer.from(lines.join("\n"))), /sourceOffset/);
}));
