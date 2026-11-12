/* Plan changes: the card at the top of a live draw launch's Overview. Each
 * row is a change to the comms plan as it stands (the build's
 * `planChanges`, etl/plan_changes.py): what kind (add, change, drop), what,
 * the change itself, whose channel, the day and a rough size in units. A row
 * opens to its one-line reason and three presses: Accept, Dismiss, Ask.
 *
 * Accepting or dismissing is the reader's, kept by the server by release and
 * key (server/planChanges.js) and laid over the build's list here, so a
 * handled change leaves the list until it is undone (the ⋯ menu shows them).
 * Nothing is written to the plan in Notion. The server also says whether
 * this account sees the card at all; without that the card draws nothing.
 *
 * Ask hands the question to the Agent, bottom right, with the change named
 * in it (an "agent:ask" event; Agent.jsx listens), so the card has no chat
 * of its own. "Plan as it stands" folds the plan's rows still to come under
 * the changes; it is there only when the plan is on file. */
import React, { useEffect, useState } from "react";
import { Card, Note } from "../ui.jsx";
import { Agent as AgentIcon, Check, Chev, Undo } from "../icons.jsx";
import { fmtDay } from "../format.mjs";

const KIND = { add: "Add", change: "Change", drop: "Drop" };
const DAY_MS = 86400000;
const at = (iso) => new Date(String(iso).slice(0, 10) + "T00:00:00Z");

/* the day a change falls on, read from the page's own day: Today, the
 * weekday inside a week, else the date */
export function dayWord(iso, asOf) {
  if (!iso) return "";
  const n = Math.round((at(iso) - at(asOf || iso)) / DAY_MS);
  if (n === 0) return "Today";
  if (n > 0 && n < 7) return at(iso).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return fmtDay(at(iso));
}

/* a size as the row prints it: a range, one figure when the two meet, "Up to"
 * from nothing, and no estimate said as that */
export function unitsWord(u) {
  if (!u || !(u.high >= 1)) return null;
  if (u.low === u.high) return `+${u.high}`;
  if (!(u.low >= 1)) return `Up to ${u.high}`;
  return `+${u.low} to ${u.high}`;
}

/* the arrow before what a planned item changes to */
const To = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg>;

const ask = (text) => window.dispatchEvent(new CustomEvent("agent:ask", { detail: { text } }));
const named = (c) => `${KIND[c.kind] || "Change"} "${c.title}"${c.to ? ` to ${String(c.to).toLowerCase()}` : ""}`;

function Row({ c, asOf, open, onOpen, onSet, artist }) {
  const size = unitsWord(c.units);
  return (
    <div className={`pc-row${open ? " open" : ""}`}>
      <div className="pc-line">
        <button className="pc-ring" aria-label={`Accept: ${named(c)}`} title="Accept" onClick={() => onSet(c, "accepted")} />
        <button className="pc-hit" aria-expanded={open} onClick={onOpen}>
          <span className={`pc-kind ${c.kind}`}>{KIND[c.kind] || "Change"}</span>
          <span className="pc-t">{c.title}</span>
          <span className={`pc-d${c.to ? " to" : ""}`}>{c.to ? <><To />{c.to}</> : c.note || ""}</span>
          <span className="pc-ch">{c.channel}</span>
          <span className="pc-day">{dayWord(c.date, asOf)}</span>
          <span className={`pc-u${size ? "" : " none"}`}>{size || "No estimate"}</span>
        </button>
      </div>
      {open && (
        <div className="pc-open">
          <div className="pc-dd">{[c.to ? `To ${String(c.to).toLowerCase()}` : c.note, c.channel, dayWord(c.date, asOf)].filter(Boolean).join(" · ")}</div>
          <div className="pc-why">{c.reason}</div>
          <div className="pc-acts">
            <button className="sbtn prim" onClick={() => onSet(c, "accepted")}>Accept</button>
            <button className="sbtn" onClick={() => onSet(c, "dismissed")}>Dismiss</button>
            <button className="sbtn" onClick={() => ask(`Plan change on ${artist}: ${named(c)}. Why, and what is it based on?`)}><AgentIcon w={13} />Ask</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlanChanges({ snap }) {
  const pc = snap && snap.planChanges;
  const id = snap && snap.id;
  const [st, setSt] = useState(null);       // { visible, states } from the server
  const [open, setOpen] = useState(null);   // the open row's key
  const [more, setMore] = useState(false);
  const [handled, setHandled] = useState(false);
  const [plan, setPlan] = useState(false);
  const [note, setNote] = useState(null);
  useEffect(() => {
    setSt(null); setOpen(null); setMore(false); setHandled(false); setPlan(false); setNote(null);
    if (!id || !pc) return undefined;
    let live = true;
    fetch(`/api/releases/${id}/plan-changes`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setSt(d); }).catch(() => {});
    return () => { live = false; };
  }, [id, !!pc]);
  if (!pc || !st || !st.visible) return null;

  const states = st.states || {};
  const all = [...(pc.changes || []), ...(pc.more || [])];
  const todo = all.filter((c) => !states[c.key]);
  const done = all.filter((c) => states[c.key]);
  const shown = more ? todo : todo.slice(0, 3);
  const toCome = pc.planToCome || [];
  if (!todo.length && !done.length && !toCome.length) return null;

  const save = (c, state, quiet) => {
    const before = states[c.key] || null;
    setSt({ ...st, states: state ? { ...states, [c.key]: { state, by: "you", at: new Date().toISOString() } } : Object.fromEntries(Object.entries(states).filter(([k]) => k !== c.key)) });
    if (open === c.key) setOpen(null);
    fetch(`/api/releases/${id}/plan-changes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: c.key, state }) })
      .then(async (r) => { if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || "Not saved"); return r.json(); })
      .then((d) => { setSt((s) => (s ? { ...s, states: d.states || {} } : s)); if (!quiet) setNote({ text: `${state === "accepted" ? "Accepted" : "Dismissed"}: ${c.title}`, undo: () => { setNote(null); save(c, before ? before.state : null, true); } }); })
      .catch((e) => { setSt((s) => (s ? { ...s, states } : s)); setNote({ text: e.message || "Not saved", bad: true }); });
  };
  const artist = snap.artist || "this launch";

  return (
    <Card wide className="pcard" aria="Plan changes"
      title={<>Plan changes<span className="pc-n">{todo.length}</span></>}
      right={<button className="sbtn" onClick={() => ask(`What changes to the plan do you suggest for ${artist}, and why?`)}><AgentIcon w={13} />Ask</button>}
      menu={done.length ? [{ label: handled ? "Hide accepted and dismissed" : "Show accepted and dismissed", onClick: () => setHandled(!handled) }] : null}>
      <div className="pc">
        {shown.map((c) => <Row key={c.key} c={c} asOf={pc.asOf} artist={artist} open={open === c.key} onOpen={() => setOpen(open === c.key ? null : c.key)} onSet={save} />)}
        {!todo.length && <div className="pc-none">{pc.status === "on_course" ? "On course. No changes suggested." : "No changes suggested."}</div>}
        {todo.length > 3 && <button className="pc-fold" onClick={() => setMore(!more)}><Chev />{more ? "Fewer" : `${todo.length - 3} more`}</button>}
        {handled && done.map((c) => {
          const s = states[c.key];
          return (
            <div className="pc-done" key={c.key}>
              <span className="pc-tick">{s.state === "accepted" ? <Check w={11} /> : null}</span>
              <span className="pc-kind">{s.state === "accepted" ? "Accepted" : "Dismissed"}</span>
              <span className="pc-t">{KIND[c.kind] || "Change"}: {c.title}{c.to ? `, ${String(c.to).toLowerCase()}` : ""}</span>
              <span className="pc-by">{s.by}{s.at ? `, ${fmtDay(new Date(s.at))}` : ""}</span>
              <button className="pc-undo" onClick={() => save(c, null, true)}><Undo w={11} />Undo</button>
            </div>
          );
        })}
        {toCome.length > 0 && (
          <>
            <button className={`pc-fold${plan ? " on" : ""}`} aria-expanded={plan} onClick={() => setPlan(!plan)}><Chev />Plan as it stands, {toCome.length} to come</button>
            {plan && toCome.map((p, i) => (
              <div className="pc-plan" key={`${p.date}:${p.channel}:${p.title}:${i}`}>
                <span className="pc-t">{p.title || p.channel}</span>
                <span className="pc-ch">{p.channel}</span>
                <span className="pc-day">{dayWord(p.date, pc.asOf)}</span>
              </div>
            ))}
          </>
        )}
      </div>
      {note && <Note text={note.text} bad={note.bad} onUndo={note.undo} onClose={() => setNote(null)} />}
    </Card>
  );
}
