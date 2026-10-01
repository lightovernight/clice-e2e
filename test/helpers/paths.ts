import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This file compiles to dist/test/helpers/paths.js.
const fromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const repoRoot = fromHere("../../../");
export const cliPath = fromHere("../../src/cli.js");
/** A scripted LSP server standing in for clice; its first argument selects a scenario. */
export const fakeClice = fromHere("../fixtures/fake-clice.js");
/** A server that answers late and declines superseded requests; see the fixture for its scenarios. */
export const fakeBurstClice = fromHere("../fixtures/fake-burst-clice.js");

export function examplePath(name: string): string {
  return join(repoRoot, "examples", name);
}
