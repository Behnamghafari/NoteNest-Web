// Public OAuth client ID for the NoteNest Web application.
// Set this to a Google Cloud OAuth 2.0 Client ID of type "Web application".
// This value is public by design. NEVER put a client secret in this file.
export const GOOGLE_CLIENT_ID = "";
export const GOOGLE_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "profile"
].join(" ");
