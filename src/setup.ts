import readline, { type Interface } from "node:readline";
import { discoverCatalogs, resolveDynamicModels } from "./catalog.js";
import { loadConfig, writeGlobalConfig } from "./config.js";
import { AGENTS } from "./providers.js";
import { agentColor, divider, promptLabel, statusIcon, ui } from "./ui.js";

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(`${promptLabel()}${question} `, resolve));
}

export async function runSetup(): Promise<string> {
  const existing = loadConfig().config;
  const config = structuredClone(existing);

  console.log("");
  console.log(ui.bold(ui.cyan("╭────────────────────────────────────────────────────────╮")));
  console.log(ui.bold(ui.cyan("│                    AIRO SETUP                         │")));
  console.log(ui.bold(ui.cyan("╰────────────────────────────────────────────────────────╯")));
  console.log(
    `${statusIcon("info")} ${ui.bold("Provider models are discovered and mapped to tiers automatically.")}`,
  );
  console.log(
    `${ui.gray("Override")} ${ui.yellow('Set modelRouting.mode to "manual" to pin configured tier mappings.')}`,
  );
  console.log(`${ui.gray("Config  ")} ${ui.cyan("~/.config/airo/config.json")}`);

  console.log("");
  console.log(divider("Detected model routing"));
  const catalogs = await discoverCatalogs(config, { refresh: true, online: true });
  const resolved = resolveDynamicModels(config, catalogs);
  for (const agent of AGENTS) {
    const catalog = catalogs[agent];
    const mapping = (["fast", "balanced", "deep"] as const)
      .map((tier) => `${tier}=${resolved[agent].models[tier].model}`)
      .join(" · ");
    console.log(
      `  ${agentColor(agent, agent.padEnd(7))} ${
        catalog.detectedModels.length
          ? ui.cyan(`${catalog.detectedModels.length} detected`)
          : ui.yellow("using reviewed fallbacks")
      } ${ui.gray(`· ${mapping}`)}`,
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("");
    console.log(divider("Provider permissions"));
    console.log(
      ui.dim(
        "Prompt mode allows workspace edits and optionally network access, then asks before unrestricted system access.",
      ),
    );
    console.log(
      ui.dim(
        "Full access removes provider permission prompts; use it only in an environment you fully trust.",
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
      `${statusIcon("info")} ${ui.gray("Models refresh automatically; inspect the current mapping with")} ${ui.bold("airo models")}`,
    );
    return file;
  } finally {
    rl.close();
  }
}
