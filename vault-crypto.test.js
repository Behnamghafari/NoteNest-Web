import test from "node:test";
import assert from "node:assert/strict";
import {
  derivePasswordKey, createVaultKey, createRecoveryKey,
  wrapVaultKeyWithPassword, unwrapVaultKeyWithPassword,
  wrapVaultKeyWithRecoveryKey, unwrapVaultKeyWithRecoveryKey,
  encryptSnapshotDocument, decryptSnapshotDocument, validateSnapshot
} from "./vault-crypto.js";

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

test("PBKDF2 UTF-8 vector matches Android VaultCrypto", async () => {
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
  assert.equal(hex(await derivePasswordKey("pässword🔐", salt, 2)),
    "6cf0cde005a58355a2403abb9ff991a4d09451b1f7b3c366dd9610f772940f53");
});

test("password and recovery wrapping round-trip the same 256-bit vault key", async () => {
  const key = createVaultKey();
  const passwordWrapped = await wrapVaultKeyWithPassword(key, "test-password");
  const recoveryKey = createRecoveryKey();
  const recoveryWrapped = await wrapVaultKeyWithRecoveryKey(key, recoveryKey);
  assert.deepEqual(await unwrapVaultKeyWithPassword(passwordWrapped, "test-password"), key);
  assert.deepEqual(await unwrapVaultKeyWithRecoveryKey(recoveryWrapped, recoveryKey), key);
  await assert.rejects(() => unwrapVaultKeyWithPassword(passwordWrapped, "wrong-password"));
  await assert.rejects(() => unwrapVaultKeyWithRecoveryKey(recoveryWrapped, createRecoveryKey()));
});

test("snapshot document encrypts and decrypts using Android v1 AAD and schema", async () => {
  const snapshot = {
    schemaVersion: 1, exportedAt: 1794268800000,
    folders: [{ syncId: "123e4567-e89b-42d3-a456-426614174000", name: "Projects",
      parentSyncId: null, createdAt: 1, updatedAt: 2 }],
    notes: [{ syncId: "123e4567-e89b-42d3-a456-426614174001", title: "Mixed English",
      content: "یادداشت خصوصی NoteNest", folderSyncId: "123e4567-e89b-42d3-a456-426614174000",
      isFavorite: true, createdAt: 3, updatedAt: 4 }]
  };
  const key = createVaultKey();
  const passwordWrappedKey = await wrapVaultKeyWithPassword(key, "password");
  const recoveryWrappedKey = await wrapVaultKeyWithRecoveryKey(key, createRecoveryKey());
  const encrypted = await encryptSnapshotDocument(key, passwordWrappedKey, recoveryWrappedKey, snapshot);
  assert.equal(new TextDecoder().decode(encrypted).includes("یادداشت خصوصی"), false);
  assert.deepEqual(await decryptSnapshotDocument(encrypted, key), snapshot);
  const tampered = encrypted.slice();
  tampered[tampered.length - 3] ^= 1;
  await assert.rejects(() => decryptSnapshotDocument(tampered, key));
});

test("snapshot validation rejects unresolved folders and cycles", () => {
  const id1 = "123e4567-e89b-42d3-a456-426614174000";
  const id2 = "123e4567-e89b-42d3-a456-426614174001";
  assert.throws(() => validateSnapshot({ schemaVersion: 1, exportedAt: 1,
    folders: [], notes: [{ syncId: id1, title: "", content: "", folderSyncId: id2,
      isFavorite: false, createdAt: 1, updatedAt: 1 }] }));
  assert.throws(() => validateSnapshot({ schemaVersion: 1, exportedAt: 1,
    folders: [{ syncId: id1, name: "A", parentSyncId: id2, createdAt: 1, updatedAt: 1 },
      { syncId: id2, name: "B", parentSyncId: id1, createdAt: 1, updatedAt: 1 }], notes: [] }));
});

test("Android Gson snapshots may omit nullable folder references", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.doesNotThrow(() => validateSnapshot({
    schemaVersion: 1, exportedAt: 1,
    folders: [{ syncId: id, name: "Root", createdAt: 1, updatedAt: 1 }],
    notes: [{ syncId: "123e4567-e89b-42d3-a456-426614174001",
      title: "Note", content: "Body", isFavorite: false, createdAt: 1, updatedAt: 1 }]
  }));
});
