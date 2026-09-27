import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  linkRepositoryIdentity,
  normalizeGitRemote,
  resolveRepositoryIdentity,
} from "../repository.js";

test("normalizes equivalent Git remotes without retaining credentials", () => {
  assert.equal(
    normalizeGitRemote("git@GitHub.com:Owner/repository.git"),
    "github.com/Owner/repository",
  );
  assert.equal(
    normalizeGitRemote("https://token@github.com/Owner/repository.git?x=1#fragment"),
    "github.com/Owner/repository",
  );
  assert.equal(
    normalizeGitRemote("ssh://git@github.com/Owner/repository.git"),
    "github.com/Owner/repository",
  );
});

test("persists and explicitly links random identities for repositories without remotes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-repository-id-"));
  const storage = path.join(dir, "data");
  const first = path.join(dir, "first");
  const second = path.join(dir, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  try {
    const original = resolveRepositoryIdentity(first, storage);
    assert.match(original.id, /^local-v1:/);
    assert.equal(resolveRepositoryIdentity(first, storage).id, original.id);
    assert.notEqual(resolveRepositoryIdentity(second, storage).id, original.id);

    linkRepositoryIdentity(second, storage, original.id);
    assert.equal(resolveRepositoryIdentity(second, storage).id, original.id);
    assert.throws(() => linkRepositoryIdentity(second, storage, "not-an-id"), /Invalid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derives the same private-local ID from equivalent Git origin remotes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-repository-git-"));
  const first = path.join(dir, "first");
  const second = path.join(dir, "second");
  const storage = path.join(dir, "data");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  try {
    for (const [cwd, remote] of [
      [first, "git@github.com:Owner/repository.git"],
      [second, "https://github.com/Owner/repository"],
    ] as const) {
      assert.equal(spawnSync("git", ["init", cwd]).status, 0);
      assert.equal(spawnSync("git", ["-C", cwd, "remote", "add", "origin", remote]).status, 0);
    }
    const firstIdentity = resolveRepositoryIdentity(first, storage);
    const secondIdentity = resolveRepositoryIdentity(second, storage);
    assert.equal(firstIdentity.source, "git-remote");
    assert.equal(firstIdentity.id, secondIdentity.id);
    assert.throws(
      () => linkRepositoryIdentity(first, storage, "local-v1:00000000-0000-4000-8000-000000000000"),
      /derive their ID automatically/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
