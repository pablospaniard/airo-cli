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

export function sameBootIdentity(left: string, right: string): boolean {
  if (left === right) return true;
  const parseFallback = (value: string) =>
    value.startsWith("uptime:") ? Number(value.slice("uptime:".length)) : Number.NaN;
  const leftTime = parseFallback(left);
  const rightTime = parseFallback(right);
  return (
    Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= 300
  );
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
        ? { pid: owner.pid!, bootId: owner.bootId, token: owner.token }
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
    return true;
  } catch {
    // A PID alone is not proof that another user's process owns a lock in our
    // data directory. Treat EPERM and ESRCH as stale ownership.
    return false;
  }
}

function tryAcquire(
  file: string,
  incompleteLockGraceMs: number,
  legacyLockGraceMs: number,
): LockHandle | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = JSON.stringify({ pid: process.pid, bootId: BOOT_ID, token: crypto.randomUUID() });
  const candidate = `${file}.${process.pid}.${crypto.randomUUID()}.candidate`;
  try {
    // Publish a completely written owner record with one atomic link. No
    // observer can mistake our in-progress write for an abandoned lock.
    fs.writeFileSync(candidate, token, { flag: "wx", mode: 0o600 });
    fs.linkSync(candidate, file);
    return { token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const owner = readOwner(file);
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (
        (owner && (!ownerIsAlive(owner) || (!owner.bootId && age > legacyLockGraceMs))) ||
        (!owner && age > incompleteLockGraceMs)
      )
        fs.unlinkSync(file);
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
