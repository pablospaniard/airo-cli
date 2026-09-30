# Privacy

AIRO is local-first. Core routing, configuration, sessions, logs, history, feedback, and learned routing evidence are stored on the user's machine.

## Provider CLIs

AIRO invokes the provider CLI selected for a task. That provider receives the task and any local files or context the user chooses to make available. The provider's own account, privacy policy, data controls, and retention rules apply.

AIRO does not proxy provider traffic or collect provider credentials.

## Optional Jev feedback

Jev feedback is disabled by default and requires explicit consent. When enabled, AIRO sends task text and a bounded post-run evaluation payload to TypeSafe using a user-supplied API key.

AIRO excludes source files, diffs, provider output, repository metadata and paths, credentials, environment variables, feedback notes, and session transcripts as separate fields. Task text can itself contain sensitive information, so users should use `--no-jev` for work that must remain local.

Consent can be inspected, disabled, or renewed, and locally stored Jev evidence can be deleted:

```bash
airo feedback jev status
airo feedback jev disable
airo feedback jev reset --yes
```

TypeSafe processes submitted data under its own privacy and retention policies.

## Optional encrypted sync

Encrypted sync is disabled by default, requires an explicitly configured self-hosted service, and runs only when the user requests it.

Private records and classified settings are encrypted on the client before upload. The sync service can observe GitHub account identity, device metadata, keyed repository identifiers, cursors, request metadata, and encrypted envelopes. It cannot decrypt the synchronized records.

Provider credentials, API keys, executable paths, permission settings, Jev consent, and recovery passphrases are never synchronized.

The operator of a self-hosted sync service controls its infrastructure, logs, region, backups, and retention. Operators should document those choices for their users and must not log request bodies, authorization headers, GitHub tokens, or encrypted envelopes.

Users can export or delete their server-side account data:

```bash
airo sync export <file>
airo sync delete-cloud-data --yes
```

## Local deletion

Local AIRO data is stored under `~/.config/airo/` and `~/.local/share/airo/` by default. Individual CLI commands can reset learning or Jev evidence. Removing local files does not delete data held by a provider, TypeSafe, or a separately operated sync service.

## Research use

AIRO 1.0 does not submit local history or synchronized data for AIRO research or global policy training. Any future research program requires a separate implementation and explicit consent.
