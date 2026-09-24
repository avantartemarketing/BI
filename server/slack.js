/* Sell-through updates to Slack, on demand.
 *
 * The sell-through card carries a "Post to Slack" button; pressing it sends
 * the card as a Block Kit message to the channel set for that release on
 * its Target setting tab: the artist as the header, the campaign day under
 * it, then Slack's data table, one row per work - its units, its target,
 * how far along the target it is, its edition, its sell-through - with a
 * bold Total row, and under the table the day the figures run to, the
 * totals and the framing take-up in plain sentences. The message is
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
/* {channel, updatedAt, updatedBy, lastPostAt, lastPostBy} or null */
function stateFor(id) {
  const st = readState()[id];
  return st && typeof st === "object" ? st : null;
}
/* A channel name as typed, without its #; an empty name clears it. Returns
 * the release's state, or throws on a name Slack could not take. */
function setChannel(id, channel, by) {
  const name = String(channel ?? "").trim().replace(/^#/, "");
  if (name && !CHANNEL_RE.test(name)) {
    throw new Error("a Slack channel name is letters, digits, dots, dashes and underscores (no spaces, no #)");
  }
  const doc = readState();
  const prev = doc[id] && typeof doc[id] === "object" ? doc[id] : {};
  if (!name) { delete doc[id]; writeState(doc); return null; }
  doc[id] = { ...prev, channel: name, updatedAt: new Date().toISOString(), updatedBy: by || null };
  writeState(doc);
  return doc[id];
}
function recordPost(id, by) {
  const doc = readState();
  if (!doc[id]) return null;
  doc[id] = { ...doc[id], lastPostAt: new Date().toISOString(), lastPostBy: by || null };
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
const rawNum = (value, text) => ({ type: "raw_number", value: Number(value), ...(text !== undefined ? { text: String(text) } : {}) });
const mrkdwn = (text) => ({ type: "mrkdwn", text });
const section = (text) => ({ type: "section", text: mrkdwn(text) });
const context = (text) => ({ type: "context", elements: [mrkdwn(text)] });

/* Everything the layouts say, worked out once from the snapshot by the
 * card's own rules: the release and its day, the headline, the totals, the
 * framing take-up, and one row per product (or the release as one row
 * without the draw feed). `horizon` is the page's toggle: "close" reads the
 * projection, as the card does. The day is moved on to the day this goes out
 * (`today`, for the tests). */
function model(snap, { horizon = "today", today } = {}) {
  const st = (snap && snap.sellthrough) || {};
  const close = horizon === "close";
  const products = Array.isArray(st.products) ? st.products : [];
  const fullNames = products.map((p) => String(p.name || ""));
  const names = shortNames(fullNames);
  const soldOf = (p) => num(p.sold) + num(p.soldAssumed);
  // the whole edition is the products' editions added up; the release's own
  // edition size stands in when a product has none
  const editionSum = products.length && products.every((p) => num(p.edition) > 0)
    ? products.reduce((n, p) => n + num(p.edition), 0) : null;
  const edition = editionSum || (num(st.edition) > 0 ? num(st.edition) : null);
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
  const through = snap.completeThrough || snap.asOf;
  const dayLine = of > 0 ? `Day ${fmt(day)} of ${fmt(of)}${through ? `, figures to ${fmtDay(through)}` : ""}.`
    : through ? `Figures to ${fmtDay(through)}.` : null;

  // the headline, as the card computes it
  const sold = num(st.sold), drafts = finite(st.drafts) ? num(st.drafts) : null, inHand = num(st.soldPredicted);
  const future = close ? num(st.futureEntriesPredicted) : 0;
  const units = sold + (drafts || 0) + inHand + future;
  const headPct = edition ? (close ? num(st.pct) : Math.min(units / edition, 1)) : null;
  const what = close ? "projected at close" : "sold through";
  const headline = headPct === null
    ? { bold: `${fmt(units)} units ${close ? "projected at close" : "spoken for"}`, rest: "" }
    : { bold: `${pct(headPct)} ${what}`, rest: `, ${fmt(units)} of ${fmt(edition)} units` };

  // the totals, in words
  const totals = [
    `Paid ${fmt(sold)}`,
    drafts !== null && drafts > 0 ? `awaiting payment ${fmt(drafts)}` : null,
    `expected from the draw ${fmt(inHand)}`,
    close && future > 0 ? `still to come ${fmt(future)}` : null,
  ].filter(Boolean).join(", ") + ".";

  // framing: frames per print on the prints a frame was on offer for, from
  // the orders - the Framing card's own figure (docs 6.4); before any print
  // is sold, the rate the entrants' pre-authorised prints ask for; with no
  // framing block at all (a snapshot from before it), the plan's rate, said
  // to be the plan. Nothing on a release where no print has a frame on offer.
  const fr = snap.framing;
  const plan = fr && finite(fr.plan) ? num(fr.plan)
    : snap.economics && finite(snap.economics.frameConversion) ? num(snap.economics.frameConversion) : null;
  const framingOff = fr === null || !!(snap.economics && snap.economics.framingAvailable === false);
  const planNote = plan !== null ? ` (plan ${pct(plan)})` : "";
  const framing = framingOff ? null
    : fr && finite(fr.rate) && num(fr.prints) > 0
      ? `${pct(fr.rate)} of prints sold took a frame, ${fmt(fr.frames)} of ${fmt(fr.prints)}${planNote}.`
      : fr && fr.entrants && finite(fr.entrants.rate) && num(fr.entrants.prints) > 0
        ? `Entrants asked for frames on ${pct(fr.entrants.rate)} of their pre-authorised prints${planNote}.`
        : plan !== null ? `Framing plan ${pct(plan)}, no framed orders in the feed yet.` : null;

  // the rows: the products, or the release as one row without the draw feed
  const releaseTarget = snap.edition && finite(snap.edition.target) && num(snap.edition.target) > 0 ? num(snap.edition.target) : null;
  const targets = targetsFor(snap, products, editionSum, releaseTarget);
  const rowsIn = products.length ? products.map((p, i) => ({
    name: names[i], edition: num(p.edition) > 0 ? num(p.edition) : null, target: targets[i],
    paid: soldOf(p), drafts: num(p.drafts), winners: num(p.shown), future: close ? num(p.futurePredicted) : 0,
    pct: close ? p.pctClose : p.pct,
  })) : [{ name: releaseName, edition, target: releaseTarget, paid: sold, drafts: drafts || 0, winners: inHand, future, pct: headPct }];
  const rows = rowsIn.map((r) => {
    const u = r.paid + r.drafts + r.winners + r.future;
    return { ...r, units: u, pct: r.edition ? (finite(r.pct) ? num(r.pct) : Math.min(u / r.edition, 1)) : null };
  });
  // the table's last row: every column added up as the rows show it, the
  // shares read on the sums
  const sum = (key) => (rows.every((r) => r[key] !== null) ? rows.reduce((n, r) => n + Math.round(r[key]), 0) : null);
  const total = { units: rows.reduce((n, r) => n + Math.round(r.units), 0), target: sum("target"), edition: sum("edition") };
  total.pctTarget = total.target ? total.units / total.target : null;
  total.pct = total.edition ? Math.min(total.units / total.edition, 1) : null;

  return {
    close, artist, releaseName, prefix: prefix ? prefixWords(prefix) : null, day: of > 0 ? { day, of } : null, through,
    worksLine, dayLine, headline, totals, framing, rows, total,
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
    .filter((p) => p && p.name).map((p) => ({ name: String(p.name).toLowerCase(), units: num(p.target_units) }));
  return products.map((p) => {
    const name = String(p.name || "").toLowerCase();
    const exact = typed.filter((t) => t.name === name);
    const near = exact.length ? exact
      : name.length >= 4 ? typed.filter((t) => t.name.length >= 4 && (t.name.startsWith(name) || name.startsWith(t.name))) : [];
    if (near.length === 1 && near[0].units > 0) return near[0].units;
    if (releaseTarget === null || !editionSum || !(num(p.edition) > 0)) return null;
    return releaseTarget * num(p.edition) / editionSum;
  });
}

// ---- the table

const round1 = (v) => Math.round(v * 10) / 10;
/* a number Slack can sort, shown as words; a dash where there is nothing */
const cell = (v, text) => (v === null ? raw("-") : rawNum(v, text));

/* The table's title, and the footnote the units column's asterisk points
 * to: what "units sold" counts, since the figure is more than the paid ones. */
const tableCaption = (m) => (m.close ? "Projected at close by work" : "Sell-through by work");
const unitsHeader = (m) => (m.close ? "Units at close *" : "Units sold *");
const unitsFootnote = (m) => (m.close
  ? "* Includes paid units, drafts, forecast conversions from draw entries and the entries still to come."
  : "* Includes paid units, drafts and forecast conversions from draw entries.");

/* Slack's table block: one row per work with its units, its target, how far
 * along the target it is, its edition and its sell-through, and a bold
 * Total row adding them up (when there is more than one work). The header
 * row is plain text only, as Slack requires; the figures are numbers with
 * their words. It is the plain table rather than Slack's data table because
 * only the plain one takes column settings: the data table splits the
 * width evenly over the six columns and cuts a work's name off at a dozen
 * characters, with nothing to be done about it, while here the Work column
 * wraps and the figures sit right-aligned. */
function tableBlock(m) {
  const rows = m.rows.map((r) => [
    raw(r.name),
    rawNum(Math.round(r.units), fmt(r.units)),
    cell(r.target === null ? null : Math.round(r.target), fmt(r.target)),
    cell(r.target ? round1((r.units / r.target) * 100) : null, r.target ? pct(r.units / r.target) : null),
    cell(r.edition, fmt(r.edition)),
    cell(r.pct === null ? null : round1(r.pct * 100), r.pct === null ? null : pct(r.pct)),
  ]);
  if (m.rows.length > 1) {
    const t = m.total;
    rows.push([bold("Total"), bold(fmt(t.units)), bold(t.target === null ? "-" : fmt(t.target)),
      bold(t.pctTarget === null ? "-" : pct(t.pctTarget)), bold(t.edition === null ? "-" : fmt(t.edition)), bold(t.pct === null ? "-" : pct(t.pct))]);
  }
  return {
    type: "table",
    column_settings: [{ is_wrapped: true, align: "left" }, ...Array.from({ length: 5 }, () => ({ align: "right" }))],
    rows: [[raw("Work"), raw(unitsHeader(m)), raw("Target"), raw("% target"), raw("Edition"), raw("Sell-through")], ...rows],
  };
}

/* The update as Block Kit: the artist as the header; the works' shared
 * title and the campaign day on one line; the table's title, then the
 * table; then, in small type, the day the figures run to, the totals and
 * the framing take-up in plain sentences, a note while a feed is missing,
 * and last the footnote the units column points to. `horizon` is the
 * page's toggle: "close" reads the projection, as the card does. Returns
 * the blocks and the one-line text Slack shows in notifications. */
function composeSellThroughBlocks(snap, { horizon = "today", today } = {}) {
  const m = model(snap, { horizon, today });
  const dayWords = m.day ? `day ${fmt(m.day.day)} of ${fmt(m.day.of)}` : null;
  const above = m.prefix && dayWords ? `${m.prefix}, ${dayWords}` : m.prefix || (dayWords ? dayWords[0].toUpperCase() + dayWords.slice(1) : null);
  const below = [m.through ? `Figures to ${fmtDay(m.through)}.` : null, m.totals, m.framing].filter(Boolean).join(" ");
  const blocks = [
    { type: "header", text: { type: "plain_text", text: m.artist.slice(0, 150) } },
    ...(above ? [section(above)] : []),
    section(`*${tableCaption(m)}*`),
    tableBlock(m),
    context(below),
  ];
  if (m.incomplete.length) blocks.push(context(`_Incomplete data: ${m.incomplete.join(", ")}_`));
  blocks.push(context(unitsFootnote(m)));
  return { text: `${m.artist}: ${m.headline.bold}${m.headline.rest}`, blocks };
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
  stateFor, setChannel, recordPost, stateWarning, channelNameOk, composeSellThroughBlocks, shortNames, sharedPrefix,
  postMessage, STATE_PATH,
};
