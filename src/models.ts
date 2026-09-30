import { AGENTS, catalogAge, discoverCatalogs, resolveDynamicModels } from "./catalog.js";
import { loadConfig } from "./config.js";
import { agentColor, divider, statusIcon, ui } from "./ui.js";

export async function printModels() {
  const { config, path } = loadConfig();
  const catalogs = await discoverCatalogs(config);
  const resolved = resolveDynamicModels(config, catalogs);
  console.log("");
  console.log(divider("Active model configuration"));
  console.log(`${ui.gray("config")} ${path ? ui.cyan(path) : ui.yellow("built-in defaults")}`);
  console.log(`${ui.gray("mode  ")} ${ui.cyan(config.modelRouting.mode)}`);
  for (const agent of AGENTS) {
    const catalog = catalogs[agent];
    console.log("");
    console.log(`${statusIcon("info")} ${ui.bold(agentColor(agent, agent.toUpperCase()))}`);
    console.log(`  ${ui.gray("access ")} ${ui.bold("all provider models")}`);
    console.log(
      `  ${ui.gray("detected")} ${
        catalog.source === "builtin"
          ? ui.yellow(`none · using configured ids${catalog.note ? ` (${catalog.note})` : ""}`)
          : ui.cyan(`${catalog.detectedModels.length} via ${catalog.via ?? catalog.source}`) +
            ui.gray(` · ${catalogAge(catalog)}`)
      }`,
    );
    if (catalog.detectedModels.length)
      console.log(
        `  ${ui.gray("models  ")} ${catalog.detectedModels.map((model) => ui.cyan(model.id)).join(ui.gray(" · "))}`,
      );
    for (const tier of ["fast", "balanced", "deep"] as const) {
      const p = resolved[agent].models[tier];
      const label =
        tier === "fast"
          ? ui.green(tier.padEnd(18))
          : tier === "balanced"
            ? ui.yellow(tier.padEnd(18))
            : ui.red(tier.padEnd(18));
      const known = catalog.source === "builtin" || catalog.models.some((m) => m.id === p.model);
      console.log(
        `  ${label} ${ui.cyan(p.model)} ${ui.gray("effort=")}${ui.magenta(p.effort ?? "auto")}${
          known ? "" : ` ${ui.yellow("not in detected list")}`
        }`,
      );
    }
  }
  console.log("");
  console.log(
    `${ui.yellow("NOTE")} ${ui.dim('Dynamic mappings refresh from provider catalogs. Use `--model`, name a model in your task, or set modelRouting.mode to "manual" to override them.')}`,
  );
}
