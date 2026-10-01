import {
  CompletionTriggerKind, SignatureHelpTriggerKind,
  type ClientCapabilities, type Position, type ServerCapabilities,
} from "vscode-languageserver-protocol/node.js";
import { isRecord } from "../util/json.js";
import { positionAt } from "./positions.js";

/**
 * Probes are the read-only requests sent after each edit. Each probe is described once:
 * which capability enables it, how its params are built from the current document, and
 * which result shapes are acceptable. Only protocol shapes are checked, never accuracy;
 * `null` and empty results are always valid.
 */

export const probeNames = ["completion", "hover", "signatureHelp", "documentSymbol", "foldingRange",
  "semanticTokens/full", "definition", "references", "inlayHint"] as const;
export type ProbeName = typeof probeNames[number];
export const defaultProbes: readonly ProbeName[] = ["completion", "foldingRange"];

export function isProbeName(value: string): value is ProbeName {
  return (probeNames as readonly string[]).includes(value);
}

export function probeMethod(name: ProbeName): string {
  return `textDocument/${name}`;
}

/** The document as the probe sees it: after the edit, with the caret where the edit left it. */
export interface DocumentSnapshot {
  readonly uri: string;
  readonly text: string;
  readonly cursor: number;
}

interface ProbeSpec {
  supported(capabilities: ServerCapabilities): boolean;
  params(document: DocumentSnapshot): object;
  accepts(result: unknown): boolean;
}

// --- result-shape predicates ----------------------------------------------------------------

const isPosition = (value: unknown): value is Position => isRecord(value) &&
  Number.isInteger(value.line) && (value.line as number) >= 0 &&
  Number.isInteger(value.character) && (value.character as number) >= 0;
const isRange = (value: unknown): boolean => isRecord(value) && isPosition(value.start) && isPosition(value.end);
const isLocation = (value: unknown): boolean => isRecord(value) && typeof value.uri === "string" && isRange(value.range);
const isLocationLink = (value: unknown): boolean => isRecord(value) && typeof value.targetUri === "string" &&
  isRange(value.targetRange) && isRange(value.targetSelectionRange);
const isMarkedString = (value: unknown): boolean => typeof value === "string" ||
  (isRecord(value) && typeof value.language === "string" && typeof value.value === "string");
const isMarkupContent = (value: unknown): boolean => isRecord(value) &&
  (value.kind === "plaintext" || value.kind === "markdown") && typeof value.value === "string";
const arrayOf = (predicate: (item: unknown) => boolean) => (value: unknown): boolean =>
  Array.isArray(value) && value.every(predicate);
const labelled = (item: unknown): boolean => isRecord(item) && typeof item.label === "string";

// --- params builders ------------------------------------------------------------------------

const documentOnly = ({ uri }: DocumentSnapshot) => ({ textDocument: { uri } });
const atCaret = (extra: object = {}) => ({ uri, text, cursor }: DocumentSnapshot) =>
  ({ textDocument: { uri }, position: positionAt(text, cursor), ...extra });
const provides = (key: keyof ServerCapabilities) => (capabilities: ServerCapabilities): boolean => !!capabilities[key];

const specs: Record<ProbeName, ProbeSpec> = {
  completion: {
    supported: provides("completionProvider"),
    params: atCaret({ context: { triggerKind: CompletionTriggerKind.Invoked } }),
    accepts: (result) => {
      const items = Array.isArray(result) ? result
        : isRecord(result) && typeof result.isIncomplete === "boolean" ? result.items : undefined;
      return arrayOf(labelled)(items);
    },
  },
  hover: {
    supported: provides("hoverProvider"),
    params: atCaret(),
    accepts: (result) => isRecord(result) &&
      (isMarkedString(result.contents) || arrayOf(isMarkedString)(result.contents) || isMarkupContent(result.contents)),
  },
  signatureHelp: {
    supported: provides("signatureHelpProvider"),
    params: atCaret({ context: { triggerKind: SignatureHelpTriggerKind.Invoked, isRetrigger: false } }),
    accepts: (result) => isRecord(result) && arrayOf(labelled)(result.signatures),
  },
  documentSymbol: {
    supported: provides("documentSymbolProvider"),
    params: documentOnly,
    accepts: arrayOf((symbol) => isRecord(symbol) && typeof symbol.name === "string" && typeof symbol.kind === "number"),
  },
  foldingRange: {
    supported: provides("foldingRangeProvider"),
    params: documentOnly,
    accepts: arrayOf((fold) => isRecord(fold) && Number.isInteger(fold.startLine) && Number.isInteger(fold.endLine)),
  },
  "semanticTokens/full": {
    supported: (capabilities) => !!capabilities.semanticTokensProvider?.full,
    params: documentOnly,
    accepts: (result) => isRecord(result) && Array.isArray(result.data) && result.data.length % 5 === 0 &&
      result.data.every((value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647),
  },
  definition: {
    supported: provides("definitionProvider"),
    params: atCaret(),
    accepts: (result) => isLocation(result) || arrayOf((item) => isLocation(item) || isLocationLink(item))(result),
  },
  references: {
    supported: provides("referencesProvider"),
    params: atCaret({ context: { includeDeclaration: true } }),
    accepts: arrayOf(isLocation),
  },
  inlayHint: {
    supported: provides("inlayHintProvider"),
    params: ({ uri, text }) => ({ textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: positionAt(text, text.length) } }),
    accepts: arrayOf((hint) => isRecord(hint) && isPosition(hint.position) &&
      (typeof hint.label === "string" || arrayOf((part) => isRecord(part) && typeof part.value === "string")(hint.label))),
  },
};

export function supportsProbe(name: ProbeName, capabilities: ServerCapabilities): boolean {
  return specs[name].supported(capabilities);
}

/** Position-based probes use the caret AFTER the operation, including after cursor moves. */
export function probeParams(name: ProbeName, document: DocumentSnapshot): object {
  return specs[name].params(document);
}

export function acceptsProbeResult(name: ProbeName, result: unknown): boolean {
  return result === null || specs[name].accepts(result);
}

export const clientCapabilities: ClientCapabilities = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    completion: { contextSupport: true, completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: { contextSupport: true, signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } } },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    foldingRange: { lineFoldingOnly: false },
    definition: { linkSupport: true },
    references: {},
    inlayHint: {},
    semanticTokens: {
      requests: { full: true },
      tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property",
        "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
      tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification",
        "documentation", "defaultLibrary"],
      formats: ["relative"],
    },
  },
};
