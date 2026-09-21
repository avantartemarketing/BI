/* Sell-through updates to Slack, on demand.
 *
 * The sell-through card carries a "Post to Slack" button; pressing it sends
 * the release's current sell-through figures - paid, unique draw entrants,
 * drafts and the estimated sell-through, per product - to the channel set for
 * that release on its Target setting tab. The message is composed from the
 * snapshot the page is showing, so what lands in Slack is what the card says.
 *
 * Channel per release lives in a small document of its own (SLACK_STATE_PATH,
 * default data/slack.json; put it on the persistent disk like the layout), so
 * a release without targets can have a channel too. When SLACK_STATE_PATH
 * points somewhere the service cannot write (the disk not mounted there), the
 * save lands in data/slack.json instead and the response says so, because
 * that copy does not survive a deploy. Posting needs a Slack app
 * bot token in SLACK_BOT_TOKEN (scopes chat:write and chat:write.public; for
 * a private channel invite the bot first). README "Posting sell-through to
 * Slack" has the setup. The token stays in the environment: nothing here
 * logs it or writes it anywhere. */
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
const fmt = (v) => Math.round(num(v)).toLocaleString("en-GB");
const pct = (part, whole) => (whole > 0 ? `${Math.round((num(part) / whole) * 100)}%` : null);

/* Product names without the part they all share: "Untitled (White on White)"
 * and "Untitled (Black on Black)" become "White on White" and "Black on
 * Black"; the three Schnabel prints become I, II and III. */
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

/* People with an entry still in the draw, from the entry patterns the
 * snapshot carries (docs 6.3): each pattern is one combination of open
 * entries and unpaid wins with how many entrants share it. */
function entrants(patterns) {
  let open = 0, won = 0, any = 0;
  for (const p of patterns || []) {
    const hasOpen = Array.isArray(p.open) && p.open.length > 0;
    const hasWon = Array.isArray(p.won) && p.won.length > 0;
    const n = num(p.n);
    if (hasOpen) open += n;
    if (hasWon) won += n;
    if (hasOpen || hasWon) any += n;
  }
  return { open, won, any };
}

/* The update as Slack mrkdwn: the sales team's own layout, from the snapshot.
 * The header carries the day the update goes out (`today`, for the tests),
 * with the campaign day moved on from the snapshot's; when the feeds' last
 * complete day is earlier than that, the last line says so. */
function composeSellThrough(snap, { link, today } = {}) {
  const st = (snap && snap.sellthrough) || {};
  const products = Array.isArray(st.products) ? st.products : [];
  const names = shortNames(products.map((p) => String(p.name || "")));
  // the whole edition is the products' editions added up (Warhol: six boxes
  // of 1,000 and the Lifesize 100, 6,100); the release's own edition size
  // stands in when a product has none, and it is what the page's targets
  // use, so the two can differ (the Target setting's 2,440 is the standards'
  // sellout target, not the edition)
  const editionSum = products.length && products.every((p) => num(p.edition) > 0)
    ? products.reduce((n, p) => n + num(p.edition), 0) : null;
  const edition = editionSum || (num(st.edition) > 0 ? num(st.edition) : null);
  const lines = [];

  const sent = today || new Date().toISOString().slice(0, 10);
  const lag = Math.max(0, daysBetween(snap.asOf, sent));
  const of = num(snap.of);
  const day = Math.min(num(snap.day) + lag, of > 0 ? of : Infinity);
  const head = `*${snap.releaseName || snap.id}* - sales update, ${fmtDay(sent)}` +
    (of > 0 ? ` (day ${fmt(day)} of ${fmt(of)})` : "");
  lines.push(head);
  // a target that is only part of the edition is said up front, so the
  // percentages below (of the whole edition) read right
  if (snap.edition && num(snap.edition.total) > num(snap.edition.target)) {
    lines.push(`Target ${fmt(snap.edition.target)} units (${Math.round((100 * num(snap.edition.target)) / num(snap.edition.total))}% of the ${fmt(snap.edition.total)} edition)`);
  }

  // paid
  const soldOf = (p) => num(p.sold) + num(p.soldAssumed);
  const paid = products.length ? products.reduce((n, p) => n + soldOf(p), 0) : num(st.sold);
  lines.push(`Paid = ${fmt(paid)} units` + (edition ? ` (${pct(paid, edition)} of ${fmt(edition)})` : ""));
  products.forEach((p, i) => {
    const e = num(p.edition) > 0 ? num(p.edition) : null;
    lines.push(`• ${names[i]}: ${fmt(soldOf(p))}${e ? `/${fmt(e)}` : ""}`);
  });

  // draw entrants
  const en = entrants(st.patterns);
  if (products.length || en.any) {
    lines.push(`Draw = ${fmt(en.any)} unique entrants` + (en.won ? ` (${fmt(en.won)} won and not yet paid: not counted, their orders are in Drafts)` : ""));
    products.forEach((p, i) => {
      const ih = p.inHand || {};
      lines.push(`• ${names[i]}: ${fmt(ih.open)} open` + (num(ih.won) ? ` + ${fmt(ih.won)} to pay` : ""));
    });
  }

  // drafts
  if (st.drafts !== null && st.drafts !== undefined) {
    lines.push(`Drafts = ${fmt(st.drafts)}`);
    if (products.length) lines.push("• " + products.map((p, i) => `${names[i]}: ${fmt(p.drafts)}`).join(" · "));
  }

  // estimated sell-through as of today: paid + drafts + entries at the rate
  const rate = num(st.conversion) > 0 ? num(st.conversion) : 0.8;
  const preRate = num(st.preorderConversion) > 0 ? num(st.preorderConversion) : rate;
  const rateWords = preRate !== rate
    ? `entries at ${Math.round(rate * 100)}% entry → order, pre-orders at ${Math.round(preRate * 100)}%`
    : `entries at ${Math.round(rate * 100)}% entry → order`;
  lines.push(`Estimated sell-through (${rateWords}, placed by maximum quantity for revenue)`);
  if (products.length) {
    let total = 0;
    products.forEach((p, i) => {
      const today = soldOf(p) + num(p.drafts) + num(p.shown);
      total += today;
      const e = num(p.edition) > 0 ? num(p.edition) : null;
      lines.push(`• ${names[i]}: ~${fmt(today)} units` + (e ? ` → ${pct(today, e)}` : ""));
    });
    lines.push(`Total ~${fmt(total)} units` + (edition ? ` → ${pct(total, edition)} of ${fmt(edition)}` : ""));
  } else {
    const today = num(st.sold) + num(st.drafts) + num(st.soldPredicted);
    lines.push(`~${fmt(today)} units` + (edition ? ` → ${pct(today, edition)} of ${fmt(edition)}` : ""));
  }
  if (Array.isArray(st.incomplete) && st.incomplete.length) {
    lines.push(`_Incomplete data: ${st.incomplete.join(", ")}_`);
  }
  if (lag > 0) lines.push(`_Complete data through ${fmtDay(snap.asOf)}_`);
  if (link) lines.push(`<${link}|Open in Launch Performance>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- posting

const HINTS = {
  channel_not_found: (c) => `Slack cannot find #${c} - check the name; for a private channel invite the bot first`,
  not_in_channel: (c) => `the bot is not in #${c} - invite it to the channel, then post again`,
  is_archived: (c) => `#${c} is archived`,
  invalid_auth: () => "the Slack token is not valid - replace SLACK_BOT_TOKEN",
  token_revoked: () => "the Slack token was revoked - replace SLACK_BOT_TOKEN",
  account_inactive: () => "the Slack app is no longer installed - reinstall it and replace SLACK_BOT_TOKEN",
  missing_scope: () => "the Slack app needs the chat:write scope (and chat:write.public for channels the bot is not in)",
  msg_too_long: () => "the update is too long for one Slack message",
  ratelimited: () => "Slack is rate limiting the app - try again in a minute",
};

async function postMessage(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Slack is not connected - set SLACK_BOT_TOKEN to the app's bot token (README: Posting sell-through to Slack)");
  const isId = /^[CG][A-Z0-9]{8,}$/.test(channel);
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: isId ? channel : `#${channel}`, text, unfurl_links: false, unfurl_media: false }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const code = json.error || `HTTP ${res.status}`;
    const hint = HINTS[code];
    throw new Error(hint ? hint(channel) : `Slack refused the message (${code})`);
  }
  return { ts: json.ts, channel: json.channel };
}

module.exports = { stateFor, setChannel, recordPost, stateWarning, composeSellThrough, shortNames, entrants, postMessage, STATE_PATH };
