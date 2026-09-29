import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccountKey,
  decryptSyncPayload,
  encryptSyncPayload,
  syncRepositoryId,
  unwrapAccountKey,
  wrapAccountKey,
} from "../sync-crypto.js";

const PASSPHRASE = "correct horse battery staple";

test("encrypts sync records with authenticated context", () => {
  const key = createAccountKey();
  const envelope = encryptSyncPayload(
    key,
    { id: "record-one", task: "private" },
    "event:history:record-one",
  );
  assert.doesNotMatch(JSON.stringify(envelope), /private/);
  assert.deepEqual(decryptSyncPayload(key, envelope, "event:history:record-one"), {
    id: "record-one",
    task: "private",
  });
  assert.throws(() => decryptSyncPayload(key, envelope, "event:feedback:record-one"));
  assert.throws(() => encryptSyncPayload(Buffer.alloc(8), {}, "invalid"), /32 bytes/);
  assert.throws(() =>
    decryptSyncPayload(key, { ...envelope, version: 2 } as never, "event:history:record-one"),
  );
});

test("wraps account keys for passphrase recovery", () => {
  const key = createAccountKey();
  const wrapped = wrapAccountKey(key, PASSPHRASE);
  assert.deepEqual(unwrapAccountKey(wrapped, PASSPHRASE), key);
  assert.throws(() => unwrapAccountKey(wrapped, "incorrect password"));
  assert.throws(() => wrapAccountKey(key, "short"), /at least 12/);
});

test("derives stable account-specific repository indexes", () => {
  const first = createAccountKey();
  const second = createAccountKey();
  const id = "git-v1:public-repository-hash";
  assert.equal(syncRepositoryId(first, id), syncRepositoryId(first, id));
  assert.notEqual(syncRepositoryId(first, id), syncRepositoryId(second, id));
  assert.match(syncRepositoryId(first, id), /^sync-v1:[a-f0-9]{64}$/);
});
