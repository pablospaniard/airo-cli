import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderWebview } from "./webview";

let loginShellEnvironmentPromise: Promise<NodeJS.ProcessEnv> | undefined;

function airoCommand(): string {
  return vscode.workspace.getConfiguration("airo").get<string>("command", "airo").trim() || "airo";
}

function loginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (loginShellEnvironmentPromise) return loginShellEnvironmentPromise;
  loginShellEnvironmentPromise = new Promise((resolve) => {
    if (process.platform === "win32") return resolve({ ...process.env });
    const shell = process.env.SHELL || "/bin/sh";
    const marker = "__AIRO_ENV_BEGIN__";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-ilc", `printf '${marker}\\0'; env -0`], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      return resolve({ ...process.env });
    }
    let output = "";
    const fallback = (): NodeJS.ProcessEnv => ({ ...process.env });
    child.stdout?.on("data", (data: Buffer) => (output += data.toString()));
    child.on("error", () => resolve(fallback()));
    child.on("close", (code) => {
      if (code !== 0) return resolve(fallback());
      const start = output.indexOf(`${marker}\0`);
      if (start < 0) return resolve(fallback());
      const environment: NodeJS.ProcessEnv = fallback();
      for (const entry of output.slice(start + marker.length + 1).split("\0")) {
        const separator = entry.indexOf("=");
        if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
      }
      resolve(environment);
    });
  });
  return loginShellEnvironmentPromise;
}

type Message = {
  type: string;
  text?: string;
  action?: string;
  sessionId?: string;
  chatId?: string;
  url?: string;
  files?: string[];
  dataUrl?: string;
  name?: string;
  file?: string;
};
type AttachmentPreview = { name: string; path: string; dataUrl: string };
type RouteStatus = { provider: string; model: string; tier: string };
type SessionSummary = {
  sessionId: string;
  description: string;
  updatedAt: string;
  turnCount: number;
};
type SessionTranscript = {
  sessionId: string;
  originalTask: string;
  turns: Array<{
    userPrompt: string;
    routeSummary: string;
    finalOutput: string;
  }>;
};
type SidebarChat = {
  id: string;
  title: string;
  session?: SessionSummary;
  activeSession: boolean;
  attachments: string[];
  attachmentPreviews: Map<string, string>;
  hydrated: boolean;
  child?: ChildProcessWithoutNullStreams;
  running: boolean;
  stopping: boolean;
  awaitingInput: boolean;
};
type ProtocolEvent = {
  type: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  tier?: string;
  question?: string;
  reason?: string;
  text?: string;
  requiresApproval?: boolean;
  state?: "started" | "completed" | "failed";
  kind?: string;
  title?: string;
  phaseIndex?: number;
  phaseTotal?: number;
  exitCode?: number;
  path?: string;
  name?: string;
  mediaType?: string;
};
type RunOptions = {
  environment?: NodeJS.ProcessEnv;
  outputFormat?: "command" | "markdown";
};

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SidebarProvider();
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("airo.sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("airo.runTask", () => provider.focus()),
    vscode.commands.registerCommand("airo.openHistory", () => provider.openHistory()),
    vscode.commands.registerCommand("airo.syncStatus", () => provider.syncStatus()),
    vscode.commands.registerCommand("airo.syncNow", () => provider.syncNow()),
    vscode.commands.registerCommand("airo.jevStatus", () => provider.jevStatus()),
    vscode.commands.registerCommand("airo.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:pablospaniard.airo-vscode",
      ),
    ),
    vscode.commands.registerCommand("airo.openTerminal", () => {
      const terminal = vscode.window.createTerminal("AIRO");
      terminal.show();
      terminal.sendText(airoCommand());
    }),
  );
}

class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  protected view?: vscode.WebviewView;
  protected activeSession = false;
  private attachments: string[] = [];
  private attachmentPreviews = new Map<string, string>();
  private readonly sidebarChats = new Map<string, SidebarChat>();
  private activeChatId: string;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private viewAvailable: Promise<void>;
  private resolveViewAvailable?: () => void;

  constructor(private session?: SessionSummary) {
    this.viewAvailable = new Promise((resolve) => {
      this.resolveViewAvailable = resolve;
    });
    this.activeSession = Boolean(session);
    const chat = this.createChatState(session);
    this.activeChatId = chat.id;
    this.sidebarChats.set(chat.id, chat);
  }

  dispose(): void {
    for (const chat of this.sidebarChats.values()) chat.child?.kill();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.initializeWebview(view.webview);
    this.resolveViewAvailable?.();
    this.resolveViewAvailable = undefined;
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = undefined;
      this.resolveReady = undefined;
      this.viewAvailable = new Promise((resolve) => {
        this.resolveViewAvailable = resolve;
      });
    });
  }

  protected initializeWebview(webview: vscode.Webview): void {
    for (const chat of this.sidebarChats.values()) chat.hydrated = false;
    webview.options = { enableScripts: true };
    webview.html = renderWebview([...Array(24)].map(() => Math.random().toString(36)[2]).join(""));
    webview.onDidReceiveMessage((message: Message) => void this.receive(message));
  }

  focus(): void {
    void this.reveal();
  }

  openHistory(): void {
    void this.showHistory();
  }

  syncStatus(): void {
    void this.reveal().then(() => this.sync([], this.activeChatId));
  }

  syncNow(): void {
    void this.reveal().then(() => this.sync(["now"], this.activeChatId));
  }

  jevStatus(): void {
    void this.reveal().then(() => this.jev([], this.activeChatId));
  }

  private async reveal(): Promise<void> {
    if (!this.view) {
      const viewAvailable = this.viewAvailable;
      await vscode.commands.executeCommand("airo.sidebar.focus");
      if (!this.view) await viewAvailable;
    }
    await this.ready;
    this.view?.show?.(true);
    this.post({ type: "focus" });
  }

  async attachDroppedUris(uris: readonly vscode.Uri[]): Promise<void> {
    await this.addAttachments(uris.map((uri) => uri.toString()));
    this.focus();
  }

  private async receive(message: Message): Promise<void> {
    if (message.type === "ready") {
      this.postTabs();
      this.postAttachments();
      this.post({ type: "route", ...this.configuredRoute() });
      this.postState();
      this.resolveReady?.();
      this.resolveReady = undefined;
      if (!this.session) {
        const result = await runCommand(["session", "--json"]);
        try {
          const session = JSON.parse(result.output) as SessionSummary | null;
          if (session?.sessionId) this.session = session;
        } catch {
          // The regular session status below remains available for older AIRO installations.
        }
        this.activeSession = Boolean(this.session);
        this.saveActiveChat();
      }
      const chat = this.sidebarChats.get(this.activeChatId);
      if (chat?.session) await this.hydrateChat(chat);
      this.post({
        type: "session",
        value: this.session
          ? `Chat — ${chatTitle(this.session.description)}`
          : this.activeSession
            ? "Connected to the active AIRO chat"
            : "New chat — send a task to begin",
      });
    } else if (message.type === "newTab") await this.newTab();
    else if (message.type === "closeTab" && message.chatId) this.closeTab(message.chatId);
    else if (message.type === "openLink" && message.url) await this.openLink(message.url);
    else if (message.type === "openFile" && message.file) await this.openFile(message.file);
    else if (message.type === "revealFile" && message.file) await this.revealFile(message.file);
    else if (message.type === "removeAttachment" && message.file)
      this.removeAttachment(message.file, message.chatId);
    else if (message.type === "openSession" && message.sessionId)
      await this.openSessionTab(message.sessionId);
    else if (message.type === "switchTab" && message.chatId) this.switchTab(message.chatId);
    else if (message.type === "attach") await this.pickAttachments(message.chatId);
    else if (message.type === "dropAttachments" && message.files)
      await this.addAttachments(message.files, message.chatId);
    else if (message.type === "clipboardImage" && message.dataUrl)
      await this.addClipboardImage(message.dataUrl, message.name, message.chatId);
    else if (message.type === "action")
      await this.action(message.action ?? "", message.text, message.chatId);
    else if (
      message.type === "prompt" &&
      (message.text?.trim() ||
        this.sidebarChats.get(message.chatId ?? this.activeChatId)?.attachments.length)
    )
      await this.prompt(
        message.text?.trim() || "Please inspect the attached file(s).",
        message.chatId,
      );
  }

  private async prompt(
    text: string,
    chatId = this.activeChatId,
    forceNoJev = false,
  ): Promise<void> {
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    if (chat.running) {
      if (chat.awaitingInput && chat.child?.stdin.writable) {
        chat.awaitingInput = false;
        this.postState(chat.id);
        chat.child.stdin.write(`${text}\n`);
      }
      return;
    }
    if (text.startsWith("/") && !forceNoJev) return this.slash(text, chatId);
    if (chat.title === "New chat") {
      chat.title = shortDescription(text);
      this.postTabs();
    }
    const attached = chat.attachments.length
      ? "\n\nAttached local file(s) for inspection:\n" +
        chat.attachments.map((file) => `- ${file}`).join("\n") +
        "\nUse the provider's local file inspection capability if available."
      : "";
    chat.attachments = [];
    chat.attachmentPreviews.clear();
    if (this.activeChatId === chatId) {
      this.attachments = [];
      this.attachmentPreviews.clear();
    }
    this.postAttachments(chatId);
    const result = await this.run(
      this.taskArgs(text + attached, chat, forceNoJev),
      true,
      text,
      chatId,
      { outputFormat: "markdown" },
    );
    if (result.started) {
      const chat = this.sidebarChats.get(chatId);
      if (!chat) return;
      chat.activeSession = true;
      if (!chat.session) {
        const sessionResult = await runCommand(["session", "--json"]);
        try {
          const session = JSON.parse(sessionResult.output) as SessionSummary | null;
          if (session?.sessionId) chat.session = session;
        } catch {
          // Continue mode remains available as a fallback for older CLI versions.
        }
      }
      if (this.activeChatId === chatId) {
        this.session = chat.session;
        this.activeSession = chat.activeSession;
        this.saveActiveChat();
      } else {
        this.replaceDraftId(chatId, chat);
      }
      chat.hydrated = true;
    }
  }

  private async openLink(value: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(value, true);
    } catch {
      return;
    }
    if (uri.scheme !== "https" && uri.scheme !== "http") return;
    await vscode.env.openExternal(uri);
  }

  private async openFile(value: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = value.startsWith("file://") ? vscode.Uri.parse(value, true) : vscode.Uri.file(value);
    } catch {
      return;
    }
    if (uri.scheme !== "file" || !path.isAbsolute(uri.fsPath)) return;
    uri = vscode.Uri.file(path.normalize(uri.fsPath));
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) return;
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch {
      this.notice("That attachment is no longer available.");
    }
  }

  private async revealFile(value: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = value.startsWith("file://") ? vscode.Uri.parse(value, true) : vscode.Uri.file(value);
    } catch {
      return;
    }
    if (uri.scheme !== "file" || !path.isAbsolute(uri.fsPath)) return;
    uri = vscode.Uri.file(path.normalize(uri.fsPath));
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) return;
      await vscode.commands.executeCommand("revealFileInOS", uri);
    } catch {
      this.notice("That artifact is no longer available.");
    }
  }

  private async postArtifact(chatId: string, event: ProtocolEvent): Promise<void> {
    if (!event.path || !path.isAbsolute(event.path)) return;
    const file = path.normalize(event.path);
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return;
      let dataUrl: string | undefined;
      if (event.mediaType?.startsWith("image/") && stat.size <= 20 * 1024 * 1024) {
        const bytes = await fs.promises.readFile(file);
        dataUrl = `data:${event.mediaType};base64,${bytes.toString("base64")}`;
      }
      this.postToChat(chatId, {
        type: "artifact",
        name: event.name || path.basename(file),
        path: file,
        mediaType: event.mediaType,
        dataUrl,
      });
    } catch {
      this.notice(
        `Generated artifact is no longer available: ${event.name || path.basename(file)}`,
        chatId,
      );
    }
  }

  private removeAttachment(value: string, chatId = this.activeChatId): void {
    if (!path.isAbsolute(value)) return;
    const file = path.normalize(value);
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    chat.attachments = chat.attachments.filter((attachment) => attachment !== file);
    chat.attachmentPreviews.delete(file);
    if (chatId === this.activeChatId) {
      this.attachments = [...chat.attachments];
      this.attachmentPreviews = new Map(chat.attachmentPreviews);
    }
    this.postAttachments(chatId);
  }

  private async slash(input: string, chatId = this.activeChatId): Promise<void> {
    const [command, ...parts] = input.split(/\s+/);
    const argument = parts.join(" ");
    const chat = this.sidebarChats.get(chatId);
    const commands: Record<string, string[]> = {
      "/status": ["session", ...(chat?.session ? [chat.session.sessionId] : [])],
      "/sessions": ["sessions"],
      "/models": ["models"],
      "/account": ["account"],
      "/usage": ["usage", ...parts],
      "/logs": ["logs"],
      "/doctor": ["doctor"],
    };
    if (command === "/help") return this.postToChat(chatId, { type: "help" });
    if (command === "/clear") return this.postToChat(chatId, { type: "clear" });
    if (command === "/attach") return this.pickAttachments(chatId);
    if (command === "/new") return this.newTab();
    if (command === "/exit" || command === "/quit")
      return this.notice(
        "The sidebar stays available. Start a new chat whenever you like.",
        chatId,
      );
    if (["/mode", "/agent", "/tier", "/log"].includes(command))
      return this.notice("Routing preferences are managed in VS Code Settings.", chatId);
    if (command === "/setup") return this.openAiroTerminal(["setup"], "AIRO Setup");
    if (command === "/sync") return this.sync(parts, chatId);
    if (command === "/jev") return this.jev(parts, chatId);
    if (command === "/history") return this.portableHistory(parts, chatId);
    if (command === "/repository") return this.repository(parts, chatId);
    if (command === "/no-jev") {
      if (!argument)
        return this.notice("Usage: /no-jev <task> runs one task without Jev feedback.", chatId);
      return this.prompt(argument, chatId, true);
    }
    if (command === "/feedback") {
      if (parts[0]?.toLowerCase() === "jev") return this.jev(parts.slice(1), chatId);
      if (!/^(?:good|bad)(?:\s|$)|^phase\s+\S+\s+(?:good|bad)(?:\s|$)/.test(argument))
        return this.notice(
          "Usage: /feedback good|bad [note] or /feedback phase <id> good|bad [note]",
          chatId,
        );
      await this.run(["feedback", ...parts], true, "Feedback", chatId);
      return;
    }
    if (command === "/learning") {
      await this.run(["learning", ...parts], true, "Learning", chatId);
      return;
    }
    if (commands[command]) {
      await this.run(
        command === "/sessions" ? ["sessions", "--limit", "5"] : commands[command],
        true,
        command.slice(1),
        chatId,
      );
      return;
    }
    this.notice(`Unknown command: ${command}. Type /help for available commands.`, chatId);
  }

  private async action(action: string, text?: string, chatId = this.activeChatId): Promise<void> {
    if (action === "githubAuth") {
      const terminal = vscode.window.createTerminal("GitHub Login");
      terminal.show();
      terminal.sendText("gh auth login -h github.com -p https -w");
      void vscode.window.showInformationMessage(
        "Complete GitHub sign-in in the terminal, then return to AIRO and send “retry” in the reply box.",
      );
      return;
    }
    if (action === "settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:pablospaniard.airo-vscode",
      );
      return;
    }
    if (action === "new") return this.newTab();
    if (action === "history") return this.showHistory();
    if (action === "sync") return this.sync([], chatId);
    if (action === "stop") return this.stop(chatId);
    if (action === "feedback") {
      await this.run(["feedback", text === "bad" ? "bad" : "good"], true, "Feedback", chatId);
      return;
    }
    const commands: Record<string, string[]> = {
      models: ["models"],
      account: ["account"],
      usage: ["usage"],
      logs: ["logs"],
      doctor: ["doctor"],
    };
    if (commands[action]) await this.run(commands[action], true, action, chatId);
  }

  private async sync(parts: string[], chatId: string): Promise<void> {
    const action = (parts[0] ?? "status").toLowerCase();
    const allowCredentialFile = parts.includes("--allow-credential-file");
    if (allowCredentialFile) {
      const approved = await this.confirm(
        "Allow credential file",
        "This stores the sync credential in a protected local file because the operating-system credential store is unavailable. Use it only on a trusted machine.",
      );
      if (!approved) return;
    }
    const credentialFlag = allowCredentialFile ? ["--allow-credential-file"] : [];
    if (["status", "now"].includes(action)) {
      await this.run(["sync", action, ...credentialFlag], true, `Sync ${action}`, chatId);
      return;
    }
    if (action === "login") {
      const loginArguments = parts.slice(1).filter((part) => part !== "--allow-credential-file");
      if (loginArguments.length > 1) return this.notice("Usage: /sync login [server]", chatId);
      const server = loginArguments[0];
      const serverError = server ? validateServerUrl(server) : undefined;
      if (serverError) return this.notice(serverError, chatId);
      await this.run(
        ["sync", "login", ...(server ? ["--server", server] : []), ...credentialFlag],
        true,
        "Sync login",
        chatId,
      );
      return;
    }
    if (action === "enable") {
      const passphrase = await this.askPassphrase(
        "Enable encrypted sync",
        "Enter your end-to-end encryption passphrase (12+ characters). It is sent only to the local AIRO process.",
        true,
      );
      if (!passphrase) return;
      await this.run(["sync", "enable", ...credentialFlag], true, "Enable sync", chatId, {
        environment: { AIRO_SYNC_PASSPHRASE: passphrase },
      });
      return;
    }
    if (action === "devices") {
      if (parts[1]?.toLowerCase() !== "revoke") {
        await this.run(["sync", "devices", ...credentialFlag], true, "Sync devices", chatId);
        return;
      }
      const deviceId = parts[2];
      if (!deviceId) return this.notice("Usage: /sync devices revoke <device-id>", chatId);
      const approved = await this.confirm(
        "Revoke device",
        `Revoke sync access for device ${deviceId}?`,
      );
      if (!approved) return;
      await this.run(
        ["sync", "devices", "revoke", deviceId, ...credentialFlag],
        true,
        "Revoke sync device",
        chatId,
      );
      return;
    }
    if (action === "export") {
      const target = await vscode.window.showSaveDialog({
        title: "Export encrypted sync data",
        saveLabel: "Export",
        filters: { "AIRO encrypted export": ["airo-sync"] },
      });
      if (!target) return;
      await this.run(
        ["sync", "export", target.fsPath, "--force", ...credentialFlag],
        true,
        "Export sync data",
        chatId,
      );
      return;
    }
    if (action === "logout") {
      if (!(await this.confirm("Log out", "Remove this machine's local sync credentials?"))) return;
      await this.run(["sync", "logout", ...credentialFlag], true, "Sync logout", chatId);
      return;
    }
    if (action === "delete-cloud-data") {
      if (
        !(await this.confirm(
          "Delete cloud data",
          "Permanently delete your encrypted settings and learning data from the sync service? This cannot be undone.",
        ))
      )
        return;
      await this.run(
        ["sync", "delete-cloud-data", "--yes", ...credentialFlag],
        true,
        "Delete cloud sync data",
        chatId,
      );
      return;
    }
    this.notice(
      "Usage: /sync status|login [server]|enable|now|devices|devices revoke <id>|export|logout|delete-cloud-data",
      chatId,
    );
  }

  private async jev(parts: string[], chatId: string): Promise<void> {
    const action = (parts[0] ?? "status").toLowerCase();
    if (action === "status" || action === "disable") {
      if (
        action === "disable" &&
        !(await this.confirm("Disable Jev", "Disable optional Jev feedback for future runs?"))
      )
        return;
      await this.run(["feedback", "jev", action], true, `Jev ${action}`, chatId);
      return;
    }
    if (action === "enable") {
      const approved = await this.confirm(
        "Enable Jev feedback",
        "AIRO sends task text, phase/task features, selected route identifiers, and bucketed outcomes to TypeSafe Jev after a run. It does not send source files, diffs, provider output, repository paths or remotes, credentials, environment variables, feedback notes, or session transcripts. TYPESAFE_API_KEY remains in your environment. Jev feedback is stored locally and can only make bounded adjustments to unpinned automatic routes.",
      );
      if (!approved) return;
      await this.run(
        ["feedback", "jev", "enable", "--accept-data-sharing"],
        true,
        "Enable Jev feedback",
        chatId,
      );
      return;
    }
    if (action === "inspect") {
      const limit = parts[1];
      if (limit && !/^\d+$/.test(limit)) return this.notice("Usage: /jev inspect [limit]", chatId);
      await this.run(
        ["feedback", "jev", "inspect", ...(limit ? ["--limit", limit] : [])],
        true,
        "Inspect Jev feedback",
        chatId,
      );
      return;
    }
    if (action === "reset") {
      if (
        !(await this.confirm(
          "Reset Jev feedback",
          "Delete the locally stored Jev feedback records? Existing routing history is preserved.",
        ))
      )
        return;
      await this.run(["feedback", "jev", "reset", "--yes"], true, "Reset Jev feedback", chatId);
      return;
    }
    this.notice("Usage: /jev status|enable|disable|inspect [limit]|reset", chatId);
  }

  private async portableHistory(parts: string[], chatId: string): Promise<void> {
    const action = parts[0]?.toLowerCase();
    if (!action || /^\d+$/.test(action)) {
      await this.run(["history", ...(action ? [action] : [])], true, "History", chatId);
      return;
    }
    if (action !== "export" && action !== "import") {
      this.notice("Usage: /history [limit] or /history export|import", chatId);
      return;
    }
    const target =
      action === "export"
        ? await vscode.window.showSaveDialog({
            title: "Export encrypted AIRO history",
            saveLabel: "Export",
            filters: { "AIRO encrypted archive": ["airo"] },
          })
        : (
            await vscode.window.showOpenDialog({
              title: "Import encrypted AIRO history",
              canSelectMany: false,
              canSelectFiles: true,
              canSelectFolders: false,
              filters: { "AIRO encrypted archive": ["airo"] },
            })
          )?.[0];
    if (!target) return;
    const passphrase = await this.askPassphrase(
      `${action === "export" ? "Export" : "Import"} encrypted history`,
      "Enter the archive passphrase (12+ characters). It is sent only to the local AIRO process.",
      action === "export",
    );
    if (!passphrase) return;
    await this.run(
      [
        "history",
        action,
        ...(action === "export" ? ["--encrypted"] : []),
        target.fsPath,
        ...(action === "export" ? ["--force"] : []),
      ],
      true,
      `${action === "export" ? "Export" : "Import"} history`,
      chatId,
      { environment: { AIRO_ARCHIVE_PASSPHRASE: passphrase } },
    );
  }

  private async repository(parts: string[], chatId: string): Promise<void> {
    const action = (parts[0] ?? "id").toLowerCase();
    if (action === "id") {
      await this.run(["repository", "id"], true, "Repository identity", chatId);
      return;
    }
    if (action !== "link" || !parts[1]) {
      this.notice("Usage: /repository id or /repository link <repository-id>", chatId);
      return;
    }
    if (
      !(await this.confirm(
        "Link repository",
        `Link this workspace's learning history to repository ID ${parts[1]}?`,
      ))
    )
      return;
    await this.run(["repository", "link", parts[1]], true, "Link repository history", chatId);
  }

  private async askPassphrase(
    title: string,
    prompt: string,
    confirmEntry = false,
  ): Promise<string | undefined> {
    const passphrase = await vscode.window.showInputBox({
      title,
      prompt,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.length >= 12 ? undefined : "Passphrase must contain at least 12 characters.",
    });
    if (!passphrase || !confirmEntry) return passphrase;
    const confirmation = await vscode.window.showInputBox({
      title: `${title} — confirm passphrase`,
      prompt: "Enter the same passphrase again.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value === passphrase ? undefined : "Passphrases do not match."),
    });
    return confirmation === passphrase ? passphrase : undefined;
  }

  private async confirm(action: string, detail: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(detail, { modal: true }, action)) === action;
  }

  private openAiroTerminal(args: string[], name: string): void {
    const terminal = vscode.window.createTerminal({
      name,
      shellPath: airoCommand(),
      shellArgs: args,
    });
    terminal.show();
  }

  private stop(chatId = this.activeChatId): void {
    const chat = this.sidebarChats.get(chatId);
    if (!chat?.running || !chat.child || chat.stopping) return;
    chat.stopping = chat.child.kill();
    this.postState(chat.id);
    if (!chat.stopping) this.notice("AIRO could not stop the current run.");
  }

  private async pickAttachments(chatId = this.activeChatId): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
    });
    if (!files?.length) return;
    await this.addAttachments(
      files.map((file: vscode.Uri) => file.fsPath),
      chatId,
    );
  }

  private async addAttachments(files: string[], chatId = this.activeChatId): Promise<void> {
    const candidates = files.flatMap((file) => {
      if (typeof file !== "string") return [];
      if (path.isAbsolute(file)) return [path.normalize(file)];
      try {
        const uri = vscode.Uri.parse(file, true);
        return uri.scheme === "file" || uri.scheme === "vscode-remote" ? [uri.fsPath] : [];
      } catch {
        return [];
      }
    });
    const valid = new Set<string>();
    let invalidCount = 0;
    for (const file of candidates) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file));
        if (stat.type & vscode.FileType.Directory) invalidCount += 1;
        else valid.add(path.normalize(file));
      } catch {
        // Ignore stale or malformed resources supplied by a drop event.
        invalidCount += 1;
      }
    }
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    const attachments = chatId === this.activeChatId ? this.attachments : chat.attachments;
    const updated = [...new Set([...attachments, ...valid])];
    for (const file of updated) {
      if (!chat.attachmentPreviews.has(file)) {
        const preview = await this.imagePreviewFor(file);
        if (preview) chat.attachmentPreviews.set(file, preview);
      }
    }
    chat.attachments = updated;
    if (chatId === this.activeChatId) {
      this.attachments = updated;
      this.attachmentPreviews = new Map(chat.attachmentPreviews);
    }
    this.postAttachments(chatId);
    if (invalidCount) {
      this.notice(
        "Some dropped items could not be attached because they are not local files.",
        chatId,
      );
    }
  }

  private async imagePreviewFor(file: string): Promise<string | undefined> {
    const mimeTypes: Record<string, string> = {
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    };
    const mimeType = mimeTypes[path.extname(file).toLowerCase()];
    if (!mimeType) return undefined;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file));
      if (stat.size > 5 * 1024 * 1024) return undefined;
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  private async addClipboardImage(
    dataUrl: string,
    name = `screenshot-${Date.now()}.png`,
    chatId = this.activeChatId,
  ): Promise<void> {
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match)
      return this.notice("Only PNG, JPEG, WebP, and GIF clipboard images are supported.", chatId);
    let file: string;
    try {
      const tempDir = path.join(os.tmpdir(), "airo-attachments");
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(tempDir));
      const extension = match[1] === "jpeg" ? "jpg" : match[1];
      file = path.join(
        tempDir,
        `${path.parse(name).name || "screenshot"}-${Date.now()}.${extension}`,
      );
      await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(match[2], "base64"));
    } catch {
      return this.notice("The clipboard image could not be saved as an attachment.", chatId);
    }
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    chat.attachments = [...chat.attachments, file];
    chat.attachmentPreviews.set(file, dataUrl);
    if (chatId === this.activeChatId) {
      this.attachments = [...chat.attachments];
      this.attachmentPreviews = new Map(chat.attachmentPreviews);
    }
    this.postAttachments(chatId);
  }

  private previewsFor(attachments: string[], previews: Map<string, string>): AttachmentPreview[] {
    return attachments.flatMap((file) => {
      const dataUrl = previews.get(file);
      return dataUrl ? [{ name: path.basename(file), path: file, dataUrl }] : [];
    });
  }

  private postAttachments(chatId = this.activeChatId): void {
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    const attachments = chatId === this.activeChatId ? this.attachments : chat.attachments;
    const previews =
      chatId === this.activeChatId ? this.attachmentPreviews : chat.attachmentPreviews;
    this.postToChat(chatId, {
      type: "attachments",
      files: attachments.map((file) => path.basename(file)),
      items: attachments.map((file) => ({ name: path.basename(file), path: file })),
      previews: this.previewsFor(attachments, previews),
    });
  }

  private taskArgs(
    task: string,
    chat = this.sidebarChats.get(this.activeChatId),
    forceNoJev = false,
  ): string[] {
    const config = vscode.workspace.getConfiguration("airo");
    const mode = config.get<string>("mode", "auto");
    const agent = config.get<string>("agent", "auto");
    const tier = config.get<string>("tier", "auto");
    const log = config.get<string>("logLevel", "live");
    const jevFeedback = config.get<string>("jevFeedback", "inherit");
    const args = chat?.session
      ? ["--session", chat.session.sessionId]
      : chat?.activeSession
        ? ["--continue"]
        : [];
    if (mode === "adaptive") args.push("--adaptive");
    else if (mode === "single") args.push("--single");
    if (agent !== "auto") args.push("--prefer-agent", agent);
    if (tier !== "auto") args.push("--prefer-tier", tier);
    if (forceNoJev || jevFeedback === "disabled") args.push("--no-jev");
    return [...args, "--log", log, task];
  }

  protected run(
    args: string[],
    showOutput: boolean,
    label = args.join(" "),
    chatId = this.activeChatId,
    options: RunOptions = {},
  ): Promise<{ code: number | null; output: string; started: boolean }> {
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return Promise.resolve({ code: null, output: "", started: false });
    if (chat.running) {
      return Promise.resolve({ code: null, output: "", started: false });
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.notice("Open a workspace folder before starting AIRO.");
      return Promise.resolve({ code: null, output: "", started: false });
    }
    if (showOutput) this.postToChat(chatId, { type: "start", label });
    chat.running = true;
    chat.stopping = false;
    chat.awaitingInput = false;
    this.postAllStates();
    return loginShellEnvironment().then(
      (environment) =>
        new Promise((resolve) => {
          let output = "";
          let humanOutput = "";
          let stdoutBuffer = "";
          let stderrBuffer = "";
          let hasFinal = false;
          const pendingArtifacts: Promise<void>[] = [];
          let started = false;
          let child: ChildProcessWithoutNullStreams;
          try {
            child = spawn(airoCommand(), args, {
              cwd: folder.uri.fsPath,
              shell: false,
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...environment,
                ...options.environment,
                NO_COLOR: "1",
                AIRO_STREAM_PROTOCOL: "1",
              },
            });
            chat.child = child;
            started = true;
          } catch (error) {
            chat.running = false;
            this.postAllStates();
            this.notice(`Could not start AIRO: ${String(error)}`, chatId);
            return resolve({ code: null, output, started });
          }

          const handleProtocol = (event: ProtocolEvent): void => {
            if (event.type === "route" && event.provider && event.model && event.tier) {
              if (event.sessionId && !chat.session) {
                chat.session = {
                  sessionId: event.sessionId,
                  description: chat.title,
                  updatedAt: new Date().toISOString(),
                  turnCount: 0,
                };
                chat.activeSession = true;
                if (chatId === this.activeChatId) {
                  this.session = chat.session;
                  this.activeSession = true;
                }
              }
              this.postToChat(chatId, {
                type: "route",
                provider: event.provider,
                model: event.model,
                tier: event.tier,
                // Present only on a mid-run handover, so the transcript can
                // explain why the provider in the header just changed.
                reason: event.reason,
              });
            } else if ((event.type === "input" || event.type === "permission") && event.question) {
              chat.awaitingInput = true;
              this.postToChat(chatId, {
                type: event.type === "permission" ? "permission" : "interaction",
                text: event.question,
              });
              this.postState(chatId);
            } else if (event.type === "phase" && event.kind && event.state) {
              this.postToChat(chatId, {
                type: "phase",
                state: event.state,
                kind: event.kind,
                title: event.title,
                provider: event.provider,
                model: event.model,
                tier: event.tier,
                phaseIndex: event.phaseIndex,
                phaseTotal: event.phaseTotal,
              });
            } else if (event.type === "final" && event.text) {
              hasFinal = true;
              this.postToChat(chatId, { type: "final", text: event.text });
            } else if (event.type === "failure" && event.text) {
              hasFinal = true;
              this.postToChat(chatId, { type: "failure", text: event.text });
            } else if (event.type === "artifact" && event.path) {
              pendingArtifacts.push(this.postArtifact(chatId, event));
            }
          };
          const handleLine = (line: string, newline: boolean): void => {
            if (line.startsWith("AIRO_EVENT ")) {
              try {
                handleProtocol(JSON.parse(line.slice("AIRO_EVENT ".length)) as ProtocolEvent);
                return;
              } catch {
                // Treat a malformed protocol line as ordinary diagnostic output.
              }
            }
            const text = line + (newline ? "\n" : "");
            humanOutput += text;
            if (showOutput) this.postToChat(chatId, { type: "activity", text });
          };
          const write = (data: Buffer, stream: "stdout" | "stderr"): void => {
            const text = data.toString();
            output += text;
            const buffered = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + text;
            const lines = buffered.split("\n");
            if (stream === "stdout") stdoutBuffer = lines.pop() ?? "";
            else stderrBuffer = lines.pop() ?? "";
            for (const line of lines) handleLine(line, true);
          };
          child.stdout.on("data", (data: Buffer) => write(data, "stdout"));
          child.stderr.on("data", (data: Buffer) => write(data, "stderr"));
          child.on("error", (error) =>
            this.notice(`Could not start AIRO: ${error.message}`, chatId),
          );
          child.on("close", async (code) => {
            const stopped = chat.stopping;
            if (stdoutBuffer) handleLine(stdoutBuffer, false);
            if (stderrBuffer) handleLine(stderrBuffer, false);
            chat.child = undefined;
            chat.running = false;
            chat.stopping = false;
            chat.awaitingInput = false;
            await Promise.allSettled(pendingArtifacts);
            this.postAllStates();
            if (!stopped && showOutput && !hasFinal && humanOutput.trim()) {
              this.postToChat(chatId, {
                type:
                  code === 0
                    ? options.outputFormat === "markdown"
                      ? "final"
                      : "command"
                    : "failure",
                text: this.plainText(humanOutput).trim(),
              });
            }
            if (showOutput) this.postToChat(chatId, { type: "end", code, stopped });
            resolve({ code, output, started });
          });
        }),
    );
  }

  private configuredRoute(): RouteStatus {
    const config = vscode.workspace.getConfiguration("airo");
    const provider = config.get<string>("agent", "auto");
    return {
      provider: provider === "auto" ? "Auto" : provider,
      model: "Routing",
      tier: config.get<string>("tier", "auto"),
    };
  }

  private createChatState(session?: SessionSummary): SidebarChat {
    return {
      id: session?.sessionId ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: session ? chatTitle(session.description) : "New chat",
      session,
      activeSession: Boolean(session),
      attachments: [],
      attachmentPreviews: new Map(),
      hydrated: false,
      running: false,
      stopping: false,
      awaitingInput: false,
    };
  }

  private saveActiveChat(): void {
    const chat = this.sidebarChats.get(this.activeChatId);
    if (!chat) return;
    chat.session = this.session;
    chat.activeSession = this.activeSession;
    chat.attachments = [...this.attachments];
    chat.attachmentPreviews = new Map(this.attachmentPreviews);
    if (this.session && chat.title === "New chat") {
      chat.title = chatTitle(this.session.description);
    }
    this.replaceDraftId(chat.id, chat);
  }

  private replaceDraftId(oldId: string, chat: SidebarChat): void {
    if (!chat.session || !chat.id.startsWith("draft-") || chat.running) return;
    this.sidebarChats.delete(oldId);
    chat.id = chat.session.sessionId;
    if (this.activeChatId === oldId) this.activeChatId = chat.id;
    this.sidebarChats.set(chat.id, chat);
    this.post({ type: "replaceTabId", oldId, newId: chat.id });
    this.postTabs();
  }

  private loadChat(chat: SidebarChat): void {
    this.activeChatId = chat.id;
    this.session = chat.session;
    this.activeSession = chat.activeSession;
    this.attachments = [...chat.attachments];
    this.attachmentPreviews = new Map(chat.attachmentPreviews);
  }

  private async newTab(): Promise<void> {
    this.saveActiveChat();
    const chat = this.createChatState();
    this.sidebarChats.set(chat.id, chat);
    this.loadChat(chat);
    this.postTabs();
    this.post({ type: "activateTab", chatId: chat.id });
    this.post({ type: "session", value: "New chat — send a task to begin" });
    this.postAttachments();
    this.post({ type: "route", ...this.configuredRoute() });
    this.postState();
  }

  private switchTab(chatId: string): void {
    if (chatId === this.activeChatId) return;
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    this.saveActiveChat();
    this.activateChat(chat);
  }

  private closeTab(chatId: string): void {
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    if (chat.running) {
      this.notice("Stop the current run before closing this chat.");
      return;
    }

    const chatIds = [...this.sidebarChats.keys()];
    const closedIndex = chatIds.indexOf(chatId);
    this.sidebarChats.delete(chatId);
    this.post({ type: "removeTab", chatId });

    if (chatId !== this.activeChatId) {
      this.postTabs();
      return;
    }

    const nextId = chatIds[closedIndex + 1] ?? chatIds[closedIndex - 1];
    const nextChat = nextId ? this.sidebarChats.get(nextId) : this.createChatState();
    if (!nextChat) return;
    if (!nextId) this.sidebarChats.set(nextChat.id, nextChat);
    this.loadChat(nextChat);
    this.postTabs();
    this.activateChat(nextChat);
  }

  private activateChat(chat: SidebarChat): void {
    this.loadChat(chat);
    this.post({ type: "activateTab", chatId: chat.id });
    this.post({
      type: "session",
      value: chat.session
        ? `Chat — ${chatTitle(chat.session.description)}`
        : "New chat — send a task to begin",
    });
    this.postAttachments(chat.id);
    this.post({ type: "route", ...this.configuredRoute() });
    this.postState();
  }

  private async showHistory(): Promise<void> {
    const sessions = await listSessionSummaries();
    this.post({
      type: "history",
      sessions: sessions.map((session) => ({
        ...session,
        description: chatTitle(session.description),
        open: [...this.sidebarChats.values()].some(
          (chat) => chat.session?.sessionId === session.sessionId,
        ),
      })),
    });
  }

  private async openSessionTab(sessionId: string): Promise<void> {
    this.saveActiveChat();
    const existing = [...this.sidebarChats.values()].find(
      (chat) => chat.session?.sessionId === sessionId,
    );
    if (existing) {
      this.activateChat(existing);
      this.postTabs();
      await this.hydrateChat(existing);
      return;
    }
    const session = (await listSessionSummaries()).find((item) => item.sessionId === sessionId);
    if (!session) return this.notice("That chat is no longer available.");
    const chat = this.createChatState(session);
    this.sidebarChats.set(chat.id, chat);
    this.activateChat(chat);
    this.postTabs();
    await this.hydrateChat(chat);
  }

  private async hydrateChat(chat: SidebarChat): Promise<void> {
    if (chat.hydrated || !chat.session) return;
    const result = await runCommand(["session", chat.session.sessionId, "--json"]);
    try {
      const transcript = JSON.parse(result.output) as SessionTranscript;
      if (!transcript || !Array.isArray(transcript.turns)) return;
      this.postToChat(chat.id, { type: "restore", turns: transcript.turns });
      chat.hydrated = true;
    } catch {
      this.notice("AIRO could not restore this chat's saved transcript.", chat.id);
    }
  }

  private postTabs(): void {
    this.post({
      type: "tabs",
      activeChatId: this.activeChatId,
      tabs: [...this.sidebarChats.values()].map((chat) => ({ id: chat.id, title: chat.title })),
    });
  }

  private plainText(value: string): string {
    return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  }

  private postState(chatId = this.activeChatId): void {
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    this.postToChat(chatId, {
      type: "state",
      busy: chat.running,
      running: chat.running,
      stopping: chat.stopping,
      awaitingInput: chat.awaitingInput,
    });
  }

  private postAllStates(): void {
    for (const chatId of this.sidebarChats.keys()) this.postState(chatId);
  }

  private notice(value: string, chatId = this.activeChatId): void {
    this.postToChat(chatId, { type: "notice", value });
  }

  private postToChat(chatId: string, message: Record<string, unknown>): void {
    this.post({ ...message, chatId });
  }

  protected post(message: Record<string, unknown>): void {
    const webview = this.view?.webview;
    if (webview) void webview.postMessage(message);
  }
}

function shortDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 64) || "Untitled chat";
}

function chatTitle(value: string): string {
  const title = shortDescription(value);
  return /^(?:new session|airo sidebar session)$/i.test(title) ? "New chat" : title;
}

function validateServerUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return undefined;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
      return undefined;
  } catch {
    // Return the same actionable validation message for malformed URLs.
  }
  return "Use an HTTPS URL (HTTP is allowed only for localhost development).";
}

function listSessionSummaries(): Promise<SessionSummary[]> {
  return runCommand(["sessions", "--json"]).then((result) => {
    try {
      const sessions = JSON.parse(result.output) as SessionSummary[];
      return Array.isArray(sessions) ? sessions : [];
    } catch {
      return [];
    }
  });
}

async function runCommand(args: string[]): Promise<{ code: number | null; output: string }> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return { code: null, output: "[]" };
  const environment = await loginShellEnvironment();
  return new Promise((resolve) => {
    const child = spawn(airoCommand(), args, {
      cwd: folder.uri.fsPath,
      shell: false,
      windowsHide: true,
      env: { ...environment, NO_COLOR: "1" },
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.on("error", () => resolve({ code: null, output: "[]" }));
    child.on("close", (code) => resolve({ code, output }));
  });
}
