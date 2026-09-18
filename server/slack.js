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
 * a release without targets can have a channel too. Posting needs a Slack app
 * bot token in SLACK_BOT_TOKEN (scopes chat:write and chat:write.public; for
 * a private channel invite the bot first). README "Posting sell-through to
 * Slack" has the setup. The token stays in the environment: nothing here
 * logs it or writes it anywhere. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATE_PATH = process.env.SLACK_STATE_PATH || path.join(ROOT, "data", "slack.json");
const API = process.env.SLACK_API || "https://slack.com/api/chat.postMessage";
const CHANNEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

// ---------------------------------------------------------------- the channel per release

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) || {}; } catch { return {}; }
}
function writeState(doc) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, STATE_PATH);
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

/* The update as Slack mrkdwn: the sales team's own layout, from the snapshot. */
function composeSellThrough(snap, { link } = {}) {
  const st = (snap && snap.sellthrough) || {};
  const products = Array.isArray(st.products) ? st.products : [];
  const names = shortNames(products.map((p) => String(p.name || "")));
  const edition = num(st.edition) > 0 ? num(st.edition) : null;
  const lines = [];

  const head = `*${snap.releaseName || snap.id}* - sales update, ${fmtDay(snap.asOf)}` +
    (num(snap.of) > 0 ? ` (day ${fmt(snap.day)} of ${fmt(snap.of)})` : "");
  lines.push(head);

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
    lines.push(`Draw = ${fmt(en.any)} unique entrants` + (en.won ? ` (${fmt(en.won)} with a win to pay)` : ""));
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
  lines.push(`Estimated sell-through (entries at ${Math.round(rate * 100)}% entry → order, placed by maximum quantity)`);
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

module.exports = { stateFor, setChannel, recordPost, composeSellThrough, shortNames, entrants, postMessage, STATE_PATH };
