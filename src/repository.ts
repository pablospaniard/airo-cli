import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPOSITORY_INDEX_VERSION = 1;

interface RepositoryIndex {
  version: number;
  projects: Record<string, string>;
}

export interface RepositoryIdentity {
  id: string;
  source: "git-remote" | "local-project";
  root: string;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeGitRemote(remote: string): string {
  let value = remote.trim();
  const scp = value.match(/^git@([^:]+):(.+)$/i);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    value = `${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    value = value.replace(/^ssh:\/\//i, "");
  }
  return value.replace(/\.git$/i, "").replace(/\/+$/, "");
}

function gitValue(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

function repositoryIndexPath(storageDir: string): string {
  return path.join(storageDir, "repositories.json");
}

function readIndex(storageDir: string): RepositoryIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(repositoryIndexPath(storageDir), "utf8"));
    if (parsed?.version === REPOSITORY_INDEX_VERSION && parsed.projects)
      return parsed as RepositoryIndex;
  } catch {
    // A missing or malformed index starts clean; history remains authoritative.
  }
  return { version: REPOSITORY_INDEX_VERSION, projects: {} };
}

function writeIndex(storageDir: string, index: RepositoryIndex): void {
  fs.mkdirSync(storageDir, { recursive: true });
  const target = repositoryIndexPath(storageDir);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function projectRoot(cwd: string): string {
  return path.resolve(gitValue(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd);
}

export function resolveRepositoryIdentity(cwd: string, storageDir: string): RepositoryIdentity {
  const root = projectRoot(cwd);
  const remote = gitValue(root, ["config", "--get", "remote.origin.url"]);
  if (remote) {
    const canonical = normalizeGitRemote(remote);
    return { id: `git-v1:${sha256(canonical)}`, source: "git-remote", root };
  }

  const index = readIndex(storageDir);
  const key = path.resolve(root);
  let id = index.projects[key];
  if (!id) {
    id = `local-v1:${crypto.randomUUID()}`;
    index.projects[key] = id;
    writeIndex(storageDir, index);
  }
  return { id, source: "local-project", root };
}

export function linkRepositoryIdentity(cwd: string, storageDir: string, id: string): void {
  if (!/^(?:git-v1:[a-f0-9]{64}|local-v1:[0-9a-f-]{36})$/.test(id))
    throw new Error("Invalid repository ID.");
  const root = projectRoot(cwd);
  const remote = gitValue(root, ["config", "--get", "remote.origin.url"]);
  if (remote)
    throw new Error(
      "Repositories with an origin remote derive their ID automatically and cannot be linked manually.",
    );
  const index = readIndex(storageDir);
  index.projects[path.resolve(root)] = id;
  writeIndex(storageDir, index);
}
