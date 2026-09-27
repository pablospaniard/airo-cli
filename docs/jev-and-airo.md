# Jev and AIRO

## Decision status

Jev is not planned as a required production routing dependency or as a replacement for AIRO's router. The planned direction has two bounded uses:

1. An unpublished development evaluator that supplies semantic labels and decision feedback for improving AIRO's shipped routing policy. This is implemented on the development branch for reviewed fixtures only.
2. A future optional production feedback integration that uses the user's API key, runs after a task, stores feedback locally, and may improve later automatic decisions.

The development evaluator is not part of the published runtime and does not run in CI against the external service. Optional production feedback remains unimplemented. The complete provider, learning, sync, and research roadmap is recorded in [Routing platform roadmap](routing-platform-roadmap.md).

The findings and development CLI interface here are based on public documentation reviewed on September 27, 2026. Jev is an external, evolving service, so its API, model versions, data practices, and limitations must be verified again before future integration changes or production use.

Primary references:

- [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt)
- [Introduction to Jev](https://docs.typesafe.ai/introduction)
- [Question primitives](https://docs.typesafe.ai/primitives)
- [Confidence](https://docs.typesafe.ai/confidence)
- [API reference](https://docs.typesafe.ai/api)
- [Models](https://docs.typesafe.ai/models)
- [Known Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [`@y0usaf/typesafe-cli`](https://github.com/y0usaf/typesafe-cli), the separately installed development CLI

## Complementary responsibilities

Jev and AIRO operate at different layers:

- Jev evaluates structured state and answers bounded questions with typed results, probabilities, and confidence.
- AIRO selects providers, models, tiers, and effort; launches provider CLIs; coordinates phases; handles permissions and fallback; evaluates outcomes; and learns from local evidence.

Jev can provide a semantic opinion about a decision. AIRO remains responsible for policy, execution, safety, availability, user intent, and learning.

| Dimension | Jev | AIRO |
| --- | --- | --- |
| Primary role | Structured decision model | Local coding-agent router and orchestrator |
| Input | Selected state and typed questions | Task, configuration, availability, phase, and local history |
| Output | Choice, Score, or Noul values | Executable provider/model route and workflow |
| Uncertainty | Probabilities and confidence | Heuristic evidence and local-learning confidence |
| Execution | None | Provider CLI execution, fallback, recovery, and verification |
| Adaptation | External model releases | Shipped policy plus repository-local outcomes and feedback |
| Data boundary | Submitted state is sent to TypeSafe | Core routing and learning remain local |

AIRO's additive provider scores are not probabilities. Its `learningConfidence` measures the effective amount of similar evidence, not the probability that a route will succeed. Jev probabilities must not be numerically added to those values without a separately evaluated calibration model.

## Development evaluator

The first Jev milestone should be an unpublished workspace or tool outside the production runtime. It may read synthetic tasks and explicitly approved, sanitized routing journeys.

Useful questions include:

- What kind of work does the task require?
- How risky, ambiguous, or cross-cutting is it?
- Is the selected provider/tier semantically appropriate?
- Does the route appear excessive, adequate, or insufficient?
- Is a later user override consistent with an initial routing mismatch?
- Does a failure look more like route mismatch, execution failure, or insufficient evidence?

Each label must retain:

- The versioned Jev model identifier
- Question-set version
- Structured answer
- Full probability distribution when available
- Confidence
- Dataset and record identifier
- Evaluation timestamp

Jev feedback is supporting evidence. Actual verified completion, regressions, retries, explicit feedback, and user corrections are stronger signals. Jev cannot establish the counterfactual claim that an unexecuted provider would have succeeded.

The evaluator may help calibrate a generic routing-policy artifact, but it must never edit production weights automatically. Proposed policy changes require a held-out comparison, regression review, and normal source review.

Tests must use recorded fixtures or a fake transport. CI must not require a TypeSafe credential or spend external quota.

The development command uses the separately installed `jev` CLI without adding it to AIRO's runtime dependencies:

```bash
pnpm evaluate:jev -- --model jev-EXACT-VERSION --output .airo-dev/jev-routing-report.json
```

The exact model is mandatory; aliases such as `jev-latest` are rejected. The CLI resolves `TYPESAFE_API_KEY` itself, so AIRO never accepts, prints, or stores the key. For every reviewed fixture, the evaluator sends only the fixture task and AIRO's provider, tier, complexity, and policy version. It asks versioned Choice and Noul questions for category, risk, provider, tier, and route appropriateness. Reports retain the full typed answers, distributions, confidence values, returned model, CLI version, usage, question-set version, and fixture identifier, but omit task text. Reports never update routing weights. CI exercises the same parser and failure boundary through a fake Jev executable.

## Optional production feedback

The future production integration is post-run feedback, not live route selection:

```text
AIRO selects locally
        -> provider executes
        -> AIRO records the outcome
        -> optional Jev evaluation
        -> feedback is stored locally
        -> future automatic decisions may receive a bounded adjustment
```

This keeps the current run independent of network latency, Jev availability, authentication, rate limits, and model changes.

Live advisory routing was rejected for the initial production integration because it would put an external request, sensitive task text, added latency, variable cost, and a new failure mode directly in the execution path. Post-run evaluation can still improve later decisions while preserving deterministic local routing for the task already underway. Full replacement was rejected because Jev supplies a semantic signal, not provider eligibility, user-intent precedence, permissions, fallback, execution, or outcome verification.

### Consent and API key

The feature must be disabled by default and enabled through a dedicated consent flow. Before the first request, AIRO must state that selected task information will leave the machine and be processed by TypeSafe.

The user supplies `TYPESAFE_API_KEY` or a future operating-system credential-store entry. AIRO must not write the key to project configuration, history, logs, synchronized settings, or research records.

Consent for local Jev feedback is distinct from cloud-sync consent and research consent. Enabling one never enables the others.

### Bounded payload

The first production payload may contain:

- Task text
- Phase and semantic task features
- Eligible and selected route identifiers
- Completion, verification, retry, recovery, duration, and token buckets
- Explicit user rating or route correction when the user chose to record one

It excludes by default:

- Source files and diffs
- Provider output excerpts
- Repository names, remotes, and absolute paths
- Feedback notes
- Credentials and environment variables
- Session transcripts

Task text can itself contain sensitive information. The consent prompt must show the categories sent, and AIRO should provide a per-run opt-out.

### Local storage and influence

Jev feedback should be stored separately from execution history and user feedback. A record includes the source history ID, model and question-set versions, answers, probabilities, confidence, and whether it was accepted into learning.

Jev feedback may influence only future unpinned automatic routes. Apply a minimum confidence, minimum similar sample count, bounded adjustment, recency decay, and complete reset. Explicit current choices, custom rules, explicit historical feedback, and verified local outcomes take precedence.

Suggested controls are:

```text
airo feedback jev status
airo feedback jev enable
airo feedback jev disable
airo feedback jev inspect
airo feedback jev reset
airo --no-jev "task"
```

Command names are illustrative until the milestone is designed and implemented.

## Cloud sync interaction

If the user later enables encrypted multi-device sync, local Jev feedback may be synchronized as another client-encrypted event. The TypeSafe API key never syncs. A new machine decrypts the feedback locally and rebuilds learning from the merged evidence.

End-to-end encrypted sync data is not available for global AIRO research. Research submission requires a separate granular consent and a separately constructed server-readable payload. See the research milestone in [Routing platform roadmap](routing-platform-roadmap.md).

## Risks and required controls

| Risk | Control |
| --- | --- |
| Sensitive task text leaves the machine | Explicit opt-in, bounded payload, preview, and per-run opt-out |
| Jev is mistaken for ground truth | Preserve confidence and combine it only with actual outcomes and user feedback |
| Model behavior changes | Pin development evaluations and record the exact production model response |
| External failure disrupts work | Evaluate after execution and fail open without changing the run result |
| Feedback oversteers local routing | Minimum samples, confidence gate, bounded boost, decay, and reset |
| Logs expose submitted state | Never log request bodies or credentials |
| Synced feedback exposes content | Client-side encryption before upload |
| Local feedback is reused for research | Separate opt-in and separate payload; no consent inference |

Jev 1.13 is documented as literal, less reliable with irrelevant state, vulnerable to adversarial content in state, and unsuitable for arithmetic. Keep state narrow, questions precise, numeric calculations in code, and responses schema-validated.

## Milestone acceptance criteria

Development evaluation is ready only when:

- The evaluator is excluded from the published runtime
- The model and question set are versioned
- Datasets are synthetic or explicitly approved and reviewed
- Results are measured on held-out cases
- Policy changes require review and can be rolled back

Optional production feedback is ready only when:

- Core routing works identically when the feature is disabled or unavailable
- Consent and data categories are explicit
- No credential or excluded content reaches logs or storage
- Feedback is local, inspectable, bounded, and resettable
- Explicit routes cannot be changed
- Timeout, authentication, rate-limit, and malformed-response paths are tested
- Cloud sync and research remain separately consented

## Recommendation

Build the provider-neutral router, portable history, and development evaluation harness before adding production Jev feedback. Introduce the production option only when evaluation demonstrates useful routing improvements and the consent, privacy, failure, and reset behavior is complete.
