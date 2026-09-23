/* The schema line the Notion pull puts in the refresh status: it has to name
 * every column and, for the choice-typed ones, what is actually in them - that
 * is where a post's account or channel is recorded, and splitting artist posts
 * from the brand's own depends on reading it right. */
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { noteSchema, summariseSchema } = require("../server/notion.js");

const sel = (name) => ({ type: "select", select: { name } });
const multi = (...names) => ({ type: "multi_select", multi_select: names.map((name) => ({ name })) });
const title = (t) => ({ type: "title", title: [{ plain_text: t }] });
const when = (d) => ({ type: "date", date: { start: d } });

const summarise = (rows) => {
  const schema = new Map();
  for (const r of rows) noteSchema(schema, r);
  return summariseSchema(schema);
};

// names and types for every column; values only for the choice-typed ones
assert.strictEqual(
  summarise([{ Name: title("Warhol teaser"), "Post date": when("2026-09-04"), Account: sel("Artist") }]),
  "Name (title) | Post date (date) | Account (select: Artist 1)",
);

// values are counted across rows and ordered by how common they are
assert.strictEqual(
  summarise([
    { Account: sel("Avant Arte") }, { Account: sel("Artist") }, { Account: sel("Avant Arte") },
  ]),
  "Account (select: Avant Arte 2, Artist 1)",
);

// multi-select counts every value on the row; status reads like a select
assert.strictEqual(
  summarise([{ Channel: multi("Instagram", "TikTok") }, { Channel: multi("Instagram") }]),
  "Channel (multi_select: Instagram 2, TikTok 1)",
);
assert.strictEqual(summarise([{ Stage: { type: "status", status: { name: "Posted" } } }]),
  "Stage (status: Posted 1)");

// a long value list is cut, and says it was
const many = summarise(Array.from({ length: 9 }, (_, i) => ({ Tag: sel("v" + i) })));
assert.ok(many.endsWith(", …)"), "a cut list must say so: " + many);
assert.strictEqual(many.split(", ").length, 7, "six values then the ellipsis: " + many);

// a column absent from the first row still lands (a Notion row can omit one)
assert.strictEqual(summarise([{ Name: title("a") }, { Name: title("b"), Account: sel("Artist") }]),
  "Name (title) | Account (select: Artist 1)");

// an empty select is a column with no values, not a crash
assert.strictEqual(summarise([{ Account: { type: "select", select: null } }]), "Account (select)");
assert.strictEqual(summarise([]), "");

console.log("notion schema: 8 cases ok");
