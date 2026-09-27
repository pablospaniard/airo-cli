# Routing platform roadmap

## Status

This document records the planned product and architecture direction for AIRO. It is a roadmap, not a description of functionality available in the current release.

The current published package is [`airo-ai-router`](https://www.npmjs.com/package/airo-ai-router). Current behavior is documented in [Routing rules and learning](routing-and-learning.md). None of the provider-registry, Jev-feedback, cloud-sync, or research-consent milestones below should be presented as released until their implementation, tests, security review, and user documentation are complete.

Development status: Milestone 1 is complete on the development branch. The source-controlled provider registry, generic fallback and candidate generation, provider-neutral task features, versioned cold-start policy, development evaluation corpus, exhaustive provider adapters, support audit, diagnostics, and acceptance evidence are implemented. This status does not present the work as published until it passes the release process. The Jev development evaluator is implemented as an initial Milestone 3 tool; calibration work remains optional and open.

## Architecture principles

1. AIRO remains a local-first router and orchestrator.
2. Developers explicitly decide which providers AIRO supports.
3. Once a provider is supported, model discovery, executable resolution, candidate generation, routing, fallback, and learning should be as generic and data-driven as practical.
4. Explicit user choices and safety constraints always outrank automatic learning.
5. Jev may help evaluate and improve AIRO decisions, but it is not required for core routing.
6. Optional production Jev feedback uses the user's own API key, requires informed consent, and remains local unless the user separately enables encrypted sync.
7. Cloud sync is optional, offline-first, and end-to-end encrypted for private user data.
8. Research participation is separate from private sync, disabled by default, and deferred to a later milestone.

## Provider support boundary

AIRO must not discover an arbitrary executable and claim it as a supported provider. A provider becomes supported only after a developer adds it to the source-controlled provider registry and completes the integration contract.

A provider adapter is expected to define:

- A stable provider identifier and display name
- Default command and command/path resolution behavior
- Authentication and account inspection
- Model discovery and configured fallback profiles
- Process invocation and permission behavior
- Progress, final-output, error, and usage parsing
- Provider-level failure classification
- Capability metadata used by generic routing
- Test fixtures and integration coverage
- Setup, troubleshooting, and release documentation

The current adapter contracts are compile-time exhaustive over the registered provider identifiers. Their acceptance test requires every provider to have default configuration, all three model tiers, invocation construction, progress parsing, provider-level failure classification, default-model detection, explicit account-inspection behavior, and a model-discovery strategy. Providers without a reliable authentication probe return an unknown authentication state rather than being treated as signed in or signed out. Invocation metadata records the prompt argument position so diagnostic logs redact task text consistently for every provider. Discovery adapters also own provider-specific cache context and optional gateway configuration, preventing a new provider from silently falling through another provider's discovery path.

Provider support contract version 1 is a machine-readable audit of ten integration surfaces: registry metadata, configuration, routing policy, runtime invocation and parsing, failure classification, account inspection, model discovery, capability metadata, tests, and documentation. Test and documentation evidence is an exhaustive source-controlled map, so registering another provider cannot silently inherit a support claim. `airo doctor` reports this integration status separately from whether the configured executable is installed on the current machine.

Support should not be announced until execution, permissions, authentication, models, usage reporting, fallback, and tests work together.

### Dynamic behavior after registration

For a registered provider, AIRO should dynamically:

- Discover available models from the provider CLI or API when supported
- Retain configured tier defaults when discovery is unavailable
- Resolve an explicit command path, the inherited `PATH`, and only reliable provider-specific locations
- Generate eligible provider/tier candidates from the registry
- Apply the same generic scoring and local-learning policy to every provider
- Consider every eligible provider during automatic fallback
- Keep explicit provider selections pinned

Executable discovery must remain deterministic. AIRO should not scan arbitrary filesystem locations or execute unknown binaries.

## Generic routing evolution

The first implementation uses provider-neutral task features rather than provider-specific keyword scoring. Current features include:

- Task category: investigation, implementation, validation, review, or research
- Risk: low, medium, or high
- Scope: localized, multi-file, cross-module, or architectural
- Uncertainty and reproduction difficulty
- Language and platform
- Workflow phase
- Verification requirements

Each supported provider supplies a reviewed cold-start capability profile. The generic policy generates every provider/tier candidate and scores it using task features, provider capabilities, tier suitability, shipped policy weights, and repository-local outcomes.

The target calculation is conceptually:

```text
task features
  x provider capabilities
  + tier suitability
  + shipped policy
  + repository-local evidence
  = expected route utility
```

The shipped policy is a versioned, deterministic artifact. Every route and newly written history record carries its policy version. A development-only reviewed fixture corpus enforces minimum provider, tier, and joint routing accuracy through `pnpm evaluate:routing-policy`. The artifact may be calibrated during development, including with Jev labels as supporting evidence, but changing it requires fixture evaluation and normal code review. A new provider still needs declared cold-start capabilities because AIRO cannot learn the quality of a provider it has never observed.

## Jev boundaries

TypeSafe Jev is an external decision model that returns typed choices, scores, probabilities, and confidence. AIRO should use it as an evaluator and feedback source rather than a required routing dependency. See [Jev and AIRO](jev-and-airo.md) for the detailed decision.

### Development use

An unpublished development tool may use Jev to:

- Label semantic task dimensions
- Review whether a selected route appears appropriate
- Identify likely complexity or risk-classification mistakes
- Compare policy versions on a representative routing dataset
- Supply features for offline policy calibration

Jev labels are supporting evidence, not ground truth. Actual completion, verification, regressions, user corrections, and explicit feedback remain stronger evidence. Jev cannot prove that an unexecuted alternative provider would have succeeded.

The development evaluator lives outside the published runtime, uses a fake Jev executable in CI, requires an explicitly pinned model, records the returned model and question-set version, and never changes a shipped policy. `pnpm evaluate:jev -- --model jev-EXACT-VERSION --output .airo-dev/jev-routing-report.json` runs it manually against the reviewed routing fixtures. Human review and the routing-policy evaluation gate remain mandatory before changing shipped weights.

### Optional production feedback

Production AIRO may later offer optional, post-run Jev feedback. This feature must:

- Be disabled by default
- Require a dedicated consent flow
- Use an API key supplied by the user
- Never store the API key in project configuration, history, logs, or sync
- Send only the disclosed, bounded evaluation state
- Exclude source files, diffs, provider output, repository paths, credentials, environment variables, and session transcripts by default
- Record the Jev model, question-set version, probabilities, confidence, and whether feedback affected learning
- Never block the current route or provider execution
- Influence only future automatic decisions through bounded local adjustments
- Provide status, inspection, disable, and reset controls
- Respect a per-run opt-out

The recommended sequence is local route, provider execution, outcome recording, optional Jev evaluation, and future local learning. Explicit user choices, custom rules, explicit historical feedback, and verified outcomes outrank Jev feedback.

Suggested local separation:

```text
history.jsonl                 execution journeys
history.feedback.jsonl        user feedback
history.jev-feedback.jsonl    validated Jev feedback
routing-policy.local.json     bounded derived adjustments
```

`routing-policy.local.json` is a rebuildable local cache, not a source of truth. AIRO recomputes it from versioned history and feedback, excludes it from export and synchronization, and may delete it safely at any time.

## Portable history and learning

Migration must not depend exclusively on a hosted service. AIRO should first define a versioned portable format and support encrypted export and import.

```bash
airo history export --encrypted backup.airo
airo history import backup.airo
```

Import must be idempotent and preserve record identifiers, feedback relationships, schema versions, and policy provenance. Derived learning should be recomputed from merged evidence rather than treated as an opaque file to overwrite.

### Stable repository identity

Absolute working-directory paths cannot identify the same repository across machines. Future history records should use a stable `repositoryId` for learning scope while retaining `cwd` only as local display metadata.

For Git repositories, a plain hash of the normalized remote is not private: public repository URLs can be recovered through dictionary matching. For synchronized accounts, derive `repositoryId` with a domain-separated HMAC over the canonical remote using a dedicated account index key derived from, but distinct from, the account data-encryption key. Only the HMAC result leaves the machine. Portable archives carry the existing opaque ID so imports preserve identity without knowing the remote.

Repositories without a remote receive a random project ID. Linking another checkout or machine requires an explicit local operation that transfers or selects that opaque ID.

## Optional Cloudflare sync

Cloud sync is a future opt-in convenience for migration and multi-device continuity. Local data remains authoritative, routing continues offline, and sync failure never changes a task's exit status.

The proposed platform is:

- A [Cloudflare Worker](https://developers.cloudflare.com/workers/) for authentication, authorization, validation, rate limiting, and sync endpoints
- [Cloudflare D1](https://developers.cloudflare.com/d1/) for users, devices, encrypted settings, append-only sync events, cursors, and tombstones
- R2 only when encrypted archives or payload sizes justify object storage
- No Durable Object initially; append-only events and optimistic revisions are sufficient for expected CLI concurrency

### Authentication

The initial user flow should be browser-assisted GitHub authentication suitable for local terminals, remote shells, and containers:

```text
airo sync login
  -> receive verification URL and short-lived device challenge
  -> authenticate with GitHub in the browser
  -> CLI polls until approved
  -> receive short-lived access and rotating refresh credentials
```

End users do not need Cloudflare accounts. Device sessions must be individually revocable. Refresh tokens are stored in the operating-system credential store when possible, with a permission-restricted local file only as an explicit fallback; the server stores only token hashes.

### End-to-end encryption

Cloudflare-managed encryption at rest is not sufficient for sensitive task history. Before upload, the client should encrypt private payloads with a random account data-encryption key. A recovery passphrase-derived key wraps that account key so a new authenticated machine can decrypt it locally.

The server stores only encrypted private payloads and the wrapped account key. Loss of the recovery passphrase and all authorized devices makes the data unrecoverable; setup must state this clearly.

Secrets never sync. Provider credentials, provider API keys, the user's Jev API key, executable paths, and machine-specific permission settings remain local.

### Append-only synchronization

History sync should exchange immutable, globally identified events rather than whole JSONL files. Duplicate IDs are ignored, corrections create new events, deletions create tombstones, and every server insertion advances a pull cursor. Settings use per-key revisions instead of replacing an entire configuration document.

After a pull, each client deterministically rebuilds local learning from the merged evidence. This prevents one machine from silently overwriting another machine's history or policy.

Expected controls include:

```bash
airo sync login
airo sync enable
airo sync now
airo sync status
airo sync devices
airo sync logout
airo sync delete-cloud-data
```

## Research-consent milestone

Research collection is explicitly deferred. It must not be implemented as part of the initial provider-registry, portability, Jev-local-feedback, or private-sync milestones.

Private sync and research are separate data lanes:

```text
local journey
  +-- private sync: client encryption -> Worker -> D1 -> user devices
  +-- research: consent filter -> local redaction -> research service -> evaluation
```

The server must never decrypt private synchronized history for research. The client creates a separate research submission only when the relevant consent scopes are active.

### Consent requirements

Consent must be a positive, granular opt-in separate from service terms and private sync. Proposed scopes are:

- Share routing and outcome metrics
- Share sanitized task text
- Permit submitted text to be evaluated by TypeSafe Jev
- Include selected history created before consent
- Use the submission to calibrate future shipped routing policies

No scope is preselected. Enabling research today must not upload existing history without a second explicit choice, preview, and date range. Account-level consent is combined with per-device activation, and repositories need a local opt-out for sensitive work.

The consent ledger records the user, device, notice version and hash, scopes, timestamp, and revocation. Material changes to purpose, fields, processors, or retention require renewed consent. The service rejects submissions tied to absent, expired, incompatible, or revoked consent.

### Research payload

A purpose-built research schema should contain only approved fields such as:

- Task category, risk, complexity, and optional sanitized text
- Eligible routes, selected route, selection source, and user override
- Completion, verification, quality, retry, recovery, duration, and token buckets
- AIRO version, policy version, consent ID, and schema version

The first version excludes source, diffs, provider output, repository identity, paths, feedback notes, environment values, credentials, and session transcripts. Sanitized text must be described as pseudonymized rather than guaranteed anonymous because automatic redaction may miss sensitive content.

### Research processing architecture

Research adds infrastructure that private sync does not need:

- D1 tables for consent, submissions, processing state, labels, deletion requests, dataset membership, and policy versions
- [Cloudflare R2](https://developers.cloudflare.com/r2/) for larger research payloads and evaluation artifacts
- [Cloudflare Queues](https://developers.cloudflare.com/queues/) for asynchronous, idempotent Jev evaluation
- A Worker secret owned by the AIRO research service for server-side Jev calls

Queue consumers re-check consent immediately before processing. Stable submission IDs prevent duplicate evaluations under at-least-once delivery. Research payloads and labels must never be written to request logs.

### Withdrawal, deletion, and lineage

Users need separate controls to stop future participation, inspect/export their submissions, and delete previously collected data. Withdrawal immediately stops local creation and server acceptance of new submissions. Pending workers re-check consent and skip revoked submissions.

Deletion removes retained research payloads and Jev labels. Dataset manifests must make each policy build traceable to eligible submission IDs so deleted data is excluded from future builds. Documentation must be honest that a contribution already incorporated into a released aggregate policy may not be individually removable without rebuilding that policy.

Cloud sync consent never implies research consent. Local Jev consent never implies research consent. Research participation never becomes a condition of using AIRO.

## Security and privacy invariants

- Core routing works without an account, network access, Jev, or the sync service.
- No arbitrary provider or executable is auto-trusted.
- Explicit routing choices are never silently replaced.
- Provider credentials and API keys never enter history, sync, research payloads, or logs.
- Private sync payloads are encrypted before leaving the machine.
- Server-readable research data uses a separate consented payload.
- No existing history is uploaded retroactively by default.
- Users can inspect, export, reset, revoke, and delete applicable data.
- Schema, consent, evaluator, dataset, and policy versions remain auditable.

## Milestones

### Milestone 1: provider-neutral foundations

- [x] Static, source-controlled provider registry
- [x] Complete, exhaustive provider adapter contract and versioned support audit
- [x] Generic candidate generation and fallback across registered providers
- [x] Provider-neutral task features and capability scoring
- [x] Versioned routing-policy artifact and reviewed fixture evaluation

#### Milestone 1 acceptance record

- **Versioning:** provider support contract version 1 and routing policy version are source controlled; routes and new history records retain policy provenance. No configuration schema change is required.
- **Verification:** unit, integration, negative/failure-path, routing-policy evaluation, legacy path migration, and backward-compatibility tests run through `pnpm validate`; the support audit also fails closed when a required provider configuration is incomplete.
- **Diagnostics:** `airo doctor` distinguishes source integration readiness from command availability and model discovery on the current machine. Runtime provider switches identify authentication or usage-limit failures.
- **Documentation:** this roadmap records development status, while the README and routing documentation describe observable CLI behavior. Publication remains a separate release step.
- **Security and privacy:** Milestone 1 adds no network service or telemetry. Provider commands remain explicitly registered, arbitrary filesystem scanning is prohibited, provider credentials are not read, and task prompt arguments are redacted from invocation diagnostics.
- **Compatibility and migration:** existing configuration remains valid, deprecated model allowlists remain readable, historical records without a policy version remain readable, and legacy AI Router paths continue through the tested migration path.
- **Rollback:** the policy artifact and support contract are versioned and code-reviewed. A released regression can be rolled back by pinning the prior npm package version or reverting the policy/code change; explicit routes and custom rules remain higher precedence than automatic routing.

### Milestone 2: portable local learning

- Versioned history and feedback schemas
- Stable repository identity
- Idempotent encrypted export and import
- Deterministic learning rebuild after merge

### Milestone 3: Jev development evaluator

- Unpublished evaluation workspace
- Pinned model and versioned question set
- Synthetic and privacy-reviewed datasets
- Held-out comparison and policy-calibration reports
- No runtime dependency in core routing

### Milestone 4: optional local Jev feedback

- Explicit security and data-sharing consent
- User-supplied API key
- Post-run bounded evaluation
- Local feedback storage and learning controls
- Inspection, disable, reset, and per-run opt-out

### Milestone 5: encrypted cloud sync

- Cloudflare Worker and D1 service
- Browser/device authentication and revocable device sessions
- End-to-end encryption and recovery flow
- Append-only push/pull synchronization
- Settings classification and secret exclusion
- Account export and cloud-data deletion

### Milestone 6: research consent and global improvement

- Granular versioned consent ledger
- Separate research submission API
- R2 and Queue-backed evaluation pipeline
- Withdrawal, deletion, retention, and dataset lineage
- Reviewed global policy build and release process

Milestones may be split further, but later milestones must not weaken the privacy or local-first guarantees established earlier.

## Acceptance gate for each milestone

A milestone is not complete until it has:

- A versioned data and configuration contract
- Unit, integration, failure-path, and migration tests
- Clear CLI status and error reporting
- Documentation distinguishing released behavior from roadmap behavior
- Security and privacy review appropriate to the data involved
- Backward compatibility or an explicit migration path
- A way to disable or roll back the feature

## Open implementation decisions

- Calibration and future versioning of provider capability weights
- Routing-policy training or calibration method
- Portable archive format and key derivation parameters
- Git remote fingerprinting and non-Git project linking UX
- Authentication provider beyond the initial GitHub flow
- Credential-store implementation on each operating system
- Sync quotas, retention, and encrypted archive limits
- Jev question set, confidence thresholds, and local boost bounds
- Research retention period and policy-rebuild response to deletion
- Jurisdiction and governance requirements for hosted services

These questions do not change the planned boundaries above. They must be resolved during the relevant milestone rather than assumed by earlier work.
