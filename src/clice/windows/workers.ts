import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../../util/json.js";

const execFileAsync = promisify(execFile);

interface WorkerProcess { pid: number; created: string }

const normalize = (path: string): string => resolve(path).replaceAll("\\", "/").toLowerCase();

/**
 * Direct worker children of this run's master, identified by parent PID, executable,
 * `worker` command line with this run's log directory, and creation time.
 * Never kill by executable name: other clice instances (the user's editor) must survive.
 */
async function ownedWorkers(parent: number, startedAt: number, runtime: string, logDirectory: string): Promise<WorkerProcess[]> {
  if (!Number.isSafeInteger(parent) || parent <= 0) throw new Error("Invalid master PID.");
  const rows = await childProcesses(parent);
  const logPrefix = normalize(logDirectory) + "/";
  return rows.flatMap((row) => {
    if (!isRecord(row) || typeof row.ProcessId !== "number" || !Number.isSafeInteger(row.ProcessId) || row.ProcessId <= 0 ||
      row.ParentProcessId !== parent || typeof row.ExecutablePath !== "string" ||
      resolve(row.ExecutablePath).toLowerCase() !== resolve(runtime).toLowerCase() ||
      typeof row.CommandLine !== "string" || !/\bworker\b/.test(row.CommandLine) ||
      !row.CommandLine.replaceAll("\\", "/").toLowerCase().includes(logPrefix) ||
      typeof row.CreatedUtc !== "string" || !(Date.parse(row.CreatedUtc) >= startedAt - 1000)) return [];
    return [{ pid: row.ProcessId, created: row.CreatedUtc }];
  });
}

/**
 * Raw process rows for `parent`'s children. The first PowerShell start on a fresh machine can
 * take over 10 s (seen on CI), so allow 30 s and retry once before giving up.
 */
async function childProcesses(parent: number): Promise<unknown[]> {
  const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parent}' | ` +
    "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine," +
    "@{Name='CreatedUtc';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, timeout: 30000,
      });
      const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      failure = error;
    }
  }
  const { killed, code, stderr } = failure as { killed?: boolean; code?: unknown; stderr?: unknown };
  const detail = killed ? "timed out"
    : code === undefined ? String(failure)
    : `exit ${String(code)}${String(stderr ?? "").trim() ? `: ${String(stderr).trim()}` : ""}`;
  throw new Error(`Listing clice worker processes with PowerShell failed twice (${detail}).`);
}

/** Kill workers that outlived their master; returns their PIDs. No-op outside Windows. */
export async function cleanupWindowsWorkers(parent: number, startedAt: number, runtime: string, logDirectory: string): Promise<number[]> {
  if (process.platform !== "win32") return [];
  const remaining = await ownedWorkers(parent, startedAt, runtime, logDirectory);
  for (const worker of remaining) {
    // Re-identify right before killing: the PID may have been reused.
    const fresh = (await ownedWorkers(parent, startedAt, runtime, logDirectory)).find((row) => row.pid === worker.pid);
    if (!fresh) continue;
    if (fresh.created !== worker.created) throw new Error("Worker identity changed; refusing to terminate it.");
    try { process.kill(worker.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  return remaining.map((worker) => worker.pid);
}
