import type { EditOperation } from "../sequence/types.js";

/**
 * `serial`: every operation waits for its probes before the next one.
 * `burst`: the keystrokes of one word or whitespace run are sent without waiting in between,
 * the way an editor sends them while the user keeps typing.
 */
export type Typing = "serial" | "burst";

/** Bounds the number of requests in flight at once. */
const maxBurstLength = 32;

const classOf = (text: string): "word" | "space" | "other" =>
  /^[\p{L}\p{N}_]$/u.test(text) ? "word" : /^\s$/.test(text) ? "space" : "other";

/**
 * Split operations into bursts: consecutive insertions of one word (identifier, keyword,
 * number) or one whitespace run, typed left to right. Punctuation, cursor moves and
 * operations that are not probed are groups of their own, so every token boundary is
 * still a point where all probes must succeed.
 */
export function typingGroups(operations: readonly EditOperation[], probed: (operation: EditOperation) => boolean): EditOperation[][] {
  const groups: EditOperation[][] = [];
  let previous: EditOperation | undefined;
  for (const operation of operations) {
    const group = groups.at(-1);
    const continues = group !== undefined && group.length < maxBurstLength &&
      previous?.type === "insert" && operation.type === "insert" && probed(previous) && probed(operation) &&
      operation.offset === previous.offset + previous.text.length &&
      operation.sourceOffset === previous.sourceOffset + previous.text.length &&
      classOf(operation.text) !== "other" && classOf(operation.text) === classOf(previous.text);
    if (continues) group.push(operation);
    else groups.push([operation]);
    previous = operation;
  }
  return groups;
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32), so a run can be repeated from its seed. */
export function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
