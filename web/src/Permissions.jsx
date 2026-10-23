/* Permissions (the workspace menu, admins only): who can open the dashboard.
 * App-level, not per-release. Everyone signs in with their company Google
 * account, so the page is an access list plus a role per person: invite
 * someone ahead of their first sign-in (as an admin, or to pre-approve them
 * when the server admits listed accounts only), change a role, remove access.
 * Removal takes effect at the person's next request. The list comes from
 * GET /api/users; changes go through POST /api/users and DELETE
 * /api/users/:email, which also keep the last admin and refuse self-removal.
 * With no Google client configured (a review build, local development) the
 * server wants a password for every new user, so the invite row grows one. */
import React, { useEffect, useRef, useState } from "react";
import { Avatar, Menu, MenuItem, Note, useMenu } from "./ui.jsx";
import { Caret, Hamburger, X } from "./icons.jsx";
import "./permissions.css";

const ROLES = [
  { key: "admin", label: "Admin", what: "Everything, and this page" },
  { key: "user", label: "User", what: "Every release, the Overview and Target setting tabs" },
];
const roleOf = (u) => (u.admin ? ROLES[0] : ROLES[1]);

/* "tom.lloyd@avantarte.com" reads as "Tom Lloyd" */
function nameOf(email) {
  return String(email || "").split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

async function api(url, opts) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}

/* the role button and its menu: the two roles, and removal for a member */
function RoleMenu({ role, onRole, onRemove, removeTitle, locked, lockTitle, busy, label }) {
  const m = useMenu();
  return (
    <span style={{ position: "relative", display: "inline-flex", justifySelf: "start" }}>
      <button className="rolebtn" aria-haspopup="menu" aria-expanded={m.open} disabled={busy} title={locked ? lockTitle : label} onClick={m.toggle}>
        {role.label}<Caret />
      </button>
      <Menu open={m.open} onClose={m.close} style={{ top: 30, left: 0, width: 240 }} label={label}>
        {ROLES.map((r) => (
          <MenuItem key={r.key} radio checked={r.key === role.key} disabled={locked && r.key !== role.key} title={locked && r.key !== role.key ? lockTitle : r.what}
            onClick={() => { m.close(); if (r.key !== role.key) onRole(r.key); }}>{r.label}</MenuItem>
        ))}
        {onRemove && <div className="msep" />}
        {onRemove && <MenuItem icon={<X />} disabled={!!removeTitle} title={removeTitle || "Remove access"} onClick={() => { m.close(); onRemove(); }}>Remove</MenuItem>}
      </Menu>
    </span>
  );
}

export default function Permissions({ me, onMenu }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [google, setGoogle] = useState(null);       // null until /healthz answers
  const [busy, setBusy] = useState(null);           // the email being changed
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [password, setPassword] = useState("");
  const [inviting, setInviting] = useState(false);
  const noteTimer = useRef(null);

  const refresh = () =>
    api("/api/users").then((d) => { setRows(d.users); setError(null); })
      .catch((e) => setError(String(e.message || e)));
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    fetch("/healthz").then((r) => (r.ok ? r.json() : null)).then((d) => setGoogle(!!(d && d.googleLogin))).catch(() => setGoogle(false));
  }, []);
  useEffect(() => () => clearTimeout(noteTimer.current), []);

  const flash = (text, bad) => {
    clearTimeout(noteTimer.current);
    setNote({ text, bad });
    noteTimer.current = setTimeout(() => setNote(null), bad ? 7000 : 4000);
  };
  const run = async (key, fn, done) => {
    setBusy(key);
    try { await fn(); await refresh(); if (done) flash(done); }
    catch (e) { flash(String(e.message || e), true); }
    finally { setBusy(null); }
  };

  const list = rows || [];
  const adminCount = list.filter((u) => u.admin).length;
  const needsPassword = google === false;
  const canInvite = email.includes("@") && !inviting && (!needsPassword || password.length >= 8);

  const invite = (e) => {
    if (e) e.preventDefault();
    if (!canInvite) return;
    const addr = email.trim().toLowerCase();
    const body = { email: addr, admin: role === "admin" };
    if (needsPassword) body.password = password;
    setInviting(true);
    api("/api/users", { method: "POST", body: JSON.stringify(body) })
      .then((d) => { setEmail(""); setRole("user"); setPassword(""); return refresh().then(() => flash(`${d.created ? "Invited" : "Updated"} ${addr}`)); })
      .catch((e2) => flash(String(e2.message || e2), true))
      .finally(() => setInviting(false));
  };
  const setUserRole = (u, key) => run(u.email,
    () => api("/api/users", { method: "POST", body: JSON.stringify({ email: u.email, admin: key === "admin" }) }),
    `${nameOf(u.email)} is now ${key === "admin" ? "an admin" : "a user"}`);
  const remove = (u) => {
    if (!window.confirm(`Remove ${u.email}? They are signed out at their next request.`)) return;
    run(u.email, () => api(`/api/users/${encodeURIComponent(u.email)}`, { method: "DELETE" }), `Removed ${u.email}`);
  };

  return (
    <main className="page">
      <header className="phead">
        <button className="ib menub" style={{ marginLeft: -8 }} aria-label="Open the sidebar" onClick={onMenu}><Hamburger /></button>
        <span className="crumb">Settings</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#a3a3a3" strokeWidth="1.5" aria-hidden="true"><path d="M4.5 3l3 3-3 3" /></svg>
        <span className="name">Permissions</span>
      </header>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 24px 64px" }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.015em" }}>Permissions</h1>
        <div style={{ fontSize: 13, color: "#6b6b6f", marginTop: 6 }}>Who can open the dashboard, and who can change this list</div>

        <div className="sec2">Invite</div>
        <form onSubmit={invite} className="invrow">
          <label className="sr" htmlFor="inv">Email address</label>
          <input id="inv" className="inp" type="email" placeholder="name@avantarte.com" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          {needsPassword && (
            <>
              <label className="sr" htmlFor="invpw">Password for the new user</label>
              <input id="invpw" className="inp pw" type="password" placeholder="Password (8+ characters)" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} title="No Google client is configured on this server, so a new user signs in with a password" />
            </>
          )}
          <RoleMenu role={role === "admin" ? ROLES[0] : ROLES[1]} onRole={setRole} label="Role for the invitation" />
          <button className="act" type="submit" disabled={!canInvite} style={{ height: 32, borderRadius: 8, padding: "0 14px" }}>Invite</button>
        </form>
        {needsPassword && <div style={{ fontSize: 12, color: "#8a8a8e", marginTop: 8 }}>No Google client is configured on this server, so a new user signs in with the password you set here.</div>}

        <div className="sec2">Members{rows && <span className="loz ghost">{rows.length}</span>}</div>
        {error ? <div style={{ fontSize: 13, color: "#b8461d" }}>{error}</div> :
         !rows ? <div style={{ fontSize: 13, color: "#8a8a8e" }}>Loading…</div> : (
          <div style={{ borderTop: "1px solid #f0f0f2" }}>
            {list.map((u) => {
              const lastAdmin = u.admin && adminCount === 1;
              const lockTitle = "The last admin keeps the role, so this page can never lock itself out";
              const removeTitle = u.self ? "You cannot remove yourself" : lastAdmin ? "The last admin cannot be removed" : "";
              const r = roleOf(u);
              return (
                <div className="mrow2" key={u.email}>
                  <Avatar name={u.email} size={28} />
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nameOf(u.email)}{u.self && <span style={{ color: "#8a8a8e", fontWeight: 400 }}> (you)</span>}</span>
                    <span style={{ fontSize: 12, color: "#8a8a8e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email} · {r.what}</span>
                  </span>
                  <RoleMenu role={r} onRole={(k) => setUserRole(u, k)} onRemove={() => remove(u)} removeTitle={removeTitle}
                    locked={lastAdmin} lockTitle={lockTitle} busy={busy === u.email} label={`Role of ${nameOf(u.email)}`} />
                  <button className="ib" style={{ margin: 0 }} aria-label={`Remove ${nameOf(u.email)}`} title={removeTitle || "Remove access"} disabled={!!removeTitle || busy === u.email} onClick={() => remove(u)}><X /></button>
                </div>
              );
            })}
          </div>
        )}

        <div className="sec2">How access works</div>
        <div style={{ fontSize: 13, color: "#6b6b6f", lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0 }}>
            Everyone signs in with their company Google account. Anyone in the domain is added here as a <b style={{ color: "#1b1b1c", fontWeight: 500 }}>User</b> the first time they sign in. Invite someone before that to make them an <b style={{ color: "#1b1b1c", fontWeight: 500 }}>Admin</b> from the start, or to pre-approve them when the server admits listed accounts only.
          </p>
          <p style={{ margin: 0 }}>
            <b style={{ color: "#1b1b1c", fontWeight: 500 }}>Admin</b> sees everything a User sees, plus this page. <b style={{ color: "#1b1b1c", fontWeight: 500 }}>User</b> gets the full dashboard - every release, the Overview and Target setting tabs - but cannot change who has access.
          </p>
          <p style={{ margin: 0 }}>
            Removing someone signs them out at their next request, even mid-session; they come back as a User if they sign in again, unless the server admits listed accounts only. The last remaining admin cannot be removed or demoted, so this page can never lock itself out{me && me.email ? ` (you are signed in as ${me.email})` : ""}.
          </p>
        </div>
      </div>
      <Note text={note && note.text} bad={note && note.bad} onClose={() => setNote(null)} />
    </main>
  );
}
