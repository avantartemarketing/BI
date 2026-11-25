/* Suggested actions: the card at the top of a live draw launch's Overview.
 * Each row is a change to the plan as it stands (the build's `planChanges`,
 * etl/plan_changes.py): what kind (add, change, drop), what, the change
 * itself, whose channel, the day and a rough size - the units it adds, or
 * for a paid cut the spend it saves. The comms plan's changes and the paid
 * budget's sit in one list. A row opens to its one-line reason and three
 * presses: Accept, Dismiss, Ask.
 *
 * Accepting or dismissing is the reader's, kept by the server by release and
 * key (server/planChanges.js) and laid over the build's list here, so a
 * handled change leaves the list until it is undone (the ⋯ menu shows them).
 * Nothing is written to the plan in Notion. The server also says whether
 * this account sees the card at all. Its answer and the ticks are asked for
 * beside the page and handed in (`state`, App.jsx), so the card is drawn
 * with the page rather than a moment after it; when that read failed the
 * card is drawn with no ticks. With nothing to suggest the card stays and
 * reads "No suggested actions".
 *
 * Ask hands the question to the Agent, bottom right, with the change named
 * in it (an "agent:ask" event; Agent.jsx listens), so the card has no chat
 * of its own. "Plan as it stands" folds the plan's rows still to come under
 * the changes; it is there only when the plan is on file.
 *
 * The list's load (etl/list_load.py, `planChanges.list`) is the strip above
 * the rows: how busy the list is, and this week's general sends against the
 * cap. It opens to the sends it counted, this week and next. A general send
 * the rule lets through says which of the week's it would be; one it does not
 * sits under "Held back" with the reason, where it can still be read and,
 * unless the week is at the cap, accepted. An email offered at two audiences
 * is one row, the larger left standing, and opens to the other (`alts`). */
import React, { useEffect, useState } from "react";
import { Card, Note } from "../ui.jsx";
import { Agent as AgentIcon, Check, Chev, Undo } from "../icons.jsx";
import { fmtDay } from "../format.mjs";

const KIND = { add: "Add", change: "Change", drop: "Drop" };
const LOAD = { normal: "List as usual", busy: "List busy", very_busy: "List very busy" };
export const nth = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const sends = (n) => `${n} general send${n === 1 ? "" : "s"}`;
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
  if (!u) return null;
  if (u.high > 0 && u.high < 1) return "Under 1";   // a timed launch read in signup conversions: a size too small to count
  if (!(u.high >= 1)) return null;
  const f = (v) => Math.round(v).toLocaleString("en-GB");
  if (u.low === u.high || (u.low >= 1 && Math.round(u.low) === Math.round(u.high))) return `+${f(u.high)}`;
  if (!(u.low >= 1)) return `Up to ${f(u.high)}`;
  return `+${f(u.low)} to ${f(u.high)}`;
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

function Row({ c, asOf, open, onOpen, onSet, artist, week }) {
  const units = unitsWord(c.units);
  const size = units || savesWord(c.saves);
  const capped = c.heldBy === "cap";   // a week at the cap takes no further general send: read, not accepted
  const g = c.general;
  return (
    <div className={`pc-row${open ? " open" : ""}${c.held ? " held" : ""}`}>
      <div className="pc-line">
        {capped ? <span className="pc-ring off" aria-hidden="true" /> : <button className="pc-ring" aria-label={`Accept: ${named(c)}`} title="Accept" onClick={() => onSet(c, "accepted")} />}
        <button className="pc-hit" aria-expanded={open} onClick={onOpen}>
          <span className={`pc-kind ${c.kind}`}>{KIND[c.kind] || "Change"}</span>
          <span className="pc-t">{c.title}</span>
          <span className={`pc-d${c.to ? " to" : ""}`}><span className="pc-dt"><Detail c={c} /></span>{g && <span className="pc-g" title={`The list's ${nth(g.nth)} general send ${g.week === week ? "this" : "that"} week; the cap is ${g.cap}`}>General send {g.nth} of {g.cap}</span>}</span>
          <span className="pc-ch">{c.channel}</span>
          <span className="pc-day">{dayWord(c.date, asOf)}</span>
          <span className={`pc-u${units ? "" : size ? " save" : " none"}`}>{size || "No estimate"}</span>
        </button>
      </div>
      {open && (
        <div className="pc-open">
          <div className="pc-dd">{[c.to ? `${c.from ? `${c.from} to` : "To"} ${String(c.to).toLowerCase()}` : c.note, c.channel, dayWord(c.date, asOf)].filter(Boolean).join(" · ")}</div>
          {c.held && <div className="pc-why"><b>Held back.</b> {c.held}</div>}
          <div className="pc-why">{c.reason}{g ? ` The list's ${nth(g.nth)} general send ${g.week === week ? "this" : "that"} week; the cap is ${g.cap}.` : ""}</div>
          {(c.alts || []).map((a) => (
            <div className="pc-why pc-alt" key={a.key}>Or {a.people ? `to ${Math.round(a.people).toLocaleString("en-GB")} people` : String(a.title || "").toLowerCase()}: {unitsWord(a.units) || "no estimate"}.</div>
          ))}
          <div className="pc-acts">
            {!capped && <button className="sbtn prim" onClick={() => onSet(c, "accepted")}>{c.held ? "Accept anyway" : "Accept"}</button>}
            <button className="sbtn" onClick={() => onSet(c, "dismissed")}>Dismiss</button>
            <button className="sbtn" onClick={() => ask(`Suggested action on ${artist}: ${named(c)}. Why, and what is it based on?`)}><AgentIcon w={13} />Ask</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* the list's load: one line, opening to the general sends it counted this week and next */
function ListLoad({ list, open, onOpen }) {
  const w = list.week || {}, nx = list.next || {};
  const named = (x) => ((x.names || []).length ? x.names.join(", ") : "None");
  return (
    <>
      <button className={`pc-list ${w.state || ""}${open ? " on" : ""}`} aria-expanded={open} onClick={onOpen}>
        <Chev />
        <span className="pc-ls"><i />{LOAD[w.state] || "List"}</span>
        <span className="pc-lw">{sends(w.general || 0)} this week, {list.cap} at most</span>
        {w.load != null && <span className="pc-ll">{w.load.toFixed(1)} emails a person a week</span>}
      </button>
      {open && (
        <div className="pc-lopen">
          <div><span>This week</span>{named(w)}</div>
          <div><span>Next week</span>{named(nx)}{nx.general > list.cap ? `: ${nx.general}, over the cap of ${list.cap}` : ""}</div>
          <div className="pc-lnote">A general send goes to half the list or more. Up to {list.normalTo} emails a person a week, any launch that is short can have one; up to {list.busyTo}, only the launch with the most at stake; past that, none. Never more than {list.cap} a week.</div>
        </div>
      )}
    </>
  );
}

/* what the card reads when the server's answer did not arrive: shown, nothing ticked */
const OPEN = { visible: true, states: {} };

export default function PlanChanges({ snap, state }) {
  const pc = (snap && snap.planChanges) || {};   // nothing from the build: an empty list, and the card says so
  const id = snap && snap.id;
  const [st, setSt] = useState(state || OPEN);   // { visible, states } from the server, loaded with the page
  const [open, setOpen] = useState(null);   // the open row's key
  const [more, setMore] = useState(false);
  const [handled, setHandled] = useState(false);
  const [plan, setPlan] = useState(false);
  const [note, setNote] = useState(null);
  const [load, setLoad] = useState(false);   // the list's strip, opened
  const [back, setBack] = useState(false);   // the held-back rows, opened
  useEffect(() => {
    setSt(state || OPEN); setOpen(null); setMore(false); setHandled(false); setPlan(false); setNote(null); setLoad(false); setBack(false);
  }, [id, state]);
  if (!st.visible) return null;

  const states = st.states || {};
  const all = [...(pc.changes || []), ...(pc.more || [])];
  const held = (pc.held || []).filter((c) => !states[c.key]);
  const todo = all.filter((c) => !states[c.key]);
  const done = [...all, ...(pc.held || [])].filter((c) => states[c.key]);
  const cap = snap.method === "plan" ? 4 : 3;   // the plan-based view shows four, so the paid budget sits beside the comms
  const shown = more ? todo : todo.slice(0, cap);
  const toCome = pc.planToCome || [];
  const week = pc.list && pc.list.week ? pc.list.week.start : null;   // this week's Monday, as the list's reading has it

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
    <Card wide className="pcard" aria="Suggested actions"
      title={<>Suggested actions{todo.length > 0 && <span className="pc-n">{todo.length}</span>}{snap.type === "TL" && todo.length > 0 && <span className="pc-n">in {snap.countAs === "conversions" ? "conversions" : "signups"} by the open</span>}</>}
      right={<button className="sbtn" onClick={() => ask(`What actions do you suggest for ${artist}, and why?`)}><AgentIcon w={13} />Ask</button>}
      menu={done.length ? [{ label: handled ? "Hide accepted and dismissed" : "Show accepted and dismissed", onClick: () => setHandled(!handled) }] : null}>
      <div className="pc">
        {pc.list && <ListLoad list={pc.list} open={load} onOpen={() => setLoad(!load)} />}
        {shown.map((c) => <Row key={c.key} c={c} asOf={pc.asOf} artist={artist} week={week} open={open === c.key} onOpen={() => setOpen(open === c.key ? null : c.key)} onSet={save} />)}
        {!todo.length && <div className="pc-none">{pc.status === "on_course" ? "On course. No suggested actions." : "No suggested actions"}</div>}
        {todo.length > cap && <button className="pc-fold" onClick={() => setMore(!more)}><Chev />{more ? "Fewer" : `${todo.length - cap} more`}</button>}
        {held.length > 0 && (
          <>
            <button className={`pc-fold${back ? " on" : ""}`} aria-expanded={back} onClick={() => setBack(!back)}><Chev />Held back: {sends(held.length)}</button>
            {back && held.map((c) => <Row key={c.key} c={c} asOf={pc.asOf} artist={artist} week={week} open={open === c.key} onOpen={() => setOpen(open === c.key ? null : c.key)} onSet={save} />)}
          </>
        )}
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
