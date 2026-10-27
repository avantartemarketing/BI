/* Sell-through updates to Slack, on demand.
 *
 * The sell-through card carries a "Post to Slack" button; pressing it sends
 * the card as a Block Kit message to the channel set for that release on
 * its Target setting tab: the artist as the header, the campaign day under
 * it, then Slack's table, one row per work - its units, its target, how
 * far along the target it is, its framed units and its framing conversion,
 * both on the same units as the units column - with a bold Total row, and
 * under the table the day the figures run to, the totals and the two
 * framing readings behind the table's (paid prints, entrants) in plain
 * sentences. The message is
 * composed here from the snapshot the page is showing, by the card's own
 * rules (docs 6.3), so what lands in Slack is what the card says, set in
 * Slack's own type at Slack's own size. It replaced a picture of the card,
 * which Slack shrank to a fixed height whatever its size, then a table
 * with bars drawn in text, which a phone wrapped, then a plain table; the
 * data table was the one that read on a phone.
 *
 * Channel per release lives in a small document of its own (SLACK_STATE_PATH,
 * default data/slack.json; put it on the persistent disk like the layout), so
 * a release without targets can have a channel too. When SLACK_STATE_PATH
 * points somewhere the service cannot write (the disk not mounted there), the
 * save lands in data/slack.json instead and the response says so, because
 * that copy does not survive a deploy. Posting needs a Slack app bot token in
 * SLACK_BOT_TOKEN (scopes chat:write, and chat:write.public for a public
 * channel the bot has not joined; for a private channel invite the bot
 * first). README "Posting sell-through to Slack" has the setup. The token
 * stays in the environment: nothing here logs it or writes it anywhere. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FALLBACK_PATH = process.env.SLACK_STATE_FALLBACK_PATH || path.join(ROOT, "data", "slack.json");
const STATE_PATH = process.env.SLACK_STATE_PATH || FALLBACK_PATH;
const API = process.env.SLACK_API || "https://slack.com/api/chat.postMessage";
const CHANNEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

// ---------------------------------------------------------------- the channel per release

let fallback = null;   // {reason} once the configured path has proved unwritable

function readState() {
  // the configured document first, then the fallback copy a failed write left
  for (const p of STATE_PATH === FALLBACK_PATH ? [STATE_PATH] : [STATE_PATH, FALLBACK_PATH]) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}
function writeTo(p, doc) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, p);
}
/* Writes the configured document. When that path cannot be made or written
 * (the persistent disk not mounted where SLACK_STATE_PATH points) the save
 * lands in the fallback copy instead, so the channel is not lost on the way,
 * and stateWarning() says so until the process restarts on a mounted disk. */
function writeState(doc) {
  if (!fallback) {
    try { writeTo(STATE_PATH, doc); return; } catch (e) {
      if (STATE_PATH === FALLBACK_PATH) throw e;
      fallback = { reason: String(e.code || e.message || e) };
      console.warn(`slack: cannot write ${STATE_PATH} (${fallback.reason}); saving to ${FALLBACK_PATH}, which does not survive a deploy`);
    }
  }
  writeTo(FALLBACK_PATH, doc);
}
/* Null while saves reach the configured path; otherwise one sentence for the
 * screen: where the save went and why it will not last. */
function stateWarning() {
  return fallback
    ? `Saved, but not on the persistent disk: ${STATE_PATH} cannot be written (${fallback.reason}), so this resets on the next deploy. Mount the disk there or unset SLACK_STATE_PATH.`
    : null;
}
/* {channel, pm, updatedAt, updatedBy, lastPostAt, lastPostBy,
 * lastEconomicsAt, lastEconomicsBy} or null. `pm` is the project manager who
 * confirms the unit economics, as typed on the Target setting tab: a Slack
 * member ID, an @handle or an email (resolveMention). */
function stateFor(id) {
  const st = readState()[id];
  return st && typeof st === "object" ? st : null;
}
/* The release's channel and project manager, as typed: the channel without
 * its #, the project manager without a leading @; a field left undefined
 * keeps its value, an empty channel clears the release (nothing to post to,
 * so the project manager goes with it). Returns the release's state, or
 * throws on a value Slack could not take. */
function setSlack(id, { channel, pm } = {}, by) {
  const doc = readState();
  const prev = doc[id] && typeof doc[id] === "object" ? doc[id] : {};
  const name = channel === undefined ? String(prev.channel || "") : String(channel ?? "").trim().replace(/^#/, "");
  if (name && !CHANNEL_RE.test(name)) {
    throw new Error("a Slack channel name is letters, digits, dots, dashes and underscores (no spaces, no #)");
  }
  const who = pm === undefined ? String(prev.pm || "") : String(pm ?? "").trim().replace(/^@/, "");
  if (who && (who.length > 120 || /[\s<>]/.test(who))) {
    throw new Error("the project manager is one Slack member ID, @handle or email address, with no spaces");
  }
  if (!name) { delete doc[id]; writeState(doc); return null; }
  doc[id] = { ...prev, channel: name, updatedAt: new Date().toISOString(), updatedBy: by || null };
  if (who) doc[id].pm = who; else delete doc[id].pm;
  writeState(doc);
  return doc[id];
}
function setChannel(id, channel, by) {
  return setSlack(id, { channel }, by);
}
function recordPost(id, by) {
  const doc = readState();
  if (!doc[id]) return null;
  doc[id] = { ...doc[id], lastPostAt: new Date().toISOString(), lastPostBy: by || null };
  writeState(doc);
  return doc[id];
}
function recordEconomicsPost(id, by) {
  const doc = readState();
  if (!doc[id]) return null;
  doc[id] = { ...doc[id], lastEconomicsAt: new Date().toISOString(), lastEconomicsBy: by || null };
  writeState(doc);
  return doc[id];
}

// ---------------------------------------------------------------- the message

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso) => {
  const d = new Date(String(iso) + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? String(iso) : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const dayOf = (iso) => { const d = new Date(String(iso) + "T00:00:00Z"); return Number.isNaN(d.getTime()) ? null : d.getTime(); };
/* whole days from one ISO date to another, 0 when either is not a date */
const daysBetween = (a, b) => { const x = dayOf(a), y = dayOf(b); return x === null || y === null ? 0 : Math.round((y - x) / 86400000); };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const fmt = (v) => Math.round(num(v)).toLocaleString("en-GB");
const pct = (v) => `${Math.round(num(v) * 100)}%`;

/* The part of the names all the products share, back to the last space or
 * opening bracket: "Brillo Box Collectable (" for the seven Brillo boxes;
 * null when they share less than eight characters. */
function sharedPrefix(names) {
  if (names.length < 2) return null;
  let p = names[0];
  for (const n of names) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  p = p.replace(/[^\s(]*$/, "");
  return p.length < 8 ? null : p;
}
/* Product names without the part they all share: "Untitled (White on White)"
 * and "Untitled (Black on Black)" become "White on White" and "Black on
 * Black"; the three Schnabel prints become I, II and III. The card can
 * truncate and lean on its hover; a message in a channel cannot. */
function shortNames(names) {
  const p = sharedPrefix(names);
  if (p === null) return names.slice();
  return names.map((n) => n.slice(p.length).replace(/^[\s(]+|[\s)]+$/g, "") || n);
}
/* the shared part as words, for the line under the header */
const prefixWords = (p) => p.replace(/[\s(,:-]+$/, "").trim();

const bold = (t) => ({ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: String(t), style: { bold: true } }] }] });
const raw = (t) => ({ type: "raw_text", text: String(t) });
const mrkdwn = (text) => ({ type: "mrkdwn", text });
const section = (text) => ({ type: "section", text: mrkdwn(text) });
const context = (text) => ({ type: "context", elements: [mrkdwn(text)] });

/* Everything the layouts say, worked out once from the snapshot by the
 * card's own rules: the release and its day, the headline, the totals, the
 * framing take-up, and one row per product (or the release as one row
 * without the draw feed). `horizon` is the page's toggle: "close" reads the
 * projection, as the card does. The day is moved on to the day this goes out
 * (`today`, for the tests). `direct` says the page reads Direct spread over
 * the other channels, and the snapshot handed in is that reading. */
function model(snap, { horizon = "today", today, direct = false } = {}) {
  const st = (snap && snap.sellthrough) || {};
  const close = horizon === "close";
  const products = Array.isArray(st.products) ? st.products : [];
  const fullNames = products.map((p) => String(p.name || ""));
  const names = shortNames(fullNames);
  const soldOf = (p) => num(p.sold) + num(p.soldAssumed);
  // the products' editions added up, for splitting the release's target over
  // the works; the headline's edition is the card's, the release's own, with
  // this sum standing in only when the release has none
  const editionSum = products.length && products.every((p) => num(p.edition) > 0)
    ? products.reduce((n, p) => n + num(p.edition), 0) : null;
  const edition = num(st.edition) > 0 ? num(st.edition) : editionSum;
  const releaseName = String(snap.releaseName || snap.id || "Release");
  const artist = String(snap.artist || releaseName);

  // the works and the campaign day, moved on to the day this goes out
  const prefix = sharedPrefix(fullNames);
  const worksLine = products.length === 1 ? `${fullNames[0]}.`
    : products.length ? `${prefix ? prefixWords(prefix) + ", " : ""}${products.length} works.` : null;
  const sent = today || new Date().toISOString().slice(0, 10);
  const lag = Math.max(0, daysBetween(snap.asOf, sent));
  const of = num(snap.of);
  const day = Math.min(num(snap.day) + lag, of > 0 ? of : Infinity);
  // the figures run to the page's as-of day ("data through" on the page),
  // which is only partly in while the feed is live on it
  const through = snap.asOf || snap.completeThrough || null;
  const partial = !!snap.asOf && finite(snap.asOfFraction) && num(snap.asOfFraction) < 1;
  const toWords = through ? `${fmtDay(through)}${partial ? " so far" : ""}` : null;
  const dayLine = of > 0 ? `Day ${fmt(day)} of ${fmt(of)}${toWords ? `, figures to ${toWords}` : ""}.`
    : toWords ? `Figures to ${toWords}.` : null;

  // the headline, as the card computes it: today's units over the release's
  // edition, and at close the card's own percentage (the sell-through's pct,
  // on that edition from these same parts); both on the edition it prints
  const sold = num(st.sold), drafts = finite(st.drafts) ? num(st.drafts) : null, inHand = num(st.soldPredicted);
  const future = close ? num(st.futureEntriesPredicted) : 0;
  const units = sold + (drafts || 0) + inHand + future;
  const headPct = edition
    ? (close && edition === num(st.edition) && finite(st.pct) ? num(st.pct) : Math.min(units / edition, 1))
    : null;
  const what = close ? "projected at close" : "sold through";
  const headline = headPct === null
    ? { bold: `${fmt(units)} units ${close ? "projected at close" : "spoken for"}`, rest: "" }
    : { bold: `${pct(headPct)} ${what}`, rest: `, ${fmt(units)} of ${fmt(edition)} units` };

  // the close read on current results, for the beta line under the table of
  // a Today update (5 October 2026): the same figures the "At close" view's
  // headline prints, so the two never disagree - the parts with the entries
  // still to come, the percentage the card's own at close. Nothing once the
  // campaign is complete: today's figure is then the close's.
  const closeUnits = sold + (drafts || 0) + inHand + num(st.futureEntriesPredicted);
  const closePct = edition
    ? (edition === num(st.edition) && finite(st.pct) ? num(st.pct) : Math.min(closeUnits / edition, 1))
    : null;
  const atClose = snap.complete ? null : { pct: closePct, units: closeUnits, edition };
  // the paid lever under that line (6 October 2026): the forecast holds
  // paid at its current daily spend (stopped where the Paid card's own
  // limits say spending on is wasted, docs 5.4); the card's recommendation
  // says whether there is room to scale it, and the build carries the
  // sell-through at close with paid at the recommended spend instead
  // (paid.atRecommended.sellThrough). Nothing without a running campaign, a
  // recommendation or that figure, and nothing once the campaign is complete.
  const pb = (snap.paid && snap.paid.budget) || {};
  const ar = snap.paid && snap.paid.atRecommended;
  const ic = snap.paid && snap.paid.ifContinued;
  const cur = finite(pb.current) ? num(pb.current) : 0;
  const rec = finite(pb.recommended) ? num(pb.recommended) : null;
  const recPct = ar && ar.sellThrough && finite(ar.sellThrough.pct) ? num(ar.sellThrough.pct) : null;
  // the forecast runs at the recommended spend (27 October 2026); the
  // sell-through today's spend held to the close would reach
  // (paid.ifContinued.sellThrough) is the comparison the line gives
  const heldPct = ic && ic.sellThrough && finite(ic.sellThrough.pct) ? num(ic.sellThrough.pct) : null;
  // what bound the recommendation (paid.budget.cap, the Paid card's "Capped
  // by" chip) rides along, so a cut or a stop can say why (leverLine)
  const lever = snap.complete || !(cur > 0) || rec === null || recPct === null || closePct === null ? null
    : { current: cur, recommended: rec, move: Math.round(rec) - Math.round(cur), pct: recPct, units: num(ar.sellThrough.units),
        held: heldPct === null ? null : { pct: heldPct, units: num(ic.sellThrough.units) },
        cap: pb.cap || null, paced: !!pb.paced, floor: finite(pb.floor) ? num(pb.floor) : null,
        // paid switched off today while the feed shows other campaigns
        // spending: the current figure is the last day it ran (13 October 2026)
        offToday: !!pb.offToday };

  // the totals, in words
  const totals = [
    `Paid ${fmt(sold)}`,
    drafts !== null && drafts > 0 ? `awaiting payment ${fmt(drafts)}` : null,
    `expected from the draw ${fmt(inHand)}`,
    close && future > 0 ? `still to come ${fmt(future)}` : null,
  ].filter(Boolean).join(", ") + ".";

  // framing in words: the two readings the table's framing figure is made
  // of, the Framing card's two bars (docs 6.4) - the frames bought with the
  // paid prints, and the frames the entrants still in the draw ask for on
  // their pre-authorisations; either alone where only one has anything to
  // say; nothing on a snapshot without the block, or where no print has a
  // frame on offer. The plan's rate is not repeated.
  const fr = snap.framing;
  const framingOff = fr === null || !!(snap.economics && snap.economics.framingAvailable === false);
  const paidWords = fr && finite(fr.rate) && num(fr.prints) > 0
    ? `${pct(fr.rate)} of paid prints took a frame, ${fmt(fr.frames)} of ${fmt(fr.prints)}` : null;
  const entrantWords = fr && fr.entrants && finite(fr.entrants.rate) && num(fr.entrants.prints) > 0
    ? `entrants asked for frames on ${pct(fr.entrants.rate)} of their pre-authorised prints` : null;
  const framing = framingOff ? null
    : paidWords && entrantWords ? `${paidWords}; ${entrantWords}.`
      : paidWords ? `${paidWords}.`
        : entrantWords ? `${entrantWords[0].toUpperCase()}${entrantWords.slice(1)}.` : null;

  // the rows: the products, or the release as one row without the draw feed.
  // Each carries its framing for the table's last two columns, on the same
  // units as its units column: the snapshot's framing forecast at this
  // horizon (docs 6.4) - the paid prints and their frames, the drafts and
  // theirs, the draw's forecast conversions (at close the entries still to
  // come too) at the entrants' rate - for the row of the same draw. Null for
  // a work with no frame on offer: a dash in the table. The columns are left
  // out altogether where the release has no framing option, or the snapshot
  // no forecast (one built before it): a paid-only figure beside units that
  // count drafts and the draw's forecast would not be the same thing.
  const releaseTarget = snap.edition && finite(snap.edition.target) && num(snap.edition.target) > 0 ? num(snap.edition.target) : null;
  const targets = targetsFor(snap, products, editionSum, releaseTarget);
  const at = close ? "close" : "today";
  const fc = !framingOff && fr && typeof fr === "object" && fr.forecast && typeof fr.forecast === "object"
    && fr.forecast[at] && typeof fr.forecast[at] === "object" ? fr.forecast : null;
  const framingCols = !!fc;
  const onOffer = (x) => (x && num(x.prints) > 0 ? { prints: num(x.prints), frames: num(x.frames) } : null);
  const fcRows = new Map((fc && Array.isArray(fc.products) ? fc.products : []).map((r) => [r.key, r[at]]));
  const rowsIn = products.length ? products.map((p, i) => ({
    name: names[i], target: targets[i], edition: num(p.edition) > 0 ? num(p.edition) : null,
    paid: soldOf(p), drafts: num(p.drafts), winners: num(p.shown), future: close ? num(p.futurePredicted) : 0,
    framing: fc ? onOffer(fcRows.get(p.key)) : null,
  })) : [{ name: releaseName, target: releaseTarget, edition: edition || null, paid: sold, drafts: drafts || 0, winners: inHand, future,
    framing: fc ? onOffer(fc[at]) : null }];
  // a work's sell-through is its units over its edition, capped at the whole
  // as the headline's is; null without an edition (a dash)
  const rows = rowsIn.map((r) => ({
    ...r, units: r.paid + r.drafts + r.winners + r.future,
    framed: r.framing ? r.framing.frames : null, framingRate: r.framing ? r.framing.frames / r.framing.prints : null,
  })).map((r) => ({ ...r, sellThrough: r.edition ? Math.min(r.units / r.edition, 1) : null }));
  // the table's last row: the units, the targets and the editions added up
  // as the rows show them, the shares read on the sums; the frames and the
  // frame rate the forecast's own totals, the rows' figures before rounding
  // (a frame on an order of two prints is half a frame on each)
  const sum = (key) => (rows.every((r) => r[key] !== null) ? rows.reduce((n, r) => n + Math.round(r[key]), 0) : null);
  const fcTotal = fc ? onOffer(fc[at]) : null;
  const total = { units: rows.reduce((n, r) => n + Math.round(r.units), 0), target: sum("target"), edition: sum("edition"),
    framed: fcTotal ? fcTotal.frames : null };
  total.pctTarget = total.target ? total.units / total.target : null;
  total.sellThrough = total.edition ? Math.min(total.units / total.edition, 1) : null;
  total.framingRate = fcTotal ? fcTotal.frames / fcTotal.prints : null;

  return {
    close, artist, releaseName, prefix: prefix ? prefixWords(prefix) : null, day: of > 0 ? { day, of } : null, through, toWords,
    direct: !!direct, worksLine, dayLine, headline, totals, framing, framingCols, rows, total, atClose, lever,
    hasProducts: products.length > 0,
    incomplete: Array.isArray(st.incomplete) ? st.incomplete : [],
  };
}

/* The target for each work: the one the Target setting tab shows for it
 * (its Airtable or typed target units, matched by name, or by one name
 * starting the other where the draw feed's title is the short form), else
 * the release's target split by edition share, the rule the card's
 * references follow. Null without a target, or for a work without an
 * edition. A release still on legacy release-level figures can have works
 * whose targets add up to something other than its hero target; the table
 * shows the works' own. */
function targetsFor(snap, products, editionSum, releaseTarget) {
  const ec = snap.economics || {};
  const typed = (Array.isArray(ec.products) ? ec.products : [])
    .filter((p) => p && p.name).map((p) => ({ name: String(p.name), units: num(p.target_units) }));
  return products.map((p) => {
    const own = byName(p.name, typed);
    if (own && own.units > 0) return own.units;
    if (releaseTarget === null || !editionSum || !(num(p.edition) > 0)) return null;
    return releaseTarget * num(p.edition) / editionSum;
  });
}

/* The one of `items` (each with a `name`) for a product's name: the same
 * name (case aside), else the one name that starts the other where both
 * are four characters or more (the draw feed's short titles against
 * Airtable's long ones). Null when none or several. The ETL places a draw's
 * framing the same way when the draw is not paired (etl/build.py _by_name). */
function byName(name, items) {
  const n = String(name || "").toLowerCase();
  const named = items.map((it) => ({ it, name: String(it.name || "").toLowerCase() }));
  const exact = named.filter((x) => x.name === n);
  const near = exact.length ? exact
    : n.length >= 4 ? named.filter((x) => x.name.length >= 4 && (x.name.startsWith(n) || n.startsWith(x.name))) : [];
  return near.length === 1 ? near[0].it : null;
}

// ---- the table

const round1 = (v) => Math.round(v * 10) / 10;
/* a number Slack can sort, shown as words; a dash where there is nothing */
/* A figure's cell: its words as plain text, "-" where it has none. Slack's
 * table reads two cell types, raw_text and rich_text; a raw_number cell
 * posted without complaint and showed as a blank on the phone app (the
 * header row, plain text, was the only row that read). */
const cell = (v, text) => raw(v === null ? "-" : text);

/* Which attribution the figures are on, said only when the page has Direct
 * spread over the other channels (its Direct switch on Spread, docs 1.3):
 * the entries still to come and the framing forecast move with it. */
const DIRECT_WORDS = "Attribution: Direct spread over the other channels.";

/* The table's title, and the footnote the units column's asterisk points
 * to: what "units sold" counts, since the figure is more than the paid ones. */
const tableCaption = (m) => (m.close ? "Projected at close by work" : "Sell-through by work");
/* The close forecast under a Today update, at full size and marked beta (5
 * October 2026): the sell-through at close on current results, the figure the
 * "At close" view's headline gives, with its units over the edition; the units
 * alone where the release has no edition. Words only until the forecast has
 * been checked against closes; nothing on the "At close" update, whose whole
 * table is the projection, or once the campaign is complete. */
const closeLine = (m) => {
  const c = m.atClose;
  if (m.close || !c || !(c.units > 0)) return null;
  return c.pct === null
    ? `Projected at close: *${fmt(c.units)} units* on current results \`BETA\``
    : `Projected sell-through at close: *${pct(c.pct)}*, ${fmt(c.units)} of ${fmt(c.edition)} units on current results \`BETA\``;
};
/* The paid lever, the line under the close forecast (6 October 2026; since
 * 27 October 2026 the forecast runs at the recommended spend): the line says
 * the spend the forecast assumes - a raise or a cut from today's, a stop, a
 * pause, or no move - with the reason the level was bound by (paid.budget.cap,
 * the card's Capped by chip: the next euro paying for itself or not, the
 * sellout on course without the spend, days that bought nothing), and the
 * sell-through today's spend held to the close would have reached
 * (paid.ifContinued.sellThrough), so the lever's worth shows. It is an
 * update, not an instruction. On course to sell out the line ends at the
 * reason, and a stop says the forecast already assumes it, since the gap to
 * the edition is closed and the paid path stops at once (the target being
 * part of the edition changes nothing, paid runs to the sellout, 9 October
 * 2026). The sell-through is given to one decimal and in units, so a move
 * the forecast's whole percentage hides still shows. Nothing without the
 * forecast line, a running campaign or a recommendation. */
const eur = (v) => `€${fmt(v)}`;
const pct1 = (v) => `${(Math.round(num(v) * 1000) / 10).toFixed(1)}%`;
const leverLine = (m) => {
  const l = m.lever;
  if (m.close || !l) return null;
  // paid off today: the figure is the last day it ran, so the line says so
  const off = !!l.offToday;
  const offNote = `Paid is off today, after ${eur(l.current)} a day until yesterday.`;
  // the forecast runs at the recommended spend (27 October 2026): the line
  // says what it assumes, why the level is where it is (the Paid card's
  // Capped by chip), and what today's spend held to the close would reach
  const held = l.held ? `; held at ${eur(l.current)} the forecast would be *${pct1(l.held.pct)}* (${fmt(l.held.units)} units)` : "";
  const why = {
    marginal: l.move > 0 ? "as the next euro still pays for itself" : "as the next euro returns less than it costs",
    supply: l.move > 0 ? "to sell out by the close" : "as we are on course to sell out anyway",
    zero_conversion_pause: "as it has bought no entries for three days",
    zero_conversion: "as it bought no entries yesterday",
  }[l.cap] || null;
  if (l.move > 0) {
    const to = off ? `The forecast assumes it runs again at ${eur(l.recommended)} a day` : `This assumes paid is raised to ${eur(l.recommended)} a day from ${eur(l.current)}`;
    return `${off ? offNote + " " : ""}${to}${why ? `, ${why}` : ""}${held}.`;
  }
  if (l.move < 0) {
    const stop = !(l.recommended > 0);
    if (l.cap === "supply" && stop) {
      return off ? `${offNote.slice(0, -1)}, and we are on course to sell out without it.`
        : `This assumes paid stops now, as we are on course to sell out without it. Paid is at ${eur(l.current)} a day.`;
    }
    const verb = l.cap === "zero_conversion_pause" ? "pauses" : stop ? "stops now" : `is cut to ${eur(l.recommended)} a day from ${eur(l.current)}`;
    const to = off ? `The forecast assumes it ${stop ? "stays off" : `runs again at ${eur(l.recommended)} a day`}` : `This assumes paid ${verb}`;
    return `${off ? offNote + " " : ""}${to}${why ? `, ${why}` : ""}${l.cap === "supply" ? "" : held}.`;
  }
  return off ? `${offNote} The forecast assumes it runs again at that rate.` : `This assumes paid stays at ${eur(l.current)} a day: the next euro would not pay for more.`;
};
const unitsHeader = (m) => (m.close ? "Units at close *" : "Units sold *");
const unitsFootnote = (m) => (m.close
  ? "* Includes paid units, drafts, forecast conversions from draw entries and the entries still to come."
  : "* Includes paid units, drafts and forecast conversions from draw entries.");

/* Slack's table block: one row per work with its units, its target, how far
 * along the target it is, its total units (the edition) and its sell-through
 * on them, its frames and its frame % (frames per print on the prints a
 * frame is on offer for, counted on the same units as the units column, so
 * the footnote's asterisk covers both; the Framing card's headline figure; a
 * dash for a work with no frame on offer), and a bold Total row adding them
 * up (when there is more than one work). The two frame columns are left out where the release has no
 * framing option or the snapshot no forecast. The header row is plain text only, as
 * Slack requires; the figures are numbers with their words. It is the plain
 * table rather than Slack's data table because only the plain one takes
 * column settings: the data table splits the width evenly over the columns
 * and cuts a work's name off at a dozen characters, with nothing to be done
 * about it, while here the Work column wraps and the figures sit
 * right-aligned. */
function tableBlock(m) {
  const framing = (r) => (m.framingCols ? [
    cell(r.framed === null ? null : Math.round(r.framed), r.framed === null ? null : fmt(r.framed)),
    cell(r.framingRate === null ? null : round1(r.framingRate * 100), r.framingRate === null ? null : pct(r.framingRate)),
  ] : []);
  const rows = m.rows.map((r) => [
    raw(r.name),
    raw(fmt(r.units)),
    cell(r.target === null ? null : Math.round(r.target), fmt(r.target)),
    cell(r.target ? round1((r.units / r.target) * 100) : null, r.target ? pct(r.units / r.target) : null),
    cell(r.edition === null ? null : Math.round(r.edition), fmt(r.edition)),
    cell(r.sellThrough === null ? null : round1(r.sellThrough * 100), r.sellThrough === null ? null : pct(r.sellThrough)),
    ...framing(r),
  ]);
  if (m.rows.length > 1) {
    const t = m.total;
    rows.push([bold("Total"), bold(fmt(t.units)), bold(t.target === null ? "-" : fmt(t.target)), bold(t.pctTarget === null ? "-" : pct(t.pctTarget)),
      bold(t.edition === null ? "-" : fmt(t.edition)), bold(t.sellThrough === null ? "-" : pct(t.sellThrough)),
      ...(m.framingCols ? [bold(t.framed === null ? "-" : fmt(t.framed)), bold(t.framingRate === null ? "-" : pct(t.framingRate))] : [])]);
  }
  const header = [raw("Work"), raw(unitsHeader(m)), raw("Target"), raw("% target"), raw("Total units"), raw("% sell-through"),
    ...(m.framingCols ? [raw("Frames *"), raw("Frame %")] : [])];
  return {
    type: "table",
    column_settings: [{ is_wrapped: true, align: "left" }, ...Array.from({ length: header.length - 1 }, () => ({ align: "right" }))],
    rows: [header, ...rows],
  };
}

/* The update as Block Kit: the artist as the header; the works' shared
 * title and the campaign day on one line; the table's title, then the
 * table; on a Today update the close forecast at full size, marked beta
 * (closeLine) and under it the line on the paid lever (leverLine); then, in
 * small type, the day the figures run to (the page's as-of
 * day, "so far" while it is only partly in), which attribution they are on
 * when the page spreads Direct over the other channels, the totals and the
 * framing take-up in plain sentences, a note while a feed is missing, and
 * last the footnote the units column points to. `horizon` is the page's
 * toggle: "close" reads the projection, as the card does; `direct` is its
 * Direct switch on Spread, with `snap` already that reading. Returns the
 * blocks and the one-line text Slack shows in notifications. */
function composeSellThroughBlocks(snap, { horizon = "today", today, direct = false } = {}) {
  const m = model(snap, { horizon, today, direct });
  const dayWords = m.day ? `day ${fmt(m.day.day)} of ${fmt(m.day.of)}` : null;
  const above = m.prefix && dayWords ? `${m.prefix}, ${dayWords}` : m.prefix || (dayWords ? dayWords[0].toUpperCase() + dayWords.slice(1) : null);
  const below = [m.toWords ? `Figures to ${m.toWords}.` : null, m.direct ? DIRECT_WORDS : null, m.totals, m.framing].filter(Boolean).join(" ");
  const forecast = closeLine(m);
  const lever = forecast ? leverLine(m) : null;
  const blocks = [
    { type: "header", text: { type: "plain_text", text: m.artist.slice(0, 150) } },
    ...(above ? [section(above)] : []),
    section(`*${tableCaption(m)}*`),
    tableBlock(m),
    ...(forecast ? [section(forecast)] : []),
    ...(lever ? [section(lever)] : []),
    context(below),
  ];
  if (m.incomplete.length) blocks.push(context(`_Incomplete data: ${m.incomplete.join(", ")}_`));
  blocks.push(context(unitsFootnote(m)));
  return { text: `${m.artist}: ${m.headline.bold}${m.headline.rest}`, blocks };
}

// ---------------------------------------------------------------- the unit economics, for confirmation

/* The unit economics to the release's channel, for the project manager to
 * confirm: the Target setting tab's "Send unit economics to PM" button. These
 * are the figures the Paid ROI reads (docs 7), so a wrong one moves every
 * ROI on the page, and the person who knows the deal is asked to check them
 * where they will see it. Per work, every figure per unit (a line above the
 * table says so): the price, the artist's and Avant Arte's group profit
 * (before framing, as the works' rows and Airtable carry it), the blended
 * frame profit (the take-up times the profit per frame, Avant Arte's alone)
 * and the split, with an All works row weighted by target units as the
 * tab's; then the ask, to check and confirm in thread, with the project
 * manager mentioned, and last where the figures came from and who sent them
 * (12 October 2026: the edition and target columns, the launch value, the
 * profit at the target and the terms under the table came out, and the
 * frame's price gave way to the frame profit).
 * `mention` is the Slack mention ("<@U…>", resolveMention) or null, and
 * `mentionLabel` the person's name for the notification text; `mentions`
 * is a list of such {mention, label} pairs when more than one person is
 * asked (the project manager and whoever ECONOMICS_MENTIONS names, 12
 * October 2026), mentioned in that order. A page still carrying
 * release-level figures (economics.mode "release") is one row. */
function composeEconomicsBlocks(snap, { mention = null, mentionLabel = null, mentions = null, by = null, link = null, today } = {}) {
  const e = (snap && snap.economics) || {};
  const people = (Array.isArray(mentions) && mentions.length ? mentions : mention || mentionLabel ? [{ mention, label: mentionLabel }] : [])
    .filter((m) => m && (m.mention || m.label));
  const mentionText = people.map((m) => m.mention).filter(Boolean).join(" ");
  const labels = people.map((m) => m.label).filter(Boolean);
  const labelText = labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const artist = String(snap.artist || snap.releaseName || snap.id || "Release");
  const title = String(snap.title || "");
  const eur = (v, dp = 0) => "€" + num(v).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const price = (p, v) => (!finite(v) ? "-" : p.currency && p.currency !== "EUR" ? `${num(v).toLocaleString("en-GB")} ${p.currency}` : eur(v));
  const dealWords = (p) => (finite(p.aa_revenue_share) ? `AA ${pct(p.aa_revenue_share)} of revenue`
    : finite(p.aa_profit_share) ? `AA ${pct(p.aa_profit_share)} of profit` : "-");
  const sized = (Array.isArray(e.products) ? e.products : []).filter((p) => p && num(p.edition) > 0);
  const names = shortNames(sized.map((p) => String(p.name || "Product")));
  // the frame profit blended into a unit sold: the take-up times the profit
  // per frame (frame_uplift_per_unit), Avant Arte's alone, each work's own
  // and in the Total row the release's over every target unit
  const frameProfit = (p) => (p.framing_available !== false && finite(p.frame_uplift_per_unit) ? eur(p.frame_uplift_per_unit) : "-");
  const rows = sized.map((p, i) => [
    raw(names[i]), raw(price(p, p.unit_price)),
    raw(finite(p.artist_profit_per_unit) ? eur(p.artist_profit_per_unit) : "-"),
    raw(finite(p.aa_profit_per_unit) ? eur(p.aa_profit_per_unit) : "-"),
    raw(frameProfit(p)),
    raw(dealWords(p)),
  ]);
  const deal = Array.isArray(e.deal) && e.deal.length ? e.deal.join(", ") : "-";
  // the release's AA figure carries the framing uplift (economics
  // frameUpliftPerUnit); the works' rows and Airtable read before framing,
  // so the Total row reads the same way and the framing line puts the
  // uplift on top (12 October 2026: a total that read €787 over rows of
  // €644 was the uplift folded into the one and not the others)
  const uplift = finite(e.frameUpliftPerUnit) ? num(e.frameUpliftPerUnit) : 0;
  const aaBefore = finite(e.aaProfitPerUnit) ? num(e.aaProfitPerUnit) - uplift : null;
  const releaseRow = (label) => [bold(label), bold(finite(e.unitPrice) ? eur(e.unitPrice) : "-"),
    bold(finite(e.artistProfitPerUnit) ? eur(e.artistProfitPerUnit) : "-"), bold(finite(aaBefore) ? eur(aaBefore) : "-"),
    bold(e.framingAvailable === false || !finite(e.frameUpliftPerUnit) ? "-" : eur(e.frameUpliftPerUnit)), bold(deal)];
  // the release's figures per target unit, every work weighted by its target
  // units, as the tab's All works column reads
  if (sized.length > 1) rows.push(releaseRow("All works"));
  if (!sized.length) rows.push(releaseRow(title || "Release"));
  const table = {
    type: "table",
    column_settings: [{ is_wrapped: true, align: "left" }, ...Array.from({ length: 5 }, () => ({ align: "right" }))],
    rows: [[raw("Work"), raw("Price"), raw("Artist profit"), raw("AA group profit"), raw("Blended frame profit"), raw("Split")], ...rows],
  };

  const ask = `${mentionText ? mentionText + " please" : "Please"} check and confirm in thread. They inform our paid ROI model.`;
  const typed = sized.reduce((n, p) => n + Object.values(p.sources || {}).filter((s) => s === "typed").length, 0);
  const source = e.mode === "release" ? "Release-level figures typed on the Target setting tab stand over the works'."
    : typed ? `Figures from Airtable, ${typed} typed over on the Target setting tab.` : "Figures from Airtable.";
  const when = today || new Date().toISOString().slice(0, 10);
  const sent = `Sent by ${by || "the dashboard"} on ${fmtDay(when)}${link ? ` · <${link}|Target setting>` : ""}.`;
  const blocks = [
    // headed by what it is, so it never reads as the sell-through card's
    // post (whose header is the artist's name): a separate message from a
    // separate button, sharing only the channel
    { type: "header", text: { type: "plain_text", text: `Unit economics to confirm · ${artist}`.slice(0, 150) } },
    section(`*${artist}${title ? ` · ${title}` : ""}*`),
    section("These numbers are all per unit:"),
    table,
    section(ask),
    context(`${source} ${sent}`),
  ];
  return { text: `${artist}: unit economics to confirm${labelText ? `, ${labelText} please` : ""}`, blocks };
}

// ---------------------------------------------------------------- who to mention

const MEMBER_ID_RE = /^[UW][A-Z0-9]{8,}$/;
/* What the project manager field holds: a Slack member ID (used as is), an
 * email (users.lookupByEmail) or a handle (users.list). */
function pmKind(pm) {
  const s = String(pm || "").trim().replace(/^@/, "");
  if (!s) return null;
  if (MEMBER_ID_RE.test(s)) return "id";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return "email";
  return "handle";
}
/* One Web API method beside chat.postMessage (the same base, so the tests'
 * stand-in serves it too), with the bot token; throws with Slack's error
 * code on `code`. */
async function slackApi(method, params) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Slack is not connected - set SLACK_BOT_TOKEN to the app's bot token (README: Posting sell-through to Slack)");
  const url = API.replace(/chat\.postMessage$/, "") + method + "?" + new URLSearchParams(params).toString();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const code = json.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Slack refused ${method} (${code})`), { code });
  }
  return json;
}
/* The project manager as a Slack mention. A member ID is used as typed and
 * costs no call; an email is looked up (the app needs the users:read.email
 * scope), a handle is found in the member list by its username or display
 * name (users:read). A failure says what to do: add the scope and reinstall
 * the app, or paste the member ID, which Slack gives under the profile menu
 * as Copy member ID. Returns {mention, id, label}. */
async function resolveMention(pm) {
  const s = String(pm || "").trim().replace(/^@/, "");
  const kind = pmKind(s);
  if (!kind) throw new Error("Set the project manager for this release on the Target setting tab first: their Slack member ID, @handle or email.");
  if (kind === "id") return { mention: `<@${s}>`, id: s, label: s };
  const paste = "or paste their member ID instead (Slack profile menu, Copy member ID)";
  try {
    if (kind === "email") {
      const j = await slackApi("users.lookupByEmail", { email: s });
      return { mention: `<@${j.user.id}>`, id: j.user.id, label: j.user.real_name || j.user.name || s };
    }
    const want = s.toLowerCase();
    let cursor = "";
    do {
      const j = await slackApi("users.list", { limit: "200", ...(cursor ? { cursor } : {}) });
      const hit = (j.members || []).find((u) => u && !u.deleted && [u.name, u.profile && u.profile.display_name, u.profile && u.profile.display_name_normalized]
        .filter(Boolean).some((n) => String(n).toLowerCase() === want));
      if (hit) return { mention: `<@${hit.id}>`, id: hit.id, label: hit.real_name || (hit.profile && hit.profile.real_name) || hit.name || s };
      cursor = (j.response_metadata && j.response_metadata.next_cursor) || "";
    } while (cursor);
    throw Object.assign(new Error(`no Slack member is @${s} - check the handle, ${paste}`), { code: "no_match" });
  } catch (e) {
    if (e.code === "missing_scope") {
      throw new Error(`the Slack app cannot look people up: add the ${kind === "email" ? "users:read.email" : "users:read"} scope and reinstall it, ${paste}`);
    }
    if (e.code === "users_not_found") throw new Error(`no Slack member has the email ${s}, ${paste}`);
    throw e;
  }
}

// ---------------------------------------------------------------- posting

const HINTS = {
  channel_not_found: (c) => `Slack cannot find #${c} - check the name; for a private channel invite the bot first`,
  not_in_channel: (c) => `the bot is not in #${c} - a public channel needs the chat:write.public scope; a private one needs the bot invited (/invite it), then post again`,
  is_archived: (c) => `#${c} is archived`,
  invalid_auth: () => "the Slack token is not valid - replace SLACK_BOT_TOKEN",
  token_revoked: () => "the Slack token was revoked - replace SLACK_BOT_TOKEN",
  account_inactive: () => "the Slack app is no longer installed - reinstall it and replace SLACK_BOT_TOKEN",
  missing_scope: () => "the Slack app needs the chat:write scope (and chat:write.public for channels the bot is not in)",
  invalid_blocks: () => "Slack refused the message's layout (invalid_blocks) - the table block needs a current Slack workspace",
  msg_too_long: () => "the update is too long for one Slack message",
  ratelimited: () => "Slack is rate limiting the app - try again in a minute",
};

/* One message to a channel, by name or by id: the text Slack shows in a
 * notification, and the blocks it shows in the channel. */
async function postMessage(channel, text, blocks = null) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Slack is not connected - set SLACK_BOT_TOKEN to the app's bot token (README: Posting sell-through to Slack)");
  const isId = /^[CG][A-Z0-9]{8,}$/.test(channel);
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: isId ? channel : `#${channel}`, text, ...(blocks ? { blocks } : {}), unfurl_links: false, unfurl_media: false }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const code = json.error || `HTTP ${res.status}`;
    const hint = HINTS[code];
    throw new Error(hint ? hint(channel) : `Slack refused the message (${code})`);
  }
  return { ts: json.ts, channel: json.channel };
}

/* a channel name Slack could take, as typed on the Target setting tab */
const channelNameOk = (name) => CHANNEL_RE.test(String(name ?? "").trim().replace(/^#/, ""));

module.exports = {
  stateFor, setChannel, setSlack, recordPost, recordEconomicsPost, stateWarning, channelNameOk, composeSellThroughBlocks,
  composeEconomicsBlocks, pmKind, resolveMention, shortNames, sharedPrefix, postMessage, STATE_PATH,
};
