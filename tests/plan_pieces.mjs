/* The plan's pieces read apart for the table (web/src/planPieces.mjs): the
 * channel from the piece's sender, what it is without the sender, where it
 * stands and how much of its plan it has brought; and the rows the table
 * shows before it folds. The names are the build's own, as they stood on the
 * live pages of 27 November 2026 (Seth Armstrong, Ai Weiwei).
 * node tests/plan_pieces.mjs */
import assert from "node:assert";
import { CHANNELS, describe, foldAt, ROWS_SHOWN } from "../web/src/planPieces.mjs";

const asOf = "2026-11-27";
const piece = (name, who, date, exp = 0, inn = 0) => ({ name, who, date, exp, inn });
const read = (...a) => describe(piece(...a), asOf);

// ---- an email keeps its words (they say who it went to), on the page's own email channel
assert.deepStrictEqual(read("Email to 5,401 people", "email", "2026-11-04", 24, 10), { channel: "email", what: "Email to 5,401 people", state: "sent", share: 10 / 24 });
assert.strictEqual(read("Email to 1,774 (Resend Artist and Editions)", "email", "2026-10-30").what, "Email to 1,774 (Resend Artist and Editions)");
assert.strictEqual(CHANNELS.email.name, "AA Email");
// ... one still to come says so in its mark, not in its words
assert.deepStrictEqual(read("Email to 5,000 people, planned", "email", "2026-12-02", 3, 0), { channel: "email", what: "Email to 5,000 people", state: "to come", share: 0 });
assert.strictEqual(read("Email, audience not set", "email", "2026-11-27", 1, 0).state, "to come");

// ---- a post loses its sender to the Channel column, and its count comes first
assert.deepStrictEqual(read("Avant Arte posts and stories (6)", "aa", "2026-11-06", 6, 12), { channel: "aa", what: "6 posts and stories", state: "sent", share: 1 });
assert.strictEqual(read("Avant Arte stories (2)", "aa", "2026-12-02", 2, 0).what, "2 stories");
assert.strictEqual(read("Avant Arte story", "aa", "2026-11-19", 0, 2).what, "Story");
assert.strictEqual(read("Coming soon stories (3)", "aa", "2026-10-28", 3, 0).what, "3 coming soon stories");
assert.strictEqual(read("Coming soon story", "aa", "2026-10-28").what, "Coming soon story");
assert.strictEqual(read("Artist post and story", "artist", "2026-11-12", 2, 1).what, "Post and story");
assert.strictEqual(read("Artist posts and stories (3)", "artist", "2026-11-12").what, "3 posts and stories");
assert.strictEqual(read("Artist's own email", "artist", "2026-11-04", 1, 12).what, "Email");
assert.strictEqual(read("Partner posts (2)", "other", "2026-11-06").what, "2 posts");
assert.strictEqual(CHANNELS.other.name, "Partner");
// a pair of the two kinds is one of each, and reads as the artist's pair does
assert.strictEqual(read("Avant Arte posts and stories (2)", "aa", "2026-11-12", 2, 1).what, "Post and story");

// ---- where a piece stands
assert.strictEqual(read("Artist post and story", "artist", "2026-12-02", 2, 0).state, "to come");   // its day is ahead of the page's
assert.strictEqual(read("Artist post and story", "artist", "2026-11-27", 2, 0).state, "sent");      // today's has gone
assert.deepStrictEqual(read("Artist post and story (dropped)", "artist", "2026-10-30", 8, 0), { channel: "artist", what: "Post and story", state: "dropped", share: 0 });
// ... and how much of its plan it has brought: never over the whole, and the whole with no plan and something in
assert.strictEqual(read("Avant Arte story", "aa", "2026-11-19", 0, 2).share, 1);
assert.strictEqual(read("Avant Arte story", "aa", "2026-11-19", 0, 0).share, 0);
assert.strictEqual(read("Artist post and story", "artist", "2026-11-12", 2, 1).share, 0.5);

// ---- a phase's last lines have no day: to come until something is in, and no sender
assert.deepStrictEqual(describe({ name: "Search, direct and later arrivals", who: "tail", tail: true, exp: 5, inn: 5 }, asOf), { channel: "tail", what: "Search, direct and later arrivals", state: "sent", share: 1 });
assert.strictEqual(describe({ name: "Search, direct and later arrivals", who: "tail", tail: true, exp: 0, inn: 0 }, asOf).state, "to come");
assert.deepStrictEqual(describe({ name: "€493 a day to the close", who: "paid", exp: 4, inn: 0 }, asOf), { channel: "paid", what: "€493 a day to the close", state: "to come", share: 0 });
assert.strictEqual(describe({ name: "€2,062 spent so far", who: "paid", exp: 15, inn: 16 }, asOf).state, "sent");
// a sender the page has no channel for is listed under no channel, not left out
assert.strictEqual(describe({ name: "Something new", who: "press", date: "2026-11-01" }, asOf).channel, "tail");

// ---- the fold: the first rows, and a list one over the cap whole
assert.strictEqual(ROWS_SHOWN, 8);
assert.strictEqual(foldAt(5), 5);
assert.strictEqual(foldAt(8), 8);
assert.strictEqual(foldAt(9), 9);
assert.strictEqual(foldAt(10), 8);
assert.strictEqual(foldAt(13), 8);
assert.strictEqual(foldAt(18), 8);

console.log("plan_pieces: ok");
