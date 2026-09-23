/* The reload rule: a refresh that lands while the page is open re-fetches it,
 * and one that landed before the page loaded does not. */
import { initial, step } from "../shared/refreshWatch.mjs";
import assert from "node:assert";

const run = (statuses) => {
  let state = initial();
  const reloads = [];
  for (const st of statuses) {
    const r = step(state, st);
    state = r.state;
    reloads.push(r.reload);
  }
  return reloads;
};

const IDLE = (at) => ({ running: false, at });
const RUNNING = (at) => ({ running: true, at });
const BOOTING = { running: false };        // process up, no refresh recorded yet

// an ordinary load: a refresh finished before the page arrived, so nothing to do
assert.deepStrictEqual(run([undefined, IDLE("t1")]), [false, false], "ordinary load must not re-fetch");
assert.deepStrictEqual(run([undefined, IDLE("t1"), IDLE("t1")]), [false, false, false], "a repeated status must not re-fetch");

// the hourly case: the page is open and a refresh runs to completion
assert.deepStrictEqual(run([IDLE("t1"), RUNNING("t1"), IDLE("t2")]), [false, false, true], "a refresh seen running must re-fetch when it lands");
// ... and the same run falling entirely between two polls
assert.deepStrictEqual(run([IDLE("t1"), IDLE("t2")]), [false, true], "a moved timestamp must re-fetch");

// the deploy case, which the previous rule missed: no refresh has ever
// completed in this process, so the first one to land is newer than the page
assert.deepStrictEqual(run([RUNNING(undefined), IDLE("t1")]), [false, true], "the first refresh after a deploy must re-fetch");
assert.deepStrictEqual(run([BOOTING, IDLE("t1")]), [false, true], "a refresh that starts and lands between polls must re-fetch");
assert.deepStrictEqual(run([BOOTING, RUNNING(undefined), RUNNING(undefined), IDLE("t1")]), [false, false, false, true], "one re-fetch, when it lands");

// and having landed, it does not keep re-fetching
assert.deepStrictEqual(run([RUNNING(undefined), IDLE("t1"), IDLE("t1"), IDLE("t1")]), [false, true, false, false], "a landed refresh re-fetches once");

// no status at all (the endpoint unreachable) changes nothing
assert.deepStrictEqual(run([IDLE("t1"), null, undefined, IDLE("t1")]), [false, false, false, false], "an unreadable status must not re-fetch");

console.log("refresh watch: 9 cases ok");
