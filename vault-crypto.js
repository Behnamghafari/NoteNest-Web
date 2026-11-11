// NoteNest Vault v1 — browser implementation of the Android byte-level contract.
const encoder = new TextEncoder();
const FORMAT_VERSION = 1;
const KDF_NAME = "PBKDF2-HMAC-SHA256";
const CIPHER_NAME = "AES-256-GCM";
const PBKDF2_ITERATIONS = 600_000;
const SNAPSHOT_AAD = "NoteNest:VaultSnapshot:v1";
const PASSWORD_WRAP_AAD = "NoteNest:VaultKey:Password:v1";
const RECOVERY_WRAP_AAD = "NoteNest:VaultKey:Recovery:v1";
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Invalid Base64URL value.");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new TypeError("Non-canonical Base64URL value.");
  return bytes;
}

function assertKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new TypeError("AES-256 vault keys must contain exactly 32 bytes.");
  }
}

function assertLength(bytes, expected, label) {
  if (bytes.byteLength !== expected) throw new TypeError(`Invalid ${label} length.`);
}

async function derivePasswordKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  if (typeof password !== "string" || password.length === 0) throw new TypeError("Password must not be empty.");
  assertLength(salt, 16, "PBKDF2 salt");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) {
    throw new TypeError("Invalid PBKDF2 iteration count.");
  }
  const passwordBytes = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256
    ));
  } finally { passwordBytes.fill(0); }
}

async function importAesKey(rawKey, usages) {
  assertKey(rawKey);
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, usages);
}

async function encryptBytes(keyBytes, plaintext, aad) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBytes, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad), tagLength: 128 },
    key, plaintext
  ));
  return { nonce: bytesToBase64Url(nonce), ciphertext: bytesToBase64Url(ciphertext) };
}

async function decryptBytes(keyBytes, nonceText, ciphertextText, aad) {
  assertKey(keyBytes);
  const nonce = base64UrlToBytes(nonceText);
  const ciphertext = base64UrlToBytes(ciphertextText);
  assertLength(nonce, 12, "AES-GCM nonce");
  if (ciphertext.byteLength < 16) throw new TypeError("Invalid AES-GCM ciphertext.");
  const key = await importAesKey(keyBytes, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad), tagLength: 128 },
    key, ciphertext
  ));
}

function createVaultKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

function createRecoveryKey() {
  const bytes = createVaultKey();
  try { return bytesToBase64Url(bytes); }
  finally { bytes.fill(0); }
}

async function wrapVaultKeyWithPassword(vaultKey, password) {
  assertKey(vaultKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await derivePasswordKey(password, salt);
  try {
    const encrypted = await encryptBytes(wrappingKey, vaultKey, PASSWORD_WRAP_AAD);
    return {
      version: FORMAT_VERSION, kdf: KDF_NAME, iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64Url(salt), ...encrypted
    };
  } finally { wrappingKey.fill(0); }
}

async function unwrapVaultKeyWithPassword(wrapped, password) {
  if (!wrapped || wrapped.version !== FORMAT_VERSION || wrapped.kdf !== KDF_NAME) {
    throw new TypeError("Unsupported password-wrapped key format.");
  }
  if (!Number.isInteger(wrapped.iterations) || wrapped.iterations < 100_000 || wrapped.iterations > 2_000_000) {
    throw new TypeError("Invalid PBKDF2 iteration count.");
  }
  const salt = base64UrlToBytes(wrapped.salt);
  assertLength(salt, 16, "PBKDF2 salt");
  const wrappingKey = await derivePasswordKey(password, salt, wrapped.iterations);
  try {
    const key = await decryptBytes(wrappingKey, wrapped.nonce, wrapped.ciphertext, PASSWORD_WRAP_AAD);
    assertKey(key);
    return key;
  } finally { wrappingKey.fill(0); }
}

async function wrapVaultKeyWithRecoveryKey(vaultKey, recoveryKey) {
  assertKey(vaultKey);
  const recoveryBytes = base64UrlToBytes(recoveryKey);
  assertKey(recoveryBytes);
  try {
    return { version: FORMAT_VERSION, cipher: CIPHER_NAME,
      ...await encryptBytes(recoveryBytes, vaultKey, RECOVERY_WRAP_AAD) };
  } finally { recoveryBytes.fill(0); }
}

async function unwrapVaultKeyWithRecoveryKey(wrapped, recoveryKey) {
  if (!wrapped || wrapped.version !== FORMAT_VERSION || wrapped.cipher !== CIPHER_NAME) {
    throw new TypeError("Unsupported recovery-wrapped key format.");
  }
  const recoveryBytes = base64UrlToBytes(recoveryKey);
  assertKey(recoveryBytes);
  try {
    const key = await decryptBytes(recoveryBytes, wrapped.nonce, wrapped.ciphertext, RECOVERY_WRAP_AAD);
    assertKey(key);
    return key;
  } finally { recoveryBytes.fill(0); }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.exportedAt) || snapshot.exportedAt < 0 ||
      !Array.isArray(snapshot.folders) || !Array.isArray(snapshot.notes)) {
    throw new TypeError("Invalid or unsupported vault snapshot.");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const folderMap = new Map();
  for (const folder of snapshot.folders) {
    if (!folder || !uuid.test(folder.syncId) || folderMap.has(folder.syncId) ||
        typeof folder.name !== "string" || !folder.name.trim() ||
        !Number.isSafeInteger(folder.createdAt) || folder.createdAt < 0 ||
        !Number.isSafeInteger(folder.updatedAt) || folder.updatedAt < 0 ||
        (folder.parentSyncId != null && typeof folder.parentSyncId !== "string")) {
      throw new TypeError("Invalid folder record.");
    }
    folderMap.set(folder.syncId, folder);
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError("Folder hierarchy contains a cycle.");
    visiting.add(id);
    const parent = folderMap.get(id).parentSyncId ?? null;
    if (parent !== null) {
      if (!folderMap.has(parent)) throw new TypeError("Folder parent does not exist.");
      visit(parent);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of folderMap.keys()) visit(id);
  const noteIds = new Set();
  for (const note of snapshot.notes) {
    if (!note || !uuid.test(note.syncId) || noteIds.has(note.syncId) ||
        typeof note.title !== "string" || typeof note.content !== "string" ||
        typeof note.isFavorite !== "boolean" ||
        !Number.isSafeInteger(note.createdAt) || note.createdAt < 0 ||
        !Number.isSafeInteger(note.updatedAt) || note.updatedAt < 0 ||
        (note.folderSyncId != null && !folderMap.has(note.folderSyncId))) {
      throw new TypeError("Invalid note record or unresolved folder reference.");
    }
    noteIds.add(note.syncId);
  }
  return snapshot;
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.formatVersion !== FORMAT_VERSION) throw new TypeError("Unsupported vault document version.");
  const p = envelope.passwordWrappedKey, r = envelope.recoveryWrappedKey, payload = envelope.payload;
  if (!p || p.version !== 1 || p.kdf !== KDF_NAME || !Number.isInteger(p.iterations) ||
      p.iterations < 100_000 || p.iterations > 2_000_000) throw new TypeError("Invalid password key metadata.");
  if (!r || r.version !== 1 || r.cipher !== CIPHER_NAME) throw new TypeError("Invalid recovery key metadata.");
  if (!payload || payload.version !== 1 || payload.cipher !== CIPHER_NAME) throw new TypeError("Invalid payload metadata.");
  for (const item of [p, r, payload]) {
    base64UrlToBytes(item.nonce); base64UrlToBytes(item.ciphertext);
  }
  assertLength(base64UrlToBytes(p.salt), 16, "PBKDF2 salt");
  assertLength(base64UrlToBytes(p.nonce), 12, "password nonce");
  assertLength(base64UrlToBytes(r.nonce), 12, "recovery nonce");
  assertLength(base64UrlToBytes(payload.nonce), 12, "snapshot nonce");
  return envelope;
}

async function encryptSnapshotDocument(vaultKey, passwordWrappedKey, recoveryWrappedKey, snapshot) {
  assertKey(vaultKey); validateSnapshot(snapshot);
  const plaintext = encoder.encode(JSON.stringify(snapshot));
  try {
    const payload = { version: 1, cipher: CIPHER_NAME, ...await encryptBytes(vaultKey, plaintext, SNAPSHOT_AAD) };
    return new TextEncoder().encode(JSON.stringify({
      formatVersion: FORMAT_VERSION, passwordWrappedKey, recoveryWrappedKey, payload
    }));
  } finally { plaintext.fill(0); }
}

async function decryptSnapshotDocument(documentBytes, vaultKey) {
  if (!(documentBytes instanceof Uint8Array) || documentBytes.byteLength === 0 ||
      documentBytes.byteLength > MAX_DOCUMENT_BYTES) throw new TypeError("Vault document is empty or too large.");
  const envelope = validateEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(documentBytes)));
  const plaintext = await decryptBytes(vaultKey, envelope.payload.nonce, envelope.payload.ciphertext, SNAPSHOT_AAD);
  try {
    return validateSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
  } finally { plaintext.fill(0); }
}

export {
  FORMAT_VERSION, KDF_NAME, CIPHER_NAME, PBKDF2_ITERATIONS,
  bytesToBase64Url, base64UrlToBytes, derivePasswordKey, createVaultKey, createRecoveryKey,
  wrapVaultKeyWithPassword, unwrapVaultKeyWithPassword,
  wrapVaultKeyWithRecoveryKey, unwrapVaultKeyWithRecoveryKey,
  validateSnapshot, validateEnvelope, encryptSnapshotDocument, decryptSnapshotDocument
};
