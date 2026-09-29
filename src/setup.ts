import readline from "node:readline";
import { loadConfig, writeGlobalConfig } from "./config.js";
import type { Agent, Effort, ModelProfile, ModelTier, RouterConfig } from "./types.js";
import { agentColor, divider, promptLabel, statusIcon, ui } from "./ui.js";
import { detectDefaultModels } from "./account.js";
import { discoverCatalogs } from "./catalog.js";
import { AGENTS, providerDefinition } from "./providers.js";

function ask(rl: any, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(`${promptLabel()}${question} `, resolve));
}

function parseSelection(input: string, max: number): number[] {
  return [
    ...new Set(
      input
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= max),
    ),
  ];
}

async function pickModels(
  rl: any,
  agent: Agent,
  candidates: string[],
  current: string[],
): Promise<string[]> {
  console.log("");
  console.log(divider(`${agentColor(agent, agent.toUpperCase())} models`));
  console.log(ui.dim("Choose which models are available when mapping the three automatic tiers."));
  candidates.forEach((m, i) => {
    const selected = current.includes(m);
    console.log(
      `  ${selected ? statusIcon("ok") : ui.gray("○")} ${ui.cyan(String(i + 1).padStart(2))}  ${ui.bold(m)}`,
    );
  });
  const defaults = candidates
    .map((m, i) => (current.includes(m) ? i + 1 : 0))
    .filter(Boolean)
    .join(",");
  const answer = (
    await ask(rl, `Select ${agentColor(agent, agent)} models [${ui.dim(defaults || "all")}]:`)
  ).trim();
  const indexes = answer
    ? parseSelection(answer, candidates.length)
    : defaults
      ? parseSelection(defaults, candidates.length)
      : candidates.map((_, i) => i + 1);
  const selected = indexes.length ? indexes.map((i) => candidates[i - 1]) : current;
  const extra = (
    await ask(
      rl,
      `Additional ${agentColor(agent, agent)} model IDs, comma-separated [${ui.dim("none")}]:`,
    )
  ).trim();
  const extras = extra
    ? extra
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  return [...new Set([...selected, ...extras])];
}

async function pickTier(
  rl: any,
  agent: Agent,
  tier: ModelTier,
  models: string[],
  current: ModelProfile,
): Promise<ModelProfile> {
  console.log("");
  console.log(`${statusIcon("info")} ${ui.bold(tier.toUpperCase())} ${ui.gray("tier")}`);
  models.forEach((m, i) =>
    console.log(
      `    ${m === current.model ? statusIcon("ok") : ui.gray("○")} ${ui.cyan(String(i + 1))} ${m}`,
    ),
  );
  const currentIndex = Math.max(0, models.indexOf(current.model));
  const answer = (await ask(rl, `Model for ${ui.bold(tier)} [${currentIndex + 1}]:`)).trim();
  const idx =
    answer && Number(answer) >= 1 && Number(answer) <= models.length
      ? Number(answer) - 1
      : currentIndex;
  if (!providerDefinition(agent).capabilities.effortControl)
    return { model: models[idx], effort: "auto" };
  const effort = ((
    await ask(rl, `Effort for ${ui.bold(tier)} [${ui.dim(current.effort ?? "auto")}]:`)
  ).trim() ||
    current.effort ||
    "auto") as Effort;
  return { model: models[idx], effort };
}

export async function runSetup(): Promise<string> {
  const existing = loadConfig().config;
  const config: RouterConfig = JSON.parse(JSON.stringify(existing));

  console.log("");
  console.log(ui.bold(ui.cyan("╭────────────────────────────────────────────────────────╮")));
  console.log(ui.bold(ui.cyan("│                    AIRO SETUP                         │")));
  console.log(ui.bold(ui.cyan("╰────────────────────────────────────────────────────────╯")));
  console.log(
    `${statusIcon("info")} ${ui.bold("Choose three automatic defaults; explicit requests can use any provider model.")}`,
  );
  console.log(`${ui.gray("Config")} ${ui.cyan("~/.config/airo/config.json")}`);
  console.log(
    `${ui.gray("Tip   ")} ${ui.yellow("Run `airo setup` anytime to review or change this list.")}`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(ui.dim("Detecting the models each provider can run…"));
    const catalogs = await discoverCatalogs(config, { refresh: true, online: true });
    for (const agent of AGENTS) {
      const catalog = catalogs[agent];
      console.log(
        `  ${agentColor(agent, agent.padEnd(6))} ${
          catalog.source === "builtin"
            ? ui.yellow(
                `not detected${catalog.note ? ` · ${catalog.note}` : ""}; using configured ids`,
              )
            : ui.gray(`${catalog.models.length} via ${catalog.via ?? catalog.source}`)
        }`,
      );
    }
    const candidatesFor = (agent: Agent) => catalogs[agent].models.map((model) => model.id);
    const claudeCandidates = candidatesFor("claude");
    const codexCandidates = candidatesFor("codex");
    const geminiCandidates = candidatesFor("gemini");
    const copilotCandidates = candidatesFor("copilot");
    const claudeModels = await pickModels(rl, "claude", claudeCandidates, claudeCandidates);
    const codexModels = await pickModels(rl, "codex", codexCandidates, codexCandidates);
    const geminiModels = await pickModels(rl, "gemini", geminiCandidates, geminiCandidates);
    const copilotModels = await pickModels(rl, "copilot", copilotCandidates, copilotCandidates);
    delete config.claude.allowedModels;
    delete config.codex.allowedModels;
    delete config.gemini.allowedModels;
    delete config.copilot.allowedModels;

    console.log("");
    console.log(divider("Tier mapping"));
    console.log(ui.dim("Map your selected models to fast / balanced / deep."));
    for (const agent of AGENTS) {
      console.log("");
      console.log(ui.bold(agentColor(agent, agent.toUpperCase())));
      for (const tier of ["fast", "balanced", "deep"] as const) {
        const candidates =
          agent === "claude"
            ? claudeModels
            : agent === "codex"
              ? codexModels
              : agent === "gemini"
                ? geminiModels
                : copilotModels;
        config[agent].models[tier] = await pickTier(
          rl,
          agent,
          tier,
          candidates,
          config[agent].models[tier],
        );
      }
    }

    console.log("");
    console.log(divider("Usage comparison"));
    console.log(ui.dim("AIRO compares measured runs with each provider's normal default model."));
    const detectedDefaults = detectDefaultModels(config);
    for (const agent of AGENTS) {
      const current = config[agent].defaultModel;
      const automatic = detectedDefaults[agent] ?? "not detected";
      const hint = current ? current : `auto: ${automatic}`;
      const answer = (
        await ask(rl, `Default ${agentColor(agent, agent)} model for comparison [${ui.dim(hint)}]:`)
      ).trim();
      if (answer.toLowerCase() === "auto") delete config[agent].defaultModel;
      else if (answer) config[agent].defaultModel = answer;
    }

    const tie = (
      await ask(
        rl,
        `Default provider on a tie [${agentColor(config.defaultAgent, config.defaultAgent)}]:`,
      )
    )
      .trim()
      .toLowerCase();
    if (tie === "claude" || tie === "codex") config.defaultAgent = tie;

    console.log("");
    console.log(divider("Provider permissions"));
    console.log(
      ui.dim(
        "Prompt mode allows workspace edits and optionally network access, then asks before a provider needs unrestricted system access.",
      ),
    );
    console.log(
      ui.dim(
        "Full access lets every provider run commands without permission prompts; use it only in a trusted environment.",
      ),
    );
    const permissionAnswer = (
      await ask(
        rl,
        `Permission mode: prompt or full [${ui.dim(config.permissions.mode === "fullAccess" ? "full" : "prompt")}]:`,
      )
    )
      .trim()
      .toLowerCase();
    if (permissionAnswer === "full" || permissionAnswer === "fullaccess")
      config.permissions.mode = "fullAccess";
    else if (permissionAnswer === "prompt") config.permissions.mode = "prompt";

    if (config.permissions.mode === "prompt") {
      const networkDefault = config.permissions.networkAccess ? "yes" : "no";
      const networkAnswer = (
        await ask(rl, `Allow provider commands to access the network [${ui.dim(networkDefault)}]:`)
      )
        .trim()
        .toLowerCase();
      if (["yes", "y"].includes(networkAnswer)) config.permissions.networkAccess = true;
      else if (["no", "n"].includes(networkAnswer)) config.permissions.networkAccess = false;
    }

    const file = writeGlobalConfig(config);
    console.log("");
    console.log(divider("Setup complete"));
    console.log(`${statusIcon("ok")} ${ui.green("Saved")} ${ui.cyan(file)}`);
    console.log(
      `${statusIcon("info")} ${ui.yellow("Review/modify later:")} ${ui.bold("airo setup")} ${ui.gray("or edit the config file directly")}`,
    );
    console.log(
      `${statusIcon("info")} ${ui.gray("Inspect active mapping:")} ${ui.bold("airo models")}`,
    );
    return file;
  } finally {
    rl.close();
  }
}
