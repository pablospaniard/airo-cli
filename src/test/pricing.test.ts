import assert from "node:assert/strict";
import test from "node:test";
import { apiPriceForModel, refreshApiPrices } from "../pricing.js";

test("refreshes model prices from the live catalog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        test: {
          models: {
            "pricing-test-model": {
              cost: { input: 1.1, output: 4.4, cache_read: 0.11, cache_write: 1.3 },
              last_updated: "2026-10-01",
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    assert.equal(await refreshApiPrices(), "live");
    assert.deepEqual(apiPriceForModel("pricing-test-model"), {
      input: 1.1,
      output: 4.4,
      cachedInput: 0.11,
      cacheWrite: 1.3,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the built-in prices when the live catalog fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  try {
    const result = await refreshApiPrices();
    assert.ok(result === "cache" || result === "snapshot");
    assert.equal(apiPriceForModel("gpt-5.6-luna")?.output, 1.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
