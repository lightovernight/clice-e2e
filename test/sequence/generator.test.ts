import assert from "node:assert/strict";
import { test } from "node:test";
import { countRegions, type SyntaxRegion } from "../../src/sequence/cpp-syntax.js";
import { EditBuffer } from "../../src/sequence/edit-buffer.js";
import { generateEdits, planEdits, verifyPlan } from "../../src/sequence/generator.js";
import type { EditOperation } from "../../src/sequence/types.js";

function operations(source: string): EditOperation[] {
  return [...generateEdits(planEdits(source))];
}

test("creates the outer and inner shells before typing their contents", () => {
  const source = "void f(){one();if(ok){two();}three();}";
  const buffer = new EditBuffer();
  const snapshots: string[] = [];
  for (const operation of operations(source)) {
    buffer.apply(operation);
    snapshots.push(buffer.text);
  }
  const outer = snapshots.indexOf("void f(){}");
  const inner = snapshots.indexOf("void f(){one();if(ok){}}");
  assert.ok(outer >= 0);
  assert.ok(inner > outer);
  assert.ok(!snapshots.slice(0, outer + 1).some((text) => text.includes("one()")));
  assert.ok(!snapshots.slice(0, inner + 1).some((text) => text.includes("two()")));
  assert.equal(buffer.text, source);
});

test("the shell preserves original indentation instead of generating whitespace", () => {
  const source = "void f() {\r\n\twork();\r\n}";
  const buffer = new EditBuffer();
  let sawShell = false;
  for (const operation of operations(source)) {
    buffer.apply(operation);
    if (buffer.text === "void f() {\r\n\t\r\n}") sawShell = true;
  }
  assert.ok(sawShell);
  assert.equal(buffer.text, source);
});

test("every source code point is inserted once, using current-document UTF-16 offsets", () => {
  const source = '\uFEFF// 中文😀\r\nvoid f() {\r\n    use("🧪é");\r\n}\r\n';
  const edits = operations(source);
  const insertions = edits.filter((operation) => operation.type === "insert");
  assert.equal(insertions.length, [...source].length);
  assert.ok(insertions.some((operation) => operation.text === "😀"));
  assert.ok(insertions.some((operation) => operation.offset !== operation.sourceOffset));
  const sourceOrder = [...insertions].sort((a, b) => a.sourceOffset - b.sourceOffset);
  assert.equal(sourceOrder.map((operation) => operation.text).join(""), source);
  assert.equal(new Set(sourceOrder.map((operation) => operation.sourceOffset)).size, insertions.length);
  assert.equal(verifyPlan(planEdits(source)).insertions, [...source].length);
});

test("does not treat strings, raw strings, comments or macro replacement text as blocks", () => {
  const source = '#define BODY { ignored(); }\nconst char* text = R"tag({[]})tag";\nchar c = \'}\';\n// { fake }\nvoid f() { /* { fake } */ run(); }\n';
  const plan = planEdits(source);
  assert.equal(countRegions(plan.analysis.regions), 1);
  assert.equal(plan.analysis.regions[0]?.kind, "block");
  verifyPlan(plan);
});

test("discovers lambdas inside function headers and distinguishes initialization from bodies", () => {
  const source = "struct S { int n; S():n{1}{}; int f(int x=[] { return 1; }()) { return x; } };";
  const plan = planEdits(source);
  assert.equal(plan.analysis.hasParseErrors, false);
  assert.equal(countRegions(plan.analysis.regions), 5);
  const members = plan.analysis.regions[0];
  assert.equal(members?.kind, "members");
  assert.deepEqual(members?.children.map((region) => region.kind), ["initializer", "block", "block", "block"]);
  verifyPlan(plan);
});

test("retains a usable function region when a sibling contains a parse error", () => {
  const source = "void good(){return;} @@@";
  const plan = planEdits(source);
  assert.equal(plan.analysis.hasParseErrors, true);
  assert.ok(plan.analysis.issues.some((issue) => issue.reason === "parse-error"));
  assert.equal(countRegions(plan.analysis.regions), 1);
  verifyPlan(plan);
});

const reconstructionCases = new Map<string, string>([
  ["empty file", ""],
  ["whitespace only", " \r\n\t"],
  ["empty bodies", "void a(){} void b(){\n\t\n}"],
  ["constructor semicolons", "union mini_variant_impl { int value; mini_variant_impl() : value() {}; ~mini_variant_impl() {}; };"],
  ["declarators after a class body", "struct S { int x; } first{1}, second{2};"],
  ["unbraced statements and do-while tail", "void f(){ if(a) if(b) run(); else stop(); while(a) work(); do { work(); } while(a); }"],
  ["function try block", "struct A { int x; A() try : x{[] {return 1;}()} {} catch(...) { throw; } };"],
  ["requires and a nested compound requirement", "template<class T> concept C = requires(T t) { t+t; { [] { return 1; }() } noexcept; requires requires(T t) { t+t; }; };"],
  ["preprocessor branches with shared closing brace", "#if MODE_A\nnamespace A {\n#else\nnamespace B {\n#endif\nint value;\n}\n"],
  ["macro-generated body delimiters", "#define BEGIN {\n#define END }\nvoid f() BEGIN\nint x = 0;\nEND\n"],
  ["digraphs, supported structurally or replayed as text", "void f() <% int n{}; %>"],
  ["missing delimiter", "void f() { if(x) { run();"],
]);

for (const [name, source] of reconstructionCases) {
  test(`exact reconstruction: ${name}`, () => {
    const plan = planEdits(source);
    verifyPlan(plan);
    assert.deepEqual([...generateEdits(plan)], [...generateEdits(plan)]);
  });
}

test("classifies requirement bodies separately from statement blocks", () => {
  const plan = planEdits("template<class T> concept C = requires(T t) { { t+t } noexcept; };");
  assert.equal(plan.analysis.regions[0]?.kind, "requirements");
  assert.equal(plan.analysis.regions[0]?.children[0]?.kind, "compound-requirement");
});

test("nested planning and generation do not depend on the JavaScript call stack", () => {
  const source = "void f()" + "{".repeat(250) + "work();" + "}".repeat(250);
  const plan = planEdits(source);
  assert.equal(countRegions(plan.analysis.regions), 250);
  verifyPlan(plan);
});

test("regions form a non-overlapping forest inside source delimiters", () => {
  const source = "namespace n { struct X { int f(int x=[] {return 1;}()) {int a[]={1,2}; return x;} }; }";
  const plan = planEdits(source);
  const pending: Array<{ regions: readonly SyntaxRegion[]; start: number; end: number }> = [
    { regions: plan.analysis.regions, start: 0, end: source.length },
  ];
  for (const { regions, start, end } of pending) {
    let previous = start;
    for (const region of regions) {
      assert.ok(region.open.start >= previous);
      assert.ok(region.close.end <= end);
      assert.equal(source.slice(region.open.start, region.open.end), "{");
      assert.equal(source.slice(region.close.start, region.close.end), "}");
      pending.push({ regions: region.children, start: region.open.end, end: region.close.start });
      previous = region.close.end;
    }
  }
});

test("rejects malformed operations and surrogate-splitting moves", () => {
  const buffer = new EditBuffer();
  assert.throws(() => buffer.apply({ type: "move", offset: 1 }), /offset/);
  assert.throws(() => buffer.apply({ type: "insert", offset: 0, sourceOffset: 0, text: "ab", version: 1 }), /code point/);
  assert.throws(() => buffer.apply({ type: "insert", offset: 0, sourceOffset: 0, text: "a", version: 2 }), /version/);
  buffer.apply({ type: "insert", offset: 0, sourceOffset: 0, text: "😀", version: 1 });
  assert.throws(() => buffer.apply({ type: "move", offset: 1 }), /splits/);
  assert.throws(() => buffer.apply({ type: "insert", offset: 0, sourceOffset: 2, text: "a", version: 2 }), /cursor/);
  assert.throws(() => planEdits("\uD800"), /surrogate/);
});

test("sources beyond Tree-sitter's default 32 Ki input buffer are parsed, not rejected", () => {
  const body = Array.from({ length: 2500 }, (_, i) => `  int v${i} = ${i};\n`).join("");
  const source = `void big() {\n${body}}\n// 中文😀\n`;
  assert.ok(source.length > 40000);
  const plan = planEdits(source);
  assert.equal(plan.analysis.hasParseErrors, false);
  assert.equal(countRegions(plan.analysis.regions), 1);
  assert.equal(verifyPlan(plan).insertions, [...source].length);
});
