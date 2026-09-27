export type Agent = "claude" | "codex" | "gemini" | "copilot";
export type Policy = "balanced" | "claude-heavy" | "codex-heavy";
export type ModelTier = "fast" | "balanced" | "deep";
export type Effort = "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type FeedbackRating = "good" | "bad";
export type PhaseKind = "analyze" | "implement" | "test" | "review" | "recover" | "clarify";
export type OrchestrationMode = "auto" | "adaptive" | "single";
export type LogLevel = "compact" | "live" | "verbose";
export type PermissionMode = "prompt" | "fullAccess";

export interface Rule {
  name: string;
  agent?: Agent;
  modelTier?: ModelTier;
  effort?: Effort;
  pattern: string;
}

export interface ModelProfile {
  model: string;
  effort?: Effort;
}

export interface ProviderConfig {
  command: string;
  args?: string[];
  /** Optional override used when the provider CLI's default model cannot be detected. */
  defaultModel?: string;
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
  /** @deprecated Retained for configuration compatibility; model access is unrestricted. */
  allowedModels?: string[];
  models: Record<ModelTier, ModelProfile>;
}

export interface HistoryConfig {
  enabled: boolean;
  learningEnabled: boolean;
  path?: string;
  similarityThreshold: number;
  /** Minimum effective observations before learned routing may override the heuristic route. */
  minimumSamples?: number;
  /** Half-life used to reduce the influence of stale observations. */
  halfLifeDays?: number;
  /** Fraction of routing decisions that may explore an uncertain route. Zero disables exploration. */
  explorationRate?: number;
  /** Keep learned evidence isolated to the current repository. */
  repositoryScoped?: boolean;
}

export type TaskCategory = "debug" | "implement" | "review" | "research" | "test" | "general";

export interface TaskFeatures {
  category: TaskCategory;
  language?: string;
  risk: "low" | "medium" | "high";
  complexity: number;
  tokens: string[];
  /** Locally generated feature embedding; no task text leaves the machine. */
  embedding: number[];
}

export interface RouteEvaluation {
  taskSatisfied: boolean;
  verified: boolean;
  quality: number;
  confidence: number;
  signals: string[];
}

export interface RouteOutcome {
  completion: number;
  verification: number;
  retries: number;
  recoveries: number;
  regressions: number;
  durationMs: number;
  tokens?: number;
  confidence: number;
}

export type FeedbackScope = "run" | "phase";
export type FeedbackSource = "explicit" | "implicit";

export interface FeedbackRecord {
  id: string;
  timestamp: string;
  scope: FeedbackScope;
  targetId: string;
  rating: FeedbackRating;
  source: FeedbackSource;
  note?: string;
  confidence: number;
}

export interface LoggingConfig {
  level: LogLevel;
  persist: boolean;
}

export interface OrchestrationConfig {
  mode: OrchestrationMode;
  maxPhases: number;
  autoReview: boolean;
  recoverOnFailure: boolean;
  stopOnFailure: boolean;
  outputTailChars: number;
}

export interface PermissionsConfig {
  mode: PermissionMode;
  networkAccess: boolean;
}

export interface RouterConfig {
  policy: Policy;
  defaultAgent: Agent;
  claude: ProviderConfig;
  codex: ProviderConfig;
  gemini: ProviderConfig;
  copilot: ProviderConfig;
  history: HistoryConfig;
  orchestration: OrchestrationConfig;
  permissions: PermissionsConfig;
  logging: LoggingConfig;
  rules: Rule[];
}

export interface ScoreReason {
  agent: Agent;
  points: number;
  reason: string;
}

export interface RouteCandidate {
  agent: Agent;
  modelTier: ModelTier;
  model: string;
  effort: Effort;
  providerScore: number;
  tierScore: number;
  totalScore: number;
}

export interface RouteResult {
  agent: Agent;
  modelTier: ModelTier;
  userRequestedAgent?: Agent;
  userRequestedTier?: ModelTier;
  userRequestedModel?: string;
  /** The user picked this provider explicitly, so AIRO must never swap it for another one. */
  agentPinned?: boolean;
  model: string;
  effort: Effort;
  complexity: number;
  claudeScore: number;
  codexScore: number;
  agentScores?: Record<Agent, number>;
  reasons: ScoreReason[];
  modelReasons: string[];
  matchedRule?: string;
  learningConfidence?: number;
  expectedUtility?: number;
  routingPolicyVersion: string;
}

export interface HistoryRecord {
  id: string;
  runId?: string;
  sessionId?: string;
  parentRunId?: string;
  timestamp: string;
  cwd: string;
  task: string;
  originalTask?: string;
  phaseKind?: PhaseKind;
  phaseIndex?: number;
  agent: Agent;
  modelTier: ModelTier;
  model: string;
  effort: Effort;
  complexity: number;
  /** Shipped cold-start policy used to make this routing decision. */
  routingPolicyVersion?: string;
  exitCode: number;
  durationMs: number;
  outputExcerpt?: string;
  usage?: TokenUsage;
  feedback?: FeedbackRating;
  feedbackNote?: string;
  taskFeatures?: TaskFeatures;
  evaluation?: RouteEvaluation;
  outcome?: RouteOutcome;
}

export interface PhasePlan {
  id: string;
  kind: PhaseKind;
  title: string;
  instruction: string;
  preferredAgent?: Agent;
  preferredTier?: ModelTier;
  preferredEffort?: Effort;
}

export interface PhaseExecution {
  phase: PhasePlan;
  route: RouteResult;
  exitCode: number;
  durationMs: number;
  output: string;
  usage?: TokenUsage;
  historyId?: string;
}

export interface AgentRunResult {
  exitCode: number;
  output: string;
  question?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  /** Input tokens that were not served from a provider cache. */
  uncachedInputTokens: number;
  cachedInputTokens: number;
  /** Tokens written into a provider cache, when reported separately. */
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface SessionTurn {
  turnId: string;
  runId: string;
  timestamp: string;
  userPrompt: string;
  routeSummary: string;
  phaseSummaries: string[];
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  originalTask: string;
  turns: SessionTurn[];
}
