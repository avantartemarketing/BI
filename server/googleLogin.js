/* Sign in with Google (OpenID Connect, authorization-code flow).
 *
 * Configured by GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET (a "Web
 * application" OAuth client in Google Cloud Console whose authorised redirect
 * URI is <site>/auth/google/callback). auth.js owns the routes, the state
 * cookie and the session; this module builds the Google URL, exchanges the
 * code and verifies the ID token itself: RS256 signature against Google's
 * published keys, issuer, audience, expiry, nonce, verified email, and the
 * account's domain (the hd claim, or the address's domain). Nothing here
 * trusts the token endpoint's response beyond the signature check. */
const crypto = require("crypto");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const configured = () => !!(CLIENT_ID && CLIENT_SECRET);

function redirectUri(req) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  return `${base}/auth/google/callback`;
}

function startUrl(req, state, nonce, hd) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri(req), response_type: "code",
    scope: "openid email profile", state, nonce, prompt: "select_account", access_type: "online",
  });
  if (hd) q.set("hd", hd); // pre-selects the Workspace domain on Google's side; the token check is what enforces it
  return `${AUTH_URL}?${q.toString()}`;
}

let jwks = { keys: null, at: 0 };
async function signingKeys(force) {
  if (!force && jwks.keys && Date.now() - jwks.at < 6 * 3600 * 1000) return jwks.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`could not fetch Google signing keys (${res.status})`);
  const body = await res.json();
  jwks = { keys: body.keys || [], at: Date.now() };
  return jwks.keys;
}

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

async function verifyIdToken(idToken, { nonce, hd } = {}) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const header = decode(parts[0]);
  if (header.alg !== "RS256") throw new Error(`unexpected id_token alg ${header.alg}`);
  let keys = await signingKeys(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await signingKeys(true); jwk = keys.find((k) => k.kid === header.kid); } // key rotation
  if (!jwk) throw new Error("id_token signing key not found");
  const ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("id_token signature check failed");
  const c = decode(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(c.iss)) throw new Error("id_token issuer is not Google");
  if (c.aud !== CLIENT_ID) throw new Error("id_token audience is not this app");
  if (!c.exp || c.exp < now - 60) throw new Error("id_token has expired");
  if (nonce && c.nonce !== nonce) throw new Error("id_token nonce mismatch");
  if (!(c.email_verified === true || c.email_verified === "true")) throw new Error("Google has not verified this email");
  const email = String(c.email || "").toLowerCase();
  if (!email) throw new Error("id_token carries no email");
  if (hd && c.hd !== hd && !email.endsWith("@" + hd)) throw new Error(`account is not in the ${hd} domain`);
  return { ...c, email };
}

/* Exchanges the callback's code for tokens and returns the verified claims. */
async function signIn(req, code, nonce, hd) {
  if (!code) throw new Error("no authorization code in the callback");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req), grant_type: "authorization_code" }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    throw new Error(`token exchange failed: ${body.error || res.status} ${body.error_description || ""}`.trim());
  }
  return verifyIdToken(body.id_token, { nonce, hd });
}

module.exports = { configured, startUrl, signIn, verifyIdToken, redirectUri };
