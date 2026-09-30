# AIRO for VS Code

AIRO brings the local AIRO router into a stateful VS Code sidebar. It supports streamed multi-phase work, parallel chats, attachments, session history, model controls, logs, diagnostics, feedback, and encrypted sync.

## Requirements

- VS Code 1.106 or newer
- Node.js 22 or newer
- The `airo-ai-router` npm package (version 1.0.3 or newer) installed globally
- At least one installed and signed-in provider CLI: Claude Code, Codex CLI, Gemini CLI, or GitHub Copilot CLI

```bash
npm install --global airo-ai-router
airo doctor
```

If VS Code cannot find `airo`, open extension settings and set **AIRO: Command** to the executable's absolute path.

## Get started

1. Open the AIRO view in the secondary sidebar.
2. Enter a task in the composer.
3. Review any permission or clarification request in the same chat.
4. Use **New chat** to start another conversation without losing previous sessions.

Choose `auto`, `adaptive`, or `single` routing and optionally select a provider or model tier from the sidebar controls.

## Attachments

Use the paperclip, paste a screenshot, or drag files onto the **Attach Files** view. VS Code requires holding Shift when dragging Explorer files directly onto a webview.

Attachments remain local. The extension passes their paths to the AIRO CLI and does not store provider credentials.

## Commands and settings

The Command Palette includes:

- **AIRO: Run Task**
- **AIRO: Open Previous Chats**
- **AIRO: Open Terminal**
- **AIRO: Open Settings**
- **AIRO: Show Sync Status**
- **AIRO: Sync Now**
- **AIRO: Show Jev Status**

Settings control the AIRO executable, workflow mode, provider, model tier, output detail, and whether sidebar tasks may use an already-consented Jev integration.

Use `/help` in the sidebar for session, history, learning, repository, Jev, and sync commands.

The extension uses the installed CLI's current model catalog and API-price data. Each CLI invocation attempts to refresh list prices; a local cache and bundled snapshot keep estimates available when offline.

## Optional features

Jev feedback remains disabled until enabled through its explicit consent flow. Use `/no-jev <task>` to disable it for one run.

Encrypted sync requires a deployed AIRO sync Worker. `/sync login <url>` selects the service; later commands reuse the saved URL or `AIRO_SYNC_URL`. Passphrases are collected with VS Code password prompts and passed only to the local CLI process.

## Build and package

From the repository root:

```bash
pnpm install
pnpm run package:extension
```

The resulting `.vsix` can be installed with **Extensions: Install from VSIX**.

## Privacy and security

The extension runs AIRO in the open workspace. Provider data handling follows the selected provider CLI. Optional Jev and sync behavior follows the repository's [Privacy](https://github.com/pablospaniard/airo-cli/blob/main/PRIVACY.md) and [Security](https://github.com/pablospaniard/airo-cli/blob/main/SECURITY.md) policies.
