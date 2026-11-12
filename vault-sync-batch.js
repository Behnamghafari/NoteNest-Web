// NoteNest incremental sync batch codec v1.
// Mirrors Android VaultSyncBatchCodec and VaultCrypto wire semantics.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const PROTOCOL_VERSION = 1;
const CIPHER = "AES-256-GCM";
const AAD = "NoteNest:SyncBatch:v1";
const MAX_ENVELOPE_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`Invalid ${label} Base64URL value.`);
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new TypeError(`Non-canonical ${label} Base64URL value.`);
  return bytes;
}

function assertKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new TypeError("AES-256 vault keys must contain exactly 32 bytes.");
  }
}

function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`Invalid ${label} UUID.`);
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label} timestamp.`);
}

function requireNullableString(value, label) {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new TypeError(`${label} must be a string or null.`);
  }
}

function normalizeProtocolVersion(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  if (value.protocolVersion == null) value.protocolVersion = PROTOCOL_VERSION;
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported ${label} protocol version.`);
  }
  return value;
}

function validateSyncBatch(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) throw new TypeError("Sync batch must be an object.");
  if (batch.protocolVersion !== PROTOCOL_VERSION) throw new TypeError("Unsupported sync batch protocol version.");
  requireUuid(batch.batchId, "batch");
  requireUuid(batch.deviceId, "device");
  requireTimestamp(batch.createdAt, "batch");
  if (!Array.isArray(batch.changes) || batch.changes.length === 0) {
    throw new TypeError("Sync batch cannot be empty.");
  }
  if (!Number.isSafeInteger(batch.firstSequence) || batch.firstSequence <= 0 ||
      !Number.isSafeInteger(batch.lastSequence) || batch.lastSequence < batch.firstSequence) {
    throw new TypeError("Invalid batch sequence range.");
  }
  if (batch.changes.length !== batch.lastSequence - batch.firstSequence + 1) {
    throw new TypeError("Batch sequences must be contiguous.");
  }
  if (batch.changes[0]?.sequence !== batch.firstSequence ||
      batch.changes.at(-1)?.sequence !== batch.lastSequence) {
    throw new TypeError("Batch sequence bounds do not match its changes.");
  }

  const changeIds = new Set();
  batch.changes.forEach((change, index) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) throw new TypeError("Invalid sync change.");
    requireUuid(change.changeId, "change");
    requireUuid(change.entitySyncId, "entity");
    if (changeIds.has(change.changeId)) throw new TypeError("Duplicate change ID in batch.");
    changeIds.add(change.changeId);
    if (!Number.isSafeInteger(change.sequence) || change.sequence !== batch.firstSequence + index) {
      throw new TypeError("Batch changes must be ordered by contiguous sequence.");
    }
    if (change.entityType !== "note" && change.entityType !== "folder") throw new TypeError("Unsupported sync entity type.");
    if (change.operation !== "upsert" && change.operation !== "delete") throw new TypeError("Unsupported sync operation.");
    const revision = change.revision;
    if (!revision || typeof revision !== "object" || Array.isArray(revision)) throw new TypeError("Invalid change revision.");
    requireTimestamp(revision.updatedAt, "revision");
    if (revision.deviceId !== batch.deviceId) throw new TypeError("Change revision device does not match its batch.");
    if (revision.changeId !== change.changeId) throw new TypeError("Change revision ID does not match its change.");

    if (change.operation === "delete") {
      if (change.payload !== null) throw new TypeError("Delete changes must have a null payload.");
      return;
    }

    const payload = change.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("Upsert changes must contain an entity JSON object.");
    }
    if (payload.syncId !== change.entitySyncId) throw new TypeError("Upsert payload sync ID does not match its change.");
    if (payload.updatedAt !== revision.updatedAt) throw new TypeError("Upsert payload timestamp does not match its revision.");
    requireTimestamp(payload.createdAt, "entity created");
    requireTimestamp(payload.updatedAt, "entity updated");
    if (change.entityType === "note") {
      if (typeof payload.title !== "string" || typeof payload.content !== "string" ||
          typeof payload.isFavorite !== "boolean") throw new TypeError("Note upsert payload is incomplete.");
      requireNullableString(payload.folderSyncId, "Note folderSyncId");
      if (payload.folderSyncId != null) requireUuid(payload.folderSyncId, "note folder");
    } else {
      if (typeof payload.name !== "string" || !payload.name.trim()) throw new TypeError("Folder upsert payload is incomplete.");
      requireNullableString(payload.parentSyncId, "Folder parentSyncId");
      if (payload.parentSyncId != null) requireUuid(payload.parentSyncId, "folder parent");
    }
  });
  return batch;
}

async function encryptPayload(keyBytes, plaintext, nonce) {
  assertKey(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(AAD), tagLength: 128 },
    key, plaintext
  ));
  return ciphertext;
}

async function decryptPayload(keyBytes, nonce, ciphertext) {
  assertKey(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(AAD), tagLength: 128 },
    key, ciphertext
  ));
}

async function encodeSyncBatch(batch, vaultKey) {
  validateSyncBatch(batch);
  assertKey(vaultKey);
  const plaintext = encoder.encode(JSON.stringify(batch));
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await encryptPayload(vaultKey, plaintext, nonce);
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        version: PROTOCOL_VERSION,
        cipher: CIPHER,
        nonce: toBase64Url(nonce),
        ciphertext: toBase64Url(ciphertext)
      }
    };
    const document = encoder.encode(JSON.stringify(envelope));
    if (document.byteLength > MAX_ENVELOPE_BYTES) throw new TypeError("Encrypted sync batch is too large.");
    return document;
  } finally {
    plaintext.fill(0);
  }
}

async function decodeSyncBatch(document, vaultKey) {
  if (!(document instanceof Uint8Array) || document.byteLength === 0 ||
      document.byteLength > MAX_ENVELOPE_BYTES) throw new TypeError("Encrypted sync batch is empty or too large.");
  assertKey(vaultKey);
  const envelopeText = decoder.decode(document);
  const envelope = normalizeProtocolVersion(JSON.parse(envelopeText), "encrypted sync batch");
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.version !== PROTOCOL_VERSION || payload.cipher !== CIPHER) {
    throw new TypeError("Invalid encrypted sync batch payload metadata.");
  }
  const nonce = fromBase64Url(payload.nonce, "nonce");
  const ciphertext = fromBase64Url(payload.ciphertext, "ciphertext");
  if (nonce.byteLength !== 12) throw new TypeError("Invalid AES-GCM nonce length.");
  if (ciphertext.byteLength < 16) throw new TypeError("Invalid AES-GCM ciphertext.");
  const plaintext = await decryptPayload(vaultKey, nonce, ciphertext);
  try {
    const batch = normalizeProtocolVersion(JSON.parse(decoder.decode(plaintext)), "decrypted sync batch");
    return validateSyncBatch(batch);
  } finally {
    plaintext.fill(0);
  }
}

function compareSyncRevision(left, right) {
  requireTimestamp(left?.updatedAt, "left revision");
  requireTimestamp(right?.updatedAt, "right revision");
  if (typeof left.deviceId !== "string" || typeof right.deviceId !== "string" ||
      typeof left.changeId !== "string" || typeof right.changeId !== "string") {
    throw new TypeError("Invalid revision identifiers.");
  }
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -1 : 1;
  if (left.deviceId !== right.deviceId) return left.deviceId < right.deviceId ? -1 : 1;
  if (left.changeId !== right.changeId) return left.changeId < right.changeId ? -1 : 1;
  return 0;
}

export {
  PROTOCOL_VERSION, CIPHER, AAD, MAX_ENVELOPE_BYTES,
  validateSyncBatch, encodeSyncBatch, decodeSyncBatch, compareSyncRevision
};
