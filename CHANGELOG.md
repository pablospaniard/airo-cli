# Changelog

## 1.0.2 - 2026-09-30

### Changed

- Use one provider-neutral catalog pipeline for dynamic model discovery across all supported providers.
- Discover all eligible models exposed by installed providers instead of filtering through hardcoded tiers.
- Preserve existing manual model configurations while allowing dynamic mode to use newly discovered models.

## 1.0.1 - 2026-09-30

### Fixed

- Fall back to the `airo` executable when the VS Code command setting is empty or whitespace.

## 1.0.0 - 2026-09-30

### Added

- Provider-neutral routing across Claude Code, Codex CLI, Gemini CLI, and GitHub Copilot CLI.
- Dynamic model discovery with reviewed `fast`, `balanced`, and `deep` fallbacks.
- Automatic, single-agent, and adaptive multi-phase workflows with recovery and review phases.
- Local routing history, explicit feedback, outcome evaluation, and bounded repository-scoped learning.
- Encrypted history export/import and stable repository identities for moving learning between machines.
- Optional, explicitly consented post-run Jev feedback with inspect, disable, reset, and per-run opt-out controls.
- Optional self-hosted, end-to-end encrypted multi-device sync with GitHub device authentication, device revocation, account export, and cloud-data deletion.
- A stateful VS Code sidebar with parallel chats, attachments, session history, routing controls, diagnostics, feedback, and sync controls.

### Changed

- `airo` is the primary command. `ai-router`, `airoute`, and `ai-route` remain compatibility aliases.
- Automatic fallback now considers every eligible installed provider while explicit provider or model selections remain pinned.
- Configuration and data use the `~/.config/airo/` and `~/.local/share/airo/` locations. Legacy AI Router paths are copied on first use and remain readable.
- Existing configurations without `modelRouting` retain their pinned model behavior by being interpreted as manual mode.

### Security and reliability

- Preserve refresh-token families across rotation so reuse revokes every descendant session.
- Keep refreshed credentials when enabling sync and keep repository overrides out of account-wide synchronized settings.
- Preserve legacy pinned model configurations by treating a missing `modelRouting` field as manual mode.
- Replace 32-bit history IDs with 128-bit IDs and add versioned, kind-scoped sync events so changed records converge without permanent cursor conflicts.
- Keep macOS Keychain credential values out of process arguments.
- Bind GitHub identity exchange to AIRO's OAuth application using GitHub's pinned token-check API and a Worker secret.
- Bound encrypted sync requests and responses by serialized size, process pull pages incrementally, and propagate record deletions with tombstones.
- Make refresh rotation and settings revisions atomic under concurrent requests.
- Namespace sync cursors by service and account, and remember an explicitly selected credential-file backend.
- Continue automatic fallback through all eligible installed providers.
- Keep synchronized evidence on one canonical global path, lock local evidence merges, and avoid treating repository-specific views as deletions.
- Preserve account keys across same-account sign-in, serialize concurrent token refreshes, and retry rate-limited sync requests.
- Upload only changed evidence with durable per-transition versions so retries, deletion, restoration, and repeated deletion converge.
- Increase byte-bounded pull throughput, update manifests incrementally, and paginate cloud account exports.
- Require a provider failure exit before interpreting rate-limit wording as an automatic-fallback signal.
