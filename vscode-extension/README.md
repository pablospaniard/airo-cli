# AIRO for VS Code

AIRO brings the AIRO CLI into a stateful chat in the VS Code secondary sidebar.
It can continue the active repository chat, stream progress, attach local files,
and expose AIRO's routing, diagnostics, usage, logs, and feedback commands.

## Requirements

- VS Code 1.106 or newer
- Node.js 22 or newer
- The [`airo-ai-router`](https://www.npmjs.com/package/airo-ai-router) npm package installed globally, with its `airo` CLI available on `PATH`, or an absolute path configured
  in **AIRO: Command**
- At least one configured and signed-in provider CLI (Claude Code, Codex CLI, Gemini CLI, or GitHub Copilot CLI); AIRO verifies Claude and Codex sign-in and reports the other authentication states as `not inspected`

Open the AIRO view from the secondary sidebar. Use the extension settings to
choose routing mode, provider, tier, output detail, and the CLI executable.

Attach files with the paperclip or drag them from the VS Code Explorer onto the
native **Attach Files** drop target. VS Code requires holding Shift when
dropping Explorer files directly onto any webview, so Shift-dragging onto the
chat composer also works. Paste a screenshot from the clipboard to attach it
directly; sent messages show every attachment name and a thumbnail for pasted
images.

Use the `+` tab in the sidebar to keep multiple AIRO chats open. Each tab keeps
its own rendered conversation, draft, attachments, and AIRO chat context.
Stop an active run before switching tabs so progress and permission requests
remain attached to the chat that started them.

The extension runs the CLI in the currently opened workspace; it does not upload
attached files or store provider credentials.

The extension uses the same local routing, history, and learning behavior as the
CLI. Use the sync button in the sidebar header, the **AIRO: Sync Now** and
**AIRO: Show Sync Status** commands, or `/sync` commands to manage encrypted
sync. Passphrases are collected with VS Code password prompts and passed only to
the local AIRO process through its environment. `/sync login` reuses the saved
server or `AIRO_SYNC_URL`; use `/sync login https://sync.example.com` to choose
a server explicitly.

Use `/jev` to inspect, enable, disable, or reset optional Jev feedback. Enabling
it displays the data-sharing disclosure and requires explicit confirmation.
`/no-jev <task>` disables Jev for one run, while **AIRO: Jev Feedback** can
disable it for every task started by the extension. Portable encrypted history
archives are available through `/history export|import`, repository identities
through `/repository`, and the interactive first-run flow through `/setup`.

These features require a matching development build of the AIRO CLI until a
newer npm package is published. Research consent remains unimplemented and is
documented separately in
[`docs/routing-platform-roadmap.md`](../docs/routing-platform-roadmap.md).
