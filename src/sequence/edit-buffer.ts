import { isWellFormed, sha256 } from "../util/text.js";
import type { EditOperation, SequenceSummary } from "./types.js";

/**
 * A code-point gap buffer that applies edit operations with strict checks.
 * Used for offline verification of generated sequences and as the replay's document model.
 */
export class EditBuffer {
  private readonly left: string[] = [];
  private readonly right: string[] = [];
  private cursor = 0;
  private length = 0;
  private version = 0;
  private moves = 0;

  get text(): string {
    return this.left.join("") + [...this.right].reverse().join("");
  }

  get state(): { cursor: number; length: number; version: number } {
    return { cursor: this.cursor, length: this.length, version: this.version };
  }

  apply(operation: EditOperation): void {
    const { offset } = operation;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.length) {
      throw new Error(`Invalid edit offset ${offset} for document length ${this.length}.`);
    }
    if (operation.type === "insert") this.insert(operation.text, offset, operation.version);
    else this.moveTo(offset);
  }

  private insert(text: string, offset: number, version: number): void {
    if ([...text].length !== 1 || !isWellFormed(text)) {
      throw new Error("An insertion must contain exactly one valid Unicode code point.");
    }
    if (offset !== this.cursor) throw new Error("Insertion offset does not match the cursor.");
    if (version !== this.version + 1) throw new Error("Non-consecutive document version.");
    this.left.push(text);
    this.cursor += text.length;
    this.length += text.length;
    this.version = version;
  }

  private moveTo(offset: number): void {
    while (this.cursor !== offset) {
      const movingLeft = this.cursor > offset;
      const from = movingLeft ? this.left : this.right;
      const to = movingLeft ? this.right : this.left;
      const text = from.at(-1);
      if (!text || text.length > Math.abs(this.cursor - offset)) {
        throw new Error("Cursor move splits a Unicode code point.");
      }
      from.pop();
      to.push(text);
      this.cursor += movingLeft ? -text.length : text.length;
    }
    this.moves++;
  }

  /** The buffer must equal `expected` exactly; returns the summary record for it. */
  verify(expected: string): SequenceSummary {
    const actual = this.text;
    if (actual !== expected) throw new Error("Replay did not reconstruct the original source exactly.");
    return {
      type: "summary",
      verified: true,
      insertions: this.version,
      cursorMoves: this.moves,
      finalVersion: this.version,
      finalSha256: sha256(actual),
    };
  }
}
