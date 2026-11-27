/* What the Agent's chats keep in the browser (web/src/agentStore.mjs), on a
 * stand-in for localStorage: a release's conversation is found again on the
 * way back, New chat forgets where the tab was without losing the chat, each
 * release keeps its own, the list is capped and gives up its oldest when the
 * store is full, and a store that will not answer costs the memory, never an
 * error.  node tests/agent_store.mjs */
import assert from "node:assert";
import { HOME, KEEP, TURNS, CHATS, OPEN, ago, answered, chatTitle, keepChat, loadChats, loadOpen, openFor, saveChats, saveOpen } from "../web/src/agentStore.mjs";

function fakeStore(limit = Infinity) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { if (String(v).length > limit) throw new Error("QuotaExceededError"); data.set(k, String(v)); },
  };
}
const q = (text, extra = {}) => ({ role: "user", text, ...extra });
const a = (text) => ({ role: "assistant", text, charts: [] });

assert.strictEqual(HOME, "home");
assert.strictEqual(answered([q("hi")]), false);
assert.strictEqual(answered([q("hi"), { role: "assistant", error: true, text: "The agent could not answer." }]), false, "a failed answer is not an answer");
assert.strictEqual(answered([q("hi"), a("hello")]), true);
assert.strictEqual(chatTitle([q("Diagnose this release", { skill: "diagnose" }), a("...")]), "Diagnose this release");

// a release's conversation is remembered: kept in the list under its release, and the tab is pointed at it
const s = fakeStore();
assert.strictEqual(openFor(s, "harland"), null, "nothing yet: the tab opens empty");
let list = keepChat(s, "c1", [q("Diagnose this release", { skill: "diagnose" })], "harland", 1000);
saveOpen(s, "harland", "c1", list);
assert.deepStrictEqual(openFor(s, "harland"), { id: "c1", thread: [q("Diagnose this release", { skill: "diagnose" })] }, "the question is there on a reload, before its answer");
list = keepChat(s, "c1", [q("Diagnose this release", { skill: "diagnose" }), a("The finding.")], "harland", 2000);
saveOpen(s, "harland", "c1", list);
assert.strictEqual(list.length, 1, "the same chat is kept once");
assert.strictEqual(openFor(s, "harland").thread.length, 2);
assert.deepStrictEqual(loadChats(s)[0], { id: "c1", at: 2000, thread: [q("Diagnose this release", { skill: "diagnose" }), a("The finding.")], rel: "harland" });

// each release its own; the home page's chats carry no release
list = keepChat(s, "c2", [q("How is it pacing?"), a("Behind.")], "weiwei", 3000);
saveOpen(s, "weiwei", "c2", list);
keepChat(s, "c3", [q("Which launches are behind?"), a("Three.")], undefined, 4000);
assert.strictEqual(openFor(s, "harland").id, "c1");
assert.strictEqual(openFor(s, "weiwei").id, "c2");
assert.deepStrictEqual(loadChats(s).map((c) => [c.id, c.rel]), [["c3", undefined], ["c2", "weiwei"], ["c1", "harland"]], "newest first");
assert.strictEqual(openFor(s, "c3"), null);
// a chat is only ever opened on the release it was held on
s.setItem(OPEN, JSON.stringify({ harland: "c2" }));
assert.strictEqual(openFor(s, "harland"), null);
saveOpen(s, "harland", "c1");
saveOpen(s, "weiwei", "c2");

// New chat: the tab forgets where it was, the earlier chat stays in the list
saveOpen(s, "harland", null);
assert.strictEqual(openFor(s, "harland"), null);
assert.ok(loadChats(s).some((c) => c.id === "c1" && c.rel === "harland"), "still listed, to be opened again");
assert.deepStrictEqual(loadOpen(s), { weiwei: "c2" });
// opened again from the list
saveOpen(s, "harland", "c1");
assert.strictEqual(openFor(s, "harland").id, "c1");

// the list is capped, the oldest go, and a tab pointed at a chat that has gone opens empty
for (let i = 0; i < KEEP; i++) keepChat(s, `n${i}`, [q(`q${i}`), a("ok")], `rel${i}`, 5000 + i);
assert.strictEqual(loadChats(s).length, KEEP);
assert.ok(!loadChats(s).some((c) => c.id === "c1"));
assert.strictEqual(openFor(s, "harland"), null);
saveOpen(s, "rel0", "n0");
assert.deepStrictEqual(Object.keys(loadOpen(s)), ["rel0"], "pointers to chats that have gone are dropped");
// a long chat keeps its last turns
const long = Array.from({ length: TURNS + 10 }, (_, i) => (i % 2 ? a(`a${i}`) : q(`q${i}`)));
assert.strictEqual(keepChat(s, "long", long, "harland")[0].thread.length, TURNS);

// a full store gives up its oldest chats, half at a time, and never throws
const small = fakeStore(400);
const big = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, at: i, thread: [q("x".repeat(60)), a("y".repeat(60))] }));
const kept = saveChats(small, big);
assert.ok(kept >= 1 && kept < 8 && loadChats(small).length === kept, `kept ${kept} of 8`);
assert.strictEqual(loadChats(small)[0].id, "b0", "the head of the list is what is kept");
assert.strictEqual(saveChats(fakeStore(1), big), 0);
// a store that will not answer (a private window)
const dead = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
assert.deepStrictEqual(loadChats(dead), []);
assert.deepStrictEqual(loadOpen(dead), {});
assert.strictEqual(openFor(dead, "harland"), null);
assert.doesNotThrow(() => { keepChat(dead, "c", [q("hi")], "harland"); saveOpen(dead, "harland", "c"); });
// what is stored is never anything but a list of chats
const junk = fakeStore();
junk.setItem(CHATS, JSON.stringify({ not: "a list" }));
junk.setItem(OPEN, JSON.stringify(["not", "a", "map"]));
assert.deepStrictEqual(loadChats(junk), []);
assert.deepStrictEqual(loadOpen(junk), {});

// how long ago, the short way
const now = Date.UTC(2026, 10, 27, 12);
assert.deepStrictEqual([0, 5, 180, 2 * 1440, 28 * 1440].map((m) => ago(now - m * 60000, now)), ["now", "5m", "3h", "2d", "4w"]);

console.log("agent store: ok");
