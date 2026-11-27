/* The Spend levels card when the snapshot carries no levels (paid.levels,
 * etl/build.py): what the card says in place of a recommendation. The card
 * is on every draw launch with a paid block (12 November 2026); until then
 * it was left out whenever the build had no level to give, which read as a
 * card gone missing. The build gives no level when the last three full days
 * bought no entries (no price of an entry to set one from: paid off, or
 * spend that bought nothing), when the release has closed or is on its last
 * day, and on a release without targets. The reason is read here from what
 * the snapshot already carries, so a page built before this shows it too.
 * The head's figure sits under a small label, the day it was spent on, as
 * the card's two figures do when there is a level (27 November 2026;
 * spentDay names that day for both).
 * Plain JavaScript, no JSX: tests/no_levels.mjs. */
import { fmtMoney } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";
import { stepOf } from "./clock.mjs";

const num = (v) => (Number.isFinite(v) ? v : 0);
const money = (v) => fmtMoney(Math.round(num(v)));
const DAY_MS = 86400000;
const at = (iso) => Date.parse(String(iso).slice(0, 10) + "T00:00:00Z");

/* The day the card's current spend was read on, in words: { label, poss }.
 * The build reads the spend of the last full day (today's is part of a day),
 * and where that day spent nothing while paid still has a level, of the last
 * full day that spent (`spending`). That is yesterday on a page built today,
 * and said as such; a feed a day or more behind gives the day's date, and a
 * snapshot without dated days says what it is, the last full day. */
export function spentDay(snap, spending = false) {
  const daily = snap && snap.paid && Array.isArray(snap.paid.daily) ? snap.paid.daily : [];
  const full = daily.filter((d) => d && !d.partial && d.date);
  let last = full.length ? full[full.length - 1] : null;
  if (last && spending && !(num(last.spend) > 0)) last = [...full].reverse().find((d) => num(d.spend) > 0) || last;
  const n = last && snap.asOf ? Math.round((at(snap.asOf) - at(last.date)) / DAY_MS) : NaN;
  if (n === 1) return { label: "Yesterday", poss: "yesterday's" };
  if (n > 1) {
    const d = new Date(at(last.date)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    return { label: d, poss: `${d}'s` };
  }
  return { label: "Last full day", poss: "the last full day's" };
}

/* { l, v, aside, loz, kind, why }: the head's figure and the small label over
 * it, its aside, the lozenge's word and kind (none: no lozenge) and the note
 * under it */
export function noLevels(snap) {
  const paid = (snap && snap.paid) || {};
  const daily = Array.isArray(paid.daily) ? paid.daily : [];
  const full = daily.filter((d) => d && !d.partial);
  const part = daily.find((d) => d && d.partial) || null;
  const spent = Number.isFinite(paid.spendToDate) ? paid.spendToDate : daily.reduce((a, d) => a + num(d.spend), 0);
  const stepWord = wordsOf(snap).stepWord;
  // the last full day's spend (today's level), and the last day paid spent at all
  const today = full.length ? num(full[full.length - 1].spend) : 0;
  const lastSpent = [...daily].reverse().find((d) => num(d.spend) > 0) || null;
  const lastStep = lastSpent ? stepOf(snap, lastSpent.date) : null;
  const off = today <= 0 && !(part && num(part.spend) > 0) && lastSpent !== null;
  const since = off && lastStep !== null ? `${stepWord} ${Math.round(lastStep)}` : null;
  // the window the price of an entry is read on: the last three full days
  const win = full.slice(-3);
  const s3 = win.reduce((a, d) => a + num(d.spend), 0);
  const e3 = win.reduce((a, d) => a + num(d.entries), 0);
  const head = { l: spentDay(snap).label, v: money(today), aside: since ? `off since ${since}` : "" };

  if (snap && snap.complete) {
    return { l: "Spent in all", v: money(spent), aside: "", loz: "Closed", kind: undefined,
      why: spent > 0 ? "The release has closed: no spend still to come."
        : "The release closed without paid spend." };
  }
  if (!(spent > 0)) {
    return { ...head, aside: "", loz: null,
      why: snap && snap.campaignName ? "No paid spend yet. Levels come once paid has run a full day and bought entries."
        : "No Meta campaign matched: set one on the Targets tab." };
  }
  if (snap && snap.targeted === false) {
    return { ...head, loz: "No targets", kind: undefined,
      why: "No recommendation: set targets and a profit split on the Targets tab." };
  }
  if (win.length && s3 <= 0) {
    return { ...head, loz: "Paid off", kind: "warm",
      why: `No recommendation: paid has spent nothing in the last three days${since ? ` (off since ${since})` : ""}. Levels return once paid runs for a day and buys entries.` };
  }
  if (win.length && e3 <= 0) {
    return { ...head, loz: "No entries in 3 days", kind: "warm",
      why: `No recommendation: the ${money(s3)} spent in the last three days bought no entries.${since ? ` Paid has been off since ${since}.` : ""} Levels return once paid buys entries again.` };
  }
  if ((paid.budget || {}).daysLeft === 0) {
    return { ...head, loz: "Last day", kind: undefined,
      why: "No recommendation: the release is on its last day." };
  }
  return { ...head, loz: null,
    why: "No recommendation yet: it needs three days of entry prices, the profit on a unit and the days left." };
}
