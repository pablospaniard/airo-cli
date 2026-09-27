# Jev and AIRO: concepts, differences, and integration options

This document compares AIRO with TypeSafe AI's Jev model and records the initial findings for a possible integration.

## Scope

This comparison is about **Jev itself**: TypeSafe AI's System One decision model and API. Third-party routing projects are outside its scope and are not evaluated.

The findings are based on TypeSafe's public documentation as reviewed on September 27, 2026. Jev is an external, evolving service, so API behavior and model characteristics must be verified again before implementation.

Primary references:

- [TypeSafe AI documentation](https://docs.typesafe.ai/llms.txt)
- [Introduction to Jev](https://docs.typesafe.ai/introduction)
- [System One concepts](https://docs.typesafe.ai/concepts/system-one)
- [Question primitives](https://docs.typesafe.ai/primitives)
- [Choice questions](https://docs.typesafe.ai/primitives/choice)
- [Confidence](https://docs.typesafe.ai/confidence)
- [API reference](https://docs.typesafe.ai/api)
- [Known Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Executive summary

Jev and AIRO operate at different layers:

- **Jev is a decision model.** It evaluates structured state and answers constrained questions with typed results, probabilities, and confidence.
- **AIRO is a local coding-agent router and orchestrator.** It selects a provider, model tier, and effort; launches the provider CLI; coordinates phases; validates outcomes; handles recovery; and learns from local history.

They are therefore complementary rather than direct substitutes. A possible integration would use Jev as a semantic decision input inside AIRO's automatic routing path. AIRO would retain control of explicit overrides, policy, provider availability, execution, permissions, fallback, orchestration, logging, and local outcome learning.

The recommended investigation is a feature-flagged advisory integration evaluated by offline replay before Jev is allowed to influence live routes.

## What Jev is

TypeSafe describes Jev as its first public System One model: software sends state and typed questions, and receives structured answers that code can consume directly. It is intended for bounded decisions rather than open-ended text generation. Choice and Score return probability distributions and a separate confidence value; Noul returns a yes/no probability.

The public API exposes three main question types:

| Primitive | Result | Potential routing use |
| --- | --- | --- |
| `Choice` | One selection from a declared set, plus probabilities and confidence | Select a provider/tier route from eligible candidates |
| `Score` | One position on an ordered scale, plus probabilities and confidence | Estimate task complexity or risk |
| `Noul` | Probability for a yes/no question | Decide whether escalation, review, or a deep model is warranted |

Jev supplies a decision signal; application code remains responsible for determining what actions are allowed, what confidence is sufficient, and what happens on errors or uncertainty.

## What AIRO is

AIRO accepts a software-development task and controls its execution through supported provider CLIs. Its automatic routing currently combines:

- Explicit provider, model, tier, and effort requests
- User-authored regular-expression rules
- Built-in provider keyword signals
- A deterministic complexity score
- Routing policy and default-provider tie-breaking
- Locally stored evidence from similar previous work
- Phase-specific preferences during adaptive orchestration
- Provider availability and fallback rules

After choosing a route, AIRO does substantially more than classification. It invokes the provider CLI, preserves session context, coordinates implementation phases, handles clarification and permission flows, records usage and outcomes, evaluates verification evidence, and can recover from provider failures.

The current implementation is documented in [Routing rules and learning](routing-and-learning.md) and defined primarily in [`src/router.ts`](../src/router.ts), [`src/history.ts`](../src/history.ts), and [`src/orchestrator.ts`](../src/orchestrator.ts).

## Conceptual differences

| Dimension | Jev | AIRO |
| --- | --- | --- |
| Kind of system | Trained decision model exposed through an API | Local routing and execution application |
| Primary responsibility | Answer bounded semantic questions | Route and complete coding work |
| Input | Structured state and typed questions | Natural-language task, configuration, phase, availability, and local history |
| Output | Typed decisions, probabilities, and confidence | Provider, model, tier, effort, reasons, and an executable workflow |
| Current decision method | Learned model behavior | Regex signals, deterministic scoring, rules, and historical aggregation |
| Execution capability | None by itself | Runs supported coding-agent CLIs |
| Uncertainty | Per-answer probability and confidence | Heuristic scores and confidence in the amount of historical evidence |
| Adaptation | Changes through TypeSafe model versions | Changes continuously from repository-local outcomes and feedback |
| Workflow scope | Generic classification and decision tasks | Software analysis, implementation, testing, review, and recovery |
| Data boundary | Selected state is sent to the configured Jev endpoint | Routing features and history stay local; the selected coding provider receives the execution prompt |
| Failure policy | Must be designed by the caller | Explicit pinning, fallback, retry, recovery, and permission behavior are built into AIRO |

### Scores and confidence are not interchangeable

AIRO's provider scores are additive heuristic points. A Claude score of `8` and a Codex score of `4` do not mean probabilities of 67% and 33%.

AIRO's `learningConfidence` measures the effective amount of similar historical evidence. It is not a calibrated probability that a route will succeed.

Jev's Choice and Score primitives return probabilities and a separate confidence value, while Noul's probability is itself the decision signal. Those values would need explicit thresholds and evaluation on AIRO's own task distribution before they could safely control routing.

### Learning is different

Jev is a trained external model. AIRO does not train a model. AIRO writes phase outcomes and feedback to local JSONL files, computes similarity against previous tasks, and derives temporary route boosts at decision time.

An integration should preserve that distinction:

- Jev can provide a semantic prior about the current task.
- AIRO history can provide repository-specific evidence about which configured route actually worked.
- Deterministic AIRO policy must resolve conflicts and control execution.

## Potential integration boundary

The safest architectural boundary is to treat Jev as an optional classifier behind a small interface, not as the owner of the router:

```text
Task + phase + eligible routes
              |
              v
     local feature extraction
              |
              +--------------------+
              |                    |
              v                    v
      existing heuristics    optional Jev decision
              |                    |
              +---------+----------+
                        v
              deterministic policy
              - explicit overrides
              - custom rules
              - confidence threshold
              - availability
              - local history
              - fallback policy
                        |
                        v
              AIRO execution engine
```

This keeps the effect boundary in AIRO: Jev may recommend a route, but it cannot launch a provider, bypass permissions, override a pinned choice, or silently change fallback behavior.

## Candidate integration modes

### 1. Advisory or shadow mode — recommended first step

AIRO calls Jev but does not change the selected route. It records:

- Eligible candidates presented to Jev
- Jev's selected candidate
- Probabilities and confidence
- The existing AIRO route
- Actual completion, verification, duration, and token outcome

This supports offline comparison without introducing execution risk. It does introduce API cost and sends the selected classification state outside the machine, so it must still be explicitly enabled.

### 2. Confidence-gated semantic input

Jev may influence automatic routing only when:

- No provider, model, or tier was explicitly selected
- No custom rule forced the relevant route dimension
- The Jev request succeeded and passed schema validation
- Its confidence exceeds a configured threshold
- The selected route is locally configured and currently eligible
- The decision passes deterministic policy checks

Below the threshold, AIRO should use its existing routing logic. There should be no retry loop that repeatedly asks Jev until a preferred answer appears.

### 3. Primary automatic classifier

Jev chooses among all eligible automatic routes, with the current heuristic router used only as fallback. This is the largest behavioral change and should not be attempted until shadow-mode results demonstrate better end-to-end outcomes on representative AIRO tasks.

### 4. Full replacement — not recommended

Replacing AIRO's routing and orchestration logic with Jev would mix semantic classification with policy and execution. It would also discard useful deterministic guarantees, local learning, phase behavior, and provider failure handling. Jev is better treated as one input to those mechanisms.

## Proposed decision contract

For the first experiment, use one `Choice` over complete eligible route candidates rather than independent provider and tier choices. A joint choice prevents invalid combinations and lets each candidate carry its own description.

Conceptual request:

```json
{
  "state": {
    "task": "Investigate an intermittent authentication race condition",
    "phase": "analyze",
    "risk": "high",
    "configured_policy": "balanced"
  },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Choose the least expensive eligible route likely to complete this phase correctly.",
      "criteria": {
        "claude/balanced": "Architecture and investigation with moderate reasoning",
        "claude/deep": "High-risk or uncertain investigation requiring deep reasoning",
        "codex/balanced": "Scoped coding or validation with moderate reasoning",
        "codex/deep": "Complex implementation requiring deep reasoning"
      }
    }
  }
}
```

The production candidate identifiers should be stable internal route IDs rather than display names. Model names and provider availability should remain AIRO configuration concerns.

The state should be deliberately bounded. The first version should not send source files, diffs, output excerpts, feedback notes, session transcripts, credentials, or arbitrary environment data. Task text alone may still be sensitive, so the integration requires clear disclosure and opt-in configuration.

## Proposed precedence

If Jev is allowed to influence live routing, the precedence should remain:

1. Explicit CLI overrides
2. Provider, model, or tier explicitly requested in the current task
3. Matching custom configuration rule
4. Hard eligibility and safety constraints
5. Phase constraints and preferences
6. Confidence-gated Jev recommendation combined with local historical evidence
7. Existing heuristic route as fallback
8. Configured default provider for unresolved ties

Jev must never override a user-pinned provider or select an unavailable route.

## Configuration sketch

No configuration shape is final, but an experiment could use:

```json
{
  "routingDecision": {
    "provider": "local",
    "jev": {
      "enabled": false,
      "mode": "shadow",
      "model": "pinned-model-version",
      "minimumConfidence": 0.8,
      "timeoutMs": 1500,
      "sendTaskText": true,
      "storeDecisionState": false
    }
  }
}
```

Required properties:

- Disabled by default
- Explicit `shadow` and `active` modes
- A pinned model version during evaluation
- A strict timeout with immediate local fallback
- No secret in project configuration
- Redacted logs by default
- Clear reporting when Jev affected a route

## Risks and controls

| Risk | Required control |
| --- | --- |
| Sensitive task text leaves the machine | Explicit opt-in, bounded state, documentation, and a local-only default |
| External outage or latency blocks work | Short timeout, no mandatory dependency, immediate local fallback |
| Model-version behavior changes | Pin the evaluated model version and require an intentional upgrade |
| Confidence is assumed to equal routing quality | Calibrate thresholds against AIRO outcomes rather than accepting generic confidence at face value |
| Jev selects an unavailable or forbidden route | Construct candidates from eligible local configuration and validate the response |
| Explicit user intent is lost | Preserve the existing override and pinning precedence |
| Cost grows with every phase | Track classifier usage separately and support per-run or per-phase limits |
| Logs expose external request state | Store minimal decision metadata; make full state logging an explicit diagnostic option |
| Local learning and Jev disagree | Define deterministic combination rules and preserve both explanations |
| New nondeterminism is hard to debug | Record model version, candidate set, response, threshold result, and final policy decision |

## Evaluation plan

### Phase 1: contract spike

- Define a provider-neutral `RoutingDecisionEngine` interface.
- Implement a fixture-backed Jev adapter with no live credentials required for tests.
- Validate typed responses, timeouts, malformed answers, low confidence, and unavailable candidates.
- Confirm that explicit choices and custom rules never invoke or yield to Jev.

### Phase 2: offline replay

- Build a representative, privacy-reviewed dataset from synthetic tasks and optionally sanitized local history.
- Compare the current router and Jev recommendations without executing providers.
- Measure agreement, route stability, coverage above candidate confidence thresholds, latency, and classifier cost.
- Review disagreements manually; agreement alone is not evidence of correctness.

### Phase 3: shadow execution

- Run the normal AIRO route while recording what Jev would have selected.
- Join shadow decisions with AIRO's deterministic completion and verification outcomes.
- Do not treat a successful provider exit as proof that the alternative Jev route would also have succeeded.

### Phase 4: controlled active experiment

- Allow high-confidence Jev decisions for a narrow category of unpinned tasks.
- Keep a stable baseline cohort on the existing router.
- Compare task satisfaction, verified completion, retries, regressions, latency, tokens, classifier cost, and fallback rate.
- Provide a kill switch and revert to local routing on any systemic regression.

## Suggested success criteria

Before making Jev an active routing input, the investigation should establish:

- No violation of explicit model/provider/tier choices
- No selection of unavailable or policy-ineligible routes
- Measurably improved verified task outcomes, or equivalent outcomes at lower total cost or latency
- Acceptable decision latency at the selected confidence threshold
- Reliable local fallback during timeouts, authentication failures, malformed responses, and rate limits
- Clear route explanations that distinguish Jev advice from AIRO policy and history
- A reviewed privacy model for task text and decision logs
- Offline tests that do not require a Jev credential or spend external quota

## Open questions

- Should Jev choose a complete provider/tier route or only classify task category, risk, and complexity?
- Should local historical utility re-rank Jev probabilities or act as a separate policy gate?
- Which task text, session context, or phase context is necessary for good decisions?
- What confidence threshold produces useful coverage on AIRO's actual workload?
- Should Jev be called once per job or independently for every adaptive phase?
- How should classifier token usage and cost appear in `airo usage`?
- How long should decision metadata be retained, and should it share AIRO's history path?
- Is a hosted-only classifier acceptable for AIRO's local-first positioning?
- What user-facing consent and redaction controls are required?

## Recommendation

Proceed with a bounded investigation, not an immediate routing replacement. Start with an internal decision-engine interface, fixture-driven tests, and shadow mode. Preserve AIRO's deterministic policy and execution boundaries throughout the experiment.

The integration should advance to active routing only if repository-specific evidence shows that Jev improves verified outcomes or efficiency enough to justify the added network dependency, privacy considerations, latency, and cost.
