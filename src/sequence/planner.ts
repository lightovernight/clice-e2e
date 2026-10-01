import type { SyntaxRegion } from "./cpp-syntax.js";
import { TaskGraphBuilder, topologicalOrder, validateSourceCoverage, type Subplan, type TaskGraph } from "./task-graph.js";
import type { SourceRange } from "./types.js";

/**
 * Turn syntax regions into editing dependencies ("class-members-first" strategy):
 *
 * - Every brace region is typed as a shell first: `{`, the original leading/trailing
 *   whitespace and `}` (plus a class's `;`), then the caret moves inside to fill it.
 * - A class body has two phases. *Prepare* types every member with empty function bodies;
 *   *fill* then types the member-function bodies in source order. Directly nested classes
 *   join the outer class's preparation barrier.
 *
 * No current-document offsets are computed here; the generator derives them from the order.
 */

interface RegionPlan {
  /** Shell only (and, for classes, all member declarations). */
  readonly prepare: Subplan;
  /** Deferred contents. */
  readonly fill: Subplan;
  /** prepare → fill. */
  readonly full: Subplan;
}

const regionEnd = (region: SyntaxRegion): number => region.suffix?.end ?? region.close.end;

export function buildTaskGraph(source: string, regions: readonly SyntaxRegion[]): TaskGraph {
  const builder = new TaskGraphBuilder();
  const planned = new Map<SyntaxRegion, RegionPlan>();

  /**
   * Plan the text of `range` with its child regions. Inside a class (`owner`), nested classes
   * and member-function bodies contribute only their preparation; their fills are returned
   * separately so the class can schedule them after its preparation barrier.
   */
  function content(range: SourceRange, children: readonly SyntaxRegion[], owner?: SyntaxRegion) {
    const parts: Subplan[] = [];
    const fills: Subplan[] = [];
    let position = range.start;
    for (const child of children) {
      const childPlan = planned.get(child);
      if (!childPlan) throw new Error("A child region must be planned before its parent.");
      if (child.open.start < position || regionEnd(child) > range.end) {
        throw new Error("A child region or its suffix overlaps its parent's content.");
      }
      if (position < child.open.start) parts.push(builder.emit([{ start: position, end: child.open.start }]));
      if (owner && (child.kind === "members" || child.memberBodyOf === owner.open.start)) {
        parts.push(childPlan.prepare);
        fills.push(childPlan.fill);
      } else {
        parts.push(childPlan.full);
      }
      position = regionEnd(child);
    }
    if (position < range.end) parts.push(builder.emit([{ start: position, end: range.end }]));
    return { parts, fills };
  }

  function planRegion(region: SyntaxRegion): RegionPlan {
    const interior = source.slice(region.open.end, region.close.start);
    const leading = interior.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = interior.match(/\s*$/u)?.[0].length ?? 0;
    const bodyStart = region.open.end + leading;
    const bodyEnd = region.close.start - trailing;
    const end = regionEnd(region);
    const nonempty = bodyStart < bodyEnd;
    const shell = builder.emit(nonempty
      ? [{ start: region.open.start, end: bodyStart }, { start: bodyEnd, end }]
      : [{ start: region.open.start, end }]);
    const body = { start: bodyStart, end: bodyEnd };

    if (region.kind !== "members") {
      const { parts } = nonempty ? content(body, region.children) : { parts: [] };
      const fill = nonempty ? builder.sequence([...parts, builder.move(end)]) : builder.gate("empty-body");
      builder.connect(shell.exit, fill.entry);
      return { prepare: shell, fill, full: { entry: shell.entry, exit: fill.exit } };
    }

    const { parts, fills } = nonempty ? content(body, region.children, region) : { parts: [], fills: [] };
    const prepared = builder.gate(`class.prepared@${region.open.start}`);
    const done = builder.gate(`class.done@${region.open.start}`);
    const prepare = builder.sequence([shell, ...parts, builder.move(end), prepared]);
    // Chains select source order; these extra edges express the phase barrier, so that a nested
    // class's fills also wait for the enclosing class's preparation.
    for (const part of parts) builder.connect(part.exit, prepared.entry);
    for (const fill of fills) {
      builder.connect(prepared.exit, fill.entry);
      builder.connect(fill.exit, done.entry);
    }
    const fill = builder.sequence([...fills, builder.move(end), done]);
    builder.connect(prepare.exit, fill.entry);
    return { prepare, fill, full: { entry: prepare.entry, exit: fill.exit } };
  }

  // Iterative post-order: children are planned before parents without using the JS call stack.
  const pending = regions.map((region) => ({ region, visited: false })).reverse();
  for (let frame = pending.pop(); frame; frame = pending.pop()) {
    if (frame.visited) {
      planned.set(frame.region, planRegion(frame.region));
      continue;
    }
    pending.push({ region: frame.region, visited: true });
    for (let index = frame.region.children.length - 1; index >= 0; index--) {
      pending.push({ region: frame.region.children[index]!, visited: false });
    }
  }

  const { parts } = content({ start: 0, end: source.length }, regions);
  const graph = builder.finish(builder.sequence(parts));
  validateSourceCoverage(source, graph);
  topologicalOrder(graph);
  return graph;
}
