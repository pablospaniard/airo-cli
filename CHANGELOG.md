# Changelog

## Unreleased

- Preserve refresh-token families across rotation so reuse revokes every descendant session.
- Keep refreshed credentials when enabling sync and keep repository overrides out of account-wide synchronized settings.
- Preserve legacy pinned model configurations by treating a missing `modelRouting` field as manual mode.
- Replace 32-bit history IDs with 128-bit IDs and add versioned, kind-scoped sync events so changed records converge without permanent cursor conflicts.
- Keep macOS Keychain credential values out of process arguments.
- Bind GitHub identity exchange to AIRO's OAuth application using GitHub's pinned token-check API and a Worker secret.
- Continue automatic fallback through all eligible installed providers.
