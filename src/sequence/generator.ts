import { analyzeSource, type SourceAnalysis } from "./cpp-syntax.js";
import { EditBuffer } from "./edit-buffer.js";
import { buildTaskGraph } from "./planner.js";
import { SourcePositions } from "./source-positions.js";
import { topologicalOrder, type TaskGraph } from "./task-graph.js";
import type { EditOperation, SequenceSummary } from "./types.js";

export interface EditPlan {
  readonly source: string;
  readonly analysis: SourceAnalysis;
  readonly graph: TaskGraph;
}

/** source → syntax regions → task graph. */
export function planEdits(source: string): EditPlan {
  const analysis = analyzeSource(source);
  return { source, analysis, graph: buildTaskGraph(source, analysis.regions) };
}

/** Schedule coarse tasks, then materialize them as caret moves and single-code-point insertions. */
export function* generateEdits(plan: EditPlan): Generator<EditOperation> {
  const { source, graph } = plan;
  const positions = new SourcePositions(source);
  let cursor = 0;
  let version = 0;

  function* moveTo(sourceOffset: number): Generator<EditOperation> {
    const offset = positions.currentOffset(sourceOffset);
    if (cursor !== offset) yield { type: "move", offset };
    cursor = offset;
  }

  // The complete order (including cycle detection) is validated before anything is yielded.
  for (const id of topologicalOrder(graph)) {
    const task = graph.tasks[id]!;
    if (task.kind === "gate") continue;
    if (task.kind === "move") {
      yield* moveTo(task.sourceOffset);
      continue;
    }
    for (const range of task.ranges) {
      yield* moveTo(range.start);
      for (let sourceOffset = range.start; sourceOffset < range.end;) {
        const width = positions.insert(sourceOffset);
        const text = source.slice(sourceOffset, sourceOffset + width);
        yield { type: "insert", offset: cursor, text, sourceOffset, version: ++version };
        cursor += width;
        sourceOffset += width;
      }
    }
  }
}

/** Apply every operation offline and require an exact reconstruction of the source. */
export function verifyPlan(plan: EditPlan): SequenceSummary {
  const buffer = new EditBuffer();
  for (const operation of generateEdits(plan)) buffer.apply(operation);
  return buffer.verify(plan.source);
}
