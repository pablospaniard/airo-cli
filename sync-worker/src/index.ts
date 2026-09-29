const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const MAX_BODY_BYTES = 1_048_576;
const MAX_EVENTS = 100;
const MAX_PULL_EVENTS = 50;
const MAX_EXPORT_ROWS = 10;
const MAX_RESPONSE_BYTES = 900_000;
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const REVOKED_SESSION_RETENTION_SECONDS = 30 * 24 * 60 * 60;

interface AuthContext {
  sessionId: string;
  familyId: string;
  userId: string;
  deviceId: string;
}

interface SessionRow {
  id: string;
  family_id: string;
  user_id: string;
  device_id: string;
  expires_at: number;
  revoked_at: number | null;
  device_revoked_at: number | null;
}

interface GithubUser {
  id?: unknown;
  login?: unknown;
}

interface GithubAuthorization {
  app?: { client_id?: unknown };
  user?: GithubUser;
}

interface EventInput {
  id: string;
  version: string;
  kind: "history" | "feedback" | "jev-feedback" | "tombstone";
  repositoryId?: string;
  createdAt: number;
  envelope: EncryptedEnvelope;
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  tag: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9:_-]{8,128}$/.test(value);
}

function validEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<EncryptedEnvelope>;
  return Boolean(
    envelope.version === 1 &&
    envelope.algorithm === "aes-256-gcm" &&
    typeof envelope.nonce === "string" &&
    envelope.nonce.length >= 12 &&
    envelope.nonce.length <= 64 &&
    typeof envelope.ciphertext === "string" &&
    envelope.ciphertext.length <= 700_000 &&
    typeof envelope.tag === "string" &&
    envelope.tag.length >= 16 &&
    envelope.tag.length <= 64,
  );
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json"))
    throw new Response(
      JSON.stringify({ error: { code: "content_type", message: "Expected JSON." } }),
      {
        status: 415,
        headers: JSON_HEADERS,
      },
    );
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES)
    throw new Response(
      JSON.stringify({ error: { code: "body_too_large", message: "Request body is too large." } }),
      {
        status: 413,
        headers: JSON_HEADERS,
      },
    );
  const reader = request.body?.getReader();
  if (!reader) throw error(400, "empty_body", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw error(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Response(
      JSON.stringify({ error: { code: "invalid_json", message: "Malformed JSON." } }),
      {
        status: 400,
        headers: JSON_HEADERS,
      },
    );
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function rateLimit(limiter: RateLimit, key: string): Promise<Response | undefined> {
  const result = await limiter.limit({ key });
  if (result.success) return undefined;
  const response = error(429, "rate_limited", "Too many requests.");
  response.headers.set("Retry-After", "60");
  return response;
}

async function authenticate(request: Request, env: Env): Promise<AuthContext | Response> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return error(401, "unauthorized", "Access token required.");
  const token = header.slice(7);
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token))
    return error(401, "unauthorized", "Invalid access token.");
  const row = await env.DB.prepare(
    `SELECT s.id, s.family_id, s.user_id, s.device_id, s.expires_at, s.revoked_at,
            d.revoked_at AS device_revoked_at
       FROM sessions s
       JOIN devices d ON d.user_id = s.user_id AND d.id = s.device_id
      WHERE s.token_hash = ? AND s.kind = 'access'`,
  )
    .bind(await sha256(token))
    .first<SessionRow>();
  if (!row || row.revoked_at || row.device_revoked_at || row.expires_at <= now())
    return error(401, "unauthorized", "Access token expired or revoked.");
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE user_id = ? AND id = ?")
    .bind(now(), row.user_id, row.device_id)
    .run();
  return {
    sessionId: row.id,
    familyId: row.family_id,
    userId: row.user_id,
    deviceId: row.device_id,
  };
}

async function issueTokens(
  env: Env,
  userId: string,
  deviceId: string,
  familyId: string = crypto.randomUUID(),
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'access', ?, ?)",
    ).bind(
      crypto.randomUUID(),
      familyId,
      userId,
      deviceId,
      await sha256(accessToken),
      createdAt + ACCESS_TTL_SECONDS,
      createdAt,
    ),
    env.DB.prepare(
      "INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at) VALUES(?, ?, ?, ?, ?, 'refresh', ?, ?)",
    ).bind(
      crypto.randomUUID(),
      familyId,
      userId,
      deviceId,
      await sha256(refreshToken),
      createdAt + REFRESH_TTL_SECONDS,
      createdAt,
    ),
  ]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
}

async function refreshSession(request: Request, env: Env): Promise<Response> {
  const body = object(await readJson(request));
  if (
    !body ||
    typeof body.refreshToken !== "string" ||
    !/^[a-zA-Z0-9_-]{43}$/.test(body.refreshToken)
  )
    return error(400, "invalid_request", "refreshToken is required.");
  const row = await env.DB.prepare(
    `SELECT s.id, s.family_id, s.user_id, s.device_id, s.expires_at, s.revoked_at,
            d.revoked_at AS device_revoked_at
       FROM sessions s
       JOIN devices d ON d.user_id = s.user_id AND d.id = s.device_id
      WHERE s.token_hash = ? AND s.kind = 'refresh'`,
  )
    .bind(await sha256(body.refreshToken))
    .first<SessionRow>();
  if (row?.revoked_at) {
    await env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
    )
      .bind(now(), row.family_id)
      .run();
    return error(
      401,
      "refresh_reused",
      "Refresh token reuse detected; device sessions were revoked.",
    );
  }
  if (!row || row.device_revoked_at || row.expires_at <= now())
    return error(401, "invalid_refresh", "Refresh token expired or revoked.");
  const limited = await rateLimit(env.AUTH_RATE_LIMITER, `refresh:${row.user_id}`);
  if (limited) return limited;
  const rotationId = crypto.randomUUID();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const createdAt = now();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE sessions SET revoked_at = ?, rotation_id = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(createdAt, rotationId, row.id),
    env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND id != ? AND revoked_at IS NULL",
    ).bind(createdAt, row.family_id, row.id),
    env.DB.prepare(
      `INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, 'access', ?, ?
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND rotation_id = ?)`,
    ).bind(
      crypto.randomUUID(),
      row.family_id,
      row.user_id,
      row.device_id,
      await sha256(accessToken),
      createdAt + ACCESS_TTL_SECONDS,
      createdAt,
      row.id,
      rotationId,
    ),
    env.DB.prepare(
      `INSERT INTO sessions(id, family_id, user_id, device_id, token_hash, kind, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, 'refresh', ?, ?
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND rotation_id = ?)`,
    ).bind(
      crypto.randomUUID(),
      row.family_id,
      row.user_id,
      row.device_id,
      await sha256(refreshToken),
      createdAt + REFRESH_TTL_SECONDS,
      createdAt,
      row.id,
      rotationId,
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    await env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
    )
      .bind(now(), row.family_id)
      .run();
    return error(
      401,
      "refresh_reused",
      "Refresh token reuse detected; device sessions were revoked.",
    );
  }
  return json({ accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS });
}

async function exchangeGithubToken(request: Request, env: Env): Promise<Response> {
  const body = object(await readJson(request));
  if (
    !body ||
    !validId(body.deviceId) ||
    typeof body.deviceName !== "string" ||
    typeof body.githubAccessToken !== "string" ||
    body.githubAccessToken.length < 20 ||
    body.githubAccessToken.length > 512
  )
    return error(400, "invalid_request", "A valid device and GitHub access token are required.");
  if (!env.GITHUB_CLIENT_SECRET)
    return error(503, "auth_not_configured", "GitHub identity verification is unavailable.");
  const deviceName = body.deviceName.trim().slice(0, 80);
  if (!deviceName) return error(400, "invalid_request", "deviceName cannot be empty.");
  const limited = await rateLimit(env.AUTH_RATE_LIMITER, `github-exchange:${body.deviceId}`);
  if (limited) return limited;
  const profileResponse = await fetch(
    `https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`,
    {
      method: "POST",
      body: JSON.stringify({ access_token: body.githubAccessToken }),
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        "Content-Type": "application/json",
        "User-Agent": "airo-sync-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!profileResponse.ok)
    return error(401, "github_token_invalid", "GitHub identity verification failed.");
  const authorization: GithubAuthorization = await profileResponse.json();
  const profile = authorization.user;
  if (
    authorization.app?.client_id !== env.GITHUB_CLIENT_ID ||
    !profile ||
    (typeof profile.id !== "number" && typeof profile.id !== "string") ||
    typeof profile.login !== "string"
  )
    return error(502, "github_invalid", "GitHub returned an invalid profile.");
  const time = now();
  const githubUserId = String(profile.id);
  let user = await env.DB.prepare("SELECT id FROM users WHERE github_user_id = ?")
    .bind(githubUserId)
    .first<{ id: string }>();
  if (!user) {
    user = { id: crypto.randomUUID() };
    await env.DB.prepare(
      "INSERT INTO users(id, github_user_id, github_login, created_at) VALUES(?, ?, ?, ?)",
    )
      .bind(user.id, githubUserId, profile.login, time)
      .run();
  } else {
    await env.DB.prepare("UPDATE users SET github_login = ? WHERE id = ?")
      .bind(profile.login, user.id)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO devices(id, user_id, name, created_at, last_seen_at, revoked_at)
     VALUES(?, ?, ?, ?, ?, NULL)
     ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at, revoked_at = NULL`,
  )
    .bind(body.deviceId, user.id, deviceName, time, time)
    .run();
  // Make the exchange safe for client retries. If the response to an earlier
  // attempt was lost, its token family is revoked before replacements are
  // issued for this device.
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL",
  )
    .bind(time, user.id, body.deviceId)
    .run();
  return json({
    status: "authorized",
    user: { id: user.id, login: profile.login },
    deviceId: body.deviceId,
    ...(await issueTokens(env, user.id, body.deviceId)),
  });
}

function eventInput(value: unknown): EventInput | undefined {
  const item = object(value);
  if (
    !item ||
    !validId(item.id) ||
    typeof item.version !== "string" ||
    !/^[a-zA-Z0-9_-]{43}$/.test(item.version) ||
    !["history", "feedback", "jev-feedback", "tombstone"].includes(String(item.kind)) ||
    (item.repositoryId !== undefined && !validId(item.repositoryId)) ||
    typeof item.createdAt !== "number" ||
    !Number.isInteger(item.createdAt) ||
    !validEnvelope(item.envelope)
  )
    return undefined;
  const kind = String(item.kind);
  if (kind !== "history" && kind !== "feedback" && kind !== "jev-feedback" && kind !== "tombstone")
    return undefined;
  return {
    id: item.id,
    version: item.version,
    kind,
    repositoryId: typeof item.repositoryId === "string" ? item.repositoryId : undefined,
    createdAt: item.createdAt,
    envelope: item.envelope,
  };
}

async function pushEvents(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = object(await readJson(request));
  if (!body || !Array.isArray(body.events) || body.events.length > MAX_EVENTS)
    return error(400, "invalid_events", `events must contain at most ${MAX_EVENTS} items.`);
  const events = body.events.map(eventInput);
  if (events.some((event) => !event)) return error(400, "invalid_event", "An event is invalid.");
  if (!events.length) return json({ accepted: 0, total: 0 });
  const statements = events.map((event) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO sync_events(user_id, event_id, version, device_id, kind, repository_id, created_at, envelope)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      auth.userId,
      event!.id,
      event!.version,
      auth.deviceId,
      event!.kind,
      event!.repositoryId ?? null,
      event!.createdAt,
      JSON.stringify(event!.envelope),
    ),
  );
  const results = await env.DB.batch(statements);
  const accepted = results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  return json({ accepted, total: events.length });
}

async function pullEvents(url: URL, env: Env, auth: AuthContext): Promise<Response> {
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
  if (!Number.isInteger(cursor) || !Number.isInteger(limit))
    return error(400, "invalid_cursor", "cursor and limit must be integers.");
  const queryLimit = Math.min(limit, MAX_PULL_EVENTS);
  const result = await env.DB.prepare(
    `SELECT cursor, event_id, version, device_id, kind, repository_id, created_at, envelope
       FROM sync_events WHERE user_id = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
  )
    .bind(auth.userId, cursor, queryLimit)
    .all<{
      cursor: number;
      event_id: string;
      version: string;
      device_id: string;
      kind: EventInput["kind"];
      repository_id: string | null;
      created_at: number;
      envelope: string;
    }>();
  const events: Array<{
    cursor: number;
    id: string;
    version: string;
    deviceId: string;
    kind: EventInput["kind"];
    repositoryId?: string;
    createdAt: number;
    envelope: EncryptedEnvelope;
  }> = [];
  let responseBytes = new TextEncoder().encode('{"events":[]}').byteLength;
  for (const row of result.results) {
    const event = {
      cursor: row.cursor,
      id: row.event_id,
      version: row.version,
      deviceId: row.device_id,
      kind: row.kind,
      repositoryId: row.repository_id ?? undefined,
      createdAt: row.created_at,
      envelope: JSON.parse(row.envelope) as EncryptedEnvelope,
    };
    const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (events.length && responseBytes + eventBytes + 1 > MAX_RESPONSE_BYTES) break;
    events.push(event);
    responseBytes += eventBytes + (events.length > 1 ? 1 : 0);
  }
  return json({
    events,
    cursor: events.at(-1)?.cursor ?? cursor,
    hasMore: events.length < result.results.length || result.results.length === queryLimit,
  });
}

async function putSetting(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = object(await readJson(request));
  if (
    !body ||
    typeof body.key !== "string" ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(body.key) ||
    !Number.isInteger(body.expectedRevision) ||
    !validEnvelope(body.envelope)
  )
    return error(400, "invalid_setting", "Invalid setting update.");
  const expectedRevision = body.expectedRevision as number;
  const next = expectedRevision + 1;
  const serialized = JSON.stringify(body.envelope);
  const saved =
    expectedRevision === 0
      ? await env.DB.prepare(
          "INSERT OR IGNORE INTO sync_settings(user_id, key, revision, envelope, updated_at) VALUES(?, ?, 1, ?, ?)",
        )
          .bind(auth.userId, body.key, serialized, now())
          .run()
      : await env.DB.prepare(
          "UPDATE sync_settings SET revision = ?, envelope = ?, updated_at = ? WHERE user_id = ? AND key = ? AND revision = ?",
        )
          .bind(next, serialized, now(), auth.userId, body.key, expectedRevision)
          .run();
  if (saved.meta.changes !== 1) {
    const current = await env.DB.prepare(
      "SELECT revision FROM sync_settings WHERE user_id = ? AND key = ?",
    )
      .bind(auth.userId, body.key)
      .first<{ revision: number }>();
    return json(
      {
        error: { code: "revision_conflict", message: "Setting changed remotely." },
        revision: current?.revision ?? 0,
      },
      409,
    );
  }
  return json({ key: body.key, revision: next });
}

async function getSettings(env: Env, auth: AuthContext): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT key, revision, envelope, updated_at FROM sync_settings WHERE user_id = ? ORDER BY key",
  )
    .bind(auth.userId)
    .all<{ key: string; revision: number; envelope: string; updated_at: number }>();
  return json({
    settings: result.results.map((row) => ({
      key: row.key,
      revision: row.revision,
      envelope: JSON.parse(row.envelope),
      updatedAt: row.updated_at,
    })),
  });
}

async function accountKey(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT envelope, updated_at FROM account_keys WHERE user_id = ?",
    )
      .bind(auth.userId)
      .first<{ envelope: string; updated_at: number }>();
    return row
      ? json({ envelope: JSON.parse(row.envelope), updatedAt: row.updated_at })
      : error(404, "account_key_missing", "No wrapped account key exists.");
  }
  const body = object(await readJson(request));
  if (!body || !body.envelope || typeof body.envelope !== "object")
    return error(400, "invalid_key", "A wrapped account-key envelope is required.");
  const serialized = JSON.stringify(body.envelope);
  if (serialized.length > 8_192)
    return error(413, "key_too_large", "Account-key envelope is too large.");
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO account_keys(user_id, envelope, updated_at) VALUES(?, ?, ?)",
  )
    .bind(auth.userId, serialized, now())
    .run();
  if (!inserted.meta.changes)
    return error(409, "account_key_exists", "An account key already exists; it was not replaced.");
  return json({ stored: true });
}

async function listDevices(env: Env, auth: AuthContext): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at",
  )
    .bind(auth.userId)
    .all<{
      id: string;
      name: string;
      created_at: number;
      last_seen_at: number;
      revoked_at: number | null;
    }>();
  return json({
    devices: result.results.map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: device.created_at,
      lastSeenAt: device.last_seen_at,
      revokedAt: device.revoked_at,
      current: device.id === auth.deviceId,
    })),
  });
}

async function revokeDevice(deviceId: string, env: Env, auth: AuthContext): Promise<Response> {
  const result = await env.DB.prepare(
    "UPDATE devices SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL",
  )
    .bind(now(), auth.userId, deviceId)
    .run();
  if (!result.meta.changes) return error(404, "device_not_found", "Active device not found.");
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL",
  )
    .bind(now(), auth.userId, deviceId)
    .run();
  return json({ revoked: true, deviceId });
}

async function status(env: Env, auth: AuthContext): Promise<Response> {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sync_events WHERE user_id = ?) AS events,
       (SELECT COUNT(*) FROM devices WHERE user_id = ? AND revoked_at IS NULL) AS devices,
       (SELECT COUNT(*) FROM sync_settings WHERE user_id = ?) AS settings,
       (SELECT COUNT(*) FROM account_keys WHERE user_id = ?) AS has_key`,
  )
    .bind(auth.userId, auth.userId, auth.userId, auth.userId)
    .first<{ events: number; devices: number; settings: number; has_key: number }>();
  return json({
    events: counts?.events ?? 0,
    devices: counts?.devices ?? 0,
    settings: counts?.settings ?? 0,
    accountKeyConfigured: Boolean(counts?.has_key),
    deviceId: auth.deviceId,
  });
}

async function exportAccount(url: URL, env: Env, auth: AuthContext): Promise<Response> {
  const cursor = Math.max(
    0,
    Number(url.searchParams.get("eventCursor") ?? url.searchParams.get("cursor") ?? 0),
  );
  const deviceOffset = Math.max(0, Number(url.searchParams.get("deviceOffset") ?? 0));
  const settingOffset = Math.max(0, Number(url.searchParams.get("settingOffset") ?? 0));
  const limit = Math.min(
    MAX_EXPORT_ROWS,
    Math.max(1, Number(url.searchParams.get("limit") ?? MAX_EXPORT_ROWS)),
  );
  if (
    !Number.isInteger(cursor) ||
    !Number.isInteger(deviceOffset) ||
    !Number.isInteger(settingOffset) ||
    !Number.isInteger(limit)
  )
    return error(400, "invalid_cursor", "cursor and limit must be integers.");
  const queryLimit = limit + 1;
  const [user, devices, events, settings, key] = await Promise.all([
    env.DB.prepare("SELECT id, github_login, created_at FROM users WHERE id = ?")
      .bind(auth.userId)
      .first<{ id: string; github_login: string; created_at: number }>(),
    env.DB.prepare(
      "SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?",
    )
      .bind(auth.userId, queryLimit, deviceOffset)
      .all(),
    env.DB.prepare(
      "SELECT cursor, event_id, version, device_id, kind, repository_id, created_at, envelope FROM sync_events WHERE user_id = ? AND cursor > ? ORDER BY cursor LIMIT ?",
    )
      .bind(auth.userId, cursor, queryLimit)
      .all(),
    env.DB.prepare(
      "SELECT key, revision, envelope, updated_at FROM sync_settings WHERE user_id = ? ORDER BY key LIMIT ? OFFSET ?",
    )
      .bind(auth.userId, queryLimit, settingOffset)
      .all(),
    env.DB.prepare("SELECT envelope, updated_at FROM account_keys WHERE user_id = ?")
      .bind(auth.userId)
      .first(),
  ]);
  // Reserve room for the fixed response metadata, then share a byte budget
  // across all three independently paginated collections.
  const baseResponseBytes = 50_000;
  let responseBytes = baseResponseBytes;
  let oversizedItem = false;
  const take = (rows: unknown[]): unknown[] => {
    const selected: unknown[] = [];
    for (const item of rows.slice(0, limit)) {
      const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
      if (selected.length && responseBytes + itemBytes + 1 > MAX_RESPONSE_BYTES) break;
      if (!selected.length && responseBytes + itemBytes > MAX_RESPONSE_BYTES) {
        if (baseResponseBytes + itemBytes > MAX_RESPONSE_BYTES) oversizedItem = true;
        break;
      }
      selected.push(item);
      responseBytes += itemBytes + (selected.length > 1 ? 1 : 0);
    }
    return selected;
  };
  const eventPage = take(events.results);
  const devicePage = take(devices.results);
  const settingPage = take(settings.results);
  if (oversizedItem)
    return error(413, "export_item_too_large", "One stored item exceeds the export page limit.");
  const eventCursor = Number(
    (eventPage.at(-1) as { cursor?: number } | undefined)?.cursor ?? cursor,
  );
  const nextDeviceOffset = deviceOffset + devicePage.length;
  const nextSettingOffset = settingOffset + settingPage.length;
  const hasMore =
    eventPage.length < events.results.length ||
    devicePage.length < devices.results.length ||
    settingPage.length < settings.results.length;
  if (url.searchParams.get("paged") !== "1" && hasMore)
    return error(
      409,
      "export_pagination_required",
      "This account requires a client that supports paginated exports.",
    );
  return json({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user,
    devices: devicePage,
    events: eventPage,
    settings: settingPage,
    accountKey: key,
    eventCursor,
    deviceOffset: nextDeviceOffset,
    settingOffset: nextSettingOffset,
    hasMore,
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health")
    return json({ status: "ok", service: "airo-sync", schemaVersion: 1 });
  if (request.method === "GET" && url.pathname === "/v1/auth/config")
    return json({ provider: "github", clientId: env.GITHUB_CLIENT_ID });
  if (request.method === "POST" && ["/v1/auth/github", "/v1/auth/refresh"].includes(url.pathname)) {
    const edgeKey = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limited = await rateLimit(env.EDGE_RATE_LIMITER, `${url.pathname}:${edgeKey}`);
    if (limited) return limited;
    return url.pathname === "/v1/auth/github"
      ? exchangeGithubToken(request, env)
      : refreshSession(request, env);
  }

  const protectedRoute =
    (request.method === "GET" &&
      [
        "/v1/sync/status",
        "/v1/account/export",
        "/v1/sync/pull",
        "/v1/account-key",
        "/v1/settings",
        "/v1/devices",
      ].includes(url.pathname)) ||
    (request.method === "POST" && ["/v1/sync/push", "/v1/auth/logout"].includes(url.pathname)) ||
    (request.method === "PUT" && ["/v1/account-key", "/v1/settings"].includes(url.pathname)) ||
    (request.method === "DELETE" &&
      (url.pathname === "/v1/account" ||
        /^\/v1\/devices\/[a-zA-Z0-9:_-]{8,128}$/.test(url.pathname)));
  if (!protectedRoute) return error(404, "not_found", "Endpoint not found.");

  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const limited = await rateLimit(env.SYNC_RATE_LIMITER, `${auth.userId}:${url.pathname}`);
  if (limited) return limited;
  if (request.method === "GET" && url.pathname === "/v1/sync/status") return status(env, auth);
  if (request.method === "GET" && url.pathname === "/v1/account/export")
    return exportAccount(url, env, auth);
  if (request.method === "POST" && url.pathname === "/v1/sync/push")
    return pushEvents(request, env, auth);
  if (request.method === "GET" && url.pathname === "/v1/sync/pull")
    return pullEvents(url, env, auth);
  if (["GET", "PUT"].includes(request.method) && url.pathname === "/v1/account-key")
    return accountKey(request, env, auth);
  if (request.method === "GET" && url.pathname === "/v1/settings") return getSettings(env, auth);
  if (request.method === "PUT" && url.pathname === "/v1/settings")
    return putSetting(request, env, auth);
  if (request.method === "GET" && url.pathname === "/v1/devices") return listDevices(env, auth);
  const deviceMatch = /^\/v1\/devices\/([a-zA-Z0-9:_-]{8,128})$/.exec(url.pathname);
  if (request.method === "DELETE" && deviceMatch) return revokeDevice(deviceMatch[1], env, auth);
  if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
    await env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
    )
      .bind(now(), auth.familyId)
      .run();
    return json({ loggedOut: true });
  }
  if (request.method === "DELETE" && url.pathname === "/v1/account") {
    const body = object(await readJson(request));
    if (body?.confirmation !== "DELETE")
      return error(400, "confirmation_required", 'Set confirmation to "DELETE".');
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(auth.userId).run();
    return json({ deleted: true });
  }
  return error(404, "not_found", "Endpoint not found.");
}

export async function cleanupExpiredAuth(env: Env, time = now()): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)",
  )
    .bind(time, time - REVOKED_SESSION_RETENTION_SECONDS)
    .run();
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (caught) {
      if (caught instanceof Response) return caught;
      console.error(
        JSON.stringify({
          message: "request failed",
          path: new URL(request.url).pathname,
          error: caught instanceof Error ? caught.message : "unknown error",
        }),
      );
      return error(500, "internal_error", "Request failed.");
    }
  },
  async scheduled(_controller, env): Promise<void> {
    await cleanupExpiredAuth(env);
  },
} satisfies ExportedHandler<Env>;
