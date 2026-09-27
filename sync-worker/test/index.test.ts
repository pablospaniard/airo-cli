import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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
    const pulled = await authorized("/v1/sync/pull?cursor=0");
    const body = await pulled.json<{ events: unknown[]; cursor: number }>();
    expect(body.events).toHaveLength(1);
    expect(body.cursor).toBeGreaterThan(0);
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
  });

  it("exports opaque account data and deletes it with explicit confirmation", async () => {
    const exported = await authorized("/v1/account/export");
    const payload = await exported.json<Record<string, unknown>>();
    expect(payload.schemaVersion).toBe(1);
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

  it("revokes a token family when a rotated refresh token is reused", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const refreshToken = "r".repeat(43);
    await env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at, revoked_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?, ?)",
    )
      .bind(
        "refresh-test",
        "family-test",
        "user-test",
        "device-test",
        await hash(refreshToken),
        timestamp + 3600,
        timestamp,
        timestamp,
      )
      .run();
    const response = await SELF.fetch("https://example.com/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "refresh_reused" } });
    expect((await authorized("/v1/sync/status")).status).toBe(401);
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
