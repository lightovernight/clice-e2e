/**
 * The edit-sequence file format (JSONL, format version 1).
 * Offsets count UTF-16 code units; source ranges are half-open.
 */

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface ParseIssue {
  readonly reason: "parse-error" | "missing-token" | "unpaired-delimiter" | "overlapping-region";
  readonly syntaxType: string;
  readonly range: SourceRange;
}

export interface InsertOperation {
  readonly type: "insert";
  /** Position in the current document immediately before this insertion. */
  readonly offset: number;
  /** Exactly one Unicode code point. */
  readonly text: string;
  /** Position in the final source; used for tracing and include classification. */
  readonly sourceOffset: number;
  /** Increases on insertions; cursor moves do not change the version. */
  readonly version: number;
}

export interface MoveOperation {
  readonly type: "move";
  readonly offset: number;
}

export type EditOperation = InsertOperation | MoveOperation;

export interface SequenceHeader {
  readonly type: "sequence";
  readonly formatVersion: 1;
  readonly sourceFile: string;
  readonly sourceEncoding: "utf-8";
  readonly offsetEncoding: "utf-16";
  readonly initialText: "";
  readonly initialVersion: 0;
  readonly strategy: "class-members-first";
  readonly target: { readonly sha256: string; readonly utf16Length: number };
  readonly parser: { readonly runtimeVersion: string; readonly cppGrammarVersion: string };
  readonly regionCount: number;
  readonly hasParseErrors: boolean;
  readonly issues: readonly ParseIssue[];
}

export interface SequenceSummary {
  readonly type: "summary";
  readonly verified: true;
  readonly insertions: number;
  readonly cursorMoves: number;
  readonly finalVersion: number;
  readonly finalSha256: string;
}

export type SequenceRecord = SequenceHeader | EditOperation | SequenceSummary;
