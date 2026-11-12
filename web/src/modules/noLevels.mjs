/* The Spend levels card when the snapshot carries no levels (paid.levels,
 * etl/build.py): what the card says in place of a recommendation. The card
 * is on every draw launch with a paid block (12 November 2026); until then
 * it was left out whenever the build had no level to give, which read as a
 * card gone missing. The build gives no level when the last three full days
 * bought no entries (no price of an entry to set one from: paid off, or
 * spend that bought nothing), when the release has closed or is on its last
 * day, and on a release without targets. The reason is read here from what
 * the snapshot already carries, so a page built before this shows it too.
 * Plain JavaScript, no JSX: tests/no_levels.mjs. */
import { fmtMoney } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";
import { stepOf } from "./clock.mjs";

const num = (v) => (Number.isFinite(v) ? v : 0);
const money = (v) => fmtMoney(Math.round(num(v)));

/* { v, u, aside, loz, kind, why }: the head's figure, its unit and aside,
 * the lozenge's word and kind (none: no lozenge) and the note under it */
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
  const head = { v: money(today), u: "a day today", aside: since ? `off since ${since}` : "" };

  if (snap && snap.complete) {
    return { v: money(spent), u: "spent in all", aside: "", loz: "Closed", kind: undefined,
      why: spent > 0 ? "The release has closed, so there is no spend still to come to set a level for."
        : "The release closed without paid spend." };
  }
  if (!(spent > 0)) {
    return { ...head, aside: "", loz: null,
      why: snap && snap.campaignName ? "No paid spend yet. The spend levels come once paid has run for a full day and bought entries."
        : "No Meta campaign matched to this release: set one on the Targets tab." };
  }
  if (snap && snap.targeted === false) {
    return { ...head, loz: "No targets", kind: undefined,
      why: "No recommendation: the spend levels need targets and a profit split. Set them on the Targets tab." };
  }
  if (win.length && s3 <= 0) {
    return { ...head, loz: "Paid off", kind: "warm",
      why: `No recommendation: paid has spent nothing in the last three days${since ? ` (off since ${since})` : ""}, so there is no recent price of an entry to set a level from. The levels return once paid runs for a day and buys entries.` };
  }
  if (win.length && e3 <= 0) {
    return { ...head, loz: "No entries in 3 days", kind: "warm",
      why: `No recommendation: the ${money(s3)} spent in the last three days bought no entries, so there is no price of an entry to set a level from.${since ? ` Paid has been off since ${since}.` : ""} The levels return once paid buys entries again.` };
  }
  if ((paid.budget || {}).daysLeft === 0) {
    return { ...head, loz: "Last day", kind: undefined,
      why: "No recommendation: the release is on its last day, so there is no full day still to come to set a level for." };
  }
  return { ...head, loz: null,
    why: "No recommendation yet: a level is set from the price of an entry over the last three days, the profit on a unit and the days left, and these are not all there." };
}
