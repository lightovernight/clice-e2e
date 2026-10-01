import { assertCodePointBoundary } from "../util/text.js";

/**
 * Maps final-source offsets to current-document offsets while characters are inserted
 * out of order. A Fenwick tree keeps prefix lengths of the already-typed characters.
 */
export class SourcePositions {
  private readonly tree: Uint32Array;
  private readonly inserted: Uint8Array;

  constructor(private readonly source: string) {
    this.tree = new Uint32Array(source.length + 1);
    this.inserted = new Uint8Array(source.length);
  }

  currentOffset(sourceOffset: number): number {
    assertCodePointBoundary(this.source, sourceOffset);
    let length = 0;
    for (let index = sourceOffset; index > 0; index -= index & -index) length += this.tree[index]!;
    return length;
  }

  /** Marks the code point at `sourceOffset` as typed; returns its UTF-16 length. */
  insert(sourceOffset: number): number {
    assertCodePointBoundary(this.source, sourceOffset);
    const codePoint = this.source.codePointAt(sourceOffset);
    if (codePoint === undefined) throw new Error("Cannot insert at the source's end boundary.");
    if (this.inserted[sourceOffset]) throw new Error(`Source character ${sourceOffset} was inserted twice.`);
    const width = codePoint > 0xffff ? 2 : 1;
    this.inserted[sourceOffset] = width;
    for (let index = sourceOffset + 1; index < this.tree.length; index += index & -index) {
      this.tree[index]! += width;
    }
    return width;
  }
}
