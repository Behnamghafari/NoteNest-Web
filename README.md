# NoteNest Web

A local-first browser client for NoteNest with an encrypted local vault.

## Current capabilities
- Persian RTL responsive interface and mixed Persian/English text handling
- Create, edit, search, favorite, sort and organize notes in folders
- Light/dark theme
- Offline app shell via service worker / PWA manifest
- First-run vault setup with a password and one-time recovery key
- AES-256-GCM encrypted snapshot storage using the Android Vault v1 format
- Password unlock and recovery-key unlock
- Explicit lock action; vault key remains in memory only while unlocked
- Migration of the earlier local-only notes into the encrypted vault during setup

## Security model and limitations
- Note content and folder metadata are stored as an encrypted Vault v1 document in browser localStorage. Password-wrapped and recovery-wrapped vault keys remain in the envelope; the raw vault key and password are not persisted.
- PBKDF2-HMAC-SHA256 (600,000 iterations) derives the password wrapping key. AES-256-GCM uses a fresh 96-bit nonce and 128-bit tag.
- The recovery key is shown once during setup. The user must store it separately; losing both password and recovery key means the vault cannot be opened.
- Browser storage is device/browser-local and can be cleared by the browser or operating system. This milestone does not yet sync with Android or Google Drive.
- Use HTTPS (or localhost) so Web Crypto and secure random generation are available.
- Browser JavaScript cannot guarantee secure memory erasure. Locking clears the app's references and zeroes the raw key buffer on a best-effort basis.
- The earlier prototype stored notes without encryption. If such local data exists, setup imports it into the encrypted vault and removes the old plaintext storage only after the encrypted write succeeds. Until setup is completed, old prototype data remains in that browser's localStorage.
- Do not use this browser milestone as the only copy of important data until backup and cross-device sync are available.

## Validation
Run from the repository root:

```sh
node --check app.js
node --check sw.js
node --check vault-crypto.js
node --test vault-crypto.test.js
```

## Hosting
This repository root is the static site root. GitHub Pages deploys it automatically from `main`. No CDN or external runtime dependency is used.
