import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cachedCatalog,
  candidateModels,
  resolveDynamicModels,
  type CatalogModel,
  type ProviderCatalog,
} from "../catalog.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { Agent } from "../types.js";

function catalog(
  agent: Agent,
  detectedModels: CatalogModel[],
  source: ProviderCatalog["source"] = detectedModels.length ? "cli" : "builtin",
): ProviderCatalog {
  return {
    agent,
    models: detectedModels,
    detectedModels,
    source,
    probedAt: new Date().toISOString(),
    fingerprint: `${agent}@test`,
    contextFingerprint: "context",
  };
}

test("catalog reads tolerate invalid cache data and retain current configured models", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-catalog-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const dir = path.join(home, ".local", "share", "airo");
  const file = path.join(dir, "model-catalog.json");
  try {
    assert.equal(cachedCatalog("codex"), undefined);
    assert.equal(fs.existsSync(dir), false, "a cache read should not create directories");
    fs.mkdirSync(dir, { recursive: true });
    for (const entries of [null, [], { codex: {} }, { codex: { models: [null] } }]) {
      fs.writeFileSync(file, JSON.stringify({ version: 4, entries }));
      assert.equal(cachedCatalog("codex"), undefined);
      assert.ok(candidateModels("codex", DEFAULT_CONFIG).length);
    }
    fs.writeFileSync(file, "invalid json");
    assert.equal(cachedCatalog("codex"), undefined);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 4,
        entries: {
          codex: {
            agent: "codex",
            models: [{ id: "discovered-model" }],
            detectedModels: [{ id: "discovered-model" }],
            source: "cli",
            fingerprint: "test@1",
            contextFingerprint: "context",
            probedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.models.fast.model = "new-config-model";
    const ids = candidateModels("codex", config).map((model) => model.id);
    assert.ok(ids.includes("discovered-model"));
    assert.ok(ids.includes("new-config-model"));
    assert.equal(new Set(ids).size, ids.length);
    fs.rmSync(path.join(home, ".local"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local"), "blocked directory");
    assert.equal(cachedCatalog("codex"), undefined);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("maps detected provider models onto tiers without changing the saved config", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const catalogs = {
    claude: catalog("claude", []),
    codex: catalog("codex", [
      { id: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.6-terra", efforts: ["low", "medium", "high"] },
      { id: "gpt-5.6-luna", efforts: ["low", "medium"] },
    ]),
    gemini: catalog("gemini", [{ id: "gemini-3-flash" }, { id: "gemini-3-pro" }]),
    copilot: catalog("copilot", []),
  };

  const resolved = resolveDynamicModels(config, catalogs);
  assert.equal(resolved.codex.models.fast.model, "gpt-5.6-luna");
  assert.equal(resolved.codex.models.balanced.model, "gpt-5.6-terra");
  assert.equal(resolved.codex.models.deep.model, "gpt-6-astra");
  assert.equal(resolved.gemini.models.fast.model, "gemini-3-flash");
  assert.equal(resolved.gemini.models.deep.model, "gemini-3-pro");
  assert.equal(resolved.gemini.models.fast.effort, "auto");
  assert.equal(resolved.gemini.models.deep.effort, "auto");
  assert.equal(config.codex.models.deep.model, DEFAULT_CONFIG.codex.models.deep.model);
});

test("does not treat one configured provider model as a complete catalog", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const catalogs = {
    claude: catalog("claude", [{ id: "opus" }], "provider-config"),
    codex: catalog("codex", []),
    gemini: catalog("gemini", []),
    copilot: catalog("copilot", []),
  };

  const resolved = resolveDynamicModels(config, catalogs);
  assert.equal(resolved.claude.models.fast.model, "haiku");
  assert.equal(resolved.claude.models.balanced.model, "sonnet");
  assert.equal(resolved.claude.models.deep.model, "opus");
});

test("maps a complete file-based provider catalog positionally", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const catalogs = {
    claude: catalog("claude", []),
    codex: catalog(
      "codex",
      [{ id: "gpt-newest" }, { id: "gpt-middle" }, { id: "gpt-oldest" }],
      "catalog-file",
    ),
    gemini: catalog("gemini", []),
    copilot: catalog("copilot", []),
  };

  const resolved = resolveDynamicModels(config, catalogs);
  assert.equal(resolved.codex.models.fast.model, "gpt-oldest");
  assert.equal(resolved.codex.models.balanced.model, "gpt-middle");
  assert.equal(resolved.codex.models.deep.model, "gpt-newest");
});

test("manual model routing preserves configured tier mappings", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.modelRouting.mode = "manual";
  config.codex.models.deep.model = "pinned-model";
  const catalogs = Object.fromEntries(
    (["claude", "codex", "gemini", "copilot"] as Agent[]).map((agent) => [
      agent,
      catalog(agent, [{ id: `${agent}-new-model` }]),
    ]),
  ) as Record<Agent, ProviderCatalog>;

  assert.equal(resolveDynamicModels(config, catalogs), config);
  assert.equal(resolveDynamicModels(config, catalogs).codex.models.deep.model, "pinned-model");
});
