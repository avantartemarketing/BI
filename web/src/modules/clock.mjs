/* The campaign clock as the day-by-day cards draw it: the x axis ticks for
 * a run of N steps (days from the announce, or hours from the sales open on
 * a timed launch inside its window), and the step a dated row of the
 * snapshot sits on. Shared by the trajectory and the two paid cards so the
 * three axes read the same way. Plain JavaScript, no JSX. */
import { dayAxisLabel } from "../format.mjs";
import { hourClock } from "../vocab.mjs";

const DAY_MS = 86400000, HOUR_MS = 3600000;

/* [[index, label]] for an axis that runs 0..last: the first step, every
 * week or so, and the last; on an hour clock every 6 or 12 hours. */
export function stepTicks(snap, last) {
  if (!(last > 0)) return [[0, dayAxisLabel(snap, 0)]];
  const hours = hourClock(snap);
  const step = hours ? (last > 36 ? 12 : 6) : last <= 12 ? 3 : last <= 40 ? 7 : last <= 100 ? 14 : 30;
  const out = [];
  for (let i = 0; i < last - step * 0.6; i += step) out.push(i);
  out.push(last);
  return out.map((i) => [i, hours ? (i === 0 ? "Hour 0" : String(i)) : dayAxisLabel(snap, i)]);
}

/* The step a dated row sits on: days from the announce (snap.windowStart),
 * or hours from the clock's start inside a timed launch's window, where a
 * whole day of spend is read at its middle hour. Null without a clock. */
export function stepOf(snap, dateStr) {
  if (!snap || !dateStr) return null;
  const t = Date.parse(String(dateStr).length > 10 ? dateStr : dateStr + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  if (hourClock(snap) && snap.clock && snap.clock.start) {
    const t0 = Date.parse(snap.clock.start);
    return Number.isFinite(t0) ? (t - t0) / HOUR_MS + 12 : null;
  }
  if (!snap.windowStart) return null;
  const t0 = Date.parse(snap.windowStart + "T00:00:00Z");
  return Number.isFinite(t0) ? Math.round((t - t0) / DAY_MS) : null;
}
