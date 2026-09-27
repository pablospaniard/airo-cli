# Changelog

## Unreleased

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
