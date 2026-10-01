import {
  createProtocolConnection, StreamMessageReader, StreamMessageWriter,
  type DataCallback, type Message, type ProtocolConnection,
} from "vscode-languageserver-protocol/node.js";
import { isRecord } from "../util/json.js";

export interface ClientObserver {
  /** Raw traffic and library log lines: kinds are `lsp.send`, `lsp.receive`, `protocol.*`. */
  record(kind: string, data: unknown): void;
  /** A message that violates JSON-RPC; the message is dropped. */
  protocolError(message: string, evidence?: unknown): void;
}

/**
 * A JSON-RPC connection that records every message and rejects malformed traffic that
 * vscode-jsonrpc would otherwise tolerate: unmatched or duplicate responses, and responses
 * with both or neither of `result`/`error`.
 */
export function createClient(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, observer: ClientObserver): ProtocolConnection {
  const pending = new Set<string>();
  const key = (id: unknown): string => `${typeof id}:${String(id)}`;

  class Reader extends StreamMessageReader {
    override listen(callback: DataCallback) {
      return super.listen((message) => {
        observer.record("lsp.receive", message);
        const data: unknown = message;
        if (!isRecord(data) || data.jsonrpc !== "2.0") {
          observer.protocolError("Invalid JSON-RPC message.", message);
          return;
        }
        if (!("method" in data)) {
          const id = key(data.id);
          const hasResult = "result" in data;
          const hasError = "error" in data;
          const errorValid = !hasError || (isRecord(data.error) && Number.isInteger(data.error.code) && typeof data.error.message === "string");
          if (!pending.has(id) || hasResult === hasError || !errorValid) {
            observer.protocolError("Unmatched, duplicate or malformed response.", message);
            return;
          }
          pending.delete(id);
        }
        callback(message);
      });
    }
  }

  class Writer extends StreamMessageWriter {
    override write(message: Message): Promise<void> {
      const data: unknown = message;
      if (isRecord(data) && typeof data.method === "string" && "id" in data) pending.add(key(data.id));
      observer.record("lsp.send", message);
      return super.write(message);
    }
  }

  return createProtocolConnection(new Reader(input), new Writer(output), {
    error: (message) => observer.protocolError(message),
    warn: (message) => observer.record("protocol.warning", message),
    info: (message) => observer.record("protocol.info", message),
    log: (message) => observer.record("protocol.log", message),
  });
}
