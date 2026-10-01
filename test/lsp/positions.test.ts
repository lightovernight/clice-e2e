import assert from "node:assert/strict";
import { test } from "node:test";
import { offsetAt, positionAt } from "../../src/lsp/positions.js";

test("UTF-16 positions preserve Unicode and all newline forms, rejecting unrepresentable offsets", () => {
  const text = "中😀\r\na\rb\nc";
  const cases = [[0, 0, 0], [1, 0, 1], [3, 0, 3], [5, 1, 0], [6, 1, 1], [7, 2, 0], [9, 3, 0], [10, 3, 1]] as const;
  for (const [offset, line, character] of cases) {
    assert.deepEqual(positionAt(text, offset), { line, character });
    assert.equal(offsetAt(text, { line, character }), offset);
  }
  assert.throws(() => positionAt(text, 2), /surrogate/);
  assert.throws(() => positionAt(text, 4), /CRLF/);
  assert.throws(() => offsetAt(text, { line: 0, character: 4 }), /exceeds/);
  assert.throws(() => offsetAt(text, { line: 4, character: 0 }), /exceeds/);
  assert.deepEqual(positionAt("a\r", 2), { line: 1, character: 0 });
  assert.equal(offsetAt("a\r", { line: 1, character: 0 }), 2);
});
