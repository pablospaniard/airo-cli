import fs from "node:fs";
import path from "node:path";
import type { Agent, LogLevel, PhaseKind } from "./types.js";
import {
  agentColor,
  divider,
  outputWidth,
  renderTerminalMarkdown,
  sectionRule,
  statusIcon,
  ui,
} from "./ui.js";
import { dataRootDir, ensurePrivateDirectory, ensurePrivateFile } from "./paths.js";
import { extractLocalArtifacts } from "./artifacts.js";

export interface RunLoggerOptions {
  runId: string;
  sessionId?: string;
  level: LogLevel;
  persist?: boolean;
}

export interface PhaseLogMeta {
  phaseIndex: number;
  phaseTotal: number;
  phaseKind: PhaseKind | "single";
  agent: Agent;
  model: string;
  effort: string;
  tier: string;
}

export function formatLocalTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function nowTime(): string {
  return formatLocalTime(new Date());
}

function dataDir(create = true): string {
  const dir = path.join(dataRootDir(), "logs");
  if (create) ensurePrivateDirectory(dir, true);
  return dir;
}

function safeName(v: string): string {
  return v.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export class RunLogger {
  readonly runId: string;
  readonly sessionId?: string;
  readonly level: LogLevel;
  readonly persist: boolean;
  readonly runDir: string;
  readonly combinedPath: string;

  constructor(options: RunLoggerOptions) {
    this.runId = options.runId;
    this.sessionId = options.sessionId;
    this.level = options.level;
    this.persist = options.persist ?? true;
    const parent = this.sessionId ? `session-${safeName(this.sessionId)}` : "standalone";
    const parentDir = path.join(dataDir(this.persist), parent);
    this.runDir = path.join(parentDir, `run-${safeName(this.runId)}`);
    if (this.persist) {
      ensurePrivateDirectory(parentDir, true);
      ensurePrivateDirectory(this.runDir, true);
    }
    this.combinedPath = path.join(this.runDir, "combined.log");
  }

  private append(file: string, value: string) {
    if (!this.persist) return;
    fs.appendFileSync(file, value.endsWith("\n") ? value : `${value}\n`, { mode: 0o600 });
    ensurePrivateFile(file);
  }

  private console(value: string) {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
  }

  private event(type: string, value: Record<string, unknown>) {
    if (process.env.AIRO_STREAM_PROTOCOL !== "1") return;
    this.console(`AIRO_EVENT ${JSON.stringify({ type, ...value })}`);
  }

  private prettyStatus(message: string): string {
    if (/\b(?:phase|run)\b.*\b(?:complete|blocked)\b.*\bexit=[1-9]\d*\b/i.test(message))
      return `${ui.gray(nowTime())} ${statusIcon("error")} ${ui.bold("airo")} ${ui.red(message)}`;
    if (message.includes(" complete"))
      return `${ui.gray(nowTime())} ${statusIcon("ok")} ${ui.bold("airo")} ${message}`;
    if (message.includes("phase ") || message.includes("started"))
      return `${ui.gray(nowTime())} ${statusIcon("work")} ${ui.bold("airo")} ${message}`;
    if (message.includes("question") || message.includes("input"))
      return `${ui.gray(nowTime())} ${statusIcon("ask")} ${ui.bold("airo")} ${ui.yellow(message)}`;
    return `${ui.gray(nowTime())} ${statusIcon("info")} ${ui.bold("airo")} ${message}`;
  }

  status(message: string) {
    const line = `${nowTime()} [airo] ${message}`;
    this.append(this.combinedPath, line);
    this.console(this.prettyStatus(message));
  }

  metadata(message: string) {
    const line = `${nowTime()} [meta] ${message}`;
    this.append(this.combinedPath, line);
    if (this.level === "verbose")
      this.console(`${ui.gray(nowTime())} ${ui.gray("[meta]")} ${ui.dim(message)}`);
  }

  phaseFile(meta: PhaseLogMeta): string {
    const index = String(meta.phaseIndex).padStart(2, "0");
    return path.join(
      this.runDir,
      `${index}-${safeName(meta.phaseKind)}-${safeName(meta.agent)}.log`,
    );
  }

  eventsFile(meta: PhaseLogMeta): string {
    const index = String(meta.phaseIndex).padStart(2, "0");
    return path.join(
      this.runDir,
      `${index}-${safeName(meta.phaseKind)}-${safeName(meta.agent)}.events.jsonl`,
    );
  }

  rawEvent(meta: PhaseLogMeta, rawLine: string) {
    this.append(this.eventsFile(meta), rawLine);
  }

  progress(meta: PhaseLogMeta, message: string, category = "ai") {
    if (!message.trim()) return;
    const lines = message.replace(/\r/g, "").split("\n").filter(Boolean);
    for (const text of lines) {
      const line = `${nowTime()} [${meta.phaseKind}][${meta.agent}][${category}] ${text}`;
      this.append(this.phaseFile(meta), line);
      this.append(this.combinedPath, line);
      if (this.level !== "compact") {
        const time = ui.gray(nowTime());
        if (category === "message")
          this.console(`${time} ${agentColor(meta.agent, "▌")} ${ui.white(text)}`);
        else if (category === "tool") this.console(`${time} ${ui.cyan("⚙ tool ")} ${ui.dim(text)}`);
        else if (category === "file")
          this.console(`${time} ${ui.blue("✎ edit ")} ${ui.cyan(text)}`);
        else if (category === "error") this.console(`${time} ${ui.red("✗ error")} ${ui.red(text)}`);
        else if (category === "retry")
          this.console(`${time} ${ui.yellow("↻ retry")} ${ui.yellow(text)}`);
        else if (category === "result")
          this.console(`${time} ${ui.gray("└ done ")} ${ui.dim(text)}`);
        else if (category === "system")
          this.console(`${time} ${ui.gray("· sys  ")} ${ui.dim(text)}`);
        else this.console(`${time} ${ui.gray("· info ")} ${ui.dim(text)}`);
      }
    }
  }

  stderr(meta: PhaseLogMeta, chunk: string) {
    // stderr often contains useful provider progress. Persist it always; show it only in verbose.
    const lines = chunk.replace(/\r/g, "").split("\n").filter(Boolean);
    for (const text of lines) {
      const line = `${nowTime()} [${meta.phaseKind}][${meta.agent}][stderr] ${text}`;
      this.append(this.phaseFile(meta), line);
      this.append(this.combinedPath, line);
      if (this.level === "verbose")
        this.console(
          `${ui.gray(nowTime())} ${agentColor(meta.agent, `[${meta.phaseKind}]`)} ${agentColor(meta.agent, `[${meta.agent}]`)} ${ui.red("[stderr]")} ${ui.red(text)}`,
        );
    }
  }

  /**
   * Route and phase events describing who is running the phase right now.
   * `reason` is set only for a handover, so clients can say why the provider
   * changed instead of silently swapping the name in the header.
   */
  private routeEvents(meta: PhaseLogMeta, reason?: string) {
    this.event("route", {
      provider: meta.agent,
      model: meta.model,
      tier: meta.tier,
      sessionId: this.sessionId,
      phase: meta.phaseKind,
      phaseIndex: meta.phaseIndex,
      phaseTotal: meta.phaseTotal,
      ...(reason ? { reason } : {}),
    });
    this.event("phase", {
      state: "started",
      kind: meta.phaseKind,
      title: `${meta.phaseKind[0].toUpperCase()}${meta.phaseKind.slice(1)}`,
      provider: meta.agent,
      model: meta.model,
      tier: meta.tier,
      phaseIndex: meta.phaseIndex,
      phaseTotal: meta.phaseTotal,
    });
  }

  /**
   * Report a provider handover inside a running phase. Clients render the
   * active provider from route events, so they need a fresh one immediately:
   * otherwise the sidebar keeps showing the provider that just dropped out.
   * Call this after `meta` has been updated to the new provider.
   */
  providerSwitch(meta: PhaseLogMeta, message: string) {
    this.status(message);
    this.routeEvents(meta, message);
    this.console(
      `${ui.gray(nowTime())} ${statusIcon("work")} ${ui.bold("airo")} ${ui.gray("now running")} ${agentColor(meta.agent, `${meta.agent}/${meta.model}`)} ${ui.gray(`effort=${meta.effort} · tier=${meta.tier}`)}`,
    );
    this.metadata(`phase-log=${this.phaseFile(meta)}`);
    this.metadata(`events=${this.eventsFile(meta)}`);
  }

  phaseStart(meta: PhaseLogMeta) {
    const message = `phase ${meta.phaseIndex}/${meta.phaseTotal}: ${meta.phaseKind} → ${meta.agent}/${meta.model} effort=${meta.effort} tier=${meta.tier}`;
    this.append(this.combinedPath, `${nowTime()} [airo] ${message}`);
    this.routeEvents(meta);
    this.console("");
    this.console(
      sectionRule(
        `Phase ${meta.phaseIndex}/${meta.phaseTotal} · ${meta.phaseKind} · ${meta.agent}/${meta.model}`,
      ),
    );
    this.console(`${ui.gray(nowTime())} ${ui.gray(`effort=${meta.effort} · tier=${meta.tier}`)}`);
    this.metadata(`phase-log=${this.phaseFile(meta)}`);
    this.metadata(`events=${this.eventsFile(meta)}`);
  }

  phaseEnd(meta: PhaseLogMeta, exitCode: number, durationMs: number) {
    this.event("phase", {
      state: exitCode === 0 ? "completed" : "failed",
      kind: meta.phaseKind,
      title: `${meta.phaseKind[0].toUpperCase()}${meta.phaseKind.slice(1)}`,
      provider: meta.agent,
      phaseIndex: meta.phaseIndex,
      phaseTotal: meta.phaseTotal,
      exitCode,
    });
    this.status(
      `phase ${meta.phaseIndex}/${meta.phaseTotal} complete: ${meta.phaseKind} exit=${exitCode} duration=${(durationMs / 1000).toFixed(1)}s`,
    );
  }

  question(question: string) {
    const line = `${nowTime()} [airo][question] ${question}`;
    this.append(this.combinedPath, line);
    const requiresApproval = /\b(?:approval|permission|authori[sz]ation)\b/i.test(question);
    this.event(requiresApproval ? "permission" : "input", { question, requiresApproval });
    this.console("");
    this.console(divider("Input needed"));
    this.console(`${statusIcon("ask")} ${ui.yellow(ui.bold(question))}`);
  }

  finalOutput(output: string, success = true) {
    const clean = output.trim();
    if (!clean) return;
    this.event(success ? "final" : "failure", { text: clean });
    for (const artifact of extractLocalArtifacts(clean)) this.event("artifact", { ...artifact });
    const file = path.join(this.runDir, "final-output.txt");
    if (this.persist) {
      fs.writeFileSync(file, `${clean}\n`, { mode: 0o600 });
      ensurePrivateFile(file);
    }
    this.append(
      this.combinedPath,
      `${nowTime()} [airo][final] ${clean.replace(/\n/g, "\n[final] ")}`,
    );

    const width = outputWidth();
    this.console("");
    this.console(
      sectionRule(
        `${statusIcon(success ? "ok" : "error")} ${success ? "Final result" : "Run failed"}`,
        width,
      ),
    );
    this.console(renderTerminalMarkdown(clean, { width }));
    this.console(ui.gray("─".repeat(width)));
  }
}

export function logsRoot(): string {
  return dataDir();
}

export function findRunLogs(runId: string): string | undefined {
  const root = dataDir();
  const sessions = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((x: any) => x.isDirectory());
  for (const session of sessions) {
    const candidate = path.join(root, session.name, `run-${safeName(runId)}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function recentRunDirs(limit = 20): Array<{ runId: string; path: string; mtime: Date }> {
  const root = dataDir();
  const out: Array<{ runId: string; path: string; mtime: Date }> = [];
  for (const session of fs
    .readdirSync(root, { withFileTypes: true })
    .filter((x: any) => x.isDirectory())) {
    const sessionPath = path.join(root, session.name);
    for (const run of fs
      .readdirSync(sessionPath, { withFileTypes: true })
      .filter((x: any) => x.isDirectory() && x.name.startsWith("run-"))) {
      const p = path.join(sessionPath, run.name);
      out.push({ runId: run.name.slice(4), path: p, mtime: fs.statSync(p).mtime });
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

export async function followFile(file: string): Promise<void> {
  if (!fs.existsSync(file)) throw new Error(`Log file not found: ${file}`);
  let offset = 0;
  const printNew = () => {
    const stat = fs.statSync(file);
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = stat.size;
    process.stdout.write(buf.toString());
  };
  printNew();
  await new Promise<void>((resolve) => {
    const watcher = fs.watch(file, () => printNew());
    const stop = () => {
      watcher.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
