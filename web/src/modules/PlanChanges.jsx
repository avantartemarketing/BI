/* Suggested actions: the card at the top of a live draw launch's Overview.
 * Each row is a change to the plan as it stands (the build's `planChanges`,
 * etl/plan_changes.py): what kind (add, change, drop), what, the change
 * itself, whose channel, the day and a rough size - the units it adds, or
 * for a paid cut the spend it saves. The comms plan's changes and the paid
 * budget's sit in one list. A row opens to its one-line reason and four
 * presses: Mark as complete, Snooze, Delete, Ask.
 *
 * Each row has a tickbox. Ticking one or more brings up a bar at the foot of
 * the page - how many are selected, and an Actions button whose menu marks
 * them complete, snoozes them (tomorrow, in 3 days, in a week) or deletes
 * them, all in one save. Escape or the bar's cross clears the selection.
 *
 * What is done with a row is the reader's, kept by the server by release and
 * key (server/planChanges.js; it saves complete as "accepted" and delete as
 * "dismissed", the first card's words) and laid over the build's list here,
 * so a handled change leaves the list until it is undone (the ⋯ menu shows
 * them) and a snoozed one comes back by itself on its day. Nothing is
 * written to the plan in Notion. The server also says whether this account
 * sees the card at all; without that the card draws nothing. With nothing to
 * suggest the card stays and reads "No suggested actions".
 *
 * Ask hands the question to the Agent, bottom right, with the change named
 * in it (an "agent:ask" event; Agent.jsx listens), so the card has no chat
 * of its own. "Plan as it stands" folds the plan's rows still to come under
 * the changes; it is there only when the plan is on file. */
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Card, Menu, MenuItem, Note, useMenu } from "../ui.jsx";
import { Agent as AgentIcon, Caret, Check, Chev, Clock, Trash, Undo, X } from "../icons.jsx";
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

/* a paid cut's size: the spend it saves to the close, in thousands past one */
export function savesWord(v) {
  if (!(v >= 1)) return null;
  return `Saves €${v >= 1000 ? `${(v / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : Math.round(v).toLocaleString("en-GB")}`;
}

const ask = (text) => window.dispatchEvent(new CustomEvent("agent:ask", { detail: { text } }));
const named = (c) => `${KIND[c.kind] || "Change"} "${c.title}"${c.from ? ` from ${c.from}` : ""}${c.to ? ` to ${String(c.to).toLowerCase()}` : ""}`;
/* what a row changes: the planned item's old value struck through, then what it becomes, or a word on why */
const Detail = ({ c }) => (c.to ? <>{c.from ? <s>{c.from}</s> : null}<To />{c.to}</> : c.from && c.note ? <><s>{c.from}</s>{c.note}</> : c.note || "");

/* how long a snooze can run: the start of the reader's own day, so many days on */
const SNOOZE = [[1, "Tomorrow"], [3, "In 3 days"], [7, "In a week"]];
const dayStart = (n, now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
const dateWord = (d) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
/* the day a snooze ends, as a toast or a handled row says it: tomorrow, the weekday inside a week, else the date */
export function untilWord(iso, now = new Date()) {
  const d = new Date(iso);
  const n = Math.round((dayStart(0, d) - dayStart(0, now)) / DAY_MS);
  if (n <= 1) return "tomorrow";
  return n < 7 ? d.toLocaleDateString("en-GB", { weekday: "short" }) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
/* a snooze still running, or any other state: what keeps a row out of the list */
const handledNow = (s) => !!s && !(s.state === "snoozed" && !(Date.parse(s.until) > Date.now()));
const DONE = { accepted: "Completed", snoozed: "Snoozed", dismissed: "Deleted" };
/* the toast after a save: one row by its title, several by their number */
const said = (list, state, until) => {
  const w = state === "snoozed" ? `Snoozed until ${untilWord(until)}` : DONE[state];
  if (list.length === 1) return `${w}: ${list[0].title}`;
  return state === "snoozed" ? `Snoozed ${list.length} actions until ${untilWord(until)}` : `${w} ${list.length} actions`;
};

/* the days a snooze can run to, as menu rows */
const SnoozeItems = ({ onPick }) => SNOOZE.map(([n, label]) => {
  const d = dayStart(n);
  return <MenuItem key={n} right={dateWord(d)} onClick={() => onPick(d.toISOString())}>{label}</MenuItem>;
});

/* The bar at the foot of the page while rows are ticked: how many, a cross
 * that clears them, and Actions - complete, snooze (a second page of days)
 * or delete, for all of them. It sits above the toast when one is up. */
function Bar({ n, lift, onClear, onDo }) {
  const m = useMenu();
  const [snz, setSnz] = useState(false);
  useEffect(() => {
    const key = (e) => { if (e.key === "Escape" && !m.open) onClear(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [m.open, onClear]);
  const act = (state, until) => { m.close(); onDo(state, until); };
  return createPortal(
    <div className={`pc-bar${lift ? " lift" : ""}`} role="toolbar" aria-label="Selected actions">
      <span className="pc-cnt">{n} selected<button aria-label="Clear the selection" title="Clear" onClick={onClear}><X w={12} /></button></span>
      <span style={{ position: "relative", display: "inline-flex" }}>
        <button className="sbtn" aria-haspopup="menu" aria-expanded={m.open} onClick={(e) => { setSnz(false); m.toggle(e); }}>Actions<Caret /></button>
        <Menu open={m.open} onClose={m.close} label="Actions" style={{ bottom: 34, right: 0, minWidth: 220 }}>
          {snz ? (
            <>
              <div className="dmh">Snooze until</div>
              <SnoozeItems onPick={(until) => act("snoozed", until)} />
            </>
          ) : (
            <>
              <MenuItem icon={<Check />} onClick={() => act("accepted")}>Mark as complete</MenuItem>
              <MenuItem icon={<Clock w={14} />} right="›" onClick={() => setSnz(true)}>Snooze</MenuItem>
              <div className="msep" />
              <MenuItem icon={<Trash />} onClick={() => act("dismissed")}>Delete</MenuItem>
            </>
          )}
        </Menu>
      </span>
    </div>,
    document.body,
  );
}

function Row({ c, asOf, open, onOpen, onSet, artist, picked, onPick }) {
  const sz = useMenu();
  const units = unitsWord(c.units);
  const size = units || savesWord(c.saves);
  return (
    <div className={`pc-row${open ? " open" : ""}${picked ? " sel" : ""}`}>
      <div className="pc-line">
        <input type="checkbox" className="pc-box" aria-label={`Select: ${named(c)}`} checked={picked} onChange={onPick} />
        <button className="pc-hit" aria-expanded={open} onClick={onOpen}>
          <span className={`pc-kind ${c.kind}`}>{KIND[c.kind] || "Change"}</span>
          <span className="pc-t">{c.title}</span>
          <span className={`pc-d${c.to ? " to" : ""}`}><Detail c={c} /></span>
          <span className="pc-ch">{c.channel}</span>
          <span className="pc-day">{dayWord(c.date, asOf)}</span>
          <span className={`pc-u${units ? "" : size ? " save" : " none"}`}>{size || "No estimate"}</span>
        </button>
      </div>
      {open && (
        <div className="pc-open">
          <div className="pc-dd">{[c.to ? `${c.from ? `${c.from} to` : "To"} ${String(c.to).toLowerCase()}` : c.note, c.channel, dayWord(c.date, asOf)].filter(Boolean).join(" · ")}</div>
          <div className="pc-why">{c.reason}</div>
          <div className="pc-acts">
            <button className="sbtn prim" onClick={() => onSet([c], "accepted")}>Mark as complete</button>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <button className="sbtn" aria-haspopup="menu" aria-expanded={sz.open} onClick={sz.toggle}>Snooze<Caret /></button>
              <Menu open={sz.open} onClose={sz.close} label="Snooze until" style={{ top: 30, left: 0, minWidth: 200 }}>
                <SnoozeItems onPick={(until) => { sz.close(); onSet([c], "snoozed", until); }} />
              </Menu>
            </span>
            <button className="sbtn" onClick={() => onSet([c], "dismissed")}>Delete</button>
            <button className="sbtn" onClick={() => ask(`Suggested action on ${artist}: ${named(c)}. Why, and what is it based on?`)}><AgentIcon w={13} />Ask</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlanChanges({ snap }) {
  const pc = (snap && snap.planChanges) || {};   // nothing from the build: an empty list, and the card says so
  const id = snap && snap.id;
  const [st, setSt] = useState(null);       // { visible, states } from the server
  const [open, setOpen] = useState(null);   // the open row's key
  const [more, setMore] = useState(false);
  const [handled, setHandled] = useState(false);
  const [plan, setPlan] = useState(false);
  const [note, setNote] = useState(null);
  const [sel, setSel] = useState(() => new Set());   // the ticked rows' keys
  const clear = React.useCallback(() => setSel(new Set()), []);
  useEffect(() => {
    setSt(null); setOpen(null); setMore(false); setHandled(false); setPlan(false); setNote(null); setSel(new Set());
    if (!id) return undefined;
    let live = true;
    fetch(`/api/releases/${id}/plan-changes`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setSt(d); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  if (!st || !st.visible) return null;

  const states = st.states || {};
  const all = [...(pc.changes || []), ...(pc.more || [])];
  const todo = all.filter((c) => !handledNow(states[c.key]));
  const done = all.filter((c) => handledNow(states[c.key]));
  const shown = more ? todo : todo.slice(0, 3);
  const picked = shown.filter((c) => sel.has(c.key));   // only rows on show count as ticked
  const toCome = pc.planToCome || [];
  const pick = (c) => setSel((v) => { const n = new Set(v); if (!n.delete(c.key)) n.add(c.key); return n; });

  /* one state for one row or several, saved in one write; null undoes it */
  const save = (list, state, until, quiet) => {
    const keys = list.map((c) => c.key);
    const next = Object.fromEntries(Object.entries(states).filter(([k]) => !keys.includes(k)));
    if (state) for (const k of keys) next[k] = { state, by: "you", at: new Date().toISOString(), ...(until ? { until } : {}) };
    setSt({ ...st, states: next });
    if (keys.includes(open)) setOpen(null);
    setSel((v) => new Set([...v].filter((k) => !keys.includes(k))));
    fetch(`/api/releases/${id}/plan-changes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys, state, ...(until ? { until } : {}) }) })
      .then(async (r) => { if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || "Not saved"); return r.json(); })
      .then((d) => { setSt((s) => (s ? { ...s, states: d.states || {} } : s)); if (!quiet) setNote({ text: said(list, state, until), undo: () => { setNote(null); save(list, null, null, true); } }); })
      .catch((e) => { setSt((s) => (s ? { ...s, states } : s)); setNote({ text: e.message || "Not saved", bad: true }); });
  };
  const artist = snap.artist || "this launch";

  return (
    <Card wide className="pcard" aria="Suggested actions"
      title={<>Suggested actions{todo.length > 0 && <span className="pc-n">{todo.length}</span>}</>}
      right={<button className="sbtn" onClick={() => ask(`What actions do you suggest for ${artist}, and why?`)}><AgentIcon w={13} />Ask</button>}
      menu={done.length ? [{ label: handled ? "Hide completed, snoozed and deleted" : "Show completed, snoozed and deleted", onClick: () => setHandled(!handled) }] : null}>
      <div className="pc">
        {shown.map((c) => <Row key={c.key} c={c} asOf={pc.asOf} artist={artist} open={open === c.key} onOpen={() => setOpen(open === c.key ? null : c.key)} onSet={save} picked={sel.has(c.key)} onPick={() => pick(c)} />)}
        {!todo.length && <div className="pc-none">{pc.status === "on_course" ? "On course. No suggested actions." : "No suggested actions"}</div>}
        {todo.length > 3 && <button className="pc-fold" onClick={() => setMore(!more)}><Chev />{more ? "Fewer" : `${todo.length - 3} more`}</button>}
        {handled && done.map((c) => {
          const s = states[c.key];
          return (
            <div className="pc-done" key={c.key}>
              <span className={`pc-tick ${s.state}`}>{s.state === "accepted" ? <Check w={10} /> : s.state === "snoozed" ? <Clock w={14} /> : <X w={12} />}</span>
              <span className="pc-kind">{DONE[s.state] || "Handled"}</span>
              <span className="pc-t">{KIND[c.kind] || "Change"}: {c.title}{c.to ? `, ${String(c.to).toLowerCase()}` : ""}</span>
              <span className="pc-by">{s.state === "snoozed" ? `Back ${untilWord(s.until)}` : `${s.by}${s.at ? `, ${fmtDay(new Date(s.at))}` : ""}`}</span>
              <button className="pc-undo" onClick={() => save([c], null, null, true)}><Undo w={11} />Undo</button>
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
      {picked.length > 0 && <Bar n={picked.length} lift={!!note} onClear={clear} onDo={(state, until) => save(picked, state, until)} />}
      {note && <Note text={note.text} bad={note.bad} onUndo={note.undo} onClose={() => setNote(null)} />}
    </Card>
  );
}
