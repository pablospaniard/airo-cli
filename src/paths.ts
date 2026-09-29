import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataRootDir(): string {
  const current = path.join(os.homedir(), ".local", "share", "airo");
  const legacy = path.join(os.homedir(), ".local", "share", "ai-router");
  return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}

/** Create a directory privately; optionally tighten an existing app-owned directory. */
export function ensurePrivateDirectory(directory: string, tightenExisting = false): void {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed || tightenExisting)
    try {
      fs.chmodSync(directory, 0o700);
    } catch {}
}

/** Tighten a sensitive file that may have been created by an older AIRO version. */
export function ensurePrivateFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function migrateLegacyPaths(home = os.homedir()): { migrated: string[]; errors: string[] } {
  const migrated: string[] = [];
  const errors: string[] = [];
  const pairs = [
    [
      path.join(home, ".config", "ai-router", "config.json"),
      path.join(home, ".config", "airo", "config.json"),
    ],
    [path.join(home, ".local", "share", "ai-router"), path.join(home, ".local", "share", "airo")],
  ] as const;

  for (const [legacy, current] of pairs) {
    if (!fs.existsSync(legacy)) continue;
    try {
      const stat = fs.statSync(legacy);
      if (stat.isDirectory()) {
        fs.mkdirSync(current, { recursive: true });
        fs.cpSync(legacy, current, { recursive: true, force: false, errorOnExist: false });
      } else {
        if (fs.existsSync(current)) continue;
        fs.mkdirSync(path.dirname(current), { recursive: true });
        fs.copyFileSync(legacy, current);
      }
      migrated.push(current);
    } catch (error) {
      errors.push(`${legacy}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { migrated, errors };
}
