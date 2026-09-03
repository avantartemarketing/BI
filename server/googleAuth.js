/* Google service-account auth, shared by the Sheets and BigQuery feeds.
 *
 * Both feeds sign a JWT with the service account's private key and swap it for
 * a bearer token. They need DIFFERENT scopes, so the token cache is keyed by
 * (client_email, scope) - handing a spreadsheets token to BigQuery would fail
 * with a 403 that reads like a permissions problem.
 *
 * Keys live in env vars only, never in the repo:
 *   GOOGLE_SERVICE_ACCOUNT_JSON    - the sheet reader
 *   BIGQUERY_SERVICE_ACCOUNT_JSON  - the BigQuery reader (falls back to the above
 *                                    when the same account can do both) */
const crypto = require("crypto");

const SCOPES = {
  sheets: "https://www.googleapis.com/auth/spreadsheets.readonly",
  bigquery: "https://www.googleapis.com/auth/bigquery.readonly",
};

/* Reads the first env var that is set, in order. Returns null when none is -
 * every caller treats that as "this feed is switched off", not an error. */
function serviceAccount(...envNames) {
  for (const name of envNames) {
    const raw = process.env[name];
    if (!raw) continue;
    let sa;
    try {
      sa = JSON.parse(raw);
    } catch (e) {
      // a key pasted through a shell often arrives with the newlines in
      // private_key escaped or stripped; say so rather than "unexpected token"
      throw new Error(`${name} is not valid JSON (${e.message}) - paste the key file verbatim, ` +
        "including the \\n escapes inside private_key");
    }
    if (!sa.client_email || !sa.private_key) {
      throw new Error(`${name} is missing client_email/private_key - is it a service-account key?`);
    }
    // Render's env editor sometimes turns "\n" into a literal backslash-n
    if (!sa.private_key.includes("\n")) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    return { ...sa, _env: name };
  }
  return null;
}

const cache = new Map(); // "client_email|scope" -> { token, exp }

async function accessToken(sa, scopeName) {
  const scope = SCOPES[scopeName] || scopeName;
  const key = `${sa.client_email}|${scope}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;

  const b64u = (s) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64u(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64u(JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now, exp: now + 3600,
    }));
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
  const jwt = unsigned + "." + sig.toString("base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(jwt),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange failed for ${sa.client_email} (${res.status}): ` +
      (body.error_description || body.error || "?"));
  }
  const token = { token: body.access_token, exp: (now + (body.expires_in || 3600)) * 1000 };
  cache.set(key, token);
  return token.token;
}

module.exports = { serviceAccount, accessToken, SCOPES };
