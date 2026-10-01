import assert from "node:assert/strict";
import { test } from "node:test";
import { EditBuffer } from "../../src/sequence/edit-buffer.js";
import { generateEdits, planEdits } from "../../src/sequence/generator.js";
import { traceEdits } from "../helpers/edit-trace.js";

for (const keyword of ["class", "struct", "union"]) {
  test(`${keyword}: all member shells and fields precede the first implementation`, () => {
    const source = `${keyword} S{int a(){alpha();}int value;void b(){beta();}};void after(){tail();}`;
    const skeleton = `${keyword} S{int a(){}int value;void b(){}};`;
    const trace = traceEdits(source);
    assert.equal(trace.before("alpha"), skeleton);
    assert.equal(trace.before("beta"), skeleton.replace("a(){}", "a(){alpha();}"));
    trace.ordered(["int value", "alpha", "beta", "void after", "tail"]);
  });
}

test("nested class preparations join the outer barrier before any of their implementations", () => {
  const source = "struct Outer{void a(){A();}struct Inner{struct Deep{void d(){D();}int deep;};void b(){B();}int inner;};void c(){C();}int outer;};";
  const trace = traceEdits(source);
  assert.equal(trace.before("A();"), source.replace(/\b[ADBC]\(\);/gu, ""));
  trace.ordered(["int deep", "int inner", "int outer", "A();", "D();", "B();", "C();"]);
});

test("function-local classes prepare their members only when their enclosing body is filled", () => {
  const source = "struct S{void a(){struct Local{void x(){X();}void y(){Y();}};Z();}void b(){B();}int value;};";
  const trace = traceEdits(source);
  assert.equal(trace.before("struct Local"), "struct S{void a(){}void b(){}int value;};");
  assert.equal(trace.before("X();"), "struct S{void a(){struct Local{void x(){}void y(){}};}void b(){}int value;};");
  trace.ordered(["int value", "struct Local", "void y", "X();", "Y();", "Z();", "B();"]);
});

test("default-argument lambdas and constructor initializers finish during preparation", () => {
  const source = "struct S{int n;S():n{[]{init();return 1;}()}{ctor_body();}int f(int x=[]{arg();return 2;}()){method_body();}int tail;};";
  const trace = traceEdits(source);
  assert.equal(trace.plan.analysis.hasParseErrors, false);
  assert.equal(trace.before("ctor_body"), source.replace("ctor_body();", "").replace("method_body();", ""));
  trace.ordered(["init();", "arg();", "int tail", "ctor_body", "method_body"]);
});

test("templates, friends and conditional branches keep their members in the class phase", () => {
  const source = "struct S{\ntemplate<class T> T f(T v){first();return v;}\nfriend void g(S&){friend_body();}\n#if MODE\nvoid a(){if_body();}\n#else\nvoid b(){else_body();}\n#endif\nint last;\n};";
  const trace = traceEdits(source);
  assert.equal(trace.plan.analysis.hasParseErrors, false);
  assert.equal(trace.before("first();"), source.replace("first();return v;", "").replace(/(?:friend|if|else)_body\(\);/gu, ""));
  trace.ordered(["int last", "first();", "friend_body", "if_body", "else_body"]);
});

test("function-try bodies and handlers wait for class preparation, unlike initializer lambdas", () => {
  const source = "struct S{int n;S() try:n{[]{init();return 1;}()}{ctor_body();}catch(...){handler_body();}void f(){method_body();}int tail;};";
  const trace = traceEdits(source);
  assert.equal(trace.plan.analysis.hasParseErrors, false);
  assert.equal(trace.before("ctor_body"), source.replace(/(?:ctor|handler|method)_body\(\);/gu, ""));
  trace.ordered(["init();", "int tail", "ctor_body", "handler_body", "method_body"]);
});

test("empty, defaulted, deleted and pure virtual methods need no fabricated bodies", () => {
  const source = "class S{public:S()=default;S(const S&)=delete;virtual void f()=0;void empty(){}void declared();void body(){work();}int n;};";
  assert.equal(traceEdits(source).before("work();"), source.replace("work();", ""));
});

test("the early class suffix retains comments and never consumes object declarators", () => {
  const source = "struct S{void f(){work();}int x;}/*keep*/ ;";
  const trace = traceEdits(source);
  assert.equal(trace.before("void f"), "struct S{}/*keep*/ ;");
  assert.equal(trace.before("work();"), source.replace("work();", ""));

  const objects = "struct S{void f(){work();}int x;} first{1},second{2};";
  assert.equal(traceEdits(objects).before("work();"), "struct S{void f(){}int x;}");
});

test("every reordered Unicode edit still equals the inserted subset of the original source", () => {
  const source = '﻿struct S{\r\nvoid a(){use("😀中");}\r\nvoid b(){use("🧪é");}\r\nint n;\r\n};\r\n';
  const inserted = new Map<number, string>();
  const buffer = new EditBuffer();
  for (const operation of generateEdits(planEdits(source))) {
    buffer.apply(operation);
    if (operation.type === "insert") {
      assert.equal(inserted.has(operation.sourceOffset), false);
      inserted.set(operation.sourceOffset, operation.text);
    }
    const expected = [...inserted].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
    assert.equal(buffer.text, expected);
  }
  buffer.verify(source);
});

test("many members use a sparse task graph rather than all-pairs preparation dependencies", () => {
  const members = 100;
  const source = `struct S{${Array.from({ length: members }, (_, i) => `void f${i}(){work${i}();}`).join("")}};`;
  const trace = traceEdits(source);
  assert.ok(trace.plan.graph.tasks.length < 10 * members);
  assert.ok(trace.plan.graph.edges.length < 12 * members);
  trace.ordered(["void f99", "work0(", "work99"]);
});
