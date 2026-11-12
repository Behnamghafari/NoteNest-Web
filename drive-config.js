// Public OAuth client ID for the NoteNest Web application.
// Set this to a Google Cloud OAuth 2.0 Client ID of type "Web application".
// This value is public by design. NEVER put a client secret in this file.
export const GOOGLE_CLIENT_ID = "133014235496-c18i79ncbrljkrpv5s58ivp91tq1fkd9.apps.googleusercontent.com";
export const GOOGLE_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "profile"
].join(" ");
