import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isRecord } from "../util/json.js";
import { decodeUtf8, sha256 } from "../util/text.js";

export interface CompileCommands {
  readonly path: string;
  readonly raw: Buffer;
  readonly hash: string;
  /** The entry for the source file, or null when clice must infer one (headers, new files). */
  readonly entry: unknown;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function isValidEntry(entry: unknown): boolean {
  if (!isRecord(entry) || !isNonEmptyString(entry.file) || typeof entry.directory !== "string" || !isAbsolute(entry.directory)) return false;
  return isNonEmptyString(entry.command) ||
    (Array.isArray(entry.arguments) && entry.arguments.length > 0 && entry.arguments.every((arg: unknown) => typeof arg === "string"));
}

/**
 * Validate the compilation database and look up the source file's entry for the run record.
 * The original file is passed to clice unchanged; clice resolves commands for headers itself.
 */
export async function loadCompileCommands(path: string, sourceFile: string): Promise<CompileCommands> {
  const raw = await readFile(path);
  const entries: unknown = JSON.parse(decodeUtf8(raw));
  assert(Array.isArray(entries), "compile_commands.json must be an array.");
  assert(entries.length > 0, "compile_commands.json must contain at least one compile command.");
  entries.forEach((entry, index) => assert(isValidEntry(entry), `Invalid compile command entry ${index + 1}.`));

  const key = (file: string): string => process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
  const target = key(sourceFile);
  const entry = entries.find((row: { directory: string; file: string }) => key(resolve(row.directory, row.file)) === target);
  return { path, raw, hash: sha256(raw), entry: entry ?? null };
}
