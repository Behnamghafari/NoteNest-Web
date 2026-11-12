# NoteNest Web

A read-only browser viewer for the encrypted NoteNest vault and Android incremental sync batches stored in Google Drive.

## Current capabilities
- Persian RTL responsive interface and mixed Persian/English text handling
- Read, search, filter and sort notes and folders from Google Drive (read-only)
- Light/dark theme
- Offline app shell via service worker / PWA manifest
- AES-256-GCM encrypted snapshot storage using the Android Vault v1 format
- Password unlock and recovery-key unlock
- Explicit lock action; vault key remains in memory only while unlocked

## Security model and limitations
- Note content and folder metadata remain in encrypted files in Google Drive; the browser only decrypts them in memory after the user enters the vault password or recovery key. Password-wrapped and recovery-wrapped vault keys remain in the envelope; the raw vault key and password are not persisted.
- PBKDF2-HMAC-SHA256 (600,000 iterations) derives the password wrapping key. AES-256-GCM uses a fresh 96-bit nonce and 128-bit tag.
- The recovery key is shown once during setup. The user must store it separately; losing both password and recovery key means the vault cannot be opened.
- This milestone requests the `drive.readonly` OAuth scope. It never creates folders, uploads, overwrites, moves, or deletes Drive files. Notes are not written to localStorage.
- Use HTTPS (or localhost) so Web Crypto and secure random generation are available.
- Browser JavaScript cannot guarantee secure memory erasure. Locking clears the app's references and zeroes the raw key buffer on a best-effort basis.
- The earlier prototype stored notes without encryption. If such local data exists, setup imports it into the encrypted vault and removes the old plaintext storage only after the encrypted write succeeds. Until setup is completed, old prototype data remains in that browser's localStorage.
- Do not use this browser milestone as the only copy of important data until backup and cross-device sync are available.

## Google Drive integration (read-only)\n- Uses Google's official Identity Services token client with a Web OAuth client ID; no client secret is shipped to the browser.\n- Requests `drive.readonly`, `openid`, and `profile`. The token remains in memory only; a SHA-256 account fingerprint is stored locally to prevent accidental account switching.\n- The Google Identity Services library is loaded from Google's official origin when the user chooses Connect. This is the only external authentication runtime dependency.\n- This branch finds the existing `My Drive/NoteNest` folder without creating it, reads `vault-v1.json` and root-level `notenest-sync-v1-*.json` batches, and displays the decrypted records. It never writes to Drive.\n- Before enabling sync, implement and test Android incremental protocol v1, conflict handling, tombstones, and local/shared privacy rules.\n\n## Validation
Run from the repository root:

```sh
node --check app.js
node --check sw.js
node --check vault-crypto.js
node --test vault-crypto.test.js
```

## Hosting
This repository root is the static site root. GitHub Pages deploys it automatically from `main`. No CDN or external runtime dependency is used.
