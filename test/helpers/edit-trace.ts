import assert from "node:assert/strict";
import { EditBuffer } from "../../src/sequence/edit-buffer.js";
import { generateEdits, planEdits, type EditPlan } from "../../src/sequence/generator.js";
import type { EditOperation } from "../../src/sequence/types.js";

export interface EditTrace {
  readonly plan: EditPlan;
  readonly edits: readonly EditOperation[];
  /** Document text immediately before the first character of `marker` is typed. */
  before(marker: string): string;
  /** Assert that the markers' first characters are typed in this order. */
  ordered(markers: readonly string[]): void;
}

/**
 * Generate edits for `source`, check they are deterministic and reconstruct it exactly,
 * then allow inspection by marker text. Markers must occur exactly once in the source.
 */
export function traceEdits(source: string): EditTrace {
  const plan = planEdits(source);
  const edits = [...generateEdits(plan)];
  assert.deepEqual([...generateEdits(plan)], edits, "Generation must be deterministic.");
  const buffer = new EditBuffer();
  for (const edit of edits) buffer.apply(edit);
  buffer.verify(source);

  const offsetOf = (marker: string): number => {
    const offset = source.indexOf(marker);
    assert.ok(offset >= 0, `Missing marker ${marker}`);
    assert.equal(source.indexOf(marker, offset + 1), -1, `Ambiguous marker ${marker}`);
    return offset;
  };
  const indexOf = (marker: string): number => {
    const offset = offsetOf(marker);
    return edits.findIndex((edit) => edit.type === "insert" && edit.sourceOffset === offset);
  };

  return {
    plan,
    edits,
    before(marker) {
      const stop = indexOf(marker);
      assert.ok(stop >= 0, `Marker was never inserted: ${marker}`);
      const current = new EditBuffer();
      for (const edit of edits.slice(0, stop)) current.apply(edit);
      return current.text;
    },
    ordered(markers) {
      let previous = -1;
      for (const marker of markers) {
        const index = indexOf(marker);
        assert.ok(index > previous, `Unexpected order for ${marker}`);
        previous = index;
      }
    },
  };
}

/** For inputs that are expected to be valid C++. */
export function assertCleanParse(trace: EditTrace): void {
  assert.equal(trace.plan.analysis.hasParseErrors, false);
  assert.deepEqual(trace.plan.analysis.issues, []);
}
