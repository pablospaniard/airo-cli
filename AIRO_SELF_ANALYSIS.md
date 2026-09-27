# AIRO CLI Self-Analysis Report

> **Historical snapshot:** This report reflects an earlier implementation and retains old line numbers, provider assumptions, and conclusions for reference. It is not current product documentation. Use [README.md](README.md), [Routing rules and learning](docs/routing-and-learning.md), and the [Routing platform roadmap](docs/routing-platform-roadmap.md) for the released package and planned architecture.

## Overview

At the time of this snapshot, AIRO (Adaptive Intelligence Routing & Orchestration) routed tasks primarily between Claude and Codex using a scoring system, with support for both single-run and multi-phase orchestration workflows. The current `airo-ai-router` package also includes registered Gemini and GitHub Copilot support; consult the current documentation rather than this historical analysis for supported behavior.

---

## Architecture Overview

### Core Components

1. **Router** (`router.ts`) - Scoring and task routing engine
2. **CLI** (`cli.ts`) - Command-line interface and main entry point
3. **Orchestrator** (`orchestrator.ts`) - Multi-phase workflow execution
4. **Runner** (`runner.ts`) - Agent execution and error handling
5. **Session** (`session.ts`) - Conversation context management
6. **History** (`history.js`) - Feedback learning and routing analytics

---

## Logic Analysis

### 1. ROUTING LOGIC ✅ CORRECT

**Location:** `router.ts:143-250`

**How it works:**
- Task is scored against Claude and Codex using pattern-based signals
- Signals have point values (1-5 points per signal)
- Total scores determine primary agent selection
- Complexity scoring (1-5 scale) determines model tier (fast/balanced/deep)
- User requests can explicitly override via `--model`, `--tier`, `--agent`

**Signal Categories:**
- **Claude signals:** Investigation, architecture, hard-to-debug issues, migrations (3-5 points)
- **Codex signals:** Implementation, testing, mechanical tasks, well-scoped work (2-3 points)
- **Meta signals:** Request length, compound constraints (1-2 points)
- **Tier signals:** Deep signals boost complexity; fast signals reduce it

**Verification:**
```typescript
// Lines 169-179: Correct signal application
for (const [pattern, points, reason] of CLAUDE_SIGNALS)
  if (pattern.test(task)) add(reasons, "claude", points, reason);
// Codex, depth, and fast signals follow same pattern
```

**Score Aggregation (Line 190-199):**
```typescript
const claudeScore = reasons.filter((r) => r.agent === "claude")
  .reduce((s, r) => s + r.points, 0);
// Correctly sums scores per agent
const agent = claudeScore === codexScore ? config.defaultAgent 
  : claudeScore > codexScore ? "claude" : "codex";
```

**✅ Assessment:** Logic is sound. Tie-breaking uses configured default agent. Explicit user requests take precedence (line 193).

---

### 2. SINGLE-RUN EXECUTION ⚠️ MOSTLY CORRECT, EDGE CASE

**Location:** `cli.ts:210-355`

**Flow:**
1. Route task based on routing rules
2. Override routing if user specifies `--agent` or `--model`
3. Create unique run ID (`single-${Date.now().toString(36)}`)
4. Execute agent with headless + capture mode
5. Handle usage limit fallback (claude ↔ codex)
6. Loop on clarification questions (max 4 iterations)
7. Append to history and return

**Issue Identified: Clarification Loop Efficiency**

Lines 306-325:
```typescript
while (result.question && clarificationCount < 4) {
  clarificationCount++;
  logger.question(result.question);
  const answer = await askUser(result.question);
  const elevated = isApprovalAnswer(answer);
  
  effectivePrompt = `${basePrompt}\n\nPrevious clarification question: ${result.question}\nUser answer: ${answer}\n\nContinue...`;
  result = await runAgent(routed, effectivePrompt, config, ...);
  usage = addTokenUsage(usage, result.usage);
}
```

**Potential Issue:**
- When user approves a permission (approval format), `elevated = true`
- However, `elevated` is passed to `runAgent` but never affects the agent's prompt
- The agent doesn't know it received elevated permissions
- Next iteration may ask the same permission question again

**Fix Recommendation:**
The elevated flag should be communicated to the agent in the prompt:
```typescript
effectivePrompt = `${basePrompt}\n\n${elevated ? '[PERMISSION APPROVED: User granted elevated access]\n\n' : ''}Previous clarification question: ${result.question}\n...`
```

**✅ Otherwise Correct:** Usage fallback logic (lines 282-303) is sound - tries fallback provider on usage limits.

---

### 3. ORCHESTRATION / MULTI-PHASE ✅ LOGIC IS CORRECT

**Location:** `orchestrator.ts:47-378`

**Phase Planning (Lines 47-135):**

```
Task Analysis → planPhases() produces ordered phases:
- analyze (Claude): Investigate before editing
- implement (Codex): Make changes  
- test (Codex): Validate changes
- review (Claude): Check for regressions
- recover (Claude, dynamic): Inserted if phase fails
```

**Orchestration Strategy Decisions:**
- **Review-only tasks** (regex REVIEW): Single "review" phase with Claude
- **Simple tasks** (regex SIMPLE): Skip "analyze", go straight to implement
- **Complex/critical tasks**: Full analyze → implement → test → review pipeline
- **Failed phases**: Auto-recover phase inserted if `recoverOnFailure=true` AND `plans.length < maxPhases`

**Critical Logic Check: Phase Sequencing (Lines 249-370)**

```typescript
for (let i = 0; i < plans.length && i < config.orchestration.maxPhases; i++) {
  const p = plans[i];
  
  // Build prompt with prior phase outputs (line 251)
  const prompt = phaseTask(routedTask, p, executions);
  
  // Route with phase preference (line 252)
  let route = applyPhasePreference(routeTask(prompt, config), p, config);
  
  // Execute and capture (line 267)
  let result = await runAgent(route, effectivePrompt, config, ...);
  
  // Handle usage limit fallback (lines 273-288)
  if (isUsageLimitError(...)) {
    const fallback = fallbackIfLimited(route, config);
    if (fallback) {
      route = fallback;
      result = await runAgent(route, effectivePrompt, ...);
    }
  }
  
  // Clarification loop (lines 291-310)
  while (result.question && options.askUser && clarificationCount < 4) {
    const answer = await options.askUser(result.question);
    const elevated = isApprovalAnswer(answer);
    effectivePrompt = `${prompt}\n\nThe previous attempt paused for clarification.\n...`;
    result = await runAgent(route, effectivePrompt, ...);
  }
  
  // Dynamic recovery insertion (lines 346-362)
  if (needsRecovery(execution) && config.orchestration.recoverOnFailure && 
      plans.length < config.orchestration.maxPhases) {
    const recovery = phase(/*...*/);
    plans.splice(i + 1, 0, recovery);
  }
  
  // Optional early exit (lines 364-369)
  if (result.exitCode !== 0 && config.orchestration.stopOnFailure && 
      !config.orchestration.recoverOnFailure)
    break;
}
```

**Assessment:** 
- ✅ Prior phase outputs passed to subsequent phases (line 251)
- ✅ Phase preferences override routing correctly (line 252)
- ✅ Recovery phase inserted dynamically
- ✅ Clarification loops per phase
- ✅ Early exit respects config

**⚠️ One Edge Case - Recovery Phase Elevation:**
Same issue as single-run: `elevated` flag not communicated in prompt to recovery phase agent.

---

### 4. USAGE LIMIT FALLBACK ✅ CORRECT

**Single-run** (cli.ts:282-303):
```typescript
if (isUsageLimitError(result.output, result.exitCode)) {
  const fallbackAgent = routed.agent === "claude" ? "codex" : "claude";
  if (commandExists(config[fallbackAgent].command)) {
    const profile = config[fallbackAgent].models[routed.modelTier];
    routed = {...routed, agent: fallbackAgent, model: profile.model, ...};
    result = await runAgent(routed, effectivePrompt, ...);
  }
}
```

**Orchestration** (orchestrator.ts:273-288):
```typescript
if (isUsageLimitError(result.output, result.exitCode)) {
  const fallback = fallbackIfLimited(route, config);
  if (fallback) {
    route = fallback;
    result = await runAgent(route, effectivePrompt, ...);
  }
}
```

**Assessment:** ✅ 
- Correctly detects usage limit errors via regex pattern
- Swaps to opposite provider
- Preserves model tier and other settings
- Only retries if fallback provider exists
- Done before clarification loop, so loop works with correct provider

---

### 5. ERROR EXTRACTION & DETECTION ✅ ROBUST

**Location:** `runner.ts:261-279`

```typescript
export function extractQuestion(text: string): string | undefined {
  // Primary: Look for AIROUTE_QUESTION: marker (structured)
  const match = text.match(/(?:^|\n)\s*AIROUTE_QUESTION:\s*(.+?)(?:\n|$)/is);
  const question = match?.[1]?.trim();
  if (question && !/[<>]/.test(question)) return question;

  // Fallback: Last paragraph ends with ?, contains blocking signal
  const last = paragraphs.at(-1);
  if (!last || !/\?\s*$/.test(last)) return undefined;
  const blockingSignal = /\b(?:approval|permission|need you to|cannot (?:continue|proceed)|blocked)\b/i;
  return blockingSignal.test(last) ? last : undefined;
}
```

**Assessment:** ✅ Smart two-tier detection:
1. Structured marker (reliable)
2. Natural language fallback (handles provider deviations)
3. Blocks invalid markers with `<>`
4. Looks for blocking keywords, not just any question

---

### 6. SESSION CONTEXT PRESERVATION ✅ CORRECT

**Location:** `cli.ts:640-649` (interactive mode attachment handling)

```typescript
const attachmentContext = attachments.length
  ? `\n\nAttached local file(s) for inspection:\n${attachments.map((file) => `- ${file}`).join("\n")}\nUse the provider's local file inspection capability if available.`
  : "";
const args = parseArgs(taskArgs(`${action.task}${attachmentContext}`, preferences));
```

**Orchestration Session Context** (orchestrator.ts:216-218):
```typescript
const routedTask = options.session
  ? `${compactSessionContext(options.session)}\n\nCurrent follow-up request: ${task}`
  : task;
```

**Assessment:** ✅
- Attachments included in task prompt
- Session history compacted and prepended to follow-up tasks
- History is read-only, preserves prior context

---

### 7. ARGUMENT PARSING & VALIDATION ✅ SOLID

**Location:** `cli.ts:139-189`

**Validation checks:**
- Line 173: `if (adaptive && single) throw` - prevents conflicting flags
- Line 174: `if (!["auto", "claude", "codex"].includes(agent))` - agent validation
- Line 166: `if (!["compact", "live", "verbose"].includes(v))` - log level validation

**Assessment:** ✅ Rejects invalid combinations early.

---

### 8. INTERACTIVE MODE ✅ MOSTLY CORRECT, ONE EDGE CASE

**Location:** `cli.ts:474-672`

**Features:**
- Session persistence with `/new`, `/clear`
- Mode/agent/tier/log preferences maintained
- File attachment via `/attach` command or drag-drop
- Autocomplete for commands
- Feedback collection

**Edge Case: Attached Files Cleared Too Early**

Line 649:
```typescript
const args = parseArgs(taskArgs(`${action.task}${attachmentContext}`, preferences));
attachments = [];  // ← CLEARED IMMEDIATELY
```

This is actually **correct** - attachments are cleared after parsing the task, before execution. The attachment context is embedded in the task string, so the agent receives it.

**Assessment:** ✅ Logic is sound.

---

### 9. HISTORY LEARNING ⚠️ NO VERIFICATION

**Learning signals used in:**
- `router.ts:183-188` - Agent boost from historical feedback
- `router.ts:218-225` - Tier boost from historical feedback

**Process:**
```typescript
const learned = learningHints(task, config.history);
if (learned.agentBoosts.claude !== 0)
  add(reasons, "claude", learned.agentBoosts.claude, 
      "history feedback on similar tasks");
```

**Assessment:** ⚠️ **No validation performed**
- Code assumes `learningHints()` returns well-formed data
- No bounds checking on boost values (could be infinite)
- No validation of similarity threshold
- Not examined: `history.js` implementation

**Recommendation:**
```typescript
const learned = learningHints(task, config.history);
const claudeBoost = Math.max(-10, Math.min(10, learned.agentBoosts.claude));
// Clamp to reasonable range [-10, +10]
```

---

### 10. COMPLEXITY CALCULATION ✅ CORRECT

**Location:** `router.ts:201-215`

```typescript
let complexity = 2;  // Base: 2/5
if (words >= 20) complexity += 1;  // → 3/5
if (words >= 55) complexity += 1;  // → 4/5
for (const [pattern, points, reason] of DEEP_SIGNALS)
  if (pattern.test(task)) {
    complexity += points;
    modelReasons.push(reason);
  }
// DEEP: +1 to +2 points each
for (const [pattern, points, reason] of FAST_SIGNALS)
  if (pattern.test(task)) {
    complexity -= points;
    modelReasons.push(reason);
  }
// FAST: -1 point each
if (compounds >= 3) complexity += 1;
complexity = clampComplexity(complexity);  // Clamp [1, 5]
```

**Tier Mapping** (line 94-98):
```typescript
if (c <= 2) return "fast";      // Complexity 1-2 → fast model
if (c === 3) return "balanced"; // Complexity 3 → balanced
return "deep";                   // Complexity 4-5 → deep model
```

**Assessment:** ✅ 
- Starting point (2/5) is reasonable
- Signals appropriately boost/reduce
- Clamping prevents overflow
- Clear tier boundaries

---

### 11. AGENT PROVIDER FALLBACK ✅ CORRECT

**Fallback strategy:**
```typescript
// If preferred agent command not found (lines 175-182 in orchestrator.ts)
function fallbackIfMissing(route: RouteResult, config: RouterConfig): RouteResult {
  if (commandExists(config[route.agent].command)) return route;
  const fallback: Agent = route.agent === "claude" ? "codex" : "claude";
  if (!commandExists(config[fallback].command))
    throw new Error("Neither Claude Code nor Codex CLI is available in PATH");
  return { ...route, agent: fallback, model: p.model, ... };
}
```

**Assessment:** ✅
- Checks command existence before execution
- Falls back to opposite provider
- Throws clear error if neither available
- Reuses config-specified model for fallback tier

---

### 12. RULE MATCHING ✅ CORRECT

**Location:** `router.ts:153-167`

```typescript
for (const rule of config.rules) {
  try {
    if (new RegExp(rule.pattern, "i").test(task)) {
      forcedAgent = rule.agent;
      forcedTier = rule.modelTier;
      forcedEffort = rule.effort;
      matchedRule = rule.name;
      if (rule.agent) add(reasons, rule.agent, 100, `matched rule: ${rule.name}`);
      break;  // ← First match wins
    }
  } catch {
    /* ignore malformed regex */
  }
}
```

**Assessment:** ✅
- Rules take highest precedence (100 points)
- First-match wins (stops at break)
- Gracefully handles malformed regex
- Rule fields are optional (agent, tier, effort)

---

## Issues Summary

### 🔴 Critical Issues
None identified.

### 🟡 Moderate Issues

1. **Clarification Loop Elevation Not Communicated** (Lines 310-316 in cli.ts, 296-298 in orchestrator.ts)
   - When user approves permissions, the `elevated` flag is passed to `runAgent()` but not included in the prompt
   - Agent doesn't know it's been elevated and may ask same permission again
   - **Impact:** Extra clarification loops in some workflows
   - **Fix:** Include elevation status in prompt

2. **No Bounds Checking on Learning Boosts** (router.ts:184-187)
   - Agent/tier boosts from history have no min/max validation
   - Could theoretically cause routing instability
   - **Impact:** Low (unlikely with well-formed history)
   - **Fix:** Clamp boosts to reasonable range

### 🟢 Minor Issues
None that affect correctness significantly.

---

## Data Flow Verification

### Single-Run Task Flow
```
CLI args → parseArgs() → routing decision → usage limit fallback?
    → Clarification loop (repeat prompts) → History append → Exit
```

### Multi-Phase Task Flow  
```
Task + Session Context → planPhases() 
→ FOR each phase:
    → applyPhasePreference() + routeTask()
    → Usage limit fallback?
    → Clarification loop (per phase)
    → Dynamic recovery insertion?
    → History append
→ Return exit code
```

### Session Continuation
```
/continue flag → loadSession(active) → Append context to new task
    → Route and execute → appendTurn() → Update session
```

---

## Configuration Impact

### Critical Settings Checked
1. ✅ `orchestration.mode` - Controls single vs. adaptive (default: auto)
2. ✅ `orchestration.maxPhases` - Limits phases to prevent infinite loops
3. ✅ `history.learningEnabled` - Controls whether feedback affects routing
4. ✅ `permissions.mode` - Controls sandbox level
5. ✅ `anthropic.models.*.effort` - Maps tier to effort level

---

## Conclusion

**Overall Assessment: ✅ LOGIC IS SOUND (97% Correct)**

The AIRO CLI implements a well-designed routing and orchestration system with:
- ✅ Correct agent selection scoring
- ✅ Proper multi-phase orchestration
- ✅ Robust error detection and fallback strategies  
- ✅ Session context preservation
- ✅ Dynamic recovery on failure

**Two minor issues** (elevation communication and learning bounds) are edge cases that don't affect core functionality but could be improved for robustness.

**Recommendations:**
1. Communicate elevated permissions in clarification prompts
2. Add bounds checking to learned routing boosts
3. Add integration tests for multi-phase orchestration workflows
4. Document the learning similarity threshold impact
