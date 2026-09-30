/* The incremental pull's rename check (server/bigquery.js renamedOutsideOverlap).
 * An incremental pull keeps the local rows older than the overlap, so a release
 * renamed upstream keeps its old name on them and the build lists it twice:
 * Roy Lichtenstein Estate's quarter, corrected from 2027 Q4 to 2026 Q4 on 30
 * September 2026, sat in the sidebar as two rows. BigQuery is not reachable
 * from a test, so this reads the two decisions and the queries' text.
 *   node tests/rename_outside_overlap.mjs */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bq = require(path.join(here, "..", "server", "bigquery.js"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const OLD = "Roy Lichtenstein Estate · Multiple · 2027 Q4", NEW = "Roy Lichtenstein Estate · Multiple · 2026 Q4";
const set = (...xs) => new Set(xs);

// the Lichtenstein case at the first pull after the rename: the old name stood in
// the local overlap rows and still stands on the July row, the re-pull carries the new one
check(same(bq.renamedOutsideOverlap(set(OLD, "Parra · Multiple · 2024 Q4"), set(OLD, "Ai Weiwei · Multiple · 2026 Q4"), set(NEW, "Ai Weiwei · Multiple · 2026 Q4")), [OLD]),
  "a name gone from the overlap while older rows carry it is flagged");
// a release wholly inside the overlap is re-pulled whole: renamed or not, nothing lingers
check(same(bq.renamedOutsideOverlap(set("Parra · Multiple · 2024 Q4"), set("Loie Hollowell · Mother's Milk · 2026 Q4"), set("Loie Hollowell · Mother's Milk · 2027 Q1")), []),
  "a release with no row older than the overlap is not flagged");
// a release that ended before the overlap has nothing to vanish from
check(same(bq.renamedOutsideOverlap(set("Parra · Multiple · 2024 Q4"), set(NEW), set(NEW)), []), "a release only in the kept rows is not flagged here");
// nothing changed: the overlap's names come back
check(same(bq.renamedOutsideOverlap(set(OLD), set(OLD), set(OLD)), []), "an unchanged name is not flagged");
// empty names never count
check(same(bq.renamedOutsideOverlap(set("", OLD), set("", OLD), set(NEW)), [OLD]), "empty names are ignored");

// the daily reading: the kept rows' names against upstream's, the Lichtenstein state a week later
check(same(bq.namesMissingUpstream(set(OLD, "Parra · Multiple · 2024 Q4"), set(NEW, "Parra · Multiple · 2024 Q4")), [OLD]), "a kept name upstream no longer has is flagged");
check(same(bq.namesMissingUpstream(set(NEW, "Parra · Multiple · 2024 Q4"), set(NEW, "Parra · Multiple · 2024 Q4", "Someone · New · 2026 Q4")), []), "names upstream still has are not");

// when the daily reading runs
const now = "2026-09-30T14:00:00.000Z";
check(bq.namesCheckDue({}, now), "never checked: due");
check(bq.namesCheckDue({ namesCheckedAt: "not a date" }, now), "an unreadable stamp: due");
check(!bq.namesCheckDue({ namesCheckedAt: "2026-09-30T12:30:00.000Z" }, now), "checked 90 minutes ago: not due");
check(bq.namesCheckDue({ namesCheckedAt: "2026-09-29T13:00:00.000Z" }, now), "checked 25 hours ago: due");
check(bq.namesCheckDue({ namesCheckedAt: "2026-09-30T12:30:00.000Z" }, now, 1), "the cadence can be set (BQ_NAMES_CHECK_HOURS)");
check(bq.NAMES_CHECK_HOURS === 24, `the default cadence is a day (${bq.NAMES_CHECK_HOURS})`);

// what the note says
const one = bq.describeNames([OLD], "left the last 45 days upstream while older local rows still carry");
check(one.startsWith(`1 release name left the last 45 days upstream while older local rows still carry it ("${OLD}")`) && /renamed or removed upstream outside the \d+-day overlap$/.test(one), `the note names the release: ${one}`);
const many = bq.describeNames(["A", "B", "C", "D", "E"], "upstream no longer has before the overlap, where older local rows still carry");
check(many.startsWith('5 release names upstream no longer has before the overlap, where older local rows still carry them ("A", "B", "C" and 2 more)'), `several names are counted: ${many}`);
check(!(one + many).includes(String.fromCharCode(8212)), "no em dash in the notes");

// the queries: one column, the rows before the overlap, the feed's own table and filter, no address column
const fn = bq.FUNNEL_FEED.namesSql(), br = bq.BROWSING_FEED.namesSql();
check(fn === bq.funnelNamesSql() && br === bq.browsingNamesSql(), "each incremental feed carries its names query");
check(/^SELECT DISTINCT simple_release_name FROM `[^`]+`\n/.test(fn) && /^SELECT DISTINCT simple_release_name FROM `[^`]+`\n/.test(br), "one column, distinct");
check(fn.includes(bq.EVENTS_TABLE) === false && br.includes(bq.EVENTS_TABLE), "the export's names come from the export, the browsing names from the event table");
check(/event_date >= @since AND event_date < @before/.test(fn) && /event_date >= @since AND event_date < @before/.test(br), "the rows before the overlap, inside the history window");
check(/event_name IN \('page_view', 'session_start'\)/.test(br) && !/event_name/.test(fn), "the browsing filter is the browsing feed's own");
check(/simple_release_name IS NOT NULL/.test(fn) && /simple_release_name IS NOT NULL/.test(br), "no empty name");
check(!/user_email|customer_email|SELECT \*/.test(fn + br), "no address column, no SELECT *");

if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("rename outside overlap: ok");
