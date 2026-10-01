import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isRecord } from "../util/json.js";
import { decodeUtf8, readUtf8File, sha256 } from "../util/text.js";
import { countRegions, parserVersions } from "./cpp-syntax.js";
import { EditBuffer } from "./edit-buffer.js";
import { generateEdits, planEdits, verifyPlan } from "./generator.js";
import type { EditOperation, SequenceHeader, SequenceRecord, SequenceSummary } from "./types.js";

/** Producing and consuming sequence JSONL files. Both directions verify exact reconstruction. */

export interface GeneratedSequence {
  readonly header: SequenceHeader;
  readonly summary: SequenceSummary;
  /** JSONL text in ~64 KiB chunks. Each call starts a fresh pass over the operations. */
  chunks(): Iterable<string>;
  text(): string;
}

/** Plan and verify the whole sequence before any output is opened or clice is started. */
export async function generateSequence(input: string): Promise<GeneratedSequence> {
  const sourceFile = resolve(input);
  const source = await readUtf8File(sourceFile, "The input");
  const plan = planEdits(source);
  const summary = verifyPlan(plan);
  const header: SequenceHeader = {
    type: "sequence",
    formatVersion: 1,
    sourceFile,
    sourceEncoding: "utf-8",
    offsetEncoding: "utf-16",
    initialText: "",
    initialVersion: 0,
    strategy: "class-members-first",
    target: { sha256: sha256(source), utf16Length: source.length },
    parser: parserVersions(),
    regionCount: countRegions(plan.analysis.regions),
    hasParseErrors: plan.analysis.hasParseErrors,
    issues: plan.analysis.issues,
  };
  function* records(): Generator<SequenceRecord> {
    yield header;
    yield* generateEdits(plan);
    yield summary;
  }
  const chunks = () => encodeJsonl(records());
  return { header, summary, chunks, text: () => [...chunks()].join("") };
}

function* encodeJsonl(records: Iterable<unknown>, chunkSize = 64 * 1024): Generator<string> {
  let chunk = "";
  for (const record of records) {
    chunk += `${JSON.stringify(record)}\n`;
    if (chunk.length >= chunkSize) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk) yield chunk;
}

export interface LoadedSequence {
  readonly header: SequenceHeader;
  readonly operations: readonly EditOperation[];
  /** Current contents of `header.sourceFile`, checked against the recorded fingerprint. */
  readonly source: string;
  readonly raw: Buffer;
  readonly hash: string;
}

export async function loadSequence(path: string): Promise<LoadedSequence> {
  return parseSequence(await readFile(path));
}

/**
 * Validate a sequence against its source file: header, fingerprint, every offset, version and
 * sourceOffset, and the summary. Nothing in the file (not even `verified: true`) is trusted.
 */
export async function parseSequence(raw: Buffer): Promise<LoadedSequence> {
  const text = decodeUtf8(raw);
  const records: unknown[] = text.trimEnd().split("\n").map((line, index) => {
    try { return JSON.parse(line) as unknown; }
    catch { throw new Error(`Invalid JSON on sequence line ${index + 1}.`); }
  });

  const header = records[0];
  assert(isRecord(header) && header.type === "sequence" && header.formatVersion === 1, "Unsupported sequence format.");
  assert(header.sourceEncoding === "utf-8" && header.offsetEncoding === "utf-16", "Unsupported sequence encoding.");
  assert(header.initialText === "" && header.initialVersion === 0, "Sequence must start with an empty document at version 0.");
  assert(typeof header.sourceFile === "string" && isAbsolute(header.sourceFile), "Sequence sourceFile must be absolute.");
  assert(header.strategy === "class-members-first", "Unsupported strategy.");
  assert(isRecord(header.target), "Missing target fingerprint.");

  const source = await readUtf8File(header.sourceFile);
  assert.equal(header.target.sha256, sha256(source), "Source has changed since sequence generation; regenerate the sequence.");
  assert.equal(header.target.utf16Length, source.length, "Source length mismatch.");

  // Each source code point must be inserted exactly once, with its own text.
  const untyped = new Map<number, string>();
  let offset = 0;
  for (const character of source) { untyped.set(offset, character); offset += character.length; }

  const buffer = new EditBuffer();
  const operations = records.slice(1, -1).map((record, index): EditOperation => {
    const line = index + 2;
    assert(isRecord(record), `Invalid operation on line ${line}.`);
    assert(record.type === "insert" || record.type === "move", `Unexpected record on line ${line}.`);
    assert(typeof record.offset === "number", "Operation offset must be a number.");
    let operation: EditOperation;
    if (record.type === "insert") {
      assert(typeof record.text === "string" && typeof record.sourceOffset === "number" && typeof record.version === "number", "Invalid insertion.");
      assert.equal(untyped.get(record.sourceOffset), record.text, "Insertion sourceOffset is invalid or reused.");
      untyped.delete(record.sourceOffset);
      operation = { type: "insert", offset: record.offset, text: record.text, sourceOffset: record.sourceOffset, version: record.version };
    } else {
      operation = { type: "move", offset: record.offset };
    }
    buffer.apply(operation);
    return operation;
  });
  assert.equal(untyped.size, 0, "Sequence does not cover the source.");
  assert.deepEqual(records.at(-1), buffer.verify(source), "Sequence summary does not match its operations.");
  return { header: header as unknown as SequenceHeader, operations, source, raw, hash: sha256(text) };
}
