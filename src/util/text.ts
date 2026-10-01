import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Hex SHA-256; strings are hashed as UTF-8. */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Strict decoding: the text must round-trip to exactly the same bytes. No replacement characters. */
export function decodeUtf8(bytes: Buffer, what = "Input"): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${what} must be valid UTF-8. No encoding conversion was performed.`);
  }
  return text;
}

export async function readUtf8File(path: string, what?: string): Promise<string> {
  return decodeUtf8(await readFile(path), what);
}

/** No unpaired surrogates (such text cannot be written as UTF-8). */
export function isWellFormed(text: string): boolean {
  return Buffer.from(text, "utf8").toString("utf8") === text;
}

export function assertWellFormed(text: string): void {
  if (!isWellFormed(text)) {
    throw new Error("Source contains an unpaired UTF-16 surrogate.");
  }
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

/** True when `offset` falls between the two UTF-16 units of one code point. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  return isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset));
}

/** A valid UTF-16 offset that does not split a code point. */
export function assertCodePointBoundary(text: string, offset: number, what = "Source offset"): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new Error(`Invalid ${what.toLowerCase()}: ${offset}.`);
  }
  if (splitsSurrogatePair(text, offset)) throw new Error(`${what} ${offset} splits a Unicode code point.`);
}
