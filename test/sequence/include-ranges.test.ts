import assert from "node:assert/strict";
import { test } from "node:test";
import { findIncludeRanges, rangeContaining } from "../../src/sequence/cpp-syntax.js";

test("include classification respects comments, strings, Unicode and CRLF", () => {
  const directive = '#include "local.hpp" // 注释\r\n';
  const text = '﻿/* 中文😀 */\r\n// #include <fake>\r\nconst char* s=R"tag(\n#include <fake>\n)tag";\r\n  ' + directive + 'int x;\r\n';
  const start = text.indexOf(directive);
  const ranges = findIncludeRanges(text);
  assert.deepEqual(ranges, [{ start, end: start + directive.length }]);
  assert.equal(rangeContaining(ranges, start - 1), undefined);
  assert.equal(rangeContaining(ranges, start), ranges[0]);
  assert.equal(rangeContaining(ranges, start + directive.length - 1), ranges[0]);
  assert.equal(rangeContaining(ranges, start + directive.length), undefined);
});

test("include classification accepts macro and continued includes, retaining other directives", () => {
  const text = '#define HEADER <vector>\n#if ENABLED\n#include HEADER\n#endif\n#include \\\n <utility>\nint x;\n';
  assert.deepEqual(findIncludeRanges(text).map((range) => text.slice(range.start, range.end)), ["#include HEADER\n", "#include \\\n <utility>\n"]);
});

test("uncertain include syntax retains character checks", () => {
  assert.deepEqual(findIncludeRanges("#include <broken\nint x;\n"), []);
});
