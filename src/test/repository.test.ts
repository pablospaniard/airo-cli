import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

test("serializes concurrent local repository ID assignments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-repository-concurrent-"));
  const storage = path.join(dir, "data");
  const first = path.join(dir, "first");
  const second = path.join(dir, "second");
  const lock = path.join(storage, "repositories.json.lock");
  const ready = path.join(dir, "ready");
  const release = path.join(dir, "release");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.mkdirSync(storage);
  const blocker = spawn(process.execPath, [
    "-e",
    `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(lock)},process.pid+"\\nlegacy\\n",{flag:"wx"});fs.writeFileSync(${JSON.stringify(ready)},"ready");const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);fs.unlinkSync(${JSON.stringify(lock)})},5);`,
  ]);
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(ready) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fs.existsSync(ready), true);

    const repositoryModule = new URL("../repository.js", import.meta.url).href;
    for (const [project, result] of [
      [first, path.join(dir, "first-result")],
      [second, path.join(dir, "second-result")],
    ]) {
      children.push(
        spawn(process.execPath, [
          "--input-type=module",
          "-e",
          `import fs from "node:fs";import {resolveRepositoryIdentity} from ${JSON.stringify(repositoryModule)};const value=resolveRepositoryIdentity(${JSON.stringify(project)},${JSON.stringify(storage)});fs.writeFileSync(${JSON.stringify(result)},value.id);`,
        ]),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(path.join(dir, "first-result")), false);
    assert.equal(fs.existsSync(path.join(dir, "second-result")), false);
    fs.writeFileSync(release, "release");
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("exit", (code: number | null) =>
              code === 0 ? resolve() : reject(new Error(`resolver exited ${code}`)),
            );
            child.once("error", reject);
          }),
      ),
    );
    const index = JSON.parse(fs.readFileSync(path.join(storage, "repositories.json"), "utf8")) as {
      projects: Record<string, string>;
    };
    assert.equal(Object.keys(index.projects).length, 2);
  } finally {
    fs.writeFileSync(release, "release");
    blocker.kill();
    for (const child of children) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
