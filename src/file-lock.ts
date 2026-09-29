import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const INCOMPLETE_LOCK_GRACE_MS = 250;
const LEGACY_LOCK_GRACE_MS = 5_000;

export interface FileLockOptions {
  timeoutMs?: number;
  incompleteLockGraceMs?: number;
  legacyLockGraceMs?: number;
}

interface LockHandle {
  token: string;
}

interface LockOwner {
  pid: number;
  bootId?: string;
  token?: string;
  startedAt?: string;
}

function currentBootId(): string {
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (value) return `linux:${value}`;
  } catch {}
  if (process.platform === "darwin") {
    try {
      const value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const seconds = /sec\s*=\s*(\d+)/.exec(value)?.[1];
      if (seconds) return `darwin:${seconds}`;
    } catch {}
  }
  if (process.platform === "win32") {
    try {
      const value = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[DateTimeOffset]::new((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (/^\d+$/.test(value)) return `windows:${value}`;
    } catch {}
  }
  try {
    return `uptime:${Math.round((Date.now() - os.uptime() * 1000) / 1000)}`;
  } catch {
    // Some restricted runtimes deny the platform uptime syscall. A shared
    // unknown value retains PID-based live-owner protection without making
    // every process look as if it came from a different boot.
    return "unknown";
  }
}

const BOOT_ID = currentBootId();

// An opaque, platform-specific signature for when a PID started, used only
// for equality comparison. If the OS later reuses a PID for an unrelated
// process within the same boot, this lets us tell the new process apart from
// the one that originally held the lock, instead of treating the lock as
// permanently live.
function processStartSignature(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The comm field (2nd) is parenthesized and may itself contain spaces,
      // so resume field counting after its closing paren.
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim();
      const starttime = afterComm.split(" ")[19];
      return starttime && /^\d+$/.test(starttime) ? `linux:${starttime}` : undefined;
    }
    if (process.platform === "darwin") {
      const value = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return value ? `ps:${value}` : undefined;
    }
    if (process.platform === "win32") {
      const value = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.Ticks`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return /^\d+$/.test(value) ? `windows:${value}` : undefined;
    }
  } catch {}
  return undefined;
}

export function sameBootIdentity(left: string, right: string): boolean {
  if (left === right) return true;
  // Approximate/unknown identities cannot safely prove that a live PID is
  // from an earlier boot. Prefer waiting over deleting a live owner's lock.
  if (left === "unknown" || right === "unknown") return true;
  const approximate = (value: string) =>
    value.startsWith("uptime:") ? Number(value.slice("uptime:".length)) : Number.NaN;
  const stableEpoch = (value: string) => {
    const match = /^(?:darwin|windows):(\d+)$/.exec(value);
    return match ? Number(match[1]) : Number.NaN;
  };
  const leftApproximate = approximate(left);
  const rightApproximate = approximate(right);
  if (Number.isFinite(leftApproximate) && Number.isFinite(rightApproximate)) return true;
  if (Number.isFinite(leftApproximate) !== Number.isFinite(rightApproximate)) {
    const leftEpoch = Number.isFinite(leftApproximate) ? leftApproximate : stableEpoch(left);
    const rightEpoch = Number.isFinite(rightApproximate) ? rightApproximate : stableEpoch(right);
    if (Number.isFinite(leftEpoch) && Number.isFinite(rightEpoch))
      return Math.abs(leftEpoch - rightEpoch) <= 300;
  }
  return false;
}

function readOwner(file: string): LockOwner | undefined {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value.startsWith("{")) {
      const owner = JSON.parse(value) as Partial<LockOwner>;
      return Number.isInteger(owner.pid) &&
        owner.pid! > 0 &&
        typeof owner.token === "string" &&
        owner.token.length >= 8
        ? {
            pid: owner.pid!,
            bootId: owner.bootId,
            token: owner.token,
            startedAt: typeof owner.startedAt === "string" ? owner.startedAt : undefined,
          }
        : undefined;
    }
    const pid = Number(value.split("\n", 1)[0]);
    return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
  } catch {
    return undefined;
  }
}

function ownerIsAlive(owner: LockOwner): boolean {
  if (owner.bootId && !sameBootIdentity(owner.bootId, BOOT_ID)) return false;
  try {
    process.kill(owner.pid, 0);
  } catch {
    // A PID alone is not proof that another user's process owns a lock in our
    // data directory. Treat EPERM and ESRCH as stale ownership.
    return false;
  }
  if (owner.startedAt) {
    const current = processStartSignature(owner.pid);
    // Only a positive mismatch counts: if we can't read the running
    // process's start time, keep the current behavior of preferring to wait
    // over reclaiming a lock that might still be live. But if the OS has
    // reused this PID for an unrelated process since the lock was written,
    // the start times won't match, and the lock is stale, not held.
    if (current && current !== owner.startedAt) return false;
  }
  return true;
}

function staleClaimFiles(file: string): string[] {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  try {
    return fs
      .readdirSync(directory)
      .filter((name: string) => name.startsWith(prefix) && name.endsWith(".stale"))
      .map((name: string) => path.join(directory, name));
  } catch {
    return [];
  }
}

// A stale-lock claim remains visible as a recovery gate for its entire
// lifetime. New owners must not enter while a reclaimer has temporarily moved
// the public lock path. If the reclaimer crashed, restore a captured live
// owner with an atomic hard link, or discard a captured stale owner.
function reconcileStaleClaims(
  file: string,
  incompleteLockGraceMs: number,
  legacyLockGraceMs: number,
): void {
  for (const claim of staleClaimFiles(file)) {
    try {
      const owner = readOwner(claim);
      const age = Date.now() - fs.statSync(claim).mtimeMs;
      const stale =
        (owner && (!ownerIsAlive(owner) || (!owner.bootId && age > legacyLockGraceMs))) ||
        (!owner && age > incompleteLockGraceMs);
      if (stale) {
        fs.unlinkSync(claim);
        continue;
      }
      try {
        fs.linkSync(claim, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (fs.readFileSync(file, "utf8") === fs.readFileSync(claim, "utf8")) fs.unlinkSync(claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function tryAcquire(
  file: string,
  incompleteLockGraceMs: number,
  legacyLockGraceMs: number,
): LockHandle | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = JSON.stringify({
    pid: process.pid,
    bootId: BOOT_ID,
    token: crypto.randomUUID(),
    startedAt: processStartSignature(process.pid),
  });
  const candidate = `${file}.${process.pid}.${crypto.randomUUID()}.candidate`;
  try {
    reconcileStaleClaims(file, incompleteLockGraceMs, legacyLockGraceMs);
    if (staleClaimFiles(file).length) return undefined;
    // Publish a completely written owner record with one atomic link. No
    // observer can mistake our in-progress write for an abandoned lock.
    fs.writeFileSync(candidate, token, { flag: "wx", mode: 0o600 });
    fs.linkSync(candidate, file);
    // A reclaimer may have published its gate after our first check. Do not
    // enter until that claim is resolved, and also verify nobody replaced
    // our public link before we return ownership to the caller.
    if (staleClaimFiles(file).length || fs.readFileSync(file, "utf8") !== token) {
      release(file, { token });
      return undefined;
    }
    return { token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const owner = readOwner(file);
      const age = Date.now() - fs.statSync(file).mtimeMs;
      const stale =
        (owner && (!ownerIsAlive(owner) || (!owner.bootId && age > legacyLockGraceMs))) ||
        (!owner && age > incompleteLockGraceMs);
      if (stale) {
        // Reclaiming a stale lock used to be check-then-unlink: two
        // processes could both decide the same lock was stale, and the
        // second to unlink it would actually be deleting the first's freshly
        // acquired lock, letting both enter the critical section together.
        // Renaming instead atomically claims the exact file we inspected —
        // rename() removes whatever currently sits at `file`, and a second,
        // concurrent renamer of the same path fails with ENOENT because
        // there is nothing left there to move. Only the winner proceeds.
        const claim = `${file}.${process.pid}.${crypto.randomUUID()}.stale`;
        try {
          fs.renameSync(file, claim);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw renameError;
        }
        let removeClaim = true;
        try {
          const reread = readOwner(claim);
          const sameOwner = owner
            ? reread !== undefined && reread.pid === owner.pid && reread.token === owner.token
            : reread === undefined;
          if (!sameOwner) {
            // Something else replaced the lock between our read and our
            // rename (e.g. a legitimate new owner). It is no longer the
            // stale instance we decided to reclaim, so put it back rather
            // than discarding a possibly live lock.
            try {
              fs.linkSync(claim, file);
            } catch (restoreError) {
              if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError;
              // Keep the claim as a recovery gate unless the public path is
              // already another link to exactly the owner we captured.
              removeClaim = fs.readFileSync(file, "utf8") === fs.readFileSync(claim, "utf8");
            }
          }
        } finally {
          if (removeClaim)
            try {
              fs.unlinkSync(claim);
            } catch {}
        }
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    return undefined;
  } finally {
    try {
      fs.unlinkSync(candidate);
    } catch {}
  }
}

function release(file: string, handle: LockHandle): void {
  try {
    if (fs.readFileSync(file, "utf8") === handle.token) fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // If a stale reclaimer moved this live lock between acquisition and
  // release, remove that captured link too. The reclaimer will observe the
  // missing claim and must not resurrect an owner whose operation completed.
  for (const claim of staleClaimFiles(file)) {
    try {
      if (fs.readFileSync(claim, "utf8") === handle.token) fs.unlinkSync(claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function withFileLock<T>(
  file: string,
  operation: () => T,
  options: FileLockOptions = {},
): T {
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  let handle: LockHandle | undefined;
  while (handle === undefined && Date.now() < deadline) {
    handle = tryAcquire(
      file,
      options.incompleteLockGraceMs ?? INCOMPLETE_LOCK_GRACE_MS,
      options.legacyLockGraceMs ?? LEGACY_LOCK_GRACE_MS,
    );
    if (handle === undefined)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
  }
  if (handle === undefined) throw new Error(`Timed out waiting for lock ${file}.`);
  try {
    return operation();
  } finally {
    release(file, handle);
  }
}

export async function withFileLockAsync<T>(
  file: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  let handle: LockHandle | undefined;
  while (handle === undefined && Date.now() < deadline) {
    handle = tryAcquire(
      file,
      options.incompleteLockGraceMs ?? INCOMPLETE_LOCK_GRACE_MS,
      options.legacyLockGraceMs ?? LEGACY_LOCK_GRACE_MS,
    );
    if (handle === undefined) await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
  }
  if (handle === undefined) throw new Error(`Timed out waiting for lock ${file}.`);
  try {
    return await operation();
  } finally {
    release(file, handle);
  }
}

export function withFileLocks<T>(files: string[], operation: () => T): T {
  const locks = [...new Set(files)].sort();
  const acquire = (index: number): T =>
    index === locks.length ? operation() : withFileLock(locks[index], () => acquire(index + 1));
  return acquire(0);
}
