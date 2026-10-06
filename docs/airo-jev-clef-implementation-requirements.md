# Airo CLI — Jev / Clef Decision Model Integration Requirements

**Status:** Draft  
**Target:** `airo-cli`  
**Date:** 2026-10-06  
**Scope:** Multi-provider decision-model layer for Jev, Cloudflare Clef, and Cloudflare Clef Flash

---

## 1. Purpose

Airo CLI already integrates Jev as a decision model. The goal of this work is to evolve that implementation into a **model-agnostic decision orchestration layer** that supports:

- Jev
- Cloudflare Clef
- Cloudflare Clef Flash
- future System One-compatible decision models

The implementation must preserve the existing Jev behavior while making it possible to:

1. explicitly select a decision-model provider;
2. automatically route decisions to the most appropriate provider;
3. fail over between providers;
4. run alternate providers in shadow mode for evaluation;
5. collect provider-neutral telemetry;
6. escalate ambiguous decisions to a reasoning model where applicable;
7. avoid coupling Airo's core runtime to any single vendor.

The architectural principle is:

> **Airo owns the orchestration, not the model.**

---

## 2. Background

Jev and Cloudflare Clef belong to the same category of **decision models**. Instead of producing free-form text, they evaluate a supplied state against typed questions and return structured probabilities or scores.

Cloudflare Clef implements System One-compatible decision semantics, which makes it conceptually suitable for use behind the same Airo abstraction as Jev.

Cloudflare currently exposes two variants:

- `@cf/cloudflare/clef`
  - 27B
  - intended for higher-precision decisions
  - 64K-class context window
- `@cf/cloudflare/clef-flash`
  - 9B
  - intended for latency-sensitive hot-path decisions
  - 64K-class context window

Supported decision question types include:

- `noul`
- `choice`
- `score`

Clef supports up to 64 questions per request.

The implementation must not assume that provider-specific capabilities remain identical over time. Provider capability discovery/configuration must remain explicit.

---

## 3. Goals

### 3.1 Primary goals

The implementation SHALL:

- preserve backward compatibility with the current Jev integration;
- introduce a provider-neutral `DecisionProvider` interface;
- support Jev, Clef, and Clef Flash as independently selectable providers;
- support an `auto` routing mode;
- support fallback routing;
- support shadow inference;
- normalize responses into a single Airo decision format;
- expose latency, confidence, provider, model, errors, and routing metadata;
- keep provider secrets outside application source code;
- make future decision-model providers easy to add;
- maintain Airo's existing CLI-first workflow;
- be fully testable without calling live external APIs.

### 3.2 Secondary goals

The implementation SHOULD:

- allow per-decision routing policies;
- allow task-specific model preferences;
- support provider health scoring;
- support deterministic fallback order;
- support configurable confidence thresholds;
- enable production benchmarking between providers;
- provide a clean path toward self-hosted Clef in the future;
- support Cloudflare AI Gateway where appropriate.

---

## 4. Non-goals

This phase SHALL NOT:

- replace Airo's main reasoning LLM layer;
- require every decision to call multiple providers;
- implement automatic reinforcement-learning fine-tuning;
- automatically self-host Clef;
- dynamically download model weights;
- introduce provider-specific logic into business-domain code;
- execute multiple decision providers synchronously unless explicitly requested;
- use majority voting as the default decision strategy.

---

## 5. Terminology

### Decision Model

A model that evaluates state and typed questions and returns structured probabilities, choices, or scores instead of free-form reasoning.

### Decision Provider

A concrete implementation capable of executing a decision request.

Examples:

- `JevDecisionProvider`
- `CloudflareClefDecisionProvider`

### Decision Orchestrator

The Airo runtime component responsible for:

- provider selection;
- fallback;
- timeout handling;
- confidence evaluation;
- shadow execution;
- telemetry;
- optional escalation.

### Primary inference

The provider response that is allowed to affect runtime behavior.

### Shadow inference

A secondary inference call whose result is recorded for evaluation but MUST NOT affect execution.

### Escalation

Routing an ambiguous or low-confidence decision to a more capable decision model or reasoning model.

---

## 6. Target Architecture

```text
                         Airo Runtime
                              |
                              v
                    Decision Orchestrator
                              |
        +---------------------+----------------------+
        |                     |                      |
        v                     v                      v
       Jev                   Clef              Clef Flash
        |                     |                      |
        +---------------------+----------------------+
                              |
                              v
                     Normalized Decision
                              |
                  +-----------+-----------+
                  |                       |
                  v                       v
                Action              LLM Escalation
```

The core runtime MUST depend only on the normalized Airo interfaces.

Provider SDKs, endpoints, credentials, response formats, and vendor-specific errors MUST remain inside provider adapters.

---

## 7. Required Module Structure

Recommended structure:

```text
src/
  decision/
    index.ts

    types.ts
    errors.ts
    config.ts

    orchestrator/
      DecisionOrchestrator.ts
      routing.ts
      fallback.ts
      confidence.ts

    providers/
      DecisionProvider.ts

      jev/
        JevDecisionProvider.ts
        jev.mapper.ts
        jev.types.ts

      cloudflare/
        CloudflareDecisionProvider.ts
        clef.mapper.ts
        clef.types.ts

    telemetry/
      DecisionTelemetry.ts
      DecisionEvent.ts

    testing/
      FakeDecisionProvider.ts
      fixtures.ts
```

Exact paths may follow the existing Airo repository conventions, but separation of concerns MUST remain equivalent.

---

## 8. Core Provider Interface

A provider-neutral interface MUST be introduced.

Example:

```ts
export interface DecisionProvider {
  readonly id: DecisionProviderId;

  readonly capabilities: DecisionProviderCapabilities;

  decide(
    request: DecisionRequest,
    context?: DecisionExecutionContext
  ): Promise<DecisionResponse>;

  healthCheck?(): Promise<DecisionProviderHealth>;
}
```

Provider IDs SHOULD initially include:

```ts
export type DecisionProviderId =
  | 'jev'
  | 'clef'
  | 'clef-flash';
```

The implementation SHOULD avoid hard-coding provider IDs throughout the application.

A registry SHOULD be used instead.

---

## 9. Normalized Request Model

Airo SHOULD expose a provider-neutral request:

```ts
export interface DecisionRequest {
  state: DecisionState;

  questions: Record<string, DecisionQuestion>;

  profile?: DecisionProfile;

  metadata?: Record<string, unknown>;

  timeoutMs?: number;
}
```

### 9.1 State

```ts
export type DecisionState =
  | string
  | Record<string, unknown>
  | unknown[];
```

Multimodal state SHOULD be modeled separately so providers without multimodal support can reject or transform it predictably.

Example future-compatible definition:

```ts
export interface MultimodalDecisionState {
  data: DecisionState;
  images?: DecisionImage[];
}
```

---

## 10. Question Types

Airo's internal decision schema SHOULD align with System One concepts without exposing provider-specific wire formats.

### Noul

```ts
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}
```

### Choice

```ts
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  options: string[];
}
```

### Score

```ts
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}
```

The abstraction MUST make it possible to extend question types later without changing the orchestrator.

---

## 11. Normalized Response

All providers MUST return the same Airo-level response structure.

Example:

```ts
export interface DecisionResponse {
  provider: DecisionProviderId;

  model: string;

  answers: Record<string, DecisionAnswer>;

  latencyMs: number;

  usage?: DecisionUsage;

  metadata?: DecisionResponseMetadata;
}
```

Example answer types:

```ts
export type DecisionAnswer =
  | NoulAnswer
  | ChoiceAnswer
  | ScoreAnswer;
```

A normalized answer SHOULD retain:

- selected result;
- probability distribution where available;
- confidence;
- provider-native metadata when useful;
- raw response only behind an explicit debug flag.

Application code MUST NOT inspect raw provider responses.

---

## 12. Provider Implementations

## 12.1 Jev

The existing Jev integration SHALL be refactored behind `JevDecisionProvider`.

Requirements:

- preserve current supported behavior;
- preserve current environment-variable compatibility where practical;
- map current requests into the normalized interface;
- map provider results into `DecisionResponse`;
- normalize provider errors;
- support configurable request timeout;
- expose latency;
- avoid breaking existing Airo workflows.

Jev SHOULD remain the initial default provider during migration.

---

## 12.2 Cloudflare Clef

A Cloudflare provider adapter SHALL support:

```text
@cf/cloudflare/clef
```

Expected role:

- high-precision decision workloads;
- difficult classifications;
- higher-value decisions;
- escalation from faster decision models.

The adapter MUST isolate all Cloudflare-specific concerns.

It SHALL support invocation through Cloudflare Workers AI-compatible APIs.

The implementation SHOULD allow transport to be replaced later, for example:

- direct Workers AI API;
- Cloudflare Worker proxy;
- AI Gateway;
- self-hosted compatible endpoint.

---

## 12.3 Cloudflare Clef Flash

A Cloudflare provider adapter SHALL support:

```text
@cf/cloudflare/clef-flash
```

Expected role:

- hot-path decisions;
- tool routing;
- agent dispatch;
- inexpensive classification;
- policy-related non-authoritative decisions;
- low-latency runtime decisions.

Clef Flash SHOULD become a candidate for Airo's fast decision profile after production benchmarking.

It SHALL NOT automatically replace Jev as the default as part of the initial implementation.

---

## 13. Provider Registry

Providers SHOULD be instantiated through a registry:

```ts
interface DecisionProviderRegistry {
  register(provider: DecisionProvider): void;

  get(id: DecisionProviderId): DecisionProvider;

  has(id: DecisionProviderId): boolean;

  list(): DecisionProvider[];
}
```

The orchestrator MUST resolve providers through the registry rather than constructing them directly.

This enables:

- dependency injection;
- testing;
- plugin-style future providers;
- local/self-hosted implementations;
- enterprise provider configuration.

---

## 14. Decision Profiles

Airo SHOULD introduce semantic profiles instead of making calling code pick a vendor directly.

Initial profiles:

```ts
export type DecisionProfile =
  | 'default'
  | 'fast'
  | 'high-precision'
  | 'cost-optimized';
```

Recommended initial mapping:

```text
default         -> Jev
fast            -> Clef Flash
high-precision  -> Clef
cost-optimized  -> Jev
```

These mappings MUST be configurable.

Application code SHOULD prefer:

```ts
profile: 'fast'
```

over:

```ts
provider: 'clef-flash'
```

unless explicit provider selection is required.

---

## 15. CLI Configuration

The CLI SHALL support explicit provider selection.

Example:

```bash
airo run --decision-provider jev
airo run --decision-provider clef
airo run --decision-provider clef-flash
airo run --decision-provider auto
```

The exact parent command may differ according to existing CLI structure.

Supported values SHALL include:

```text
jev
clef
clef-flash
auto
```

Invalid provider names MUST fail with a clear CLI validation error.

---

## 16. Configuration File

Example:

```yaml
decision:
  provider: auto

  profiles:
    default: jev
    fast: clef-flash
    highPrecision: clef
    costOptimized: jev

  providers:
    jev:
      enabled: true

    clef:
      enabled: true

    clef-flash:
      enabled: true

  fallback:
    enabled: true
    order:
      - jev
      - clef-flash
      - clef

  shadow:
    enabled: false
    provider: clef-flash
    sampleRate: 0.05

  escalation:
    enabled: true
    confidenceThreshold: 0.75
```

Configuration MUST support project-level and environment-level overrides according to existing Airo conventions.

---

## 17. Environment Variables

Secrets MUST NOT be stored in the config file by default.

Recommended variables:

```text
JEV_API_KEY=
JEV_BASE_URL=

CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_AI_GATEWAY_ID=
```

If Airo already defines secret-management conventions, those conventions SHALL take precedence.

Provider adapters MUST validate required configuration lazily or during startup validation.

Errors MUST identify the missing configuration but MUST NOT print secret values.

---

## 18. Auto Routing

`auto` mode SHALL route through the `DecisionOrchestrator`.

Initial routing MUST remain simple and deterministic.

Recommended version 1 behavior:

```text
profile=fast
    -> clef-flash

profile=high-precision
    -> clef

profile=cost-optimized
    -> jev

profile=default
    -> jev
```

The implementation MUST allow this table to be configured.

Do NOT implement ML-based routing in the first version.

---

## 19. Fallback

Fallback SHALL occur only for configured classes of provider failure.

Recommended fallback-triggering errors:

- timeout;
- network failure;
- provider unavailable;
- retryable HTTP 5xx;
- provider throttling where retry would exceed latency budget.

Fallback SHOULD NOT happen automatically for:

- invalid application schema;
- unsupported question type;
- invalid credentials;
- malformed configuration;
- deterministic validation failures.

Example:

```text
Jev
 |
 +-- success ------------------> result
 |
 +-- retryable failure
          |
          v
      Clef Flash
          |
          +-- success ----------> result
          |
          +-- retryable failure
                    |
                    v
                  Clef
```

Every fallback MUST be visible in telemetry.

---

## 20. Timeout Policy

Each provider request MUST have an explicit timeout.

Recommended configuration:

```yaml
decision:
  timeout:
    defaultMs: 1500
    jevMs: 2000
    clefMs: 1500
    clefFlashMs: 750
```

These numbers are starting defaults only and SHOULD be tuned using production data.

The total orchestration timeout MUST be bounded.

Fallback MUST respect the remaining overall latency budget.

---

## 21. Confidence Handling

Airo SHALL normalize provider confidence where practical.

The orchestrator SHOULD support:

```yaml
decision:
  confidence:
    minimum: 0.75
```

Low-confidence results MAY trigger:

1. a higher-precision decision provider;
2. an LLM reasoning escalation;
3. a safe no-op;
4. user confirmation;

depending on the policy attached to the decision.

Confidence MUST NOT by itself override deterministic security policies.

---

## 22. Decision-to-Reasoning Escalation

Decision models and reasoning models SHALL remain separate abstractions.

Example flow:

```text
Clef Flash
    |
    +-- confidence >= threshold ---> action
    |
    +-- confidence < threshold
                |
                v
              Clef
                |
                +-- confidence >= threshold ---> action
                |
                +-- confidence < threshold
                            |
                            v
                     Reasoning Model
```

Escalation SHOULD be configurable per decision class.

Sensitive or destructive actions SHOULD remain subject to existing Airo permission and confirmation policies regardless of decision confidence.

---

## 23. Shadow Mode

Airo SHALL support shadow inference.

Example:

```text
                     +----> Jev ----------> production result
request -------------|
                     +----> Clef Flash ---> telemetry only
```

Requirements:

- primary result MUST be returned without waiting for shadow result where technically possible;
- shadow output MUST NOT influence action execution;
- shadow failures MUST NOT fail the primary request;
- shadow calls MUST be independently timeout-bounded;
- shadow sampling MUST be configurable;
- telemetry MUST correlate primary and shadow decisions.

Config:

```yaml
decision:
  shadow:
    enabled: true
    provider: clef-flash
    sampleRate: 0.10
```

`sampleRate` MUST be within:

```text
0.0 <= sampleRate <= 1.0
```

---

## 24. Shadow Evaluation Metrics

For each comparable decision, Airo SHOULD record:

```text
decision_id
decision_type
primary_provider
shadow_provider
primary_model
shadow_model
primary_answer
shadow_answer
primary_confidence
shadow_confidence
primary_latency_ms
shadow_latency_ms
agreement
execution_outcome
timestamp
```

Where available, later business outcomes SHOULD be correlated with the original decision.

This enables Airo-specific benchmarks such as:

```text
tool-routing accuracy
task-routing accuracy
permission recommendation quality
agent selection accuracy
latency by decision category
cost by provider
provider failure rate
```

---

## 25. Telemetry Event

Example:

```ts
export interface DecisionTelemetryEvent {
  decisionId: string;

  profile: DecisionProfile;

  provider: DecisionProviderId;

  model: string;

  latencyMs: number;

  success: boolean;

  confidence?: number;

  fallbackFrom?: DecisionProviderId;

  shadow?: boolean;

  errorCode?: string;

  timestamp: string;
}
```

Telemetry MUST NOT contain secrets.

State payload logging MUST follow existing privacy/redaction policy.

Raw user content SHOULD NOT be logged by default.

---

## 26. Observability

At minimum Airo SHOULD expose:

- decision count by provider;
- success rate;
- provider error rate;
- timeout rate;
- p50 latency;
- p95 latency;
- fallback rate;
- average confidence;
- shadow agreement rate;
- escalation rate.

These metrics SHOULD eventually support provider comparison dashboards.

---

## 27. Error Model

Introduce normalized errors.

Example:

```ts
export type DecisionProviderErrorCode =
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';
```

Example:

```ts
export class DecisionProviderError extends Error {
  code: DecisionProviderErrorCode;
  provider: DecisionProviderId;
  retryable: boolean;
  cause?: unknown;
}
```

Business logic MUST use normalized error categories instead of vendor HTTP codes.

---

## 28. Retry Policy

Retries SHOULD be conservative.

Recommended:

- no retry for validation failures;
- no retry for authentication failures;
- max one retry for transient network failures;
- respect provider rate-limit hints;
- prefer fallback over repeated retry when latency-sensitive;
- add jitter if retry is used.

Retries MUST remain bounded by total execution timeout.

---

## 29. Capability Model

Providers SHOULD advertise capabilities.

Example:

```ts
export interface DecisionProviderCapabilities {
  questionTypes: Array<'noul' | 'choice' | 'score'>;

  maxQuestions?: number;

  text: boolean;

  structuredState: boolean;

  images: boolean;

  video: boolean;

  maxContextTokens?: number;
}
```

The orchestrator MUST reject incompatible requests before provider invocation where possible.

Clef-specific multimodal support MUST NOT be assumed for Jev unless verified by the active Jev integration.

---

## 30. Cloudflare Transport

The initial Cloudflare implementation MAY use direct Workers AI invocation.

The transport SHOULD be isolated:

```ts
interface CloudflareAITransport {
  run<TInput, TOutput>(
    model: string,
    input: TInput
  ): Promise<TOutput>;
}
```

This allows future switching between:

- REST API;
- Worker binding;
- AI Gateway;
- internal Airo Cloud proxy;
- customer-owned Cloudflare deployment.

The decision provider MUST NOT own global authentication state.

---

## 31. Cloudflare AI Gateway

AI Gateway support SHOULD be optional.

When configured, it MAY provide:

- centralized analytics;
- request logging subject to privacy configuration;
- gateway controls;
- billing visibility;
- operational observability.

Airo core MUST NOT require AI Gateway in order to use Clef.

---

## 32. Future Self-hosted Clef

The architecture MUST leave room for:

```text
self-hosted-clef
```

because Clef weights are available under Apache 2.0.

Self-hosting is out of scope for this phase.

However, the Cloudflare-hosted provider MUST NOT be named generically `ClefProvider` if doing so makes future local implementations ambiguous.

Recommended naming:

```text
CloudflareClefDecisionProvider
CloudflareClefFlashDecisionProvider
SelfHostedClefDecisionProvider   // future
```

---

## 33. Security Requirements

The implementation SHALL:

- never persist API keys in repository files;
- never emit secrets in logs;
- redact auth headers from diagnostics;
- validate TLS for remote providers;
- preserve existing Airo permissions;
- ensure decision output cannot bypass deterministic authorization;
- treat provider output as untrusted external data;
- validate provider responses before use;
- enforce schema boundaries at the adapter layer.

A decision model MUST NOT become an authorization authority by itself.

For example:

```text
decision model says "execute"
             |
             v
       Airo Policy Engine
             |
       allowed / denied
```

---

## 34. Privacy Requirements

Decision state MAY contain sensitive user or repository information.

Therefore:

- telemetry SHALL NOT log full state by default;
- shadow mode MUST follow the same privacy rules as primary inference;
- cloud provider use MUST be clearly configurable;
- future local-only mode MUST be supported architecturally;
- debug logs containing state MUST require explicit opt-in;
- persisted benchmark datasets MUST support redaction/anonymization.

---

## 35. Performance Requirements

The new abstraction layer MUST add negligible local overhead.

Target:

```text
provider orchestration overhead < 5 ms p95
```

excluding:

- network latency;
- provider inference;
- telemetry export.

Shadow execution MUST NOT block primary execution unless explicitly configured.

---

## 36. Caching

Decision caching SHOULD NOT be enabled globally in the first release.

A future cache MAY be appropriate for deterministic/repeated classification workloads.

Any future cache key MUST include at least:

```text
provider/model
normalized state hash
question schema hash
relevant policy version
```

Security-sensitive decisions MUST default to uncached execution.

---

## 37. Testing Requirements

The decision layer SHALL maintain Airo's existing testing quality bar.

If the repository standard is >=95% coverage, the new code SHALL meet that standard.

### Unit tests

Required for:

- request normalization;
- response normalization;
- routing;
- profile selection;
- confidence thresholds;
- fallback;
- retryability classification;
- timeouts;
- provider registry;
- configuration;
- shadow sampling;
- shadow isolation;
- error normalization.

### Provider adapter tests

Adapters MUST use mocked HTTP/transports.

Tests MUST cover:

```text
success
timeout
401 / auth error
429 / rate limit
5xx
invalid JSON
invalid provider schema
partial response
unsupported capability
```

### Orchestrator tests

Required scenarios:

```text
Jev success

Jev failure
  -> Clef Flash success

Clef Flash low confidence
  -> Clef success

primary success
  + shadow success

primary success
  + shadow failure

all providers unavailable

invalid configuration

explicit provider overrides auto routing
```

No CI test SHALL require live paid API access.

---

## 38. Contract Tests

Optional live contract tests SHOULD exist behind an explicit environment flag.

Example:

```bash
AIRO_LIVE_DECISION_TESTS=true pnpm test:decision:live
```

They SHALL NOT run by default in pull-request CI.

Live tests MAY verify that provider schemas still match Airo adapters.

---

## 39. Benchmark Harness

A lightweight benchmark command SHOULD be added.

Example:

```bash
airo decision benchmark ./fixtures/decisions.json
```

Possible output:

```text
Provider       Accuracy   Agreement   p50     p95
--------------------------------------------------
jev            93.2%      --          410ms   540ms
clef           95.8%      94.1%       190ms   250ms
clef-flash     94.7%      93.5%        42ms   120ms
```

Airo MUST distinguish:

- provider benchmark;
- business-outcome benchmark;
- synthetic fixture benchmark.

Provider marketing benchmarks MUST NOT be treated as Airo production results.

---

## 40. CLI Diagnostics

A diagnostic command SHOULD expose decision-model configuration without exposing credentials.

Example:

```bash
airo doctor decisions
```

Possible output:

```text
Decision mode: auto

Providers:
  jev         enabled   configured
  clef        enabled   configured
  clef-flash  enabled   configured

Profiles:
  default         -> jev
  fast            -> clef-flash
  high-precision  -> clef

Shadow mode:
  disabled
```

---

## 41. Feature Flags / Rollout

Recommended rollout:

### Phase 1 — Refactor

- place Jev behind `DecisionProvider`;
- preserve current behavior;
- no routing change.

### Phase 2 — Cloudflare providers

- add Clef;
- add Clef Flash;
- explicit provider selection only.

### Phase 3 — Shadow mode

- Jev remains primary;
- sample Clef/Clef Flash in shadow;
- collect real Airo workloads.

### Phase 4 — Auto routing

- activate semantic profiles;
- enable deterministic routing.

### Phase 5 — Adaptive policies

Only after sufficient telemetry:

- tune provider preference by workload;
- tune confidence thresholds;
- tune fallback order;
- optionally introduce outcome-aware routing.

---

## 42. Initial Production Policy

Recommended initial production configuration:

```yaml
decision:
  provider: auto

  profiles:
    default: jev
    fast: clef-flash
    highPrecision: clef
    costOptimized: jev

  fallback:
    enabled: true

  shadow:
    enabled: true
    provider: clef-flash
    sampleRate: 0.05

  escalation:
    enabled: true
```

Important:

Clef/Clef Flash SHOULD NOT immediately become the global default.

Real Airo workload telemetry SHOULD determine whether the default changes.

---

## 43. Acceptance Criteria

Implementation is complete when all of the following are true.

### Provider abstraction

- [ ] Existing Jev integration runs through `DecisionProvider`.
- [ ] Core runtime no longer depends directly on Jev SDK/API types.
- [ ] Provider registration is centralized.

### Clef support

- [ ] Clef provider implemented.
- [ ] Clef Flash provider implemented.
- [ ] System One-style question mapping implemented.
- [ ] Cloudflare responses normalized.
- [ ] Cloudflare errors normalized.

### Configuration

- [ ] `jev` selection works.
- [ ] `clef` selection works.
- [ ] `clef-flash` selection works.
- [ ] `auto` selection works.
- [ ] invalid configurations fail clearly.

### Routing

- [ ] decision profiles supported.
- [ ] configurable profile mapping supported.
- [ ] explicit provider overrides routing.

### Reliability

- [ ] request timeouts implemented.
- [ ] retryable/non-retryable errors distinguished.
- [ ] fallback implemented.
- [ ] fallback obeys total latency budget.

### Shadow mode

- [ ] sampling implemented.
- [ ] shadow inference cannot affect production decision.
- [ ] shadow failure cannot fail primary execution.
- [ ] primary/shadow results are correlated in telemetry.

### Observability

- [ ] provider recorded.
- [ ] model recorded.
- [ ] latency recorded.
- [ ] confidence recorded where available.
- [ ] fallback recorded.
- [ ] shadow status recorded.
- [ ] errors categorized.

### Security

- [ ] secrets excluded from logs.
- [ ] state excluded from telemetry by default.
- [ ] provider responses validated.
- [ ] Airo policy engine remains authoritative.

### Testing

- [ ] unit coverage meets repository threshold.
- [ ] provider adapters mocked in CI.
- [ ] fallback tests implemented.
- [ ] timeout tests implemented.
- [ ] shadow-mode tests implemented.
- [ ] live provider calls not required in PR CI.

---

## 44. Suggested Public API

Example:

```ts
const result = await decisionOrchestrator.decide({
  profile: 'fast',

  state: {
    command,
    repository,
    userIntent,
    availableTools,
  },

  questions: {
    shouldExecute: {
      type: 'noul',
      instructions: 'Should Airo execute the selected tool?',
    },

    targetAgent: {
      type: 'choice',
      instructions: 'Which agent should handle this task?',
      options: [
        'coding',
        'research',
        'operations',
      ],
    },
  },
});
```

Calling code SHOULD NOT need to know whether the result came from:

```text
Jev
Clef
Clef Flash
future provider
```

unless it explicitly requests a provider.

---

## 45. Long-term Direction

The final architecture should evolve toward:

```text
                       Business / User Intent
                                |
                                v
                         Airo Runtime
                                |
             +------------------+------------------+
             |                                     |
             v                                     v
        Policy Engine                     Decision Orchestrator
                                                   |
                         +-------------------------+------------------------+
                         |                         |                        |
                         v                         v                        v
                        Jev                      Clef                 Clef Flash
                         |                         |                        |
                         +-------------------------+------------------------+
                                                   |
                                             Confidence
                                                   |
                                  +----------------+----------------+
                                  |                                 |
                               enough                              low
                                  |                                 |
                                  v                                 v
                               Action                      Reasoning Model
                                                                |
                                                  Claude / GPT / Gemini
                                                                |
                                                                v
                                                              Action
```

This keeps Airo model-agnostic and establishes the decision layer as infrastructure rather than a vendor-specific feature.

---

## 46. Architectural Principle

The implementation MUST preserve the following principle:

> **Airo is not a Jev wrapper, a Clef wrapper, or an LLM wrapper. Airo is the orchestration runtime that decides which intelligence, tools, and execution path should be used for each task.**

