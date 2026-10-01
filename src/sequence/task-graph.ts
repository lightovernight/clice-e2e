import { assertCodePointBoundary } from "../util/text.js";
import type { SourceRange } from "./types.js";

/**
 * A dependency graph of coarse editing tasks. Task IDs are indices into `tasks`.
 * `emit` types original source ranges, `move` places the caret at a source position,
 * and `gate` is an empty join point used to express phase barriers.
 */
export type EditTask =
  | { readonly kind: "emit"; readonly ranges: readonly SourceRange[] }
  | { readonly kind: "move"; readonly sourceOffset: number }
  | { readonly kind: "gate"; readonly label: string };

/** A connected piece of the graph with a single entry and a single exit task. */
export interface Subplan {
  readonly entry: number;
  readonly exit: number;
}

export interface TaskGraph extends Subplan {
  readonly tasks: readonly EditTask[];
  readonly edges: readonly { readonly from: number; readonly to: number }[];
}

export class TaskGraphBuilder {
  private readonly tasks: EditTask[] = [];
  private readonly outgoing: Set<number>[] = [];

  task(task: EditTask): Subplan {
    const id = this.tasks.length;
    this.tasks.push(task);
    this.outgoing.push(new Set());
    return { entry: id, exit: id };
  }

  gate(label: string): Subplan {
    return this.task({ kind: "gate", label });
  }

  emit(ranges: readonly SourceRange[]): Subplan {
    const nonempty = ranges.filter((range) => range.start !== range.end);
    return nonempty.length ? this.task({ kind: "emit", ranges: nonempty }) : this.gate("empty");
  }

  move(sourceOffset: number): Subplan {
    return this.task({ kind: "move", sourceOffset });
  }

  connect(from: number, to: number): void {
    const successors = this.outgoing[from];
    if (!successors || !this.tasks[to]) throw new Error(`Unknown task in dependency ${from} -> ${to}.`);
    successors.add(to);
  }

  /** Chain parts in order; returns the combined entry/exit. */
  sequence(parts: readonly Subplan[]): Subplan {
    const first = parts[0];
    const last = parts.at(-1);
    if (!first || !last) return this.gate("empty");
    for (let index = 1; index < parts.length; index++) this.connect(parts[index - 1]!.exit, parts[index]!.entry);
    return { entry: first.entry, exit: last.exit };
  }

  finish(plan: Subplan): TaskGraph {
    const edges = this.outgoing.flatMap((targets, from) => [...targets].map((to) => ({ from, to })));
    return { ...plan, tasks: [...this.tasks], edges };
  }
}

/**
 * Stable Kahn ordering. Source-order preferences belong in edges, not queue heuristics.
 * Also rejects cycles and tasks that are unreachable from entry or cannot reach exit.
 */
export function topologicalOrder(graph: TaskGraph): number[] {
  const size = graph.tasks.length;
  const validId = (id: number): boolean => Number.isSafeInteger(id) && id >= 0 && id < size;
  if (!validId(graph.entry) || !validId(graph.exit)) throw new Error("Invalid graph entry or exit.");
  const indegrees = new Array<number>(size).fill(0);
  const outgoing = Array.from({ length: size }, () => [] as number[]);
  for (const { from, to } of graph.edges) {
    if (!validId(from) || !validId(to)) throw new Error(`Unknown task in dependency ${from} -> ${to}.`);
    outgoing[from]!.push(to);
    indegrees[to]!++;
  }

  const order: number[] = [];
  for (let id = 0; id < size; id++) if (indegrees[id] === 0) order.push(id);
  // The queue itself becomes the result; no repeated Array.shift().
  for (let head = 0; head < order.length; head++) {
    for (const next of outgoing[order[head]!]!) {
      if (--indegrees[next]! === 0) order.push(next);
    }
  }
  if (order.length !== size) {
    const blocked = indegrees.flatMap((degree, id) => degree > 0 ? [id] : []);
    throw new Error(`Task dependency cycle; blocked task IDs: ${blocked.join(", ")}.`);
  }

  const reachable = new Set([graph.entry]);
  for (const id of order) if (reachable.has(id)) for (const next of outgoing[id]!) reachable.add(next);
  const canFinish = new Set([graph.exit]);
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index]!;
    if (outgoing[id]!.some((next) => canFinish.has(next))) canFinish.add(id);
  }
  if (reachable.size !== size || canFinish.size !== size) {
    throw new Error("Every task must be reachable from entry and lead to exit.");
  }
  return order;
}

/** Every source character is emitted exactly once: no generated text, omissions or duplicates. */
export function validateSourceCoverage(source: string, graph: TaskGraph): void {
  const ranges: SourceRange[] = [];
  for (const task of graph.tasks) {
    if (task.kind === "move") assertCodePointBoundary(source, task.sourceOffset);
    if (task.kind !== "emit") continue;
    for (const range of task.ranges) {
      assertCodePointBoundary(source, range.start);
      assertCodePointBoundary(source, range.end);
      if (range.start >= range.end) throw new Error("Emit ranges must be nonempty and forward.");
      ranges.push(range);
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let end = 0;
  for (const range of ranges) {
    if (range.start !== end) throw new Error(`Source coverage gap or overlap at offset ${end}.`);
    end = range.end;
  }
  if (end !== source.length) throw new Error(`Source coverage gap at offset ${end}.`);
}
