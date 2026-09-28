import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sameBootIdentity, withFileLock, withFileLockAsync, withFileLocks } from "../file-lock.js";

test("treats nearby uptime estimates as the same boot", () => {
  assert.equal(sameBootIdentity("uptime:1000", "uptime:1001"), true);
  assert.equal(sameBootIdentity("uptime:1000", "uptime:1300"), true);
  assert.equal(sameBootIdentity("uptime:1000", "uptime:1301"), true);
  assert.equal(sameBootIdentity("unknown", "uptime:1301"), true);
  assert.equal(sameBootIdentity("windows:1000", "uptime:1300"), true);
  assert.equal(sameBootIdentity("windows:1000", "uptime:1301"), false);
  assert.equal(sameBootIdentity("darwin:1000", "darwin:1001"), false);
});

test("reclaims locks from a prior boot even when the PID is alive", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-lock-boot-"));
  const lock = path.join(directory, "history.lock");
  try {
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, bootId: "a-prior-boot", token: "old-owner" }),
    );
    assert.equal(
      withFileLock(lock, () => "acquired", { timeoutMs: 100 }),
      "acquired",
    );
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reclaims incomplete and legacy locks before the acquisition timeout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-lock-stale-"));
  try {
    for (const [name, contents, options] of [
      ["partial.lock", "{", { incompleteLockGraceMs: 5 }],
      ["legacy.lock", `${process.pid}\nold-token\n`, { legacyLockGraceMs: 5 }],
    ] as const) {
      const lock = path.join(directory, name);
      fs.writeFileSync(lock, contents);
      const old = new Date(Date.now() - 1_000);
      fs.utimesSync(lock, old, old);
      assert.equal(
        withFileLock(lock, () => name, { timeoutMs: 100, ...options }),
        name,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not release a lock replaced by another owner", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-lock-owner-"));
  const lock = path.join(directory, "history.lock");
  try {
    withFileLock(lock, () => {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, "replacement");
    });
    assert.equal(fs.readFileSync(lock, "utf8"), "replacement");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("serializes asynchronous owners and orders multi-file locks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-lock-async-"));
  const lock = path.join(directory, "sync.lock");
  const order: string[] = [];
  try {
    await Promise.all([
      withFileLockAsync(lock, async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 25));
        order.push("first-end");
      }),
      withFileLockAsync(lock, async () => {
        order.push("second");
      }),
    ]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
    assert.equal(
      withFileLocks([path.join(directory, "b.lock"), path.join(directory, "a.lock")], () => 42),
      42,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
