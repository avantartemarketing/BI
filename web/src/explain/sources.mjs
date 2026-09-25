/* The data sources an explanation names under "Where it comes from", each
 * with how fresh it is on this page. A feed pulled on every refresh reads
 * "to 24 Sep" off the snapshot's own dates and carries a green dot; an input
 * somebody set (the Target setting tab, Airtable, the basket) reads as set,
 * with a grey dot. Where the last refresh reported the feed behind it failing
 * (the header's Freshness line reads the same status), the dot turns amber
 * and says so. Plain JavaScript, so the tests can read it. */
import { fmtDay } from "../format.mjs";

const day = (iso) => (iso ? fmtDay(new Date(String(iso).slice(0, 10) + "T00:00:00Z")) : null);
const FAILED = /failed|misconfigured|stale/i;

/* The last day of the Meta spend on the page: the last row of paid.daily
 * with spend on it (the as-of day so far rides last, marked partial). */
function lastSpend(s) {
  const rows = (s.paid && s.paid.daily) || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i].spend ?? 0) > 0) return rows[i];
  }
  return null;
}

const partialDay = (s) => typeof s.asOfFraction === "number" && s.asOfFraction < 1;

export const SOURCES = {
  orders: {
    name: "Shopify orders", via: "BigQuery · Order_Line_Concept", feed: "bigquery",
    fresh: (s) => {
      const d = (s.sellthrough && s.sellthrough.ordersAsOf) || (s.framing && s.framing.asOf) || s.asOf;
      return d ? `to ${day(d)}` : null;
    },
  },
  funnel: {
    name: "Funnel report", via: "BigQuery · LE Funnel Report", feed: "bigquery",
    fresh: (s) => (partialDay(s) && s.completeThrough
      ? `complete to ${day(s.completeThrough)}, ${day(s.asOf)} so far`
      : s.asOf ? `to ${day(s.asOf)}` : null),
  },
  entries: {
    name: "Draw entries", via: "BigQuery · LE Funnel Report events", feed: "bigquery",
    fresh: (s) => (s.asOf ? `to ${day(s.asOf)}` : null),
  },
  meta: {
    name: "Meta ads", via: "BigQuery · Meta ads insights", feed: "bigquery",
    fresh: (s) => {
      const r = lastSpend(s);
      if (!r) return s.asOf ? `to ${day(s.asOf)}` : null;
      return r.partial ? `to ${day(r.date)}, so far` : `to ${day(r.date)}`;
    },
  },
  hubspot: {
    name: "HubSpot emails", via: "HubSpot marketing sends", feed: "emails",
    fresh: (s) => (s.email && s.email.feedThrough ? `sends to ${day(s.email.feedThrough)}` : null),
  },
  social: {
    name: "Social posts",
    via: (s) => (s.social && s.social.postsSource === "notion" ? "Notion content log" : "Emplifi export"),
    feed: (s) => (s.social && s.social.postsSource === "notion" ? "notion" : null),
    fresh: (s) => (s.asOf ? `to ${day(s.asOf)}` : null),
  },
  airtable: {
    name: "Airtable", via: "Pipeline table", feed: "airtable",
    set: "set in Airtable",
  },
  settings: {
    name: "Target setting", via: "This dashboard's tab",
    set: "set here",
  },
  basket: {
    name: "Comparable launches",
    via: (s) => {
      const b = s.benchmark && s.benchmark.basket;
      return b ? `The basket "${b.name}", ${b.n} launches` : "The benchmark basket";
    },
    set: "chosen here",
  },
  curves: {
    name: "Past launches", via: "The basket's across-time curves",
    set: "fitted",
  },
  rules: {
    name: "Spend rules", via: "The LE Paid Calculator's rules",
    set: "fixed",
  },
  dates: {
    name: "Campaign dates",
    via: (s) => {
      const how = s.inputSources && s.inputSources.announce_date;
      return how === "notion" ? "The Notion campaign log"
        : how === "typed" ? "Typed on the Target setting tab"
        : how === "airtable" ? "Airtable's planned dates"
        : "The funnel export's campaign clock";
    },
    set: "set",
  },
};

/* One source as the panel shows it: its name, where it is read from, what it
 * gave this figure, and either its freshness or how it was set. */
export function sourceRow({ key, gave }, snap, st) {
  const src = SOURCES[key];
  if (!src) return { name: key, via: "", gave, fresh: null, set: null, warn: null };
  const s = snap || {};
  const via = typeof src.via === "function" ? src.via(s) : src.via;
  const feed = typeof src.feed === "function" ? src.feed(s) : src.feed;
  const status = feed && st ? st[feed] : null;
  const warn = status && FAILED.test(String(status)) ? "last refresh failed" : null;
  return {
    name: src.name, via, gave,
    fresh: src.fresh ? src.fresh(s) : null,
    set: src.set || null,
    warn,
  };
}
