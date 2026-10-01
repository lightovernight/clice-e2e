// Runs every compiled test file under dist/test with Node's built-in test runner.
// Node 20 does not expand glob patterns itself, and npm on Windows does not either.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/test/", import.meta.url));
const files = readdirSync(root, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => join(root, file));
const { status } = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exitCode = status ?? 1;
