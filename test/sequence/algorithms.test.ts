import assert from "node:assert/strict";
import { test } from "node:test";
import { SourcePositions } from "../../src/sequence/source-positions.js";
import { TaskGraphBuilder, topologicalOrder, validateSourceCoverage } from "../../src/sequence/task-graph.js";

test("topological scheduling enforces a join barrier even when fill IDs come first", () => {
  const builder = new TaskGraphBuilder();
  const fills = Array.from({ length: 3 }, (_, i) => builder.gate(`fill${i}`));
  const preparations = Array.from({ length: 3 }, (_, i) => builder.gate(`prepare${i}`));
  const entry = builder.gate("entry");
  const prepared = builder.gate("prepared");
  const done = builder.gate("done");
  for (const prepare of preparations) {
    builder.connect(entry.exit, prepare.entry);
    builder.connect(prepare.exit, prepared.entry);
  }
  for (const fill of fills) {
    builder.connect(prepared.exit, fill.entry);
    builder.connect(fill.exit, done.entry);
  }
  const graph = builder.finish({ entry: entry.entry, exit: done.exit });
  const order = topologicalOrder(graph);
  assert.ok(Math.max(...preparations.map((p) => order.indexOf(p.exit))) < order.indexOf(prepared.entry));
  assert.ok(Math.min(...fills.map((p) => order.indexOf(p.entry))) > order.indexOf(prepared.exit));
  assert.deepEqual(topologicalOrder(graph), order);
  assert.throws(() => topologicalOrder({ ...graph, edges: [...graph.edges, { from: fills[0]!.exit, to: preparations[0]!.entry }] }), /cycle/);
  assert.throws(() => topologicalOrder({ ...graph, edges: [...graph.edges, { from: -1, to: 0 }] }), /Unknown task/);
  builder.gate("unconnected");
  assert.throws(() => topologicalOrder(builder.finish({ entry: entry.entry, exit: done.exit })), /reachable/);
});

test("coverage validation rejects missing, repeated and split source characters", () => {
  const graphFor = (ranges: readonly { start: number; end: number }[]) => {
    const builder = new TaskGraphBuilder();
    return builder.finish(builder.emit(ranges));
  };
  const source = "A😀B";
  validateSourceCoverage(source, graphFor([{ start: 3, end: 4 }, { start: 0, end: 1 }, { start: 1, end: 3 }]));
  assert.throws(() => validateSourceCoverage(source, graphFor([{ start: 0, end: 1 }, { start: 3, end: 4 }])), /gap/);
  assert.throws(() => validateSourceCoverage(source, graphFor([{ start: 0, end: 4 }, { start: 3, end: 4 }])), /overlap/);
  assert.throws(() => validateSourceCoverage(source, graphFor([{ start: 0, end: 2 }, { start: 2, end: 4 }])), /splits/);
  assert.throws(() => validateSourceCoverage(source, graphFor([{ start: 0, end: 1 }])), /gap/);
});

function* permutations(values: readonly number[]): Generator<number[]> {
  if (!values.length) { yield []; return; }
  for (const [index, value] of values.entries()) {
    for (const rest of permutations(values.filter((_, i) => i !== index))) yield [value, ...rest];
  }
}

test("source positions match a plain-string oracle for all 720 insertion orders", () => {
  const source = "A{中😀}B";
  const characters: Array<{ offset: number; text: string }> = [];
  let offset = 0;
  for (const text of source) { characters.push({ offset, text }); offset += text.length; }
  let count = 0;
  for (const order of permutations(characters.map((_, i) => i))) {
    const positions = new SourcePositions(source);
    const inserted = new Set<number>();
    let document = "";
    for (const index of order) {
      const character = characters[index]!;
      const at = positions.currentOffset(character.offset);
      document = document.slice(0, at) + character.text + document.slice(at);
      assert.equal(positions.insert(character.offset), character.text.length);
      inserted.add(index);
      assert.equal(document, characters.filter((_, i) => inserted.has(i)).map((c) => c.text).join(""));
      for (const boundary of [...characters.map((c) => c.offset), source.length]) {
        const prefix = characters.filter((c, i) => inserted.has(i) && c.offset < boundary).map((c) => c.text).join("");
        assert.equal(positions.currentOffset(boundary), prefix.length);
      }
    }
    assert.equal(document, source);
    count++;
  }
  assert.equal(count, 720);
  const positions = new SourcePositions(source);
  positions.insert(3);
  assert.throws(() => positions.insert(3), /twice/);
  assert.throws(() => positions.currentOffset(4), /splits/);
  assert.throws(() => positions.insert(source.length), /end boundary/);
});
