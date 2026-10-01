import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsProbeResult, probeNames, probeParams, supportsProbe } from "../../src/lsp/probes.js";

test("every probe accepts null and has params for an empty document", () => {
  for (const name of probeNames) {
    assert.equal(acceptsProbeResult(name, null), true, name);
    assert.ok(probeParams(name, { uri: "file:///a.cpp", text: "", cursor: 0 }), name);
  }
});

test("position probes use the caret; document probes do not", () => {
  const document = { uri: "file:///a.cpp", text: "ab\ncd", cursor: 4 };
  assert.deepEqual(probeParams("hover", document), { textDocument: { uri: document.uri }, position: { line: 1, character: 1 } });
  assert.deepEqual(probeParams("references", document),
    { textDocument: { uri: document.uri }, position: { line: 1, character: 1 }, context: { includeDeclaration: true } });
  assert.deepEqual(probeParams("foldingRange", document), { textDocument: { uri: document.uri } });
  assert.deepEqual(probeParams("inlayHint", document),
    { textDocument: { uri: document.uri }, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } });
});

test("result shapes follow the LSP definitions", () => {
  assert.equal(acceptsProbeResult("completion", [{ label: "x" }]), true);
  assert.equal(acceptsProbeResult("completion", { isIncomplete: false, items: [] }), true);
  assert.equal(acceptsProbeResult("completion", { items: [] }), false, "CompletionList requires isIncomplete.");
  assert.equal(acceptsProbeResult("hover", { contents: { kind: "markdown", value: "x" } }), true);
  assert.equal(acceptsProbeResult("hover", { contents: ["a", { language: "cpp", value: "b" }] }), true);
  assert.equal(acceptsProbeResult("hover", { contents: 1 }), false);
  assert.equal(acceptsProbeResult("semanticTokens/full", { data: [0, 0, 1, 0, 0] }), true);
  assert.equal(acceptsProbeResult("semanticTokens/full", { data: [0, 0, 1] }), false);
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  assert.equal(acceptsProbeResult("definition", { uri: "file:///a", range }), true);
  assert.equal(acceptsProbeResult("definition", [{ targetUri: "file:///a", targetRange: range, targetSelectionRange: range }]), true);
  assert.equal(acceptsProbeResult("definition", [{ uri: "file:///a" }]), false);
  assert.equal(acceptsProbeResult("inlayHint", [{ position: { line: 0, character: 1 }, label: [{ value: "x" }] }]), true);
  assert.equal(acceptsProbeResult("foldingRange", [{ startLine: 0 }]), false);
});

test("support follows server capabilities", () => {
  assert.equal(supportsProbe("completion", { completionProvider: {} }), true);
  assert.equal(supportsProbe("completion", {}), false);
  assert.equal(supportsProbe("semanticTokens/full", { semanticTokensProvider: { legend: { tokenTypes: [], tokenModifiers: [] }, full: true } }), true);
  assert.equal(supportsProbe("semanticTokens/full", { semanticTokensProvider: { legend: { tokenTypes: [], tokenModifiers: [] } } }), false);
});
