/* The header's freshness line (App.jsx Freshness), as one rule the tests can
 * run (tests/freshness.mjs).
 *
 * The line used to read the refresh's failure flag alone, so a page rebuilt
 * an hour ago read "Sources stale" because a later step of the hourly refresh
 * had failed (28 September 2026: every release page was built with the day's
 * data, the build then died on one upcoming page, and the header was red all
 * evening over fresh figures). Two different questions are answered apart:
 *
 *   - is this page's data old? Read off the page itself: the day its data
 *     runs to and when it was built. Red only when the data is two or more
 *     days behind, the same rule as the banner under the header.
 *   - is the pipeline healthy? Read off the refresh status: a failing
 *     refresh (with when the trouble started), a page that did not build, a
 *     side feed that failed, a feed with no token. Amber, never red, because
 *     none of it says the figures on screen are wrong.
 *
 * `st` is GET /api/refresh/status: undefined while loading, null when it could
 * not be read, else {running, runningSince, at, ok, failingSince,
 * etlPagesFailed, etlFailedPages, bigquery, sheet, emails, notion, airtable,
 * etl}. `now` is injectable for the tests. */

const CORE = new Set(["BigQuery", "Sheet", "ETL"]);
const FAILED = /failed|misconfigured|stale/i;
const OFF = / off \(/;

const dayMs = 86400000;
const startOfDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

/* A clock time when the moment is today, else the day and the time. */
export function whenWords(iso, now = new Date()) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const time = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((startOfDay(now) - startOfDay(t)) / dayMs);
  if (days === 0) return time;
  if (days === 1) return `${time} yesterday`;
  return `${t.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function freshness({ asOf, partial, builtAt, st, emailThrough, funnelNote, now = new Date() }) {
  const feeds = st ? [["BigQuery", st.bigquery], ["Sheet", st.sheet], ["Email", st.emails],
    ["Notion", st.notion], ["Airtable", st.airtable], ["ETL", st.etl]]
    .filter(([, v]) => v !== undefined && v !== null) : [];
  const failed = feeds.filter(([, v]) => FAILED.test(String(v))).map(([k]) => k);
  const coreFailed = st && st.ok === false && (failed.some((k) => CORE.has(k)) || !failed.length);
  const sideFailed = st && st.ok === false && !coreFailed ? failed : [];
  const dormant = feeds.filter(([, v]) => OFF.test(String(v))).map(([k]) => k.toLowerCase());
  const pagesFailed = st ? Number(st.etlPagesFailed || 0) : 0;
  const running = !!(st && st.running);

  // the page's own age, in whole days on the reader's calendar
  const ageDays = asOf ? Math.round((startOfDay(now) - Date.parse(asOf + "T00:00:00Z")) / dayMs) : null;
  const behind = ageDays !== null && ageDays >= 2;
  const day = (s) => Date.parse(s + "T00:00:00Z");
  const emailLag = asOf && emailThrough ? Math.round((day(asOf) - day(emailThrough)) / dayMs) : null;
  const emailBehind = emailLag !== null && emailLag > 7;

  const data = asOf ? `Data through ${asOf}${partial ? " (today so far)" : ""}` : "No data date on this page";
  const built = builtAt ? `built ${whenWords(builtAt, now)}` : null;

  // the notes after the data words, the amber ones first: this page's own
  // (the funnel has no rows under its name, so its actuals cannot attach),
  // then the pipeline's
  const notes = [];
  if (funnelNote) notes.push({ text: "no funnel rows under this name", tone: "amber" });
  if (st === undefined) notes.push({ text: "checking the refresh", tone: "muted" });
  else if (running && !st.at) notes.push({ text: "refreshing", tone: "muted" });
  else if (st === null || !st.at) notes.push({ text: "refresh status unknown", tone: "amber" });
  else {
    if (coreFailed) notes.push({ text: `refresh failing since ${whenWords(st.failingSince || st.at, now)}`, tone: "amber" });
    if (sideFailed.length) notes.push({ text: `${sideFailed.join(" and ")} failed`, tone: "amber" });
    if (pagesFailed > 0) notes.push({ text: `${pagesFailed} page${pagesFailed === 1 ? "" : "s"} not built`, tone: "amber" });
    if (emailBehind) notes.push({ text: `emails through ${emailThrough}`, tone: "amber" });
    if (dormant.length) notes.push({ text: `${dormant.join(" and ")} off`, tone: "muted" });
    if (running) notes.push({ text: "refreshing", tone: "muted" });
  }
  const tone = behind ? "red" : notes.some((n) => n.tone === "amber") ? "amber" : "neutral";
  const label = [data, built, ...notes.map((n) => n.text)].filter(Boolean).join(" · ");

  // the popup: the page first, the pipeline second, then the feed lines
  const clock = (iso) => new Date(iso).toLocaleString();
  const head = behind ? `This page is ${ageDays} days behind`
    : funnelNote ? "This page is current, the funnel has no rows under its name"
    : coreFailed ? "This page is current, the refresh is failing"
    : pagesFailed > 0 ? "This page is current, some pages did not build"
    : sideFailed.length ? `This page is current, ${sideFailed.join(" and ").toLowerCase()} failed`
    : "This page is current";
  let body;
  if (st === undefined) body = "Reading the refresh status.";
  else if (running && !st.at) body = `A refresh started ${new Date(st.runningSince).toLocaleTimeString()} is still running; the first one after a deploy takes several minutes.`;
  else if (st === null || !st.at) body = "The dashboard has not been able to read the refresh status.";
  else {
    body = `Last refresh attempt ${clock(st.at)}.`;
    if (coreFailed) body += ` The hourly refresh has been failing since ${whenWords(st.failingSince || st.at, now)}, so this page will not move until that is fixed; the figures on it are from its last successful build.`;
    if (pagesFailed > 0) body += ` ${pagesFailed} page${pagesFailed === 1 ? "" : "s"} failed to build on the last refresh and kept ${pagesFailed === 1 ? "its" : "their"} previous figures` +
      (Array.isArray(st.etlFailedPages) && st.etlFailedPages.length ? `: ${st.etlFailedPages.join(", ")}.` : ".");
    if (running) body += ` A refresh started ${new Date(st.runningSince).toLocaleTimeString()} is running now.`;
  }
  if (funnelNote) body = `${funnelNote} The page shows its plan with no actuals until a funnel release attaches. ${body}`;
  const rows = [
    ...(builtAt ? [{ label: "Page built", value: clock(builtAt) }] : []),
    ...(emailThrough ? [{ label: "Emails through", value: emailThrough, color: emailBehind ? "#8a5f00" : undefined }] : []),
    ...feeds.map(([k, v]) => ({ label: k, value: String(v) })),
  ];
  return { label, tone, warn: behind, head, body, rows, ageDays, notes };
}

export const TONE_COLOR = { red: "#b8461d", amber: "#8a5f00", neutral: "#6c6b68" };
