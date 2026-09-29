import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock.js";

export type SyncDeletionKind = "history" | "feedback" | "jev-feedback";

export interface SyncDeletion {
  kind: SyncDeletionKind;
  id: string;
}

export function syncDeletionJournalPath(historyFile: string): string {
  return `${historyFile}.sync-deletions.jsonl`;
}

export function recordSyncDeletions(
  historyFile: string,
  kind: SyncDeletionKind,
  ids: Iterable<string>,
): void {
  const additions = [...new Set(ids)].filter(Boolean);
  if (!additions.length) return;
  const file = syncDeletionJournalPath(historyFile);
  withFileLock(`${file}.lock`, () => {
    const existing = readSyncDeletions(historyFile);
    const known = new Set(existing.map((item) => `${item.kind}:${item.id}`));
    const pending = additions.filter((id) => !known.has(`${kind}:${id}`));
    if (!pending.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, pending.map((id) => JSON.stringify({ kind, id })).join("\n") + "\n", {
      mode: 0o600,
    });
  });
}

export function readSyncDeletions(historyFile: string): SyncDeletion[] {
  const file = syncDeletionJournalPath(historyFile);
  if (!fs.existsSync(file)) return [];
  const result: SyncDeletion[] = [];
  for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Sync deletion journal ${file} contains invalid JSON on line ${index + 1}.`);
    }
    const record = value as Partial<SyncDeletion>;
    if (
      !record ||
      !["history", "feedback", "jev-feedback"].includes(String(record.kind)) ||
      typeof record.id !== "string" ||
      !record.id
    )
      throw new Error(
        `Sync deletion journal ${file} contains an invalid entry on line ${index + 1}.`,
      );
    result.push({ kind: record.kind as SyncDeletionKind, id: record.id });
  }
  return result;
}

export function acknowledgeSyncDeletions(
  historyFile: string,
  acknowledged: Iterable<SyncDeletion>,
): void {
  const removals = new Set([...acknowledged].map((item) => `${item.kind}:${item.id}`));
  if (!removals.size) return;
  const file = syncDeletionJournalPath(historyFile);
  withFileLock(`${file}.lock`, () => {
    const kept = readSyncDeletions(historyFile).filter(
      (item) => !removals.has(`${item.kind}:${item.id}`),
    );
    const temporary = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      temporary,
      kept.length ? `${kept.map((item) => JSON.stringify(item)).join("\n")}\n` : "",
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  });
}
