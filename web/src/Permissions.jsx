/* Permissions (sidebar → Settings; admins only). App-level, not per-release.
 * Everyone signs in with their company Google account, so this page is an
 * access list plus a role per person: change a role, add someone ahead of
 * their first sign-in (to make them an admin, or to pre-approve them when the
 * server only admits listed accounts), remove access. Removal takes effect
 * immediately - the person's session dies on their next request. */
import React, { useEffect, useState } from "react";
import { Card, C } from "./ui.jsx";

const ROLES = [
  { key: "admin", label: "Admin", blurb: "Full access, plus this Permissions page" },
  { key: "user", label: "User", blurb: "Full access to releases and target setting" },
];

async function api(url, opts) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}

export default function Permissions({ me }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = () =>
    api("/api/users").then((d) => { setRows(d.users); setError(null); })
      .catch((e) => setError(String(e.message || e)));
  useEffect(() => { refresh(); }, []);
  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 4000); };

  const adminCount = (rows || []).filter((u) => u.admin).length;

  return (
    <>
      <header className="page-header" style={{ marginBottom: 24 }}>
        <div className="page-identity">
          <span className="name">Permissions</span>
          {rows && <span className="chip">{rows.length} {rows.length === 1 ? "person" : "people"}</span>}
          {rows && <span className="chip">{adminCount} admin</span>}
        </div>
      </header>

      {error ? <div style={{ color: C.red, fontSize: 13 }}>{error}</div> :
       !rows ? <div style={{ color: C.muted }}>Loading…</div> : (
        <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 24 }}>
          <Card dot="#2f5fb3" title="Who has access">
            <div className="spacer-16" />
            <div style={{ display: "flex", flexDirection: "column" }}>
              {rows.map((u) => (
                <UserRow key={u.email} u={u} lastAdmin={u.admin && adminCount === 1}
                  onChanged={refresh} onNotice={flash} />
              ))}
            </div>
            <div className="spacer-16" />
            <AddUser onAdded={(email) => { refresh(); flash(`Added ${email}.`); }} />
            {notice && <div style={{ marginTop: 12, fontSize: 12.5, color: "#0f7052" }}>{notice}</div>}
          </Card>

          <Card dot="#b8862d" title="How access works">
            <div className="spacer-16" />
            <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.65 }}>
              <p style={{ marginBottom: 10 }}>
                Everyone signs in with their company Google account. Anyone in the domain is
                added to this list as a <strong style={{ color: C.ink }}>User</strong> the first time
                they sign in. Add someone here before that to make them an{" "}
                <strong style={{ color: C.ink }}>Admin</strong> from the start.
              </p>
              <p style={{ marginBottom: 10 }}>
                <strong style={{ color: C.ink }}>Admin</strong> sees everything a User sees, plus
                this page. <strong style={{ color: C.ink }}>User</strong> gets the full dashboard -
                every release, the Overview and Target setting tabs - but no access to accounts.
              </p>
              <p>
                Removing someone signs them out immediately, even mid-session; they are added back
                as a User if they sign in again, unless the server is set to admit listed accounts
                only. The last remaining admin cannot be removed or demoted, so this page can never
                lock itself out.
              </p>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

function UserRow({ u, lastAdmin, onChanged, onNotice }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async (fn, doneMsg) => {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); if (doneMsg) onNotice(doneMsg); }
    catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const setRole = (role) => run(
    () => api("/api/users", { method: "POST", body: JSON.stringify({ email: u.email, admin: role === "admin" }) }),
    `${u.email} is now ${role === "admin" ? "an admin" : "a user"}.`);

  const removeUser = () => {
    if (!window.confirm(`Remove ${u.email}? They will be signed out immediately.`)) return;
    run(() => api(`/api/users/${encodeURIComponent(u.email)}`, { method: "DELETE" }), `Removed ${u.email}.`);
  };

  const linkBtn = {
    background: "none", border: "none", padding: 0, font: "inherit", fontSize: 12,
    color: C.muted, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2,
  };
  // the last admin must keep the role, and nobody may delete themselves
  const roleLocked = lastAdmin;

  return (
    <div style={{ borderTop: "1px solid #f2f0ea", padding: "10px 0" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 92px auto", gap: 12, alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {u.email}
          {u.self && <span style={{ color: C.muted, fontWeight: 400 }}> (you)</span>}
        </span>
        <select
          className="control"
          value={u.admin ? "admin" : "user"}
          disabled={busy || roleLocked}
          title={roleLocked ? "The last admin cannot be demoted" : "Change this person's role"}
          onChange={(e) => setRole(e.target.value)}
          style={{ height: 28, fontSize: 12, padding: "0 6px", opacity: roleLocked ? 0.55 : 1 }}
        >
          {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button
          style={{ ...linkBtn, color: u.self || roleLocked ? C.muted : C.red,
                   opacity: u.self || roleLocked ? 0.45 : 1,
                   cursor: u.self || roleLocked ? "default" : "pointer" }}
          disabled={busy || u.self || roleLocked}
          title={u.self ? "You cannot remove yourself" : roleLocked ? "The last admin cannot be removed" : "Remove access"}
          onClick={removeUser}
        >
          remove
        </button>
      </div>
      {err && <div style={{ marginTop: 8, fontSize: 12, color: C.red }}>{err}</div>}
    </div>
  );
}

function AddUser({ onAdded }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), admin: role === "admin" }),
      });
      onAdded(email.trim().toLowerCase());
      setEmail(""); setRole("user");
    } catch (e2) { setErr(String(e2.message || e2)); }
    finally { setBusy(false); }
  };

  const Field = ({ label, width, children }) => (
    <div style={width ? { width } : { flex: 1, minWidth: 0 }}>
      <div className="flabel">{label}</div>
      {children}
    </div>
  );

  return (
    <form onSubmit={submit} style={{ borderTop: "1px solid #f2f0ea", paddingTop: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Add someone ahead of their first sign-in">
          <input className="control" type="email" placeholder="name@avantarte.com" autoComplete="off"
            value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Role" width={110}>
          <select className="control" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r.key} value={r.key} title={r.blurb}>{r.label}</option>)}
          </select>
        </Field>
        <button className="btn primary" type="submit" disabled={busy || !email.includes("@")}>
          Add person
        </button>
      </div>
      {err && <div style={{ marginTop: 10, fontSize: 12, color: C.red }}>{err}</div>}
    </form>
  );
}
