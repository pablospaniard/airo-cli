import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SessionState, SessionTurn } from "./types.js";
import { dataRootDir, ensurePrivateDirectory, ensurePrivateFile } from "./paths.js";
import { findRunLogs } from "./logging.js";

export interface SessionTranscriptTurn extends SessionTurn {
  finalOutput: string;
}

export interface SessionTranscript extends Omit<SessionState, "turns"> {
  turns: SessionTranscriptTurn[];
}

function rootDir(): string {
  const dir = dataRootDir();
  ensurePrivateDirectory(dir, true);
  return dir;
}

function sessionsDir(): string {
  const dir = path.join(rootDir(), "sessions");
  ensurePrivateDirectory(dir, true);
  return dir;
}

function activeMapPath(): string {
  return path.join(rootDir(), "active-sessions.json");
}
function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

function readActiveMap(): Record<string, string> {
  const p = activeMapPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeActiveMap(map: Record<string, string>) {
  const file = activeMapPath();
  fs.writeFileSync(file, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  ensurePrivateFile(file);
}

export function createSession(originalTask: string, cwd = process.cwd()): SessionState {
  const now = new Date().toISOString();
  const s: SessionState = {
    sessionId: crypto.randomBytes(5).toString("hex"),
    cwd: path.resolve(cwd),
    createdAt: now,
    updatedAt: now,
    originalTask,
    turns: [],
  };
  saveSession(s);
  setActiveSession(s.cwd, s.sessionId);
  return s;
}

export function saveSession(s: SessionState) {
  s.updatedAt = new Date().toISOString();
  const file = sessionPath(s.sessionId);
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  ensurePrivateFile(file);
}

export function loadSession(id: string): SessionState {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) throw new Error(`Session not found: ${id}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function loadSessionTranscript(id: string): SessionTranscript {
  const session = loadSession(id);
  return {
    ...session,
    turns: session.turns.map((turn) => {
      const runDir = findRunLogs(turn.runId);
      const finalPath = runDir ? path.join(runDir, "final-output.txt") : undefined;
      const finalOutput =
        finalPath && fs.existsSync(finalPath)
          ? fs.readFileSync(finalPath, "utf8").trim()
          : turn.phaseSummaries.join("\n");
      return { ...turn, finalOutput };
    }),
  };
}

export function setActiveSession(cwd: string, id: string) {
  const map = readActiveMap();
  map[path.resolve(cwd)] = id;
  writeActiveMap(map);
}

export function getActiveSession(cwd = process.cwd()): SessionState | undefined {
  const id = readActiveMap()[path.resolve(cwd)];
  if (!id) return undefined;
  try {
    return loadSession(id);
  } catch {
    return undefined;
  }
}

export function clearActiveSession(cwd = process.cwd()) {
  const map = readActiveMap();
  delete map[path.resolve(cwd)];
  writeActiveMap(map);
}

export function appendTurn(s: SessionState, turn: SessionTurn) {
  s.turns.push(turn);
  saveSession(s);
}

export function compactSessionContext(s: SessionState, maxTurns = 6): string {
  const recent = s.turns.slice(-maxTurns);
  const lines = [`Session: ${s.sessionId}`, `Original request: ${s.originalTask}`];
  for (const t of recent) {
    lines.push(`User follow-up: ${t.userPrompt}`);
    lines.push(`Route: ${t.routeSummary}`);
    for (const p of t.phaseSummaries.slice(-4)) lines.push(`Outcome: ${p}`);
  }
  return lines.join("\n");
}

export function listSessions(cwd = process.cwd()): SessionState[] {
  return fs
    .readdirSync(sessionsDir())
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), "utf8")) as SessionState;
      } catch {
        return undefined;
      }
    })
    .filter((x: SessionState | undefined): x is SessionState => Boolean(x))
    .filter((s: SessionState) => path.resolve(s.cwd) === path.resolve(cwd))
    .sort((a: SessionState, b: SessionState) => b.updatedAt.localeCompare(a.updatedAt));
}
