// A scripted LSP server standing in for clice. argv[2] selects the scenario (see the tests).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProtocolConnection, StreamMessageReader, StreamMessageWriter, ResponseError,
  type DidChangeTextDocumentParams, type DidOpenTextDocumentParams, type TextDocumentPositionParams,
  type CompletionParams, type SignatureHelpParams, type ReferenceParams, type InlayHintParams } from "vscode-languageserver-protocol/node.js";
import { offsetAt } from "../../src/lsp/positions.js";
import { probeNames } from "../../src/lsp/probes.js";

const mode = process.argv[2];
const connection = createProtocolConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
let text = "";
let version = 0;
let probes = 0;
let foldingProbes = 0;
let completionProbes = 0;
let activeProbes = 0;
let batch: { method: string; value: unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
function onProbe<P>(method: string, handler: (params: P) => unknown): void {
  connection.onRequest(method, async (params: P) => {
    activeProbes++;
    try {
      const value = await handler(params);
      if (!mode?.startsWith("parallel-")) return value;
      // No response until all nine requests arrive: a serial client cannot pass.
      return await new Promise<unknown>((resolve, reject) => {
        assert(!batch.some((request) => request.method === method));
        batch.push({ method, value, resolve, reject });
        if (batch.length !== probeNames.length) return;
        const ready = batch;
        batch = [];
        if (version === 2) {
          if (mode === "parallel-worker") {
            void connection.sendNotification("window/logMessage", { type: 1, message: "[anomaly:WorkerCrash] Worker failed with nine requests pending" });
            return;
          }
          if (mode === "parallel-timeout") return;
          if (mode === "parallel-exit") process.exit(0);
          if (mode === "parallel-error") {
            ready.find((request) => request.method === "textDocument/signatureHelp")!.reject(new ResponseError(-32603, "Parallel failure", { detail: "preserved" }));
            return;
          }
          if (mode === "parallel-bad-result") {
            ready.find((request) => request.method === "textDocument/completion")!.resolve({ items: [] });
            return;
          }
        }
        // Reverse response order and keep the last response outstanding longer.
        for (const [index, name] of [...probeNames].reverse().entries()) {
          const request = ready.find((request) => request.method === `textDocument/${name}`)!;
          setTimeout(() => request.resolve(request.value), index * 5);
        }
      });
    } finally { activeProbes--; }
  });
}
connection.onRequest("initialize", () => ({ capabilities: {
  positionEncoding: "utf-16", textDocumentSync: { openClose: true, change: 2 }, documentSymbolProvider: true, foldingRangeProvider: true,
  completionProvider: { triggerCharacters: [".", ">"] }, hoverProvider: true, signatureHelpProvider: { triggerCharacters: ["(", ","] },
  definitionProvider: true, referencesProvider: true, inlayHintProvider: true,
  semanticTokensProvider: { legend: { tokenTypes: ["variable"], tokenModifiers: [] }, full: true },
} }));
connection.onNotification("initialized", () => {});
connection.onNotification("textDocument/didOpen", (params: DidOpenTextDocumentParams) => {
  assert.equal(params.textDocument.text, "");
  assert.equal(params.textDocument.version, 0);
});
connection.onNotification("textDocument/didChange", (params: DidChangeTextDocumentParams) => {
  assert.equal(activeProbes, 0, "The next edit must wait for every probe in the previous batch.");
  assert.equal(params.textDocument.version, ++version);
  for (const change of params.contentChanges) {
    assert("range" in change);
    assert.deepEqual(change.range.start, change.range.end);
    const offset = offsetAt(text, change.range.start);
    assert.equal([...change.text].length, 1);
    text = text.slice(0, offset) + change.text + text.slice(offset);
  }
  if (mode === "include-worker" && version === 3) {
    void connection.sendNotification("window/logMessage", { type: 1, message: "[anomaly:WorkerCrash] Worker failed during an include edit" });
  }
});
onProbe("textDocument/documentSymbol", async () => {
  probes++;
  // Compile diagnostics are expected while typing, and even text resembling a marker is source data.
  await connection.sendNotification("textDocument/publishDiagnostics", { uri: "file:///fixture.cpp", diagnostics: [
    { severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "Syntax error [anomaly:WorkerCrash]" },
  ] });
  if (probes === 3) {
    if (mode === "worker") {
      await connection.sendNotification("window/logMessage", { type: 1, message: "[anomaly:WorkerCrash] Worker SF-0 exited with code 1" });
    } else if (mode === "error") {
      throw new ResponseError(-32603, "Fixture request failed", { detail: "preserved" });
    } else if (mode === "timeout") {
      return new Promise<never>(() => {});
    } else if (mode === "exit") {
      process.exit(0);
    } else if (mode === "malformed") {
      // Client request IDs: initialize=0, initial probe=1, operation probes=2,3.
      const body = JSON.stringify({ jsonrpc: "2.0", id: 3, result: [], error: { code: -32603, message: "Both fields" } });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } else if (mode === "stderr") {
      process.stderr.write("=== CRASH STACK ");
      process.stderr.write("TRACE ===\n");
    }
  }
  return [];
});
connection.onNotification("textDocument/didClose", () => {});
const checkPosition = (params: TextDocumentPositionParams): void => { offsetAt(text, params.position); };
onProbe("textDocument/completion", async (params: CompletionParams) => {
  checkPosition(params);
  assert.equal(params.context?.triggerKind, 1);
  assert.equal(params.context?.triggerCharacter, undefined);
  completionProbes++;
  if (completionProbes === 3 && mode === "completion-worker") {
    await connection.sendNotification("window/logMessage", { type: 1, message: "[anomaly:WorkerCrash] Worker crashed on completion" });
  }
  if (completionProbes === 3 && mode === "bad-completion") return { items: [] }; // Missing required isIncomplete.
  return completionProbes % 3 === 0 ? null : completionProbes % 3 === 1 ? [{ label: "value" }] : { isIncomplete: false, items: [{ label: "value" }] };
});
onProbe("textDocument/hover", (params: TextDocumentPositionParams) => {
  checkPosition(params); return { contents: { kind: "markdown", value: "int value" } };
});
onProbe("textDocument/signatureHelp", (params: SignatureHelpParams) => {
  checkPosition(params); assert.equal(params.context?.triggerKind, 1); assert.equal(params.context.isRetrigger, false);
  return { signatures: [{ label: "f(int value)" }], activeSignature: 0, activeParameter: 0 };
});
onProbe("textDocument/definition", (params: TextDocumentPositionParams) => { checkPosition(params); return []; });
onProbe("textDocument/references", (params: ReferenceParams) => {
  checkPosition(params); assert.equal(params.context.includeDeclaration, true); return [];
});
onProbe("textDocument/inlayHint", (params: InlayHintParams) => {
  assert.equal(offsetAt(text, params.range.start), 0); assert.equal(offsetAt(text, params.range.end), text.length); return [];
});
onProbe("textDocument/semanticTokens/full", () => ({ data: [] }));
onProbe("textDocument/foldingRange", async () => {
  if (++foldingProbes === 3 && mode === "folding-worker") {
    await connection.sendNotification("window/logMessage", { type: 1, message: "[anomaly:WorkerCrash] Worker crashed on foldingRange" });
  }
  return [];
});
connection.onRequest("shutdown", async () => {
  writeFileSync(join(process.cwd(), "received.cpp"), text);
  if (mode === "late-worker") {
    await connection.sendNotification("window/logMessage", { type: 1, message: "[anomaly:WorkerCrash] Worker SF-0 exited late" });
  }
  return null;
});
connection.onNotification("exit", () => process.exit(mode === "bad-shutdown" ? 1 : 0));
connection.listen();
