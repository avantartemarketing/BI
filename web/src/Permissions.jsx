/* Permissions tab (admins only): manage who can sign in to the dashboard.
 * Add a person with their email + a password you set for them; reset a
 * password, grant/revoke admin, or remove access. Removal takes effect
 * immediately - the person's session dies on their next request. */
import React, { useEffect, useState } from "react";
import { Card, C } from "./ui.jsx";

const Field = ({ label, children, width }) => (
  <div style={width ? { width } : { flex: 1, minWidth: 0 }}>
    <div className="flabel">{label}</div>
    {children}
  </div>
);

async function api(url, opts) {
  const r = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}

export default function Permissions() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = () =>
    api("/api/users").then((d) => { setRows(d.users); setError(null); })
      .catch((e) => setError(String(e.message || e)));
  useEffect(() => { refresh(); }, []);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 4000); };

  if (error) return <div style={{ padding: 24, color: C.red }}>{error}</div>;
  if (!rows) return <div style={{ padding: 24, color: C.muted }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 24 }}>
      <Card dot="#28518f" title="Who can sign in">
        <div className="spacer-16" />
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((u) => (
            <UserRow key={u.email} u={u} onChanged={refresh} onNotice={flash} />
          ))}
        </div>
        <div className="spacer-16" />
        <AddUser onAdded={(email) => { refresh(); flash(`Added ${email}.`); }} />
        {notice && <div style={{ marginTop: 12, fontSize: 12.5, color: "#0f7052" }}>{notice}</div>}
        <div style={{ marginTop: 16, fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
          Passwords are set here and shared with the person directly; they are stored
          hashed and can be reset any time. Removing someone signs them out immediately.
        </div>
      </Card>
    </div>
  );
}

function UserRow({ u, onChanged, onNotice }) {
  const [resetting, setResetting] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async (fn, doneMsg) => {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); if (doneMsg) onNotice(doneMsg); }
    catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const saveReset = () => run(async () => {
    await api("/api/users", { method: "POST", body: JSON.stringify({ email: u.email, password: pw }) });
    setResetting(false); setPw("");
  }, `Password updated for ${u.email}.`);

  const toggleAdmin = () => run(() =>
    api("/api/users", { method: "POST", body: JSON.stringify({ email: u.email, admin: !u.admin }) }),
    `${u.email} is ${u.admin ? "no longer" : "now"} an admin.`);

  const removeUser = () => {
    if (!window.confirm(`Remove ${u.email}? They will be signed out immediately.`)) return;
    run(() => api(`/api/users/${encodeURIComponent(u.email)}`, { method: "DELETE" }),
      `Removed ${u.email}.`);
  };

  const linkBtn = {
    background: "none", border: "none", padding: 0, font: "inherit", fontSize: 12,
    color: C.muted, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2,
  };

  return (
    <div style={{ borderTop: "1px solid #f2f0ea", padding: "10px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {u.email}
          {u.self && <span style={{ color: C.muted, fontWeight: 400 }}> (you)</span>}
        </span>
        {u.admin && <span className="chip" title="Can manage this tab">admin</span>}
        <button style={linkBtn} disabled={busy} onClick={() => { setResetting(!resetting); setPw(""); setErr(null); }}>
          {resetting ? "cancel" : "reset password"}
        </button>
        {!u.self && (
          <>
            <button style={linkBtn} disabled={busy} onClick={toggleAdmin}>
              {u.admin ? "revoke admin" : "make admin"}
            </button>
            <button style={{ ...linkBtn, color: C.red }} disabled={busy} onClick={removeUser}>
              remove
            </button>
          </>
        )}
      </div>
      {resetting && (
        <form
          style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}
          onSubmit={(e) => { e.preventDefault(); saveReset(); }}
        >
          <input
            className="control" type="password" autoComplete="new-password" autoFocus
            placeholder="New password (min 8 characters)" value={pw}
            onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 280 }}
          />
          <button className="btn primary" type="submit" disabled={busy || pw.length < 8}>Save</button>
        </form>
      )}
      {err && <div style={{ marginTop: 8, fontSize: 12, color: C.red }}>{err}</div>}
    </div>
  );
}

function AddUser({ onAdded }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ email: email.trim(), password: pw, admin }) });
      onAdded(email.trim().toLowerCase());
      setEmail(""); setPw(""); setAdmin(false);
    } catch (e2) { setErr(String(e2.message || e2)); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} style={{ borderTop: "1px solid #f2f0ea", paddingTop: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Email">
          <input className="control" type="email" placeholder="name@avantarte.com"
            autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" width={220}>
          <input className="control" type="password" placeholder="Min 8 characters"
            autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, height: 34, cursor: "pointer" }}
          title="Admins can manage this tab">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          Admin
        </label>
        <button className="btn primary" type="submit" disabled={busy || pw.length < 8 || !email.includes("@")}>
          Add person
        </button>
      </div>
      {err && <div style={{ marginTop: 10, fontSize: 12, color: C.red }}>{err}</div>}
    </form>
  );
}
