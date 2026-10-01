// A scripted LSP server for burst typing. Unlike fake-clice it answers every probe 40 ms after
// it arrives, judging it against the document at that moment, the way a real server races edits:
// RequestCancelled if the request was cancelled, ContentModified if the document changed, else a result.
// argv[2]: healthy | lost (superseded requests are never answered) | crash (a superseded request
// reports a worker crash) | decline-all (even up-to-date requests get ContentModified).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProtocolConnection, LSPErrorCodes, ResponseError, StreamMessageReader, StreamMessageWriter,
  type CancellationToken, type DidChangeTextDocumentParams } from "vscode-languageserver-protocol/node.js";
import { offsetAt } from "../../src/lsp/positions.js";

const mode = process.argv[2];
const connection = createProtocolConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
let text = "";
let version = 0;

connection.onRequest("initialize", () => ({ capabilities: {
  positionEncoding: "utf-16", textDocumentSync: { openClose: true, change: 2 }, foldingRangeProvider: true, completionProvider: {},
} }));
connection.onNotification("initialized", () => {});
connection.onNotification("textDocument/didOpen", () => {});
connection.onNotification("textDocument/didClose", () => {});
connection.onNotification("textDocument/didChange", (params: DidChangeTextDocumentParams) => {
  assert.equal(params.textDocument.version, ++version);
  for (const change of params.contentChanges) {
    assert("range" in change);
    const offset = offsetAt(text, change.range.start);
    text = text.slice(0, offset) + change.text + text.slice(offset);
  }
});

for (const method of ["textDocument/completion", "textDocument/foldingRange"]) {
  connection.onRequest(method, async (_params: unknown, token: CancellationToken) => {
    const asked = version;
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (asked !== version) {
      if (mode === "lost") return new Promise<never>(() => {});
      if (mode === "crash") await connection.sendNotification("window/logMessage", { type: 1, message: "[anomaly:WorkerCrash] Worker died on a superseded request" });
      if (token.isCancellationRequested) throw new ResponseError(LSPErrorCodes.RequestCancelled, "cancelled");
      throw new ResponseError(LSPErrorCodes.ContentModified, "content modified");
    }
    if (mode === "decline-all") throw new ResponseError(LSPErrorCodes.ContentModified, "content modified");
    return [];
  });
}

connection.onRequest("shutdown", () => {
  writeFileSync(join(process.cwd(), "received.cpp"), text);
  return null;
});
connection.onNotification("exit", () => process.exit(0));
connection.listen();
