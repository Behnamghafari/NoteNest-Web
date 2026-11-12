const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const USERINFO_API = "https://openidconnect.googleapis.com/v1/userinfo";
const FOLDER_MIME = "application/vnd.google-apps.folder";
let scriptPromise;
let tokenClient;
let activeToken = null;
let tokenExpiresAt = 0;

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-notenest-google-identity="true"]');
    const script = existing || document.createElement("script");
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.defer = true;
    script.dataset.notenestGoogleIdentity = "true";
    script.onload = resolve;
    script.onerror = () => reject(new Error("بارگذاری سرویس ورود گوگل ناموفق بود."));
    if (!existing) document.head.append(script);
  });
  return scriptPromise;
}

function base64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function request(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).error?.message || ""; } catch {}
    if (response.status === 401) { activeToken = null; tokenExpiresAt = 0; }
    throw new Error(`Google Drive: HTTP ${response.status}${detail ? " — " + detail : ""}`);
  }
  return response;
}

const SESSION_TOKEN_KEY = "notenest.web.drive-token.v1";

function restoreSessionToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_TOKEN_KEY) || "null");
    if (!saved || typeof saved.accessToken !== "string" ||
        !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      return false;
    }
    activeToken = saved.accessToken;
    tokenExpiresAt = saved.expiresAt;
    return true;
  } catch {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    return false;
  }
}

function clearSessionToken() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  activeToken = null;
  tokenExpiresAt = 0;
}

export async function connectGoogleDrive(clientId, scopes, {
  prompt = "consent",
  reuseSession = true,
  allowInteractive = true
} = {}) {
  if (!clientId || !clientId.endsWith(".apps.googleusercontent.com")) {
    throw new Error("شناسه OAuth وب معتبر نیست. Client ID را در drive-config.js تنظیم کن.");
  }
  await loadGoogleIdentity();
  if (reuseSession && restoreSessionToken()) {
    try {
      const user = await request(USERINFO_API, activeToken).then(r => r.json());
      if (!user.sub) throw new Error("شناسه حساب گوگل دریافت نشد.");
      return { accountFingerprint: await sha256Hex(user.sub), expiresAt: tokenExpiresAt, reused: true };
    } catch (error) {
      clearSessionToken();
      if (!allowInteractive) throw new Error("نشست اتصال گوگل منقضی شده؛ برای اتصال دوباره دکمه را بزن.");
    }
  }
  if (!allowInteractive) {
    throw new Error("برای اتصال دوباره به گوگل، دکمهٔ اتصال را بزن.");
  }
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scopes,
      callback: async response => {
        if (response.error) return reject(new Error(response.error_description || response.error));
        activeToken = response.access_token;
        tokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in || 0) - 60) * 1000;
        try {
          sessionStorage.setItem(SESSION_TOKEN_KEY, JSON.stringify({
            accessToken: activeToken,
            expiresAt: tokenExpiresAt
          }));
        } catch {}
        try {
          const user = await request(USERINFO_API, activeToken).then(r => r.json());
          if (!user.sub) throw new Error("شناسه پایدار حساب گوگل دریافت نشد.");
          const accountFingerprint = await sha256Hex(user.sub);
          resolve({ accountFingerprint, expiresAt: tokenExpiresAt });
        } catch (error) {
          clearSessionToken();
          reject(error);
        }
      },
      error_callback: error => reject(new Error(error.message || "ورود گوگل لغو شد."))
    });
    tokenClient.requestAccessToken({ prompt });
  });
}

export function getAccessToken() {
  if (!activeToken || Date.now() >= tokenExpiresAt) throw new Error("نشست گوگل منقضی شده؛ دوباره متصل شو.");
  return activeToken;
}

export function disconnectGoogleDrive() {
  if (activeToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(activeToken, () => {});
  }
  clearSessionToken();
  tokenClient = null;
}

export async function findNoteNestFolder() {
  const token = getAccessToken();
  const q = encodeURIComponent("name = 'NoteNest' and mimeType = '" + FOLDER_MIME + "' and 'root' in parents and trashed = false");
  const found = await request(`${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name,mimeType)&pageSize=100`, token).then(r => r.json());
  if (found.files?.length) return found.files[0];
  return null;
}

export async function listNoteNestFiles(folderId) {
  const token = getAccessToken();
  const q = encodeURIComponent("'" + folderId.replace(/'/g, "\\'") + "' in parents and trashed = false");
  const files = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "";
    const page = await request(`${DRIVE_API}/files?q=${q}&spaces=drive&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)&pageSize=1000${suffix}`, token).then(r => r.json());
    files.push(...(page.files || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return files;
}

export async function downloadEncryptedFile(fileId) {
  const token = getAccessToken();
  return request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, token).then(r => r.arrayBuffer());
}


export function getReadOnlyAccessToken() { return getAccessToken(); }
