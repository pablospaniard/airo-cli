import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredAuth } from "../src/index";

const accessToken = "a".repeat(43);

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

beforeEach(async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users(id, github_user_id, github_login, created_at) VALUES(?, ?, ?, ?)",
    ).bind("user-test", "42", "tester", timestamp),
    env.DB.prepare(
      "INSERT INTO devices(id, user_id, name, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?)",
    ).bind("device-test", "user-test", "test", timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'access', ?, ?)",
    ).bind(
      "session-test",
      "family-test",
      "user-test",
      "device-test",
      await hash(accessToken),
      timestamp + 3600,
      timestamp,
    ),
  ]);
});

function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

describe("sync Worker", () => {
  it("accepts only tokens issued to the configured GitHub OAuth app", async () => {
    const github = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () =>
        Response.json({
          app: { client_id: "different-client" },
          user: { id: 42, login: "tester" },
        }),
      )
      .mockImplementationOnce(async () =>
        Response.json({
          app: { client_id: env.GITHUB_CLIENT_ID },
          user: { id: 42, login: "tester" },
        }),
      );
    const rejected = await SELF.fetch("https://example.com/v1/auth/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-oauth-test",
        deviceName: "test",
        githubAccessToken: "github-token-from-another-app",
      }),
    });
    expect(rejected.status).toBe(502);

    const accepted = await SELF.fetch("https://example.com/v1/auth/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-oauth-test",
        deviceName: "test",
        githubAccessToken: "github-token-for-this-application",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(github).toHaveBeenCalledTimes(2);
    expect(github.mock.calls[0][0]).toBe(
      `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`,
    );
    github.mockRestore();
  });

  it("reports health and rejects unauthenticated sync", async () => {
    const health = await SELF.fetch("https://example.com/health");
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await health.json()).toEqual({
      status: "ok",
      service: "airo-sync",
      schemaVersion: 1,
    });
    expect((await SELF.fetch("https://example.com/v1/sync/status")).status).toBe(401);
    expect((await SELF.fetch("https://example.com/v1/private/unknown")).status).toBe(404);
    expect(
      (await SELF.fetch("https://example.com/v1/auth/device/start", { method: "POST" })).status,
    ).toBe(404);
    expect(await (await SELF.fetch("https://example.com/v1/auth/config")).json()).toEqual({
      provider: "github",
      clientId: "Ov23li72JP3433SbMpe7",
    });
    expect(
      (
        await SELF.fetch("https://example.com/v1/auth/github", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId: "invalid" }),
        })
      ).status,
    ).toBe(400);
  });

  it("stores opaque events idempotently and advances a cursor", async () => {
    const event = {
      id: "event-test",
      version: "v".repeat(43),
      kind: "history",
      repositoryId: "sync-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: 1,
      envelope: {
        version: 1,
        algorithm: "aes-256-gcm",
        nonce: "abcdefghijklmnop",
        ciphertext: "opaque",
        tag: "abcdefghijklmnop",
      },
    };
    const first = await authorized("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ events: [event] }),
    });
    expect(await first.json()).toEqual({ accepted: 1, total: 1 });
    const duplicate = await authorized("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ events: [event] }),
    });
    expect(await duplicate.json()).toEqual({ accepted: 0, total: 1 });
    const changed = await authorized("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ events: [{ ...event, version: "w".repeat(43) }] }),
    });
    expect(await changed.json()).toEqual({ accepted: 1, total: 1 });
    const otherKind = await authorized("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({
        events: [{ ...event, kind: "feedback", version: "x".repeat(43) }],
      }),
    });
    expect(await otherKind.json()).toEqual({ accepted: 1, total: 1 });
    const pulled = await authorized("/v1/sync/pull?cursor=0");
    const body = await pulled.json<{ events: unknown[]; cursor: number }>();
    expect(body.events).toHaveLength(3);
    expect(body.cursor).toBeGreaterThan(0);
  });

  it("bounds pull pages by serialized bytes as well as event count", async () => {
    const envelope = JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: "abcdefghijklmnop",
      ciphertext: "x".repeat(450_000),
      tag: "abcdefghijklmnop",
    });
    await env.DB.batch(
      ["large-event-one", "large-event-two", "large-event-three"].map((id, index) =>
        env.DB.prepare(
          `INSERT INTO sync_events(user_id, event_id, version, device_id, kind, created_at, envelope)
           VALUES(?, ?, ?, ?, 'history', ?, ?)`,
        ).bind("user-test", id, String(index).repeat(43), "device-test", index, envelope),
      ),
    );
    const response = await authorized("/v1/sync/pull?cursor=0&limit=100");
    const text = await response.text();
    const body = JSON.parse(text) as { events: unknown[]; hasMore: boolean };
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(900_000);
    expect(body.events).toHaveLength(1);
    expect(body.hasMore).toBe(true);
  });

  it("uses optimistic revisions and never replaces an account key", async () => {
    const envelope = { version: 1, opaque: "wrapped" };
    expect(
      (await authorized("/v1/account-key", { method: "PUT", body: JSON.stringify({ envelope }) }))
        .status,
    ).toBe(200);
    expect(
      (await authorized("/v1/account-key", { method: "PUT", body: JSON.stringify({ envelope }) }))
        .status,
    ).toBe(409);
    const setting = {
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: "abcdefghijklmnop",
      ciphertext: "opaque",
      tag: "abcdefghijklmnop",
    };
    const saved = await authorized("/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ key: "routing", expectedRevision: 0, envelope: setting }),
    });
    expect(await saved.json()).toEqual({ key: "routing", revision: 1 });
    expect(
      (
        await authorized("/v1/settings", {
          method: "PUT",
          body: JSON.stringify({ key: "routing", expectedRevision: 0, envelope: setting }),
        })
      ).status,
    ).toBe(409);
    const competingUpdates = await Promise.all([
      authorized("/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "routing", expectedRevision: 1, envelope: setting }),
      }),
      authorized("/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "routing", expectedRevision: 1, envelope: setting }),
      }),
    ]);
    expect(competingUpdates.map((response) => response.status).sort()).toEqual([200, 409]);

    await env.DB.prepare("DELETE FROM sync_settings WHERE user_id = ? AND key = ?")
      .bind("user-test", "routing")
      .run();
    const concurrent = await Promise.all([
      authorized("/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "routing", expectedRevision: 0, envelope: setting }),
      }),
      authorized("/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "routing", expectedRevision: 0, envelope: setting }),
      }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("exports opaque account data and deletes it with explicit confirmation", async () => {
    const exported = await authorized("/v1/account/export");
    const payload = await exported.json<Record<string, unknown>>();
    expect(payload.schemaVersion).toBe(1);
    expect(payload.hasMore).toBe(false);
    expect(payload.eventCursor).toBe(0);
    expect(JSON.stringify(payload)).not.toContain(accessToken);
    expect(JSON.stringify(payload)).not.toContain("token_hash");

    const refused = await authorized("/v1/account", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "no" }),
    });
    expect(refused.status).toBe(400);
    const deleted = await authorized("/v1/account", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(deleted.status).toBe(200);
    expect((await authorized("/v1/sync/status")).status).toBe(401);
  });

  it("paginates account exports instead of buffering every event", async () => {
    const envelope = JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: "abcdefghijklmnop",
      ciphertext: "opaque",
      tag: "abcdefghijklmnop",
    });
    for (let offset = 0; offset < 55; offset += 25) {
      await env.DB.batch(
        Array.from({ length: Math.min(25, 55 - offset) }, (_, index) => {
          const number = offset + index;
          return env.DB.prepare(
            `INSERT INTO sync_events(user_id, event_id, version, device_id, kind, created_at, envelope)
             VALUES(?, ?, ?, ?, 'history', ?, ?)`,
          ).bind(
            "user-test",
            `export-event-${number}`,
            number.toString().padStart(43, "v"),
            "device-test",
            number,
            envelope,
          );
        }),
      );
    }

    const legacy = await authorized("/v1/account/export?cursor=0&limit=50");
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({
      error: { code: "export_pagination_required" },
    });
    let cursor = 0;
    let exported = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await (
        await authorized(`/v1/account/export?paged=1&cursor=${cursor}&limit=50`)
      ).json<{ events: unknown[]; eventCursor: number; hasMore: boolean }>();
      expect(page.eventCursor).toBeGreaterThan(cursor);
      exported += page.events.length;
      cursor = page.eventCursor;
      hasMore = page.hasMore;
    }
    expect(exported).toBe(55);
  });

  it("does not require pagination when an export exactly fills one row page", async () => {
    const envelope = JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: "abcdefghijklmnop",
      ciphertext: "opaque",
      tag: "abcdefghijklmnop",
    });
    await env.DB.batch(
      Array.from({ length: 10 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO sync_events(user_id, event_id, version, device_id, kind, created_at, envelope)
           VALUES(?, ?, ?, ?, 'history', ?, ?)`,
        ).bind(
          "user-test",
          `boundary-event-${index}`,
          index.toString().padStart(43, "b"),
          "device-test",
          index,
          envelope,
        ),
      ),
    );

    const response = await authorized("/v1/account/export");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hasMore: false });
  });

  it("fails an export explicitly when one stored row cannot fit a page", async () => {
    const envelope = JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: "abcdefghijklmnop",
      ciphertext: "x".repeat(880_000),
      tag: "abcdefghijklmnop",
    });
    await env.DB.prepare(
      `INSERT INTO sync_events(user_id, event_id, version, device_id, kind, created_at, envelope)
       VALUES(?, ?, ?, ?, 'history', ?, ?)`,
    )
      .bind("user-test", "oversized-export-event", "o".repeat(43), "device-test", 1, envelope)
      .run();

    const response = await authorized("/v1/account/export?paged=1");
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "export_item_too_large" } });
  });

  async function refresh(refreshToken: string, rotationRequestId?: string): Promise<Response> {
    return SELF.fetch("https://example.com/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, rotationRequestId }),
    });
  }

  async function statusFor(token: string): Promise<Response> {
    return SELF.fetch("https://example.com/v1/sync/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("continues rotating the same session when a retry presents the same rotation request ID", async () => {
    // A client retries /v1/auth/refresh with the same refreshToken and the
    // same, client-persisted rotationRequestId whenever it never saw the
    // previous response (dropped connection, timeout, crash) even though
    // the server had already rotated the token. That must succeed again
    // instead of being treated as a stolen-token replay, or a flaky network
    // would permanently sign the user out.
    const timestamp = Math.floor(Date.now() / 1000);
    const refreshToken = "r".repeat(43);
    const rotationRequestId = "attempt-1-".padEnd(20, "x");
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?)",
    )
      .bind(
        "refresh-test",
        "family-test",
        "user-test",
        "device-test",
        await hash(refreshToken),
        timestamp + 3600,
        timestamp,
      )
      .run();

    const first = await refresh(refreshToken, rotationRequestId);
    expect(first.status).toBe(200);
    const firstTokens = await first.json<{ accessToken: string; refreshToken: string }>();
    expect((await statusFor(firstTokens.accessToken)).status).toBe(200);

    // The client never received `first`'s body and retries with the same
    // (now-superseded) refresh token and the same rotationRequestId.
    const retry = await refresh(refreshToken, rotationRequestId);
    expect(retry.status).toBe(200);
    const retryTokens = await retry.json<{ accessToken: string; refreshToken: string }>();
    expect(retryTokens.refreshToken).not.toBe(firstTokens.refreshToken);

    // The response the client never saw is superseded, but the retry's own
    // pair works, and the account was not signed out of every device.
    expect((await statusFor(firstTokens.accessToken)).status).toBe(401);
    expect((await statusFor(retryTokens.accessToken)).status).toBe(200);

    // The newest refresh token still rotates normally afterward.
    expect((await refresh(retryTokens.refreshToken)).status).toBe(200);
  });

  it("keeps a session alive when two truly concurrent requests share the same rotation request ID", async () => {
    // The client's own request timed out and it retried while the original
    // was still being processed server-side — both requests race the same
    // refreshToken and rotationRequestId at once. The loser must not revoke
    // the winner's brand-new tokens just because it lost that race.
    const timestamp = Math.floor(Date.now() / 1000);
    const refreshToken = "r".repeat(43);
    const rotationRequestId = "concurrent-".padEnd(20, "x");
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?)",
    )
      .bind(
        "refresh-race",
        "family-race",
        "user-test",
        "device-test",
        await hash(refreshToken),
        timestamp + 3600,
        timestamp,
      )
      .run();

    const responses = await Promise.all([
      refresh(refreshToken, rotationRequestId),
      refresh(refreshToken, rotationRequestId),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const [firstTokens, secondTokens] = await Promise.all(
      responses.map((response) => response.json<{ accessToken: string; refreshToken: string }>()),
    );
    // Whichever pair is the live tip must still work; the account must not
    // have been signed out of every device by the race.
    const results = await Promise.all([
      statusFor(firstTokens.accessToken),
      statusFor(secondTokens.accessToken),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it("recovers a chain of several lost responses for the same rotation request ID", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const refreshToken = "r".repeat(43);
    const rotationRequestId = "multi-hop-".padEnd(20, "x");
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?)",
    )
      .bind(
        "refresh-chain",
        "family-chain",
        "user-test",
        "device-test",
        await hash(refreshToken),
        timestamp + 3600,
        timestamp,
      )
      .run();

    // Three retries in a row with the same original (never-updated) token
    // and request ID, as if every single response were lost — not just the
    // first one.
    let last: { accessToken: string; refreshToken: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await refresh(refreshToken, rotationRequestId);
      expect(response.status).toBe(200);
      last = await response.json<{ accessToken: string; refreshToken: string }>();
    }
    expect((await statusFor(last!.accessToken)).status).toBe(200);
    expect((await refresh(last!.refreshToken)).status).toBe(200);
  });

  it("revokes the family when a rotated refresh token is reused without a matching rotation request ID", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const refreshToken = "r".repeat(43);
    const rotationRequestId = "attempt-1-".padEnd(20, "x");
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?)",
    )
      .bind(
        "refresh-test",
        "family-test",
        "user-test",
        "device-test",
        await hash(refreshToken),
        timestamp + 3600,
        timestamp,
      )
      .run();
    const rotated = await refresh(refreshToken, rotationRequestId);
    expect(rotated.status).toBe(200);
    const replacements = await rotated.json<{ accessToken: string }>();
    expect((await statusFor(replacements.accessToken)).status).toBe(200);

    // A different actor (or a client that never persisted its
    // rotationRequestId) replays the same, now-superseded refresh token
    // without the matching ID that would prove it is the same attempt.
    const response = await refresh(refreshToken, "a-different-request-id");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "refresh_reused" } });
    expect((await statusFor(replacements.accessToken)).status).toBe(401);
  });

  it("revokes the family when a rotated refresh token is reused with no rotation request ID at all", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const refreshToken = "r".repeat(43);
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?)",
    )
      .bind(
        "refresh-plain",
        "family-plain",
        "user-test",
        "device-test",
        await hash(refreshToken),
        timestamp + 3600,
        timestamp,
      )
      .run();
    expect((await refresh(refreshToken)).status).toBe(200);
    const response = await refresh(refreshToken);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "refresh_reused" } });
  });

  it("allows only one concurrent refresh and revokes its replacements on reuse", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const refreshToken = "c".repeat(43);
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?)",
    )
      .bind(
        "refresh-concurrent",
        "family-concurrent",
        "user-test",
        "device-test",
        await hash(refreshToken),
        timestamp + 3600,
        timestamp,
      )
      .run();
    const request = () =>
      SELF.fetch("https://example.com/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const successful = responses.find((response) => response.status === 200)!;
    const replacement = await successful.json<{ accessToken: string }>();
    expect(
      (
        await SELF.fetch("https://example.com/v1/sync/status", {
          headers: { Authorization: `Bearer ${replacement.accessToken}` },
        })
      ).status,
    ).toBe(401);
  });

  it("retains revoked devices for an auditable device list", async () => {
    await env.DB.prepare(
      "INSERT INTO devices(id, user_id, name, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?)",
    )
      .bind("device-secondary", "user-test", "secondary", 1, 1)
      .run();
    expect((await authorized("/v1/devices/device-secondary", { method: "DELETE" })).status).toBe(
      200,
    );
    const response = await authorized("/v1/devices");
    const body = await response.json<{
      devices: Array<{ id: string; revokedAt: number | null; current: boolean }>;
    }>();
    expect(body.devices.find((device) => device.id === "device-secondary")).toMatchObject({
      current: false,
      revokedAt: expect.any(Number),
    });
  });

  it("cleans expired sessions without deleting device audit entries", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'access', ?, ?)",
    )
      .bind(
        "expired-session",
        "expired-family",
        "user-test",
        "device-test",
        await hash("expired-access-token-that-is-long-enough"),
        timestamp - 1,
        timestamp - 100,
      )
      .run();
    await cleanupExpiredAuth(env, timestamp);
    expect(
      await env.DB.prepare("SELECT id FROM sessions WHERE id = ?").bind("expired-session").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind("device-test").first(),
    ).not.toBeNull();
  });
});
