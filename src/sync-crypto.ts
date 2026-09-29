import crypto from "node:crypto";
import { Buffer } from "node:buffer";

export interface SyncEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface WrappedAccountKey {
  version: 1;
  format: "airo-account-key";
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  envelope: SyncEnvelope;
}

const SCRYPT_N = 1 << 15;

function b64(value: Buffer): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function requireKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("The AIRO account key must contain 32 bytes.");
}

export function createAccountKey(): Buffer {
  return crypto.randomBytes(32);
}

export function encodeAccountKey(key: Buffer): string {
  requireKey(key);
  return b64(key);
}

export function encryptSyncPayload(key: Buffer, value: unknown, context: string): SyncEnvelope {
  requireKey(key);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`airo-sync-v1\0${context}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    tag: b64(cipher.getAuthTag()),
  };
}

export function decryptSyncPayload<T>(key: Buffer, envelope: SyncEnvelope, context: string): T {
  requireKey(key);
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm")
    throw new Error("Unsupported AIRO sync envelope.");
  const tag = unb64(envelope.tag);
  // Node accepts GCM tags as short as 4 bytes, which lets a malicious or
  // compromised sync server drastically improve its odds of forging a
  // ciphertext. Require the full 16-byte tag produced by encryptSyncPayload.
  if (tag.length !== 16) throw new Error("Invalid AIRO sync authentication tag.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, unb64(envelope.nonce), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(`airo-sync-v1\0${context}`, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(unb64(envelope.ciphertext)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

function recoveryKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 12)
    throw new Error("The recovery passphrase must be at least 12 characters.");
  return crypto.scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 << 20 });
}

export function wrapAccountKey(key: Buffer, passphrase: string): WrappedAccountKey {
  requireKey(key);
  const salt = crypto.randomBytes(16);
  return {
    version: 1,
    format: "airo-account-key",
    kdf: { name: "scrypt", salt: b64(salt), N: SCRYPT_N, r: 8, p: 1 },
    envelope: encryptSyncPayload(recoveryKey(passphrase, salt), b64(key), "account-key"),
  };
}

export function unwrapAccountKey(value: WrappedAccountKey, passphrase: string): Buffer {
  if (
    value.version !== 1 ||
    value.format !== "airo-account-key" ||
    value.kdf?.name !== "scrypt" ||
    value.kdf.N !== SCRYPT_N ||
    value.kdf.r !== 8 ||
    value.kdf.p !== 1
  )
    throw new Error("Unsupported AIRO wrapped account key.");
  const result = unb64(
    decryptSyncPayload<string>(
      recoveryKey(passphrase, unb64(value.kdf.salt)),
      value.envelope,
      "account-key",
    ),
  );
  requireKey(result);
  return result;
}

export function syncRepositoryId(key: Buffer, repositoryId: string): string {
  requireKey(key);
  const indexKey = crypto.hkdfSync(
    "sha256",
    key,
    Buffer.alloc(0),
    "airo-sync-repository-index-v1",
    32,
  );
  return `sync-v1:${crypto.createHmac("sha256", indexKey).update(repositoryId).digest("hex")}`;
}
