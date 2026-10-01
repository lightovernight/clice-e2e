import type { Position } from "vscode-languageserver-protocol/node.js";
import { splitsSurrogatePair } from "../util/text.js";

const CR = 13;
const LF = 10;

/** LSP positions count UTF-16 code units; CR, LF and CRLF each end one line. */
export function positionAt(text: string, offset: number): Position {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("Invalid document offset.");
  if (splitsSurrogatePair(text, offset) || (text.charCodeAt(offset - 1) === CR && text.charCodeAt(offset) === LF)) {
    throw new Error("LSP position splits a surrogate pair or CRLF.");
  }
  let line = 0;
  let start = 0;
  for (let i = 0; i < offset; i++) {
    const code = text.charCodeAt(i);
    if (code === CR || code === LF) {
      if (code === CR && text.charCodeAt(i + 1) === LF) i++;
      line++;
      start = i + 1;
    }
  }
  return { line, character: offset - start };
}

/** Strict inverse of positionAt, without LSP's clamping; used to check outgoing payloads. */
export function offsetAt(text: string, position: Position): number {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) ||
    position.line < 0 || position.character < 0) throw new Error("Invalid LSP position.");
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    let i = start;
    while (i < text.length && text[i] !== "\r" && text[i] !== "\n") i++;
    if (i === text.length) throw new Error("LSP line exceeds document.");
    start = i + (text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1);
  }
  let end = start;
  while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end++;
  const offset = start + position.character;
  if (offset > end) throw new Error("LSP character exceeds line.");
  positionAt(text, offset);
  return offset;
}
