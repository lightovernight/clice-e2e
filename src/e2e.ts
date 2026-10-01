import { runReplay, type ReplayResult, type ReplaySettings } from "./replay/runner.js";
import { generateSequence } from "./sequence/sequence-file.js";

export interface E2eOptions extends ReplaySettings {
  sourceFile: string;
}

/**
 * source file → verified edit sequence → LSP replay with crash checks.
 * Generation errors throw before clice or the output directory are touched. The generated
 * sequence goes through the same validation as a saved one and is kept as sequence.jsonl.
 */
export async function runE2e({ sourceFile, ...settings }: E2eOptions): Promise<ReplayResult> {
  const generated = await generateSequence(sourceFile);
  return runReplay({ ...settings, sequence: Buffer.from(generated.text(), "utf8") });
}
