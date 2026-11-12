const DB_NAME = "notenest-session-v1";
const STORE_NAME = "keys";
const SESSION_ID_KEY = "notenest.web.session-id.v1";
const ENCRYPTED_KEY_KEY = "notenest.web.session-vault-key.v1";

function sessionId() {
  let id = sessionStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB unavailable."));
  });
}

async function withStore(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = action(store);
      if (request) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Session key storage failed."));
      } else {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("Session key storage failed."));
      }
    });
  } finally {
    db.close();
  }
}

export async function storeSessionVaultKey(rawKey) {
  if (!(rawKey instanceof Uint8Array) || rawKey.byteLength !== 32) {
    throw new TypeError("Invalid vault key.");
  }
  const id = sessionId();
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    wrappingKey,
    rawKey
  ));
  await withStore("readwrite", store => store.put(wrappingKey, id));
  sessionStorage.setItem(ENCRYPTED_KEY_KEY, JSON.stringify({
    sessionId: id,
    nonce: Array.from(nonce),
    ciphertext: Array.from(ciphertext)
  }));
}

export async function restoreSessionVaultKey() {
  const encoded = sessionStorage.getItem(ENCRYPTED_KEY_KEY);
  const id = sessionStorage.getItem(SESSION_ID_KEY);
  if (!encoded || !id) return null;
  const record = JSON.parse(encoded);
  if (record.sessionId !== id || !Array.isArray(record.nonce) || !Array.isArray(record.ciphertext)) {
    await clearSessionVaultKey();
    return null;
  }
  const wrappingKey = await withStore("readonly", store => store.get(id));
  if (!wrappingKey) {
    await clearSessionVaultKey();
    return null;
  }
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(record.nonce), tagLength: 128 },
    wrappingKey,
    new Uint8Array(record.ciphertext)
  );
  const key = new Uint8Array(raw);
  if (key.byteLength !== 32) {
    key.fill(0);
    await clearSessionVaultKey();
    throw new Error("Invalid restored vault key.");
  }
  return key;
}

export async function clearSessionVaultKey() {
  const id = sessionStorage.getItem(SESSION_ID_KEY);
  sessionStorage.removeItem(ENCRYPTED_KEY_KEY);
  sessionStorage.removeItem(SESSION_ID_KEY);
  if (id) {
    try { await withStore("readwrite", store => store.delete(id)); } catch {}
  }
}
