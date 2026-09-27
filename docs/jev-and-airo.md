# Jev and AIRO

## Decision status

Jev is not planned as a required production routing dependency or as a replacement for AIRO's router. The planned direction has two bounded uses:

1. An unpublished development evaluator that supplies semantic labels and decision feedback for improving AIRO's shipped routing policy. The Milestone 3 evaluator, split dataset, comparison report, and review gate are implemented on the development branch for synthetic privacy-reviewed fixtures only.
2. An optional production feedback integration on the development branch that uses the user's API key, runs after a task, stores feedback locally, and may improve later automatic decisions.

The development evaluator is not part of the published runtime and does not run in CI against the external service. Optional production feedback is implemented on the development branch but is not yet part of the published npm package. The complete provider, learning, sync, and research roadmap is recorded in [Routing platform roadmap](routing-platform-roadmap.md).

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

The development evaluator is an unpublished tool outside the production runtime. It reads synthetic tasks today; support for explicitly approved, sanitized routing journeys would require a separately reviewed dataset version.

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

The evaluator may help calibrate a generic routing-policy artifact, but it never edits production weights automatically. Proposed policy changes require a held-out comparison, regression review, the existing routing-policy accuracy gate, and normal source review.

Tests must use recorded fixtures or a fake transport. CI must not require a TypeSafe credential or spend external quota.

The development command uses the separately installed `jev` CLI without adding it to AIRO's runtime dependencies:

```bash
pnpm evaluate:jev -- --model jev-EXACT-VERSION --dataset all --output .airo-dev/jev-routing-report.json
```

The exact model is mandatory; moving aliases such as `jev-latest` and `jev-preview` are rejected, and a response naming a different model fails the run. The CLI resolves `TYPESAFE_API_KEY` itself, so AIRO never accepts, prints, or stores the key. For every reviewed fixture, the evaluator sends only the fixture task and AIRO's provider, tier, complexity, and policy version. It asks versioned Choice and Noul questions for category, risk, provider, tier, and route appropriateness. Reports retain the full typed answers, distributions, confidence values, returned model, CLI version, usage, question-set version, dataset version, split, and fixture identifier, but omit task text. Reports never update routing weights. CI exercises the same parser and failure boundary through a fake Jev executable.

### Dataset and comparison protocol

Dataset version 1 contains two disjoint source-controlled splits:

- 12 calibration cases that may identify policy-review candidates.
- 8 held-out cases that may only measure provider, tier, and joint accuracy.

The dataset manifest declares synthetic provenance, an approved privacy-review version, and excluded data categories. Tests reject common URL, filesystem-path, email, API-key, and token patterns. A report can select `all`, `calibration`, or `held-out`; the default is `all`. `--limit` is intended for transport checks, not an acceptance evaluation.

Report schema version 2 compares AIRO and Jev against the reviewed label for each available split. It records provider, tier, and joint accuracy; AIRO/Jev agreement; average confidence; appropriateness probability; held-out improvements; and held-out regressions. A calibration candidate is emitted only when AIRO misses the reviewed calibration label, Jev matches it, and both provider and tier confidence are at least 0.7. This candidate is a review prompt, not a weight update.

The report always carries `policyModified: false` and `reviewRequiredBeforePolicyChange: true`. Before changing `src/routing-policy.ts`, a developer must:

1. Run the full pinned-model evaluation without `--limit`.
2. Review calibration candidates and all held-out regressions.
3. Propose the policy change separately.
4. Re-run `pnpm evaluate:routing-policy` and the pinned Jev comparison.
5. Commit the reviewed policy artifact and evidence independently from generated `.airo-dev` reports.

Generated reports stay under the ignored `.airo-dev/` directory because they contain external model output and can be regenerated. No live TypeSafe result is required in CI, and the evaluator script is excluded from the npm package's published file list.

## Optional production feedback

The development-branch production integration is post-run feedback, not live route selection:

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

The feature is disabled by default and enabled through `airo feedback jev enable`. Before recording consent, AIRO states that selected task information will leave the machine and be processed by TypeSafe. Non-interactive enablement additionally requires `--accept-data-sharing`. A changed disclosure invalidates older consent until the user reviews and enables it again.

The user supplies `TYPESAFE_API_KEY`. AIRO reads it from the process environment and does not write the key to project configuration, consent, history, logs, synchronized settings, or research records.

Consent for local Jev feedback is distinct from cloud-sync consent and research consent. Enabling one never enables the others.

### Bounded payload

The production payload contains:

- Task text
- Phase and semantic task features
- Selected provider and tier identifiers
- Completion, verification, retry, recovery, duration, and token buckets
- Explicit user rating or route correction when the user chose to record one

It excludes by default:

- Source files and diffs
- Provider output excerpts
- Repository names, remotes, and absolute paths
- Feedback notes
- Credentials and environment variables
- Session transcripts

Task text can itself contain sensitive information. The consent prompt shows the categories sent, and `--no-jev` provides a per-run opt-out.

### Local storage and influence

Jev feedback is stored in `history.jev-feedback.jsonl`, separately from execution history and user feedback. A record includes the source history ID, model and question-set versions, answers, probabilities, confidence, local task features, and whether it was accepted into learning. Task text is not duplicated into this file.

Jev feedback influences only future unpinned automatic routes. Provider and tier answers each require confidence of at least 0.70. Reinforcement additionally requires route agreement and an appropriateness probability of at least 0.65; correction requires disagreement and an appropriateness probability no higher than 0.35. Similar evidence must meet the configured history sample threshold, decays with the configured half-life, and is capped at `1.25` provider points and `0.75` tier points. Explicit current choices, custom rules, explicit historical feedback, and verified local outcomes take precedence.

Controls are:

```text
airo feedback jev status
airo feedback jev enable
airo feedback jev disable
airo feedback jev inspect
airo feedback jev reset
airo --no-jev "task"
```

`disable` preserves the local records but immediately removes their routing influence. `reset --yes` deletes those records while preserving consent. Jev requests time out after five seconds and all network, authentication, rate-limit, model-version, and validation failures leave the completed provider run and its exit status unchanged.

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

- [x] The evaluator is excluded from the published runtime
- [x] The model, report, question set, and dataset are versioned
- [x] The dataset is synthetic and privacy reviewed
- [x] Reports measure calibration and held-out cases separately
- [x] Policy changes require review and can be rolled back

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
