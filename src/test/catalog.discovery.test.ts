import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENTS,
  cachedCatalog,
  catalogAge,
  discoverCatalog,
  discoverCatalogs,
} from "../catalog.js";
import { DEFAULT_CONFIG } from "../config.js";

const ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CORP_TOKEN",
  "OTHER_TOKEN",
];

async function withSandbox(run: (home: string) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-discovery-"));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.CODEX_HOME = path.join(home, "codex-home");
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  try {
    await run(home);
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function fakeCli(dir: string, name: string, version: string, subcommands: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncase "$1" in\n--version) echo "${name} ${version}";;\n${subcommands}\nesac\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

const CODEX_MODELS = JSON.stringify({
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, "max"],
    },
    { slug: "gpt-reserve", visibility: "hide" },
    { id: "gpt-legacy" },
    { slug: "  " },
    null,
  ],
});

function codexScript(models: string) {
  return `--help) printf 'Commands:\\n  debug  Debugging tools\\n';;\ndebug) printf '%s' '${models}';;`;
}

test("codex models come from `codex debug models`, minus hidden entries, and are cached", async () => {
  await withSandbox(async (home) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = fakeCli(home, "codex", "1.0.0", codexScript(CODEX_MODELS));

    const first = await discoverCatalog("codex", config);
    assert.equal(first.source, "cli");
    assert.match(first.via ?? "", /debug models/);
    const ids = first.models.map((model) => model.id);
    assert.ok(ids.includes("gpt-6-astra"));
    assert.ok(ids.includes("gpt-legacy"));
    assert.ok(!ids.includes("gpt-reserve"), "hidden models are not offered");
    assert.ok(ids.includes("gpt-5.6-terra"), "built-in ids are always retained");
    const astra = first.models.find((model) => model.id === "gpt-6-astra");
    assert.equal(astra?.label, "GPT-6-Astra");
    assert.deepEqual(astra?.efforts, ["low", "high", "max"]);

    assert.equal(cachedCatalog("codex")?.probedAt, first.probedAt);
    const second = await discoverCatalog("codex", config);
    assert.equal(second.probedAt, first.probedAt, "a fresh cache is reused");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const refreshed = await discoverCatalog("codex", config, { refresh: true });
    assert.notEqual(refreshed.probedAt, first.probedAt);

    const expired = await discoverCatalog("codex", config, { ttlMs: 0 });
    assert.notEqual(expired.probedAt, refreshed.probedAt, "an expired cache is probed again");

    config.codex.command = fakeCli(
      home,
      "codex",
      "2.0.0",
      codexScript(JSON.stringify({ models: [{ slug: "gpt-7" }] })),
    );
    const upgraded = await discoverCatalog("codex", config);
    assert.ok(
      upgraded.models.some((model) => model.id === "gpt-7"),
      "an upgrade invalidates",
    );
    assert.match(upgraded.fingerprint, /2\.0\.0/);
  });
});

test("cache entries are invalidated when configured models or project context changes", async () => {
  await withSandbox(async (home) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = path.join(home, "missing-codex");
    await discoverCatalog("codex", config, { refresh: true });

    config.codex.models.fast.model = "new-config-model";
    const configured = await discoverCatalog("codex", config);
    assert.ok(configured.models.some((model) => model.id === "new-config-model"));

    config.claude.command = path.join(home, "missing-claude");
    const firstRepo = path.join(home, "first-repo");
    const secondRepo = path.join(home, "second-repo");
    fs.mkdirSync(path.join(firstRepo, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(secondRepo, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(firstRepo, ".claude", "settings.json"),
      JSON.stringify({ model: "first-model" }),
    );
    fs.writeFileSync(
      path.join(secondRepo, ".claude", "settings.json"),
      JSON.stringify({ model: "second-model" }),
    );
    await discoverCatalog("claude", config, { cwd: firstRepo, refresh: true });
    const second = await discoverCatalog("claude", config, { cwd: secondRepo });
    assert.ok(second.models.some((model) => model.id === "second-model"));
    assert.ok(!second.models.some((model) => model.id === "first-model"));
  });
});

test("codex falls back to its catalogue files when `debug` is not advertised", async () => {
  await withSandbox(async (home) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = fakeCli(home, "codex", "1.0.0", "--help) echo 'Commands:';;");
    const codexHome = process.env.CODEX_HOME!;

    const empty = await discoverCatalog("codex", config);
    assert.equal(empty.source, "builtin");
    assert.match(empty.note ?? "", /exposes no model catalog/);

    fs.writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "cached-model" }] }),
    );
    const cache = await discoverCatalog("codex", config, { refresh: true });
    assert.equal(cache.source, "catalog-file");
    assert.ok(cache.models.some((model) => model.id === "cached-model"));

    const custom = path.join(home, "custom-catalog.json");
    fs.writeFileSync(custom, JSON.stringify({ models: [{ slug: "custom-model" }] }));
    fs.writeFileSync(path.join(codexHome, "config.toml"), `model_catalog_json = "${custom}"\n`);
    const configured = await discoverCatalog("codex", config, { refresh: true });
    assert.ok(configured.models.some((model) => model.id === "custom-model"));
  });
});

test("a failing `debug models` does not hide the file catalogue", async () => {
  await withSandbox(async (home) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = fakeCli(
      home,
      "codex",
      "1.0.0",
      "--help) printf 'Commands:\\n  debug  x\\n';;\ndebug) exit 3;;",
    );
    fs.writeFileSync(
      path.join(process.env.CODEX_HOME!, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "from-file" }] }),
    );
    const catalog = await discoverCatalog("codex", config);
    assert.equal(catalog.source, "catalog-file");
    assert.ok(catalog.models.some((model) => model.id === "from-file"));
  });
});

test("claude models come from configured defaults, then settings", async () => {
  await withSandbox(async (home) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = fakeCli(home, "claude", "1.0.0", "");
    const cwd = path.join(home, "repo");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });

    const none = await discoverCatalog("claude", config, { cwd });
    assert.equal(none.source, "builtin");
    assert.match(none.note ?? "", /no ANTHROPIC_DEFAULT/);

    fs.writeFileSync(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({ model: "team-model" }),
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ projects: { a: { model: "project-model" }, b: {} } }),
    );
    const settings = await discoverCatalog("claude", config, { cwd, refresh: true });
    assert.equal(settings.source, "provider-config");
    const ids = settings.models.map((model) => model.id);
    assert.ok(ids.includes("team-model") && ids.includes("project-model"));

    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "gateway-opus";
    const environment = await discoverCatalog("claude", config, { cwd, refresh: true });
    assert.equal(environment.source, "environment");
    assert.equal(environment.models[0].id, "gateway-opus");
    assert.equal(environment.models[0].label, "configured default");
  });
});

test("gemini and copilot are only probed through an advertised `models` subcommand", async () => {
  await withSandbox(async (home) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.gemini.command = fakeCli(
      home,
      "gemini",
      "1.0.0",
      '--help) printf \'Commands:\\n  models  list\\n\';;\nmodels) if [ "$2" = list ]; then printf \'["g-1",{"id":"g-2"},{"slug":"g-3"},7]\'; else exit 1; fi;;',
    );
    config.copilot.command = fakeCli(
      home,
      "copilot",
      "1.0.0",
      "--help) printf 'Commands:\\n  models  list\\n';;\nmodels) if [ \"$2\" = list ]; then exit 1; else printf 'c-1\\n\\nnot a model!\\nc-2\\n'; fi;;",
    );

    const gemini = await discoverCatalog("gemini", config);
    assert.equal(gemini.source, "cli");
    assert.equal(gemini.via, `${config.gemini.command} models list`);
    assert.deepEqual(
      ["g-1", "g-2", "g-3"].filter((id) => gemini.models.some((model) => model.id === id)),
      ["g-1", "g-2", "g-3"],
    );

    const copilot = await discoverCatalog("copilot", config);
    const ids = copilot.models.map((model) => model.id);
    assert.ok(ids.includes("c-1") && ids.includes("c-2"));
    assert.ok(!ids.includes("not a model!"));

    config.gemini.command = fakeCli(home, "gemini", "1.0.1", "--help) echo 'Commands:';;");
    const absent = await discoverCatalog("gemini", config);
    assert.match(absent.note ?? "", /no models subcommand/);

    config.gemini.command = fakeCli(
      home,
      "gemini",
      "1.0.2",
      "--help) printf 'Commands:\\n  models  list\\n';;\nmodels) printf '{\"data\":[]}';;",
    );
    const empty = await discoverCatalog("gemini", config);
    assert.match(empty.note ?? "", /listed no models/);

    config.gemini.command = path.join(home, "missing-gemini");
    const missing = await discoverCatalog("gemini", config);
    assert.equal(missing.source, "builtin");
    assert.match(missing.fingerprint, /@missing$/);
  });
});

test("an online gateway augments every local catalogue, and only when online", async () => {
  await withSandbox(async (home) => {
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(`${request.url} ${request.headers.authorization}`);
      if (request.url?.startsWith("/v1/models")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "gw-model", display_name: "GW" }, {}] }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      config.claude.command = fakeCli(home, "claude", "1.0.0", "");
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
      process.env.ANTHROPIC_API_KEY = "secret";

      const offline = await discoverCatalog("claude", config, { cwd: home });
      assert.equal(offline.source, "builtin");
      assert.deepEqual(seen, []);

      const online = await discoverCatalog("claude", config, {
        cwd: home,
        refresh: true,
        online: true,
      });
      assert.equal(online.source, "gateway");
      assert.ok(online.models.some((model) => model.id === "gw-model"));
      assert.deepEqual(seen, ["/v1/models Bearer secret"]);

      // A versioned base URL is used as given, and its models are merged with
      // local configuration instead of being discarded.
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1`;
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "local-sonnet";
      const local = await discoverCatalog("claude", config, {
        cwd: home,
        refresh: true,
        online: true,
      });
      assert.equal(local.source, "environment");
      assert.ok(local.models.some((model) => model.id === "local-sonnet"));
      assert.ok(local.models.some((model) => model.id === "gw-model"));
      assert.equal(seen.length, 2);

      delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      const versioned = await discoverCatalog("claude", config, {
        cwd: home,
        refresh: true,
        online: true,
      });
      assert.equal(versioned.source, "gateway");

      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/nowhere`;
      const missing = await discoverCatalog("claude", config, {
        cwd: home,
        refresh: true,
        online: true,
      });
      assert.equal(missing.source, "builtin", "a gateway error degrades to configured ids");

      delete process.env.ANTHROPIC_API_KEY;
      const anonymous = await discoverCatalog("claude", config, {
        cwd: home,
        refresh: true,
        online: true,
      });
      assert.equal(anonymous.source, "builtin");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("codex gateway uses the selected provider table and its credential", async () => {
  await withSandbox(async (home) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = fakeCli(home, "codex", "1.0.0", "--help) echo 'Commands:';;");
    process.env.CORP_TOKEN = "corp-secret";
    process.env.OTHER_TOKEN = "other-secret";
    fs.writeFileSync(
      path.join(process.env.CODEX_HOME!, "config.toml"),
      [
        'model_provider = "corp.gateway"',
        "[model_providers.other]",
        'base_url = "https://wrong.example/v1"',
        'env_key = "OTHER_TOKEN"',
        '[model_providers."corp.gateway"]',
        'base_url = "https://right.example/v1"',
        'env_key = "CORP_TOKEN"',
      ].join("\n"),
    );
    const previousFetch = globalThis.fetch;
    let requested: { url: string; authorization?: string } | undefined;
    globalThis.fetch = (async (input, init) => {
      requested = {
        url: String(input),
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      };
      return new Response(JSON.stringify({ data: [{ id: "corp-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const catalog = await discoverCatalog("codex", config, { online: true });
      assert.equal(catalog.source, "gateway");
      assert.deepEqual(requested, {
        url: "https://right.example/v1/models",
        authorization: "Bearer corp-secret",
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("all providers are catalogued together and ages read naturally", async () => {
  await withSandbox(async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const agent of AGENTS) config[agent].command = "/nonexistent/airo-test-cli";
    const catalogs = await discoverCatalogs(config);
    assert.deepEqual(Object.keys(catalogs).sort(), [...AGENTS].sort());
    for (const agent of AGENTS) {
      assert.equal(catalogs[agent].source, "builtin");
      assert.ok(catalogs[agent].models.length, "configured ids remain available");
    }

    const entry = catalogs.codex;
    const base = Date.parse(entry.probedAt);
    assert.equal(catalogAge(entry, base), "just now");
    assert.equal(catalogAge(entry, base + 5 * 60_000), "5m ago");
    assert.equal(catalogAge(entry, base + 3 * 3_600_000), "3h ago");
    assert.equal(catalogAge(entry, base + 3 * 86_400_000), "3d ago");
  });
});
