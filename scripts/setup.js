// Prepares this checkout for `npm run e2e -- <file.cpp>` without path options:
//   1. compile_commands.json in examples/ (and targets/, if present): absolute paths, so generated
//   2. clice-e2e.json: machine-specific defaults; an existing file is left alone
// Environment: CLICE names the clice executable; CXX_STD is the standard for targets/ (default c++17).
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const exe = process.platform === "win32" ? ".exe" : "";

function findOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory && existsSync(join(directory, name + exe))) return join(directory, name + exe);
  }
  return undefined;
}

// The compiler only names the driver in the compile command; clice does the parsing itself.
const compiler = findOnPath("clang++") ?? findOnPath("g++") ??
  ["C:/Program Files/LLVM/bin/clang++.exe"].find((path) => existsSync(path)) ?? "clang++";

/** One entry per source file directly in `directory`. */
function writeCompileCommands(name, standardOf) {
  const directory = join(root, name);
  const entries = readdirSync(directory).filter((file) => /\.(c|cc|cpp|cxx)$/.test(file)).sort().map((file) => ({
    directory,
    file: join(directory, file),
    arguments: [compiler, `-std=${standardOf(file)}`, "-c", join(directory, file)],
  }));
  // An empty database is invalid; headers and later files fall back to clice's own inference.
  if (entries.length) writeFileSync(join(directory, "compile_commands.json"), JSON.stringify(entries, null, 2) + "\n");
  console.log(`${name}/compile_commands.json: ${entries.length} files, compiler ${compiler}.`);
}

const projects = ["examples"];
writeCompileCommands("examples", (file) => file === "issue-701.cpp" ? "c++17" : "c++20"); // see examples/README.md
// targets/ holds single files copied in for a run (scripts/wsl.sh does this).
if (existsSync(join(root, "targets"))) {
  writeCompileCommands("targets", () => process.env.CXX_STD ?? "c++17");
  projects.push("targets");
}

// $CLICE, else the newest clice VS Code extension, else a clice on PATH.
function findClice() {
  if (process.env.CLICE) return process.env.CLICE;
  const extensions = join(homedir(), ".vscode", "extensions");
  const installed = existsSync(extensions)
    ? readdirSync(extensions).filter((name) => name.startsWith("clice-io.clice-")).sort().reverse()
      .map((name) => join(extensions, name, "clice", "bin", "clice" + exe)).filter((path) => existsSync(path))
    : [];
  return installed[0] ?? findOnPath("clice");
}

const configPath = join(root, "clice-e2e.json");
if (existsSync(configPath)) {
  console.log("clice-e2e.json already exists; left unchanged.");
} else {
  const clice = findClice();
  const config = {
    clice: (clice ?? "PATH/TO/clice" + exe).replaceAll("\\", "/"),
    outputRoot: "output/runs",
    projects: projects.map((name) => ({ root: name, compileCommands: `${name}/compile_commands.json` })),
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  console.log(clice
    ? `Wrote clice-e2e.json (clice: ${clice}).`
    : "Wrote clice-e2e.json, but no clice was found: edit its \"clice\" field.");
}
