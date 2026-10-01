import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from "node:path";
import { isRecord } from "./util/json.js";
import { decodeUtf8 } from "./util/text.js";

/**
 * Machine-specific defaults for `replay` and `e2e`, read from `clice-e2e.json` in the
 * working directory. Command-line options always win; without the file nothing changes.
 * Relative paths in the file are resolved against the file's own directory.
 */

export const localConfigName = "clice-e2e.json";

export interface ProjectDefaults {
  readonly root: string;
  readonly compileCommands: string;
}

export interface LocalConfig {
  readonly clice: string | undefined;
  /** New runs go to `<outputRoot>/<timestamp>-<source name>` when `-o` is not given. */
  readonly outputRoot: string | undefined;
  readonly projects: readonly ProjectDefaults[];
}

const empty: LocalConfig = { clice: undefined, outputRoot: undefined, projects: [] };

/** `path` undefined: use `clice-e2e.json` in the working directory if it exists. */
export async function loadLocalConfig(path?: string): Promise<LocalConfig> {
  const file = resolve(path ?? localConfigName);
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch (error) {
    if (path === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  const value: unknown = JSON.parse(decodeUtf8(raw));
  const base = dirname(file);
  const optionalPath = (field: unknown, name: string): string | undefined => {
    if (field === undefined) return undefined;
    assert(typeof field === "string" && field.length > 0, `${file}: "${name}" must be a non-empty string.`);
    return resolve(base, field);
  };
  assert(isRecord(value), `${file}: expected a JSON object.`);
  const projects = value.projects ?? [];
  assert(Array.isArray(projects), `${file}: "projects" must be an array.`);
  return {
    clice: optionalPath(value.clice, "clice"),
    outputRoot: optionalPath(value.outputRoot, "outputRoot"),
    projects: projects.map((project: unknown, index) => {
      assert(isRecord(project), `${file}: projects[${index}] must be an object.`);
      const root = optionalPath(project.root, `projects[${index}].root`);
      const compileCommands = optionalPath(project.compileCommands, `projects[${index}].compileCommands`);
      assert(root !== undefined && compileCommands !== undefined, `${file}: projects[${index}] needs "root" and "compileCommands".`);
      return { root, compileCommands };
    }),
  };
}

/** The configured project that contains `sourceFile`; the most deeply nested root wins. */
export function projectFor(config: LocalConfig, sourceFile: string): ProjectDefaults | undefined {
  const contains = (root: string): boolean => {
    const path = relative(root, resolve(sourceFile));
    return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
  };
  return config.projects.filter((project) => contains(project.root)).sort((a, b) => b.root.length - a.root.length)[0];
}

/** `<outputRoot>/20260930-154501-lambda` for `lambda.cpp`. */
export function defaultOutputDirectory(outputRoot: string, sourceFile: string, now = new Date()): string {
  const pad = (number: number): string => String(number).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(outputRoot, `${stamp}-${basename(sourceFile, extname(sourceFile))}`);
}

/** The source file named by a sequence file's header, without validating the rest of it. */
export async function sequenceSourceFile(sequencePath: string): Promise<string | undefined> {
  try {
    const [firstLine] = decodeUtf8(await readFile(resolve(sequencePath))).split("\n", 1);
    const header: unknown = JSON.parse(firstLine ?? "");
    return isRecord(header) && typeof header.sourceFile === "string" ? header.sourceFile : undefined;
  } catch {
    return undefined;
  }
}
