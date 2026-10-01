import { performance } from "node:perf_hooks";
import { LogMessageNotification, ResponseError, type CancellationToken, type Disposable, type ProtocolConnection } from "vscode-languageserver-protocol/node.js";
import { anomalyFailure } from "../clice/failures.js";
import type { CliceProcess } from "../clice/process.js";
import { createClient } from "../lsp/client.js";
import { StoppedError, TimeoutError, withTimeout } from "../util/async.js";
import { isRecord } from "../util/json.js";
import type { ActiveRequest, ReplayContext } from "./context.js";

export interface CallOptions {
  /** A cleanup call ignores the stop signal, so shutdown still runs after a failure. */
  cleanup?: boolean;
  /** Error codes that are a legitimate answer to this request; it then resolves to a `Declined`. */
  tolerate?: readonly number[];
  /** Cancelling it sends `$/cancelRequest`; the server must still answer the request. */
  cancellation?: CancellationToken;
}

/** The server answered with an error code the caller said it tolerates (e.g. ContentModified). */
export class Declined {
  constructor(readonly code: number) {}
}

/**
 * The LSP conversation with clice. Every request is tracked in the run context from
 * `request.begin` to `request.end`, including its real JSON-RPC id (`request.sent`),
 * so a failure snapshot shows exactly which requests were in flight.
 */
export class LspSession {
  readonly connection: ProtocolConnection;
  /** The transport reached EOF (possibly before the process exit event). */
  transportClosed = false;
  private closing = false;
  private nextTraceId = 1;
  private readonly logSubscription: Disposable;

  constructor(clice: CliceProcess, private readonly ctx: ReplayContext) {
    this.connection = createClient(clice.child.stdout, clice.child.stdin, {
      record: (kind, data) => {
        if (kind === "lsp.send") this.captureWireId(data);
        ctx.record(kind, data);
      },
      protocolError: (message, evidence) => ctx.report({ kind: "protocol-error", message, ...(evidence !== undefined ? { evidence } : {}) }),
    });
    const { connection } = this;
    // clice reports worker crashes and internal anomalies as error-level log messages.
    this.logSubscription = connection.onNotification(LogMessageNotification.type, (params) => {
      ctx.record("window/logMessage", params);
      if (params.type !== 1 || typeof params.message !== "string") return;
      const failure = anomalyFailure(params.message);
      if (failure) ctx.report(failure);
    });
    connection.onError(([error]) => {
      if (!clice.forcedCleanup) ctx.report({ kind: "protocol-error", message: error.message });
    });
    connection.onClose(() => {
      this.transportClosed = true;
      ctx.record("connection.close", {});
      if (!this.closing && !clice.forcedCleanup) {
        ctx.report({ kind: "connection-closed", message: "LSP connection closed before exit was sent." });
      }
    });
    // Raw traffic is already recorded; diagnostics for half-typed code are expected.
    connection.onNotification("textDocument/publishDiagnostics", () => {});
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.listen();
  }

  async request(method: string, params: object | undefined, timeoutMs: number, { cleanup = false, tolerate, cancellation }: CallOptions = {}): Promise<unknown> {
    const { ctx } = this;
    if (!cleanup) ctx.throwIfStopped();
    const began = performance.now();
    const request: ActiveRequest = { traceId: this.nextTraceId++, id: null, method };
    ctx.activeRequests.set(request.traceId, request);
    ctx.record("request.begin", { ...request });
    try {
      // Explicit `undefined` params would select positional arguments in vscode-jsonrpc ([null] on the wire).
      const pending = params === undefined ? this.connection.sendRequest<unknown>(method)
        : cancellation === undefined ? this.connection.sendRequest<unknown>(method, params)
        : this.connection.sendRequest<unknown>(method, params, cancellation);
      const response = await withTimeout(pending, timeoutMs, method, cleanup ? undefined : ctx.signal);
      if (!cleanup) ctx.throwIfStopped();
      ctx.record("request.end", { ...request, status: "success", durationMs: performance.now() - began });
      return response;
    } catch (error) {
      if (error instanceof ResponseError && tolerate?.includes(error.code) && !ctx.stopped) {
        ctx.record("request.end", { ...request, status: "declined", code: error.code, durationMs: performance.now() - began });
        return new Declined(error.code);
      }
      const status = error instanceof TimeoutError ? "timeout" : error instanceof StoppedError ? "interrupted" : "error";
      ctx.record("request.end", { ...request, status, durationMs: performance.now() - began, error: String(error) });
      if (!(error instanceof StoppedError)) {
        ctx.report({
          kind: error instanceof TimeoutError ? "request-timeout" : "request-error",
          message: String(error),
          evidence: { ...request, ...(error instanceof ResponseError ? { code: error.code, data: error.data } : {}) },
        });
      }
      throw error;
    } finally {
      ctx.activeRequests.delete(request.traceId);
    }
  }

  async notify(method: string, params: object | undefined, timeoutMs: number, { cleanup = false }: CallOptions = {}): Promise<void> {
    const sending = params === undefined
      ? this.connection.sendNotification(method)
      : this.connection.sendNotification(method, params);
    await withTimeout(sending, timeoutMs, method, cleanup ? undefined : this.ctx.signal);
  }

  /** The connection may close from now on (LSP `exit` is about to be sent). */
  expectClose(): void { this.closing = true; }

  dispose(): void {
    this.connection.dispose();
    this.logSubscription.dispose();
  }

  /** A request is written while it is being sent, so it is the only one of its method without an id. */
  private captureWireId(message: unknown): void {
    if (!isRecord(message) || typeof message.method !== "string") return;
    const { id, method } = message;
    if (typeof id !== "number" && typeof id !== "string") return;
    const request = [...this.ctx.activeRequests.values()].find((active) => active.method === method && active.id === null);
    if (!request) return;
    request.id = id;
    this.ctx.record("request.sent", { ...request });
  }
}
