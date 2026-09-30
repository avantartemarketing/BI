/* The header's freshness line (shared/freshness.mjs): the page's own age
 * first, the pipeline's health second, so a page rebuilt an hour ago never
 * reads "stale" because a later step of the refresh failed.
 *
 *   node tests/freshness.mjs
 */
import assert from "node:assert";
import { freshness, whenWords } from "../shared/freshness.mjs";

const now = new Date(2026, 8, 30, 9, 30);                 // 30 Sep 2026, 09:30 local
const iso = (y, m, d, hh, mm) => new Date(y, m, d, hh, mm).toISOString();
const ok = { running: false, at: iso(2026, 8, 30, 8, 46), ok: true, failingSince: null, etlPagesFailed: 0, etlFailedPages: [],
  bigquery: "funnel 436052 rows", sheet: "skipped - BigQuery is the source", emails: "hubspot 3820 emails", notion: "notion 450 posts",
  airtable: "airtable 2217 records", etl: "wrote 9 targeted + 361 actuals-only + 7 upcoming releases" };
const page = { asOf: "2026-09-30", partial: true, builtAt: iso(2026, 8, 30, 8, 46), emailThrough: "2026-09-29", now };

// a page built this morning from today's data, everything healthy: neutral, no warning
let f = freshness({ ...page, st: ok });
assert.strictEqual(f.tone, "neutral");
assert.strictEqual(f.warn, false);
assert.ok(f.label.startsWith("Data through 2026-09-30 (today so far) · built "), f.label);
assert.ok(!/stale|failing|not built/.test(f.label), f.label);
assert.strictEqual(f.head, "This page is current");

// the same page while the refresh has been failing since last night (28 Sep's
// case): the page is current, the pipeline is not - amber, and it says since when
const failing = { ...ok, ok: false, failingSince: iso(2026, 8, 29, 22, 8), etl: "etl failed: build.py failed: OSError: [Errno 36] File name too long" };
f = freshness({ ...page, st: failing });
assert.strictEqual(f.tone, "amber");
assert.strictEqual(f.warn, false, "a current page is never red over the pipeline");
assert.ok(f.label.includes("refresh failing since") && f.label.includes("yesterday"), f.label);
assert.strictEqual(f.head, "This page is current, the refresh is failing");
assert.ok(f.body.includes("will not move until that is fixed"), f.body);
assert.ok(f.rows.some((r) => r.label === "ETL" && /File name too long/.test(r.value)), "the feed lines are the diagnosis");

// a page whose data is days behind is red whatever the pipeline says
f = freshness({ ...page, asOf: "2026-09-27", partial: false, st: ok });
assert.strictEqual(f.tone, "red");
assert.strictEqual(f.warn, true);
assert.strictEqual(f.ageDays, 3);
assert.strictEqual(f.head, "This page is 3 days behind");
// through yesterday is normal until the first refresh of the day
f = freshness({ ...page, asOf: "2026-09-29", partial: false, st: ok });
assert.strictEqual(f.tone, "neutral");

// a page that did not build on the last refresh: the build went on without
// it, the index was written, and the header says how many
// a page the funnel has no rows under: its own note first, amber, with the build's words in the popup
f = freshness({ ...page, st: ok, funnelNote: "The funnel has no rows under 'Andy Warhol Estate · Multiple · 2026 Q3'. Nothing in the funnel is in the same words in another quarter." });
assert.strictEqual(f.tone, "amber");
assert.ok(f.label.includes("no funnel rows under this name"), f.label);
assert.strictEqual(f.head, "This page is current, the funnel has no rows under its name");
assert.ok(f.body.startsWith("The funnel has no rows under 'Andy Warhol Estate · Multiple · 2026 Q3'.") && f.body.includes("no actuals until a funnel release attaches"), f.body);
f = freshness({ ...page, st: ok, funnelNote: null });
assert.strictEqual(f.tone, "neutral");

f = freshness({ ...page, st: { ...ok, etlPagesFailed: 1, etlFailedPages: ["andy_warhol_brillo_box_collectable_2026_q4"] } });
assert.strictEqual(f.tone, "amber");
assert.ok(f.label.includes("1 page not built"), f.label);
assert.ok(f.body.includes("andy_warhol_brillo_box_collectable_2026_q4"), f.body);
f = freshness({ ...page, st: { ...ok, etlPagesFailed: 3, etlFailedPages: ["a", "b", "c"] } });
assert.ok(f.label.includes("3 pages not built"), f.label);

// a side feed failing leaves the page current, named and amber
f = freshness({ ...page, st: { ...ok, ok: false, emails: "hubspot failed: 401" } });
assert.strictEqual(f.tone, "amber");
assert.ok(f.label.includes("Email failed") && !f.label.includes("refresh failing"), f.label);
assert.strictEqual(f.head, "This page is current, email failed");

// a feed with no token is named, muted, never amber
f = freshness({ ...page, st: { ...ok, notion: "notion off (no NOTION_TOKEN)" } });
assert.strictEqual(f.tone, "neutral");
assert.ok(f.label.endsWith("· notion off"), f.label);

// the email feed a week or more behind the build
f = freshness({ ...page, emailThrough: "2026-09-20", st: ok });
assert.strictEqual(f.tone, "amber");
assert.ok(f.label.includes("emails through 2026-09-20"), f.label);

// before the status has loaded, after a deploy, and when it cannot be read
f = freshness({ ...page, st: undefined });
assert.strictEqual(f.tone, "neutral");
assert.ok(f.label.endsWith("· checking the refresh"), f.label);
f = freshness({ ...page, st: { running: true, runningSince: iso(2026, 8, 30, 9, 29) } });
assert.strictEqual(f.tone, "neutral");
assert.ok(f.label.endsWith("· refreshing"), f.label);
f = freshness({ ...page, st: null });
assert.strictEqual(f.tone, "amber");
assert.ok(f.label.endsWith("· refresh status unknown"), f.label);

// a page built before builtAt existed: no build time, nothing else changes
f = freshness({ ...page, builtAt: undefined, st: ok });
assert.ok(!f.label.includes("built"), f.label);
assert.strictEqual(f.tone, "neutral");

// the moment words: a time today, "yesterday", else the day
assert.ok(!/yesterday|Sep/.test(whenWords(iso(2026, 8, 30, 8, 46), now)));
assert.ok(whenWords(iso(2026, 8, 29, 22, 8), now).endsWith(" yesterday"));
assert.ok(/Sep/.test(whenWords(iso(2026, 8, 27, 22, 8), now)));

console.log("freshness: header states ok");
