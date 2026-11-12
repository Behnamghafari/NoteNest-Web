import test from "node:test";
import assert from "node:assert/strict";
import {
  AAD, validateSyncBatch, encodeSyncBatch, decodeSyncBatch, compareSyncRevision
} from "./vault-sync-batch.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const ID = {
  batch: "123e4567-e89b-42d3-a456-426614174000",
  device: "123e4567-e89b-42d3-a456-426614174001",
  change: "123e4567-e89b-42d3-a456-426614174002",
  entity: "123e4567-e89b-42d3-a456-426614174003"
};
const fixtureBatch = () => ({
  protocolVersion: 1, batchId: ID.batch, deviceId: ID.device,
  firstSequence: 1, lastSequence: 1, createdAt: 1700000000000,
  changes: [{
    changeId: ID.change, sequence: 1, entityType: "note", entitySyncId: ID.entity,
    operation: "upsert",
    revision: { updatedAt: 1700000000000, deviceId: ID.device, changeId: ID.change },
    payload: {
      syncId: ID.entity, title: "Fixture", content: "Cross-platform test",
      folderSyncId: null, isFavorite: false, createdAt: 1699999999000, updatedAt: 1700000000000
    }
  }]
});
const decode64 = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") +
  "=".repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0));

test("decrypts the fixed AES-256-GCM v1 wire fixture with the exact Android AAD", async () => {
  assert.equal(AAD, "NoteNest:SyncBatch:v1");
  const envelope = {
    protocolVersion: 1,
    payload: {
      version: 1, cipher: "AES-256-GCM", nonce: "AAECAwQFBgcICQoL",
      ciphertext: "PCCmaaqRrXjiLcHuw5oRAu30vQXcWT0dTASNzHlLOpAwIp2Zm_Qkr1nBR9TqqhwKimpN7G7jlfcLpRwvKdfE2cQM9krx_QQFeSLDDYrGasoCqPhQRQZnXcvKs6lAydug_8o91Ykg_C-oMQqAfkMQS4tQVpvT9Ae2b5k-v_GSPWvKJ2Wo17LpaTnNas1cqTiRU4WWUFty9mi2bsRVmaCMj-fy-lSd3fZPkFPtyu-wtout_voSp4kQ1ASxp6IC542oaG7pkmyzsax-MvHcmHDrt4RKzUAKLd_JSPO383MsvNciF-GZyxQxE2R2jDmCJUxhmrGVV-5V-NByBQQWqaZzrTa0nOT0rjFqDq8XJY0PVGWu0ejhou7v2xhbFAJzmtkCZSHkaov3_XKmCQxtJ_CY6vrnb2wtp-J2rAQrO6MPc9_4oU4dv1BI2oHMWU8ttm8D53O46r4up3050B0U-ZNk3StKj7D2PR2lApXfAeLFBknwmHs4mtM68KjVBOzsZ2kClbPw6aslt7nXGZ0adyQwvcA6Xoj6FGfiCj27fnSElmIrHmRGouVkRI2M7mTJyYSUal90Ii2hDMeE0YKD4c5WHFhAjOycZNpJ3izXepSs7DNEvlk28Ld_CHbzl4QjybCFLd4eNaej7ewshib9idWB7_HI86BGjJJZ2WHYOeXScS2TX4_MigfreiSD2B8XJlPctJ9aDltN_4C9U3YGg2UphFw_BaXAZcRiRLgyhPBNHYQ-2-JNyOdYR2mIRLTvTv5zSc-JfFtzRGGgzNf34vc_6ifi-8dhq93N0GDWwUaqeKTZI95O-E3a41n38KF5FZA0D_w2REDZm-V9c2VhuPqFSVe07DTTp1mlNfRcEMsGNK1XRLCIKhmgwGKvz4Cxkf2pwuFlFyl8TmyHFfiLKXECtF88uOAKPwNjjL_okjIe4nIrTvDAAQ"
    }
  };
  const decoded = await decodeSyncBatch(new TextEncoder().encode(JSON.stringify(envelope)), KEY);
  assert.deepEqual(decoded, fixtureBatch());
});

test("encodes and decodes a v1 batch and keeps nullable fields explicit", async () => {
  const batch = fixtureBatch();
  const encoded = await encodeSyncBatch(batch, KEY);
  const text = new TextDecoder().decode(encoded);
  assert.equal(text.includes("Cross-platform test"), false);
  assert.deepEqual(await decodeSyncBatch(encoded, KEY), batch);
});

test("accepts delete changes only with a null payload", () => {
  const batch = fixtureBatch();
  batch.changes[0].operation = "delete";
  batch.changes[0].payload = null;
  assert.doesNotThrow(() => validateSyncBatch(batch));
  batch.changes[0].payload = {};
  assert.throws(() => validateSyncBatch(batch));
});

test("rejects non-contiguous, reordered, duplicate and mismatched changes", () => {
  const gap = fixtureBatch();
  gap.lastSequence = 2;
  assert.throws(() => validateSyncBatch(gap));

  const mismatch = fixtureBatch();
  mismatch.changes[0].revision.changeId = ID.entity;
  assert.throws(() => validateSyncBatch(mismatch));

  const duplicate = fixtureBatch();
  duplicate.lastSequence = 2;
  duplicate.changes.push({ ...duplicate.changes[0], sequence: 2 });
  assert.throws(() => validateSyncBatch(duplicate));
});

test("rejects malformed identifiers and incomplete upsert payloads", () => {
  const badId = fixtureBatch();
  badId.batchId = "not-a-uuid";
  assert.throws(() => validateSyncBatch(badId));

  const incomplete = fixtureBatch();
  delete incomplete.changes[0].payload.content;
  assert.throws(() => validateSyncBatch(incomplete));
});

test("rejects unknown envelope versions and authenticated-data tampering", async () => {
  const bytes = await encodeSyncBatch(fixtureBatch(), KEY);
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  envelope.protocolVersion = 2;
  await assert.rejects(() => decodeSyncBatch(new TextEncoder().encode(JSON.stringify(envelope)), KEY));

  const tampered = JSON.parse(new TextDecoder().decode(bytes));
  const cipher = decode64(tampered.payload.ciphertext);
  cipher[0] ^= 1;
  let binary = "";
  for (const byte of cipher) binary += String.fromCharCode(byte);
  tampered.payload.ciphertext = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  await assert.rejects(() => decodeSyncBatch(new TextEncoder().encode(JSON.stringify(tampered)), KEY));
});

test("orders revisions by timestamp, then device ID, then change ID", () => {
  assert.equal(compareSyncRevision(
    { updatedAt: 1, deviceId: ID.device, changeId: ID.change },
    { updatedAt: 2, deviceId: ID.device, changeId: ID.change }
  ), -1);
  assert.equal(compareSyncRevision(
    { updatedAt: 2, deviceId: "device-a", changeId: ID.change },
    { updatedAt: 2, deviceId: "device-b", changeId: ID.change }
  ), -1);
  assert.equal(compareSyncRevision(
    { updatedAt: 2, deviceId: "device-a", changeId: "change-a" },
    { updatedAt: 2, deviceId: "device-a", changeId: "change-b" }
  ), -1);
});
