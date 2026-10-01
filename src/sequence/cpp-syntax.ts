import { createRequire } from "node:module";
import Parser from "tree-sitter";
import Cpp from "tree-sitter-cpp";
import { assertWellFormed } from "../util/text.js";
import type { ParseIssue, SourceRange } from "./types.js";

/**
 * Everything this project needs to know about C++ syntax, from one Tree-sitter parse:
 * - brace regions that the planner turns into "shell first, then contents" tasks;
 * - `#include` directive ranges, which replay may exempt from per-character probes.
 */

export type RegionKind =
  | "block"
  | "declarations"
  | "members"
  | "enumerators"
  | "initializer"
  | "requirements"
  | "compound-requirement";

export interface SyntaxRegion {
  readonly kind: RegionKind;
  readonly syntaxType: string;
  readonly open: SourceRange;
  readonly close: SourceRange;
  /** Original suffix through a directly following class semicolon, if present. */
  readonly suffix?: SourceRange;
  /** Opening offset of the class whose member-function body this is. */
  readonly memberBodyOf?: number;
  readonly children: SyntaxRegion[];
}

export interface SourceAnalysis {
  readonly regions: SyntaxRegion[];
  readonly issues: ParseIssue[];
  readonly hasParseErrors: boolean;
}

type Node = Parser.SyntaxNode;

let parser: Parser | undefined;

function parseCpp(source: string): Parser.Tree {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Cpp);
  }
  // node-tree-sitter copies string input through a fixed buffer (32 Ki UTF-16 units by
  // default) and throws "Invalid argument" for anything larger, so size it to the source.
  return parser.parse(source, undefined, { bufferSize: Math.max(32 * 1024, source.length + 1) });
}

export function parserVersions(): { runtimeVersion: string; cppGrammarVersion: string } {
  const require = createRequire(import.meta.url);
  const version = (name: string): string => {
    const metadata: unknown = require(`${name}/package.json`);
    if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string") {
      throw new Error(`Cannot read the version of ${name}.`);
    }
    return metadata.version;
  };
  return { runtimeVersion: version("tree-sitter"), cppGrammarVersion: version("tree-sitter-cpp") };
}

const rangeOf = (node: Node): SourceRange => ({ start: node.startIndex, end: node.endIndex });

// ---------------------------------------------------------------------------------------------
// Brace regions

const regionKinds = new Map<string, RegionKind>([
  ["compound_statement", "block"],
  ["declaration_list", "declarations"],
  ["field_declaration_list", "members"],
  ["enumerator_list", "enumerators"],
  ["initializer_list", "initializer"],
  ["requirement_seq", "requirements"],
  ["compound_requirement", "compound-requirement"],
]);

const memberWrappers = new Set([
  "template_declaration", "friend_declaration",
  "preproc_if", "preproc_ifdef", "preproc_else", "preproc_elif", "preproc_elifdef",
]);

const classSpecifiers = new Set(["class_specifier", "struct_specifier", "union_specifier"]);

/** Only actual member-function bodies (including function-try handlers) are deferred. */
function memberBodyOwner(node: Node): number | undefined {
  if (node.type !== "compound_statement") return undefined;
  let parent = node.parent;
  if (parent?.type === "catch_clause") parent = parent.parent;
  if (parent?.type === "try_statement") parent = parent.parent;
  if (parent?.type !== "function_definition") return undefined;
  parent = parent.parent;
  while (parent && memberWrappers.has(parent.type)) parent = parent.parent;
  return parent?.type === "field_declaration_list" ? parent.startIndex : undefined;
}

/** `};` after a class body (comments allowed) is typed together with the class shell. */
function classSuffix(node: Node, close: Node): SourceRange | undefined {
  if (node.type !== "field_declaration_list") return undefined;
  const specifier = node.parent;
  if (!specifier || !classSpecifiers.has(specifier.type)) return undefined;
  let next = specifier.nextSibling;
  while (next?.type === "comment") next = next.nextSibling;
  // A trailing object declarator belongs to a declaration, not to the class shell.
  if (next?.type !== ";" || next.isMissing) return undefined;
  return { start: close.endIndex, end: next.endIndex };
}

/** The node's own `{`/`}` (or digraph) pair, if both are real tokens in the source. */
function delimiters(node: Node, source: string): { open: Node; close: Node } | undefined {
  const braces = node.children.filter((child) => child.type === "{" || child.type === "}");
  const [open, close] = braces;
  if (braces.length !== 2 || !open || !close || open.type !== "{" || close.type !== "}") return undefined;
  if (open.isMissing || close.isMissing || open.endIndex > close.startIndex) return undefined;
  if (!["{", "<%"].includes(source.slice(open.startIndex, open.endIndex))) return undefined;
  if (!["}", "%>"].includes(source.slice(close.startIndex, close.endIndex))) return undefined;
  return { open, close };
}

/** Keep the original text authoritative, including text the parser cannot understand. */
export function analyzeSource(source: string): SourceAnalysis {
  assertWellFormed(source);
  const tree = parseCpp(source);
  const issues: ParseIssue[] = [];
  const candidates: SyntaxRegion[] = [];
  const pending: Node[] = [tree.rootNode];

  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.isError || node.isMissing) {
      issues.push({ reason: node.isMissing ? "missing-token" : "parse-error", syntaxType: node.type, range: rangeOf(node) });
      // Error recovery may invent structure here. Replay this whole span in source order.
      continue;
    }

    const kind = regionKinds.get(node.type);
    if (kind) {
      const pair = delimiters(node, source);
      if (pair) {
        const suffix = classSuffix(node, pair.close);
        const memberBodyOf = memberBodyOwner(node);
        candidates.push({
          kind,
          syntaxType: node.type,
          open: rangeOf(pair.open),
          close: rangeOf(pair.close),
          ...(suffix ? { suffix } : {}),
          ...(memberBodyOf !== undefined ? { memberBodyOf } : {}),
          children: [],
        });
      } else {
        issues.push({ reason: "unpaired-delimiter", syntaxType: node.type, range: rangeOf(node) });
      }
    }

    // Visit parameters and expressions too: they can contain lambda bodies.
    const children = node.children;
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!);
  }

  const regions = nestRegions(candidates, issues);
  issues.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  return { regions, issues, hasParseErrors: tree.rootNode.hasError };
}

/** Arrange candidates into a forest; a region must lie strictly inside its parent's braces. */
function nestRegions(candidates: SyntaxRegion[], issues: ParseIssue[]): SyntaxRegion[] {
  candidates.sort((a, b) => a.open.start - b.open.start || b.close.end - a.close.end);
  const roots: SyntaxRegion[] = [];
  const ancestors: SyntaxRegion[] = [];
  for (const region of candidates) {
    while (ancestors.length && region.open.start >= ancestors.at(-1)!.close.end) ancestors.pop();
    const parent = ancestors.at(-1);
    if (parent && (region.open.start < parent.open.end || region.close.end > parent.close.start)) {
      issues.push({
        reason: "overlapping-region",
        syntaxType: region.syntaxType,
        range: { start: region.open.start, end: region.close.end },
      });
      continue;
    }
    (parent ? parent.children : roots).push(region);
    ancestors.push(region);
  }
  return roots;
}

export function countRegions(regions: readonly SyntaxRegion[]): number {
  let count = 0;
  const pending = [...regions];
  for (let region = pending.pop(); region; region = pending.pop()) {
    count++;
    pending.push(...region.children);
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Include directives

/**
 * Ranges of well-formed `#include` directives in the complete source, sorted.
 * Classifying against the final text also covers intermediate states such as `#i`.
 * Comments and string literals never match; uncertain syntax keeps its checks.
 */
export function findIncludeRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const pending: Node[] = [parseCpp(source).rootNode];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.isError || node.isMissing) continue;
    if (node.type === "preproc_include") {
      if (!node.hasError) ranges.push(rangeOf(node));
      continue;
    }
    pending.push(...node.namedChildren);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Binary search in sorted, disjoint ranges. */
export function rangeContaining(ranges: readonly SourceRange[], offset: number): SourceRange | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const range = ranges[mid]!;
    if (offset < range.start) high = mid;
    else if (offset >= range.end) low = mid + 1;
    else return range;
  }
  return undefined;
}
