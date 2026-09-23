/* Sell-through updates to Slack, on demand.
 *
 * The sell-through card carries a "Post to Slack" button; pressing it sends
 * the card as a Slack message - a Block Kit table of the products, three
 * columns (the product, its units of the edition, its share), under the
 * release's headline and the framing take-up - to the channel set for that
 * release on its Target setting tab. The message is composed here from the
 * snapshot the page is showing, by the card's own rules (docs 6.3), so what
 * lands in Slack is what the card says, set in Slack's own type at Slack's
 * own size. It replaced a picture of the card, which Slack shrank to a
 * fixed height whatever its size, and then a table with bars drawn in text,
 * which a phone wrapped. Figures only, so it reads on a phone.
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

/* Product names without the part they all share: "Untitled (White on White)"
 * and "Untitled (Black on Black)" become "White on White" and "Black on
 * Black"; the three Schnabel prints become I, II and III. The card can
 * truncate and lean on its hover; a table in a channel cannot. */
function shortNames(names) {
  if (names.length < 2) return names.slice();
  let p = names[0];
  for (const n of names) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  p = p.replace(/[^\s(]*$/, "");   // back to the last space or opening bracket
  if (p.length < 8) return names.slice();
  return names.map((n) => n.slice(p.length).replace(/^[\s(]+|[\s)]+$/g, "") || n);
}

const bold = (t) => ({ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: String(t), style: { bold: true } }] }] });
const raw = (t) => ({ type: "raw_text", text: String(t) });

/* The update as Block Kit: the release as a header, the card's headline,
 * the campaign day and the framing take-up as a section, the products as a
 * table (name, units of the edition, the share), the release's totals as a
 * context line, and a note while a feed is missing. `horizon` is the page's
 * toggle: "close" reads the projection, as the card does. The section
 * carries the day the update goes out (`today`, for the tests), with the
 * campaign day moved on from the snapshot's. Returns the blocks and the
 * one-line text Slack shows in notifications. */
function composeSellThroughBlocks(snap, { horizon = "today", today } = {}) {
  const st = (snap && snap.sellthrough) || {};
  const close = horizon === "close";
  const products = Array.isArray(st.products) ? st.products : [];
  const names = shortNames(products.map((p) => String(p.name || "")));
  const soldOf = (p) => num(p.sold) + num(p.soldAssumed);
  // the whole edition is the products' editions added up; the release's own
  // edition size stands in when a product has none
  const editionSum = products.length && products.every((p) => num(p.edition) > 0)
    ? products.reduce((n, p) => n + num(p.edition), 0) : null;
  const edition = editionSum || (num(st.edition) > 0 ? num(st.edition) : null);

  // the campaign day, moved on to the day this goes out
  const sent = today || new Date().toISOString().slice(0, 10);
  const lag = Math.max(0, daysBetween(snap.asOf, sent));
  const of = num(snap.of);
  const day = Math.min(num(snap.day) + lag, of > 0 ? of : Infinity);
  const through = snap.completeThrough || snap.asOf;
  const dayLine = [of > 0 ? `day ${fmt(day)} of ${fmt(of)}` : null, through ? `data through ${fmtDay(through)}` : null].filter(Boolean).join(" · ");

  // the headline, as the card computes it
  const sold = num(st.sold), drafts = finite(st.drafts) ? num(st.drafts) : null, inHand = num(st.soldPredicted);
  const future = close ? num(st.futureEntriesPredicted) : 0;
  const headPct = edition ? (close ? num(st.pct) : Math.min((sold + (drafts || 0) + inHand) / edition, 1)) : null;
  const headline = headPct === null
    ? `${fmt(sold + (drafts || 0) + inHand + future)} units`
    : `${Math.round(headPct * 100)}% of ${fmt(edition)} units`;

  // framing: frames per print on the prints a frame was on offer for, from
  // the orders - the Framing card's own figure (docs 6.4); before any print
  // is sold, the rate the entrants' pre-authorised prints ask for; with no
  // framing block at all (a snapshot from before it), the plan's rate, said
  // to be the plan. Nothing on a release where no print has a frame on offer.
  const fr = snap.framing;
  const plan = fr && finite(fr.plan) ? num(fr.plan)
    : snap.economics && finite(snap.economics.frameConversion) ? num(snap.economics.frameConversion) : null;
  const framingOff = fr === null || !!(snap.economics && snap.economics.framingAvailable === false);
  const pc = (v) => `*${Math.round(v * 100)}%*`;
  const planNote = plan !== null ? ` · plan ${Math.round(plan * 100)}%` : "";
  const framing = framingOff ? null
    : fr && finite(fr.rate) && num(fr.prints) > 0
      ? `Framing conversion ${pc(fr.rate)} · ${fmt(fr.frames)} frames on ${fmt(fr.prints)} prints sold${planNote}`
      : fr && fr.entrants && finite(fr.entrants.rate) && num(fr.entrants.prints) > 0
        ? `Framing conversion ${pc(fr.entrants.rate)} of the prints entrants pre-authorised${planNote}`
        : plan !== null ? `Framing conversion ${pc(plan)} (plan)` : null;

  // the rows: the products, or the release as one row without the draw feed
  const rowsIn = products.length ? products.map((p, i) => ({
    name: names[i], edition: num(p.edition) > 0 ? num(p.edition) : null,
    paid: soldOf(p), drafts: num(p.drafts), winners: num(p.shown), future: close ? num(p.futurePredicted) : 0,
    pct: close ? p.pctClose : p.pct,
  })) : [{
    name: String(snap.releaseName || snap.id || "Release"), edition,
    paid: sold, drafts: drafts || 0, winners: inHand, future, pct: headPct,
  }];
  const rows = rowsIn.map((r) => {
    const units = r.paid + r.drafts + r.winners + r.future;
    const pct = r.edition ? (finite(r.pct) ? num(r.pct) : Math.min(units / r.edition, 1)) : null;
    return [
      raw(r.name),
      raw(r.edition ? `${fmt(units)} of ${fmt(r.edition)}` : fmt(units)),
      bold(pct === null ? "-" : `${Math.round(pct * 100)}%`),
    ];
  });

  // the release's totals, the parts the units column adds up
  const key = [
    `Paid *${fmt(sold)}*`,
    drafts !== null && drafts > 0 ? `Drafts *${fmt(drafts)}*` : null,
    `Draw winners (estimate) *${fmt(inHand)}*`,
    close && future > 0 ? `Still to come *${fmt(future)}*` : null,
  ].filter(Boolean).join(" · ");
  const incomplete = Array.isArray(st.incomplete) ? st.incomplete : [];
  const releaseName = String(snap.releaseName || snap.id || "Release");

  const blocks = [
    { type: "header", text: { type: "plain_text", text: releaseName.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text:
      `*Sell-through by product · ${headline}*${close ? " · at close" : ""}${dayLine ? ` · ${dayLine}` : ""}${framing ? `\n${framing}` : ""}` } },
    { type: "table",
      column_settings: [{ align: "left", is_wrapped: true }, { align: "right" }, { align: "right" }],
      rows: [[bold("Product"), bold("Units"), bold("Sold")], ...rows] },
    { type: "context", elements: [{ type: "mrkdwn", text: key }] },
  ];
  if (incomplete.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_Incomplete data: ${incomplete.join(", ")}_` }] });
  return { text: `${releaseName}: sell-through ${headline}${close ? " at close" : ""}`, blocks };
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

module.exports = {
  stateFor, setChannel, recordPost, stateWarning, composeSellThroughBlocks, shortNames,
  postMessage, STATE_PATH,
};
