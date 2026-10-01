import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertCleanParse, traceEdits } from "../helpers/edit-trace.js";
import { examplePath } from "../helpers/paths.js";

/** These inputs are valid C++: require a clean parse as well as exact reconstruction. */
function trace(source: string) {
  const result = traceEdits(source);
  assertCleanParse(result);
  return result;
}

test("a local sorting lambda fills its body before its semicolon and the sort call", () => {
  const source = readFileSync(examplePath("sort-lambda.cpp"), "utf8");
  const replay = trace(source);
  assert.equal(replay.before("auto cmp"), "#include <algorithm>\n#include <vector>\n\nvoid sort_values(std::vector<int>& values) {\n    \n}");
  assert.equal(replay.before("return lhs < rhs;"), "#include <algorithm>\n#include <vector>\n\nvoid sort_values(std::vector<int>& values) {\n    auto cmp = [](int lhs, int rhs) {\n        \n    }\n}");
  assert.equal(replay.before("std::sort"), "#include <algorithm>\n#include <vector>\n\nvoid sort_values(std::vector<int>& values) {\n    auto cmp = [](int lhs, int rhs) {\n        return lhs < rhs;\n    };\n    \n}");
  // Start at the declaration's semicolon, not at its already-inserted closing brace.
  replay.ordered(["auto cmp", "return lhs < rhs;", ";\n    std::sort", "std::sort"]);
});

test("a comparator's nested lambda completes before the enclosing comparison", () => {
  const source = "void sort_values(){int values[]={3,1,2};auto cmp=[](int a,int b){auto key=[](int value){return value%10;};return key(a)<key(b);};std::sort(values,values+3,cmp);}";
  const replay = trace(source);
  assert.equal(replay.before("return value%10;"), "void sort_values(){int values[]={3,1,2};auto cmp=[](int a,int b){auto key=[](int value){}}}");
  replay.ordered(["auto cmp", "auto key", "return value%10;", "return key(a)<key(b);", "std::sort"]);
});

for (const [name, declaration] of [
  ["generic parameters and an initialized capture", "[descending=true](const auto& a,const auto& b)"],
  ["an explicit C++20 template parameter list", "[descending=true]<typename T>(const T& a,const T& b)"],
] as const) {
  test(`sorting lambda with ${name} keeps the same shell-before-body order`, () => {
    const source = `void sort_values(){int values[]={3,1,2};auto cmp=${declaration}{if(descending){return a>b;}return a<b;};std::sort(values,values+3,cmp);}`;
    const replay = trace(source);
    assert.equal(replay.before("if(descending)"), `void sort_values(){int values[]={3,1,2};auto cmp=${declaration}{}}`);
    assert.equal(replay.before("return a>b;"), `void sort_values(){int values[]={3,1,2};auto cmp=${declaration}{if(descending){}}}`);
    replay.ordered(["auto cmp", "if(descending)", "return a>b;", "return a<b;", "std::sort"]);
  });
}

test("a comparator inside a member function starts after all class members are prepared", () => {
  const source = "struct Sorter{void sort_values(){auto cmp=[](int a,int b){return a<b;};std::sort(values,values+3,cmp);}int size()const{return 3;}int values[3];};";
  const replay = trace(source);
  assert.equal(replay.before("auto cmp"), "struct Sorter{void sort_values(){}int size()const{}int values[3];};");
  assert.equal(replay.before("return a<b;"), "struct Sorter{void sort_values(){auto cmp=[](int a,int b){}}int size()const{}int values[3];};");
  replay.ordered(["int values[3]", "auto cmp", "return a<b;", "std::sort", "return 3;"]);
});

for (const [name, header, type, initial] of [
  ["primary class template", "template<class T>class Box", "T", "{}"],
  ["partial class specialization", "template<class T>class Box<T*>", "T*", "=nullptr"],
  ["full class specialization", "template<>class Box<int>", "int", "=0"],
] as const) {
  test(`${name} prepares both methods and the field before filling either body`, () => {
    const source = `template<class T>class Box;${header}{public:${type} get()const{return value;}void set(${type} next){value=next;}private:${type} value${initial};};`;
    const replay = trace(source);
    assert.equal(replay.before("return value;"), source.replace("return value;", "").replace("value=next;", ""));
    replay.ordered(["void set", `private:${type} value`, "return value;", "value=next;"]);
  });
}

test("a variadic partial specialization and a full empty-pack specialization prepare independently", () => {
  const partial = "template<class...Ts>struct Pack;template<class Head,class...Tail>struct Pack<Head,Tail...>{int count(){return 1+sizeof...(Tail);}void reset(){state=0;}int state;};";
  const full = "template<>struct Pack<>{int count(){return 0;}void reset(){flag=false;}bool flag;};";
  const replay = trace(partial + full);
  assert.equal(replay.before("return 1+sizeof...(Tail);"), partial.replace("return 1+sizeof...(Tail);", "").replace("state=0;", ""));
  assert.equal(replay.before("return 0;"), partial + full.replace("return 0;", "").replace("flag=false;", ""));
  replay.ordered(["int state", "return 1+sizeof...(Tail);", "state=0;", "bool flag", "return 0;", "flag=false;"]);
});

test("a function template and its full specialization fill in source order", () => {
  const primary = "template<class T>T minimum(T a,T b){return a<b?a:b;}";
  const specialization = "template<>int minimum<int>(int a,int b){if(a<b){return a;}return b;}";
  const replay = trace(primary + specialization);
  assert.equal(replay.before("return a<b?a:b;"), primary.replace("return a<b?a:b;", ""));
  assert.equal(replay.before("if(a<b)"), primary + "template<>int minimum<int>(int a,int b){}");
  assert.equal(replay.before("return a;"), primary + "template<>int minimum<int>(int a,int b){if(a<b){}}");
  replay.ordered(["return a<b?a:b;", "template<>", "if(a<b)", "return a;", "return b;"]);
});

test("an overloaded function template is handled as a separate function definition", () => {
  const first = "template<class T>int category(T){return 0;}";
  const second = "template<class T>int category(T*){return 1;}";
  const replay = trace(first + second);
  assert.equal(replay.before("return 1;"), first + second.replace("return 1;", ""));
  replay.ordered(["return 0;", "int category(T*)", "return 1;"]);
});

test("a member function template joins the enclosing class template's preparation barrier", () => {
  const source = "template<class T>struct Wrapper{template<class U>U convert(U input){return input;}T get()const{return value;}T value{};};";
  const replay = trace(source);
  assert.equal(replay.before("return input;"), source.replace("return input;", "").replace("return value;", ""));
  replay.ordered(["T value", "return input;", "return value;"]);
});

test("out-of-class definitions of template members fill at their own source positions", () => {
  const declaration = "template<class T>struct Box{T get()const;void set(T next);T value{};};";
  const getter = "template<class T>T Box<T>::get()const{return value;}";
  const setter = "template<class T>void Box<T>::set(T next){value=next;}";
  const replay = trace(declaration + getter + setter);
  assert.equal(replay.before("return value;"), declaration + getter.replace("return value;", ""));
  replay.ordered(["T value", "T Box<T>::get", "return value;", "void Box<T>::set", "value=next;"]);
});

test("a constrained function template fills its requirement before the function body", () => {
  const source = "template<class T>requires requires(T x){x<x;}bool less(T a,T b){return a<b;}";
  const replay = trace(source);
  assert.equal(replay.before("return a<b;"), source.replace("return a<b;", ""));
  replay.ordered(["x<x;", "bool less", "return a<b;"]);
});

test("the complete template example preserves all specializations and independent class phases", () => {
  const source = readFileSync(examplePath("template-variants.cpp"), "utf8");
  const replay = trace(source);
  replay.ordered(["void set(T next)", "T value{}", "class Box<T*>", "T* value = nullptr", "class Box<int>", "int value = 0", "T minimum", "int minimum<int>"]);
});
