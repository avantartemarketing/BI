/* Shift-click any number: a panel slides in at the right and says, in plain
 * words, how that number is worked out and where its data comes from. The
 * page narrows beside it so the cards stay usable, and shift-clicking another
 * number swaps the panel to that one. A figure inside a step that has its own
 * working is a link down to it, with a crumb back. Esc or × closes it.
 *
 * The cards mark their figures with <Ex k="…" arg={…}>…</Ex>. Holding Shift
 * underlines every marked figure on the page, so what can be explained shows
 * itself; the headline figures are also reachable from the keyboard (Tab,
 * then Shift+Enter). What each figure says is in explanations.mjs, the
 * sources and their freshness in sources.mjs. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { explain, asText } from "./explanations.mjs";
import { sourceRow } from "./sources.mjs";
import { fmtDay } from "../format.mjs";

const Ctx = createContext(null);
const USES = "explainUses";        // opens so far, per browser: the hint retires after a few
const HINT_UNTIL = 3;

const readUses = () => { try { return Number(localStorage.getItem(USES)) || 0; } catch { return 0; } };
const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""));

export function ExplainProvider({ snap, st, resetKey, children }) {
  const [stack, setStack] = useState([]);         // [{ k, arg }], the last one on screen
  const [uses, setUses] = useState(readUses);
  const [nudged, setNudged] = useState(false);
  const anchor = useRef(null);                     // the figure that was clicked
  const opener = useRef(null);                     // where focus was, to give it back
  const nudgeTimer = useRef(null);

  const mark = (el) => {
    if (anchor.current && anchor.current !== el) anchor.current.removeAttribute("data-x-on");
    anchor.current = el || null;
    if (el) el.setAttribute("data-x-on", "");
  };
  const close = useCallback(() => {
    setStack([]);
    mark(null);
    const back = opener.current;
    opener.current = null;
    if (back && document.contains(back) && document.activeElement && document.activeElement.closest && document.activeElement.closest(".xp")) {
      back.focus({ preventScroll: true });
    }
  }, []);
  const open = useCallback((k, arg, el) => {
    mark(el);
    opener.current = document.activeElement && document.activeElement !== document.body ? document.activeElement : el;
    setStack([{ k, arg }]);
    setUses((n) => {
      const next = n + 1;
      try { localStorage.setItem(USES, String(next)); } catch { /* the hint is a convenience */ }
      return next;
    });
  }, []);
  const drill = useCallback((k, arg) => setStack((s) => [...s, { k, arg }]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const nudge = useCallback(() => {
    clearTimeout(nudgeTimer.current);
    setNudged(true);
    nudgeTimer.current = setTimeout(() => setNudged(false), 1400);
  }, []);

  // a new release, or a tab without these cards, is a new reading
  useEffect(() => { close(); }, [resetKey, close]);

  // Shift held: the explainable figures show themselves. Not while typing,
  // where Shift is a capital letter.
  const isOpen = stack.length > 0;
  const openRef = useRef(false);
  openRef.current = isOpen;
  useEffect(() => {
    const body = document.body;
    const down = (e) => {
      if (e.key === "Shift" && !typing(e.target)) body.classList.add("x-shift");
      if (e.key === "Escape" && openRef.current) close();
    };
    const up = (e) => { if (e.key === "Shift") body.classList.remove("x-shift"); };
    const off = () => body.classList.remove("x-shift");
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", off);
      off();
    };
  }, [close]);

  // the page narrows beside the panel (tokens.css, .x-open)
  useEffect(() => {
    document.body.classList.toggle("x-open", isOpen);
    return () => document.body.classList.remove("x-open");
  }, [isOpen]);
  useEffect(() => () => { clearTimeout(nudgeTimer.current); mark(null); }, []);

  const api = useMemo(() => ({ open, close, drill, back, nudge }), [open, close, drill, back, nudge]);
  const top = stack[stack.length - 1] || null;
  return (
    <Ctx.Provider value={{ ...api, uses, nudged }}>
      {children}
      {top && <ExplainPanel snap={snap} st={st} stack={stack} api={api} />}
    </Ctx.Provider>
  );
}

/* A figure a reader can ask about. `focus` puts it in the tab order (the
 * headline figures), so Shift+Enter explains it from the keyboard too. */
export function Ex({ k, arg, focus = false, children, className, style }) {
  const x = useContext(Ctx);
  if (!x) return <>{children}</>;
  const go = (e, el) => {
    e.preventDefault();
    e.stopPropagation();
    x.open(k, arg, el);
  };
  return (
    <span
      className={"x" + (className ? " " + className : "")}
      style={style}
      data-x={k}
      tabIndex={focus ? 0 : undefined}
      role={focus ? "button" : undefined}
      aria-haspopup={focus ? "dialog" : undefined}
      aria-keyshortcuts={focus ? "Shift+Enter" : undefined}
      // Shift on a mouse button extends the text selection: not here
      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
      onClick={(e) => { if (e.shiftKey) go(e, e.currentTarget); else x.nudge(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) go(e, e.currentTarget); }}
    >
      {children}
    </span>
  );
}

/* The hint in the tab row, until the reader has opened a few. A plain click
 * on a figure makes it blink, which is how most people will find it. */
export function ExplainHint() {
  const x = useContext(Ctx);
  if (!x || x.uses >= HINT_UNTIL) return null;
  return (
    <span className={"x-hint" + (x.nudged ? " nudge" : "")} aria-hidden="true">
      <kbd>⇧ Shift</kbd> + click any number to see how it is worked out
    </span>
  );
}

const dayText = (iso) => (iso ? fmtDay(new Date(String(iso).slice(0, 10) + "T00:00:00Z")) : "");

function ExplainPanel({ snap, st, stack, api }) {
  const ctx = { snap, st };
  const top = stack[stack.length - 1];
  const ex = explain(top.k, top.arg, ctx);
  const parent = stack.length > 1 ? explain(stack[stack.length - 2].k, stack[stack.length - 2].arg, ctx) : null;
  const panel = useRef(null);
  const [copied, setCopied] = useState(null);   // null | "done" | "failed"

  // focus comes to the panel, so Esc and Tab work from where the reader is
  useEffect(() => { if (panel.current) panel.current.focus({ preventScroll: true }); }, [top]);
  useEffect(() => { setCopied(null); }, [top]);

  const sources = ex ? ex.sources.map((r) => sourceRow(r, snap, st)) : [];
  const asOf = dayText(snap.asOf);
  const copy = async () => {
    const text = asText(ex, { release: `${snap.artist} - ${snap.title}`, asOf, sources });
    try {
      await navigator.clipboard.writeText(text);
      setCopied("done");
    } catch {
      // no clipboard permission: a hidden field and the old command
      const t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.left = "-9999px";
      document.body.appendChild(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      t.remove();
      setCopied(ok ? "done" : "failed");
    }
    setTimeout(() => setCopied(null), 1600);
  };

  const label = ex ? `How ${ex.value} ${ex.name.toLowerCase()} is worked out` : "How this number is worked out";
  return (
    <aside className="xp" role="dialog" aria-modal="false" aria-label={label} tabIndex={-1} ref={panel}>
      <div className="xp-top">
        <span className="ttl">How this number is worked out</span>
        <button type="button" className="xp-x" onClick={api.close} aria-label="Close" title="Close (Esc)">×</button>
      </div>
      {!ex ? (
        <div className="xp-scroll">
          <p className="say">This figure has no working to show on this page yet.</p>
        </div>
      ) : (
        <>
          <div className="xp-scroll">
            <div className="kick">
              {parent ? (
                <>
                  <button type="button" className="crumb" onClick={api.back}>← {parent.name}</button>
                  <span aria-hidden="true">›</span>
                </>
              ) : (
                <>
                  <span>{ex.where}</span>
                  {ex.when && <span className="when">{ex.when}</span>}
                  <span aria-hidden="true">›</span>
                </>
              )}
              <span className="nm">{ex.name}</span>
            </div>
            <div className="fig"><b>{ex.value}</b><span>{ex.unit}</span></div>
            <p className="say">{ex.say}</p>
            <section>
              <h3 className="lab">Step by step</h3>
              <ol className="steps">
                {ex.steps.map((segs, i) => (
                  <li key={i}>
                    <span className="k" aria-hidden="true">{i + 1}</span>
                    <span>{segs.map((x, j) => (typeof x === "string" ? <React.Fragment key={j}>{x}</React.Fragment> : (
                      <button key={j} type="button" className="drill" onClick={() => api.drill(x.k, x.arg)}
                        title={`How ${x.d} is worked out`}>{x.d}</button>
                    )))}</span>
                  </li>
                ))}
                {ex.total && (
                  <li className="eq">
                    <span className="k" aria-hidden="true">=</span>
                    <span>{ex.total.v} {ex.total.label}</span>
                  </li>
                )}
              </ol>
            </section>
            {ex.compare && ex.compare.length > 0 && (
              <section>
                <h3 className="lab">Against</h3>
                <div className="cmp">
                  {ex.compare.map((c, i) => (
                    <React.Fragment key={i}>
                      <span>{c.label}</span>
                      <span className="v">{c.k
                        ? <button type="button" className="drill" onClick={() => api.drill(c.k, c.arg)} title={`How ${c.v} is worked out`}>{c.v}</button>
                        : c.v}</span>
                      <span className="n">{c.note}</span>
                    </React.Fragment>
                  ))}
                </div>
              </section>
            )}
            <section>
              <h3 className="lab">Where it comes from</h3>
              <div className="src">
                {sources.map((r, i) => (
                  <div className="s" key={i}>
                    <span className="n">{r.name}</span>
                    <span className="f">
                      <i className={r.warn ? "warn" : r.fresh ? "" : "set"} aria-hidden="true" />
                      {r.warn || r.fresh || r.set}
                    </span>
                    <span className="d">{r.gave}{r.via ? <em> · {r.via}</em> : null}</span>
                  </div>
                ))}
              </div>
            </section>
            {ex.notes && ex.notes.length > 0 && (
              <section>
                <h3 className="lab">Worth knowing</h3>
                <ul className="notes">{ex.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </section>
            )}
          </div>
          <div className="xp-bottom">
            <span>Figures to {asOf}{ex.method ? ` · ${ex.method}` : ""}</span>
            <button type="button" className="copy" onClick={copy}>
              {copied === "done" ? "Copied" : copied === "failed" ? "Select and copy" : "Copy as text"}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
