/* Authentication, restricted to one email domain (default avantarte.com).
 *
 * Three ways in, all ending in the same signed HttpOnly session cookie:
 *   - Sign in with Google (server/googleLogin.js): GET /auth/google sends the
 *     browser to Google with a signed state + nonce held in a short-lived
 *     cookie; GET /auth/google/callback verifies state, exchanges the code,
 *     verifies the ID token and its domain, and signs the person in. An
 *     account in the domain that is not yet on the Permissions tab is added
 *     as a user (GOOGLE_LOGIN_ALLOWLIST_ONLY=1 refuses it instead).
 *     LOGIN_GOOGLE_ONLY=1 hides the password form once everyone has moved.
 *   - Password (Permissions tab accounts): POST /auth/login {email, password}.
 *   - Magic link (dormant): POST /auth/request {email} -> single-use signed
 *     token (15 min) emailed as a link -> GET /auth/verify?token=...
 *
 * Email delivery uses Resend (RESEND_API_KEY + MAIL_FROM on a verified domain).
 * Without a key the link is printed to the server log only (fish it out of the
 * Render logs) - it is never returned to the browser.
 *
 * Set SESSION_SECRET in production; the per-boot fallback signs everyone out on
 * each deploy. Used-token and rate-limit state is in-memory (fine for one
 * instance; resets on deploy). */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "avantarte.com").toLowerCase();

// Sessions must survive restarts or everyone re-logs-in on every deploy: use
// SESSION_SECRET when set (the durable option - survives deploys too), else a
// generated secret persisted to disk (survives restarts; a fresh deploy wipes
// the disk on Render, so set the env var there).
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const p = path.resolve(__dirname, "..", "data", ".session_secret");
  try {
    const s = fs.readFileSync(p, "utf8").trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, { mode: 0o600 });
    console.warn("auth: SESSION_SECRET not set - generated one in data/.session_secret " +
      "(set SESSION_SECRET in the environment so sign-ins also survive deploys)");
  } catch {
    console.warn("auth: SESSION_SECRET not set and disk not writable - sessions reset on restart");
  }
  return s;
}
const SECRET = loadSecret();
// Password login (magic-link kept dormant below): per-user accounts managed on
// the dashboard's Permissions tab (server/users.js; seeded from LOGIN_USERS /
// LOGIN_PASSWORD when the store file is missing).
const users = require("./users");

const RESEND_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || `Launch BI <login@${DOMAIN}>`;
const COOKIE = "lbi_session";
const GSTATE = "lbi_gstate";   // Google sign-in state, 10 minutes, scoped to /auth/google
const google = require("./googleLogin");
const LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;

// one Set-Cookie shape everywhere (login, verify, sliding renewal)
const sessionCookie = (req, email) => {
  const token = sign({ kind: "session", email, exp: Date.now() + SESSION_TTL_MS });
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_TTL_MS / 1000}` + (req.secure ? "; Secure" : "");
};

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload) => {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
};
const verify = (token) => {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (mac.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
};

const usedTokens = new Map();           // token id -> expiry
const attempts = new Map();             // key -> [timestamps]
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of usedTokens) if (exp < now) usedTokens.delete(k);
  for (const [k, ts] of attempts) {
    const keep = ts.filter((t) => now - t < 15 * 60 * 1000);
    if (keep.length) attempts.set(k, keep); else attempts.delete(k);
  }
}, 60 * 1000).unref();

function rateLimited(key, max) {
  const now = Date.now();
  const ts = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  ts.push(now);
  attempts.set(key, ts);
  return ts.length > max;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// A session is only as good as its account: removing a user on the Permissions
// tab invalidates their (otherwise stateless, 90-day) cookie immediately.
function sessionFrom(req) {
  const payload = verify(parseCookies(req)[COOKIE] || "");
  if (!payload || payload.kind !== "session") return null;
  return users.exists(payload.email) ? payload : null;
}

async function sendMagicLink(email, link) {
  if (!RESEND_KEY) {
    console.log(`auth: RESEND_API_KEY not set - magic link for ${email}: ${link}`);
    return { ok: true, delivered: false };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [email],
      subject: "Your Launch Performance sign-in link",
      text: `Sign in to the Launch Performance dashboard:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't request it, ignore this email.`,
    }),
  });
  if (!res.ok) {
    console.error("auth: resend error", res.status, await res.text().catch(() => ""));
    return { ok: false, delivered: false };
  }
  return { ok: true, delivered: true };
}

const LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Launch Performance</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #faf9f5; color: #141413; font-family: "Inter", -apple-system, sans-serif;
         font-feature-settings: "cv05","ss01"; font-size: 13px;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #fff; border: 1px solid #e5e4df; border-radius: 12px; padding: 32px; width: 360px; }
  h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  p { font-size: 12.5px; color: #6c6b68; margin-top: 6px; line-height: 1.5; }
  input { width: 100%; height: 36px; border: 1px solid #e5e4df; border-radius: 8px; padding: 0 12px;
          font-family: inherit; font-size: 13px; margin-top: 12px; }
  input:focus { outline: 2px solid #f7c4ad; outline-offset: -1px; }
  button { width: 100%; margin-top: 12px; height: 36px; border-radius: 8px; border: 1px solid #141413;
           background: #141413; color: #fff; font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2e2d2b; }
  .msg { margin-top: 14px; font-size: 12.5px; display: none; color: #b8461d; }
  .gbtn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; height: 38px;
          margin-top: 16px; border: 1px solid #e5e4df; border-radius: 8px; background: #fff; color: #141413;
          font-family: inherit; font-size: 12.5px; font-weight: 600; text-decoration: none; }
  .gbtn:hover { background: #faf9f5; }
  .or { display: flex; align-items: center; gap: 10px; margin-top: 14px; color: #6c6b68; font-size: 12px; }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: #e5e4df; }
</style></head><body>
<div class="card">
  <h1>Launch Performance</h1>
  <p>Sign in with your __DOMAIN__ account.</p>
  __GOOGLE__
  <form id="f" __FORM__>
    <input id="email" type="email" placeholder="you@__DOMAIN__" autocomplete="email" required>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit">Sign in with password</button>
  </form>
  <div id="err" class="msg" __ERR__></div>
</div>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.style.display = 'none';
    try {
      const res = await fetch('/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email: document.getElementById('email').value.trim(),
                               password: document.getElementById('pw').value }) });
      if (res.ok) { location.href = '/'; return; }
      const d = await res.json().catch(() => ({}));
      err.textContent = d.error || 'Sign-in failed.'; err.style.display = 'block';
    } catch { err.textContent = 'Network error.'; err.style.display = 'block'; }
  });
</script></body></html>`.replaceAll("__DOMAIN__", DOMAIN);

const G_LOGO = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">' +
  '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 7-10.3 7-17.7z"/>' +
  '<path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.7 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/>' +
  '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loginHtml(error) {
  const g = google.configured();
  const googleOnly = g && process.env.LOGIN_GOOGLE_ONLY === "1";
  return LOGIN_HTML
    .replace("__GOOGLE__", g
      ? `<a class="gbtn" href="/auth/google">${G_LOGO}Continue with Google</a>` + (googleOnly ? "" : '<div class="or">or</div>')
      : "")
    .replace("__FORM__", googleOnly ? 'style="display:none"' : "")
    .replace("__ERR__", error ? `style="display:block">${esc(error)}` : ">")
    .replace('<div id="err" class="msg" >', '<div id="err" class="msg">');
}

function install(app) {
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/login", (req, res) => res.type("html").send(loginHtml(req.query.error ? String(req.query.error).slice(0, 200) : "")));

  // ---- Sign in with Google
  const stateCookie = (req, value, maxAge) =>
    `${GSTATE}=${encodeURIComponent(value)}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (req.secure ? "; Secure" : "");
  app.get("/auth/google", (req, res) => {
    if (!google.configured()) return res.redirect("/login?error=" + encodeURIComponent("Google sign-in is not set up on this server."));
    const nonce = crypto.randomBytes(16).toString("base64url");
    const state = sign({ kind: "gstate", nonce, exp: Date.now() + 10 * 60 * 1000 });
    res.setHeader("Set-Cookie", stateCookie(req, state, 600));
    res.redirect(google.startUrl(req, state, nonce, DOMAIN));
  });
  app.get("/auth/google/callback", async (req, res) => {
    const fail = (msg) => {
      res.setHeader("Set-Cookie", stateCookie(req, "", 0));
      res.redirect("/login?error=" + encodeURIComponent(msg));
    };
    try {
      const state = String(req.query.state || "");
      const payload = verify(state);
      if (!payload || payload.kind !== "gstate" || state !== (parseCookies(req)[GSTATE] || "")) {
        return fail("That sign-in attempt expired - try again.");
      }
      if (req.query.error) return fail("Google did not complete the sign-in (" + String(req.query.error).slice(0, 60) + ").");
      const claims = await google.signIn(req, String(req.query.code || ""), payload.nonce, DOMAIN);
      const email = claims.email;
      if (!users.exists(email)) {
        if (process.env.GOOGLE_LOGIN_ALLOWLIST_ONLY === "1") {
          return fail("Your Google account is not on the access list - ask an admin to add you.");
        }
        users.upsert(email, { admin: false }, "google");
      }
      res.setHeader("Set-Cookie", [sessionCookie(req, email), stateCookie(req, "", 0)]);
      res.redirect("/");
    } catch (e) {
      console.error("auth: google sign-in failed -", e.message);
      return fail(/domain/.test(e.message) ? `Use your @${DOMAIN} Google account.` : "Google sign-in failed - try again.");
    }
  });

  app.post("/auth/login", (req, res) => {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const password = String((req.body && req.body.password) || "");
    const ip = req.ip || "?";
    if (rateLimited("lip:" + ip, 20) || rateLimited("lem:" + email, 10)) {
      return res.status(429).json({ error: "Too many attempts - try again in a few minutes." });
    }
    const user = users.get(email);
    if (!user || !users.verifyPassword(user, password)) {
      return res.status(401).json({ error: "Wrong email or password." });
    }
    res.setHeader("Set-Cookie", sessionCookie(req, email));
    res.json({ ok: true });
  });

  app.post("/auth/request", async (req, res) => {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const ip = req.ip || "?";
    if (rateLimited("ip:" + ip, 20) || rateLimited("em:" + email, 5)) {
      return res.status(429).json({ error: "Too many requests - try again in a few minutes." });
    }
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !email.endsWith("@" + DOMAIN)) {
      return res.status(400).json({ error: `Use your @${DOMAIN} email address.` });
    }
    const id = crypto.randomBytes(12).toString("base64url");
    const token = sign({ kind: "login", id, email, exp: Date.now() + LINK_TTL_MS });
    const link = `${req.protocol}://${req.get("host")}/auth/verify?token=${encodeURIComponent(token)}`;
    const sent = await sendMagicLink(email, link);
    if (!sent.ok) return res.status(502).json({ error: "Could not send the email - try again or contact the admin." });
    res.json({ ok: true });
  });

  app.get("/auth/verify", (req, res) => {
    const payload = verify(String(req.query.token || ""));
    if (!payload || payload.kind !== "login" || usedTokens.has(payload.id)) {
      return res.status(400).type("html").send(
        '<meta charset="utf-8"><body style="font-family:Inter,sans-serif;padding:40px">' +
        'That sign-in link is invalid or has already been used. <a href="/login">Request a new one</a>.</body>');
    }
    usedTokens.set(payload.id, payload.exp);
    res.setHeader("Set-Cookie", sessionCookie(req, payload.email));
    res.redirect("/");
  });

  app.get("/auth/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect("/login");
  });

  app.get("/auth/me", (req, res) => {
    const s = sessionFrom(req);
    if (!s) return res.status(401).json({ error: "not signed in" });
    const u = users.get(s.email);
    res.json({ email: s.email, admin: !!(u && u.admin) });
  });

  // the gate: everything below /auth, /login, /healthz requires a session.
  // Sliding renewal: any activity in the back half of a session's life reissues
  // the cookie for a fresh 90 days, so active users stay signed in indefinitely.
  app.use((req, res, next) => {
    const s = sessionFrom(req);
    if (s) {
      if (s.exp - Date.now() < SESSION_TTL_MS / 2) {
        res.setHeader("Set-Cookie", sessionCookie(req, s.email));
      }
      return next();
    }
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not signed in" });
    return res.redirect("/login");
  });
}

module.exports = { install, sessionFrom, DOMAIN };
