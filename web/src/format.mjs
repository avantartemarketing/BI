/* Number and date formatting, and the day arithmetic the cards share. Plain
 * JavaScript with no JSX, so the explainer's builders (web/src/explain) and
 * the tests can import it as well as the cards; ui.jsx re-exports all of it,
 * so a card imports these from there as before. */
export const MINUS = "−";

/* Days of the window seen so far, with the part day counted for the share of
 * it observed (snapshot asOfFraction; 1 on a full day and once the window has
 * closed). The pro-rata references - the budget by today, the posts by today -
 * read this rather than `day`, which is the day in progress. */
export const dayElapsed = (snap) => Math.max(0, (snap?.day ?? 0) - (1 - (snap?.asOfFraction ?? 1)));
/* The share of the paid plan due by today: paid runs from the day after the
 * announce (paid.paidStartDays, 1) to the close, and its budget is planned
 * evenly over those days, so days elapsed less the first, over the paid
 * days, is the share of it that should be spent and bought (docs 7). At
 * close the whole of it. */
export const paidDayFrac = (snap, close = false) => {
  if (close) return 1;
  const start = snap?.paid?.paidStartDays ?? 1;
  const span = (snap?.of ?? 0) - start;
  if (!(span > 0)) return 1;
  return Math.min(1, Math.max(0, (dayElapsed(snap) - start) / span));
};

export function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const v = Number(n);
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return v < 0 ? MINUS + s : s;
}

export function fmtSigned(n, digits = 0) {
  if (n === null || n === undefined) return "–";
  return (n >= 0 ? "+" : MINUS) + fmt(Math.abs(n), digits);
}

export function fmtMoney(n, digits = 0) {
  if (n === null || n === undefined) return "–";
  return (n < 0 ? MINUS : "") + "€" + fmt(Math.abs(n), digits);
}

export function fmtK(n) {
  if (n === null || n === undefined) return "–";
  return Math.abs(n) >= 10000 ? fmt(n / 1000, 1) + "k" : fmt(n);
}

export function fmtPct(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  return fmt(x * 100, digits) + "%";
}

/* "17 Sep" or "Mon 17 Sep". Dates in the snapshots are ISO days read as UTC
 * midnight, so the browser's zone never moves them across a day boundary; the
 * names are spelt here because en-GB locales write "Sept". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const fmtDay = (d, weekday = false) =>
  `${weekday ? WEEKDAYS[d.getUTCDay()] + " " : ""}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/* The calendar day a day of the window is. The ETL counts days from the
 * announce (snap.windowStart): day 0 is the announce day, snap.day is the
 * as-of day, snap.of is the close, and the daily arrays are indexed the same
 * way, so day N is windowStart + N days. Null on a snapshot without a window. */
export const windowDate = (snap, day) => {
  if (!snap || !snap.windowStart || !(day >= 0)) return null;
  const t = Date.parse(snap.windowStart + "T00:00:00Z");
  return Number.isFinite(t) ? new Date(t + day * 86400000) : null;
};

/* A day of the window named by its date, with the day number after it: a day
 * number alone only reads against the campaign clock, a date reads on its
 * own. "Mon 21 Sep · day 18"; "day 18" when the window has no start. */
export const dayLabel = (snap, day, weekday = false) => {
  const d = windowDate(snap, day);
  return d ? `${fmtDay(d, weekday)} · day ${day}` : `day ${day}`;
};

/* The date alone for an axis end, falling back to the day number. */
export const dayAxisLabel = (snap, day) => {
  const d = windowDate(snap, day);
  return d ? fmtDay(d) : `day ${day}`;
};
