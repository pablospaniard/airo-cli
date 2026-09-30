<h1 align="center">AIRO</h1>

<p align="center">
  <img src="docs/airo-setup.png" alt="AIRO setup and provider discovery" width="960">
</p>

<p align="center">Adaptive Intelligence Routing &amp; Orchestration for coding-agent CLIs.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/airo-ai-router"><img src="https://img.shields.io/npm/v/airo-ai-router?logo=npm&label=npm" alt="npm version"></a>
  <a href="https://github.com/pablospaniard/airo-cli/actions/workflows/ci.yml"><img src="https://github.com/pablospaniard/airo-cli/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

AIRO accepts a task, selects an appropriate provider and model, and can coordinate multi-phase work across coding agents. It uses the provider CLIs and accounts already installed on your machine—no separate model API keys or proxy are required for core routing.

Supported providers:

- Claude Code
- Codex CLI
- Gemini CLI
- GitHub Copilot CLI

## Install

AIRO requires Node.js 22 or newer and at least one supported provider CLI that is installed and signed in.

```bash
npm install --global airo-ai-router
airo doctor
airo
```

On first launch, AIRO discovers available providers and models and asks you to review its execution permissions.

## Use AIRO

Run a task:

```bash
airo "review this pull request for regressions"
```

Continue the active repository session:

```bash
airo --continue "fix the critical issue you found"
```

Preview a route without starting a provider:

```bash
airo --dry-run --explain "migrate this module"
```

Pin a provider, tier, or model:

```bash
airo --agent codex --tier deep "investigate this race condition"
airo --agent claude --model sonnet "explain this failure"
```

Run `airo --help` for the complete command reference.

## How routing works

AIRO maps each task to a provider and one of three model tiers:

| Tier       | Intended use                                       |
| ---------- | -------------------------------------------------- |
| `fast`     | Small, mechanical, or low-risk work               |
| `balanced` | Normal implementation, testing, and investigation |
| `deep`     | Complex, ambiguous, or high-risk work             |

Three workflow modes are available:

- `auto` is the default. AIRO chooses a single run or a multi-phase workflow from the task.
- `single` runs one routed provider and model.
- `adaptive` plans and routes analysis, implementation, validation, review, and recovery phases independently.

```bash
airo --single "rename this interface"
airo --adaptive "investigate and fix this intermittent failure"
```

Explicit choices are authoritative. If you select a provider or model, AIRO reports a failure instead of silently substituting another one. Automatically selected providers may fall back to another eligible installed provider.

See [Routing rules and learning](docs/routing-and-learning.md) for routing precedence, model discovery, fallback, and learning details.

## Interactive workspace

Run `airo` without a task to open the terminal workspace. Useful commands include:

```text
/help
/mode auto|adaptive|single
/agent auto|claude|codex|gemini|copilot
/tier auto|fast|balanced|deep
/status
/models
/attach <file-path>
/feedback good|bad [note]
/sessions
/new [title]
/exit
```

Attachments remain local files. AIRO passes their paths to the selected provider and clears the attachment list after the next task.

## VS Code extension

The AIRO extension provides a stateful sidebar chat with parallel conversations, streamed phase progress, attachments, session history, routing controls, logs, diagnostics, feedback, and encrypted-sync controls.

The extension requires the `airo-ai-router` npm package because it invokes the local `airo` command. If VS Code cannot find it on `PATH`, set **AIRO: Command** to its absolute path.

To package the extension from this repository:

```bash
pnpm install
pnpm run package:extension
```

See [AIRO for VS Code](https://github.com/pablospaniard/airo-cli/tree/main/vscode-extension) for usage and configuration.

## Models and setup

AIRO discovers models exposed by each provider and maps them to the three tiers. If discovery is unavailable, it uses reviewed fallback profiles. Existing configurations created before dynamic routing retain their pinned mappings.

```bash
airo setup       # review permissions and provider setup
airo models      # refresh and show the active model mapping
airo account     # inspect provider availability and account state
airo doctor      # check integration, commands, models, and storage
```

Use `airo config init` to create `.airo.json` in the current repository. Project configuration overrides global configuration at `~/.config/airo/config.json`. The complete schema is shown in [airo.config.example.json](airo.config.example.json).

## History and learning

AIRO stores routing history and user feedback locally. Similar, time-decayed evidence can influence future automatic routes; explicit choices and custom rules always take precedence.

```bash
airo history 20
airo feedback good
airo feedback bad "used more reasoning than necessary"
airo learning status
airo learning explain <run-or-phase-id>
```

Move learning evidence between machines with an encrypted archive:

```bash
export AIRO_ARCHIVE_PASSPHRASE="a long passphrase"
airo history export --encrypted backup.airo
airo history import backup.airo
```

For automation, use `--passphrase-file <path>`. Archives contain task history and excerpts; protect both the archive and its passphrase.

## Optional Jev feedback

Jev feedback is disabled by default. When explicitly enabled, AIRO sends a bounded post-run evaluation payload to TypeSafe using your `TYPESAFE_API_KEY`. Task text leaves the machine; source files, diffs, provider output, repository paths, credentials, environment variables, feedback notes, and transcripts are excluded as separate fields.

```bash
airo feedback jev enable
export TYPESAFE_API_KEY="..."
airo "task"
airo --no-jev "sensitive task"
```

Use `airo feedback jev status|inspect|disable` to manage the feature and `airo feedback jev reset --yes` to remove its local evidence. Jev runs after the provider and cannot change the current run's result.

See [Jev and AIRO](docs/jev-and-airo.md) for the exact consent, payload, and learning boundaries.

## Optional encrypted sync

AIRO supports self-hosted, end-to-end encrypted synchronization through the repository's [sync Worker](https://github.com/pablospaniard/airo-cli/tree/main/sync-worker). Sync is disabled by default and never runs as part of a provider task. Deploy the Worker first, then give the CLI its HTTPS URL:

```bash
airo sync login --server https://your-airo-sync.example.com
export AIRO_SYNC_PASSPHRASE="a long recovery passphrase"
airo sync enable
airo sync now
airo sync status
```

Encryption and recovery-key handling happen locally. The service stores encrypted envelopes, keyed repository identifiers, device metadata, and GitHub account identity; it does not receive provider credentials, API keys, executable paths, permission settings, Jev consent, or the recovery passphrase.

Use `airo sync devices`, `airo sync devices revoke <device-id>`, `airo sync export <file>`, `airo sync logout`, and `airo sync delete-cloud-data --yes` to manage synchronized data. Losing the recovery passphrase and every device holding the account key makes that data unrecoverable.

Deployment and operating instructions are in the [sync Worker README](https://github.com/pablospaniard/airo-cli/blob/main/sync-worker/README.md).

## Permissions and privacy

AIRO runs provider CLIs as subprocesses in your working tree. In the default `prompt` permission mode, providers receive workspace edit access and AIRO asks before retrying an action with unrestricted system access. `fullAccess` removes those prompts and should only be used in trusted environments.

Core routing, history, and learning are local. Network data is sent only by the provider CLI you choose or by optional features you explicitly enable. See [Privacy](PRIVACY.md) and [Security](SECURITY.md) for the production data and reporting policies.

## Upgrade compatibility

AIRO 1.0 preserves existing configuration and history:

- Legacy `ai-router` configuration and data are copied to the AIRO locations on first use; the originals remain untouched.
- `.ai-router.json` project configuration remains supported.
- Configurations without `modelRouting` retain manual model mappings.
- Historical records without current schema or policy fields remain readable.
- `ai-router`, `airoute`, and `ai-route` remain command aliases; new documentation uses `airo`.

## Troubleshooting

| Problem                             | What to do                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A provider is unavailable           | Run `airo doctor`, install and sign in to its CLI, or configure its absolute command path.               |
| VS Code cannot start AIRO           | Install `airo-ai-router` globally and set **AIRO: Command** if `airo` is not on VS Code's `PATH`.      |
| A model is rejected                 | Run `airo models`, confirm availability, and pair `--model` with `--agent`.                            |
| Authentication cannot be inspected  | Gemini and Copilot may report `not inspected`; verify sign-in with the provider's CLI.                  |
| A command needs broader permissions | Approve the retry, adjust settings with `airo setup`, or deliberately select `fullAccess`.              |
| Sync login has no server            | Pass your deployed Worker URL with `--server` or set `AIRO_SYNC_URL`.                                  |

## Development

```bash
corepack enable
pnpm install
pnpm run validate
pnpm run build:sync-worker
```

`pnpm run validate` checks formatting, linting, TypeScript, CLI tests, coverage thresholds, and Worker integration tests. Generated CLI files under `dist/` are ignored. The VS Code extension's compiled `out/` files are committed for packaging.

See the [changelog](CHANGELOG.md) for release notes and the [routing platform roadmap](docs/routing-platform-roadmap.md) for completed foundations and future research work.

## License

MIT © Pavel Ivanov
