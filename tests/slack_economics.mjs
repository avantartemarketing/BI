/* The unit economics as a Slack message for the project manager to confirm
 * (server/slack.js composeEconomicsBlocks), composed from the Warhol page on
 * disk and from a page still on release-level figures, checked block by
 * block; and the project manager resolved to a mention (resolveMention): a
 * member ID as typed, an email looked up, a handle found in the member list
 * across its pages, each failure said with what to do.
 *
 *   node tests/slack_economics.mjs [--print]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { composeEconomicsBlocks, composeSellThroughBlocks, resolveMention, pmKind } = require(path.join(here, "..", "server", "slack.js"));
const print = process.argv.includes("--print");
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const cellText = (c) => (c.type === "raw_text" ? c.text : c.elements.map((s) => s.elements.map((e) => e.text).join("")).join(""));

// ---- the Warhol page: seven works from Airtable, release-level profit figures
const w = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "app", "releases", "warhol_le_26.json"), "utf8"));
const msg = composeEconomicsBlocks(w, { mention: "<@U0PMTEST01>", mentionLabel: "Clare Ferris", by: "tom.lloyd@avantarte.com",
  link: "https://bi.example/?release=warhol_le_26", today: "2026-10-09" });
if (print) console.log(JSON.stringify(msg, null, 1));
check(msg.text === `${w.artist}: unit economics to confirm, Clare Ferris please`, `the notification text: ${msg.text}`);
const types = msg.blocks.map((b) => b.type).join(" ");
check(types === "header section table section context", `the blocks: the table, the ask and where the figures came from, nothing else under the table: ${types}`);
check(msg.blocks[0].text.text === `Unit economics to confirm · ${w.artist}`, `headed by what it is: ${msg.blocks[0].text.text}`);
check(msg.blocks[1].text.text === `*${w.artist} · ${w.title}*`, `then the release: ${msg.blocks[1].text.text}`);
const sell = composeSellThroughBlocks(w, { today: "2026-10-09" });
check(sell.blocks[0].text.text === w.artist && sell.blocks[0].text.text !== msg.blocks[0].text.text, "so it cannot be taken for the sell-through card's post, which the artist's name heads");
const table = msg.blocks[2];
const sized = w.economics.products.filter((p) => p.edition > 0);
check(table.rows.length === sized.length + 2, `one row per work and a Total: ${table.rows.length} rows for ${sized.length} works`);
check(table.rows.every((r) => r.length === 8), "eight cells in every row");
check(table.rows[0].map(cellText).join("|") === "Work|Edition|Target units|Price|Artist profit / unit|AA group profit / unit|Blended frame profit / unit|Deal", `the header: ${table.rows[0].map(cellText).join("|")}`);
check(table.column_settings.length === 8 && table.column_settings[0].is_wrapped === true && table.column_settings[1].align === "right", "the work column wraps, the figures sit right");
const first = table.rows[1].map(cellText);
check(first[0] === "Green Landscape" && first[1] === "1,000" && first[2] === "325" && first[3] === "€750", `a work's row, named without the shared part: ${first.join("|")}`);
check(first[4] === "-" && first[5] === "-", "no profit per unit on a work while the release-level figures stand");
check(first[6] === "€33", `the work's blended frame profit per unit, its take-up times its profit per frame: ${first[6]}`);
const lifesize = table.rows.map((r) => r.map(cellText)).find((r) => r[0] === "Lifesize");
check(lifesize && lifesize[6] === "-", `a work with no frame on offer reads a dash: ${lifesize && lifesize.join("|")}`);
const total = table.rows[table.rows.length - 1].map(cellText);
check(total[0] === "Total · per target unit" && total[1] === "6,100" && total[2] === "2,440" && total[3] === "€1,000" && total[4] === "€507" && total[5] === "€809" && total[6] === "€33" && total[7] === "-",
  `the Total row carries the release's figures per target unit, AA's before framing as the rows read: ${total.join("|")}`);
const sections = msg.blocks.filter((b) => b.type === "section").map((b) => b.text.text);
check(sections.length === 2 && sections[1] === "<@U0PMTEST01> please check and confirm in thread. They inform our paid ROI model.", `the ask, and nothing else under the table: ${sections.slice(1).join(" || ")}`);
const ctx = msg.blocks.at(-1).elements[0].text;
check(/^Release-level figures typed on the Target setting tab stand over the works'\. Sent by tom\.lloyd@avantarte\.com on 9 Oct · <https:\/\/bi\.example\/\?release=warhol_le_26\|Target setting>\.$/.test(ctx), `the context: ${ctx}`);

// ---- figures on the works, some typed: the rows carry them and the context counts the typed ones
const perWork = {
  ...w,
  economics: {
    ...w.economics, mode: "products", aaBudgetShareAssumed: true, deal: ["profit share"],
    products: [
      { ...w.economics.products[0], artist_profit_per_unit: 300, aa_profit_per_unit: 420.5, aa_profit_share: 0.5, currency: "GBP", unit_price: 650,
        sources: { ...w.economics.products[0].sources, artist_profit_per_unit: "typed", aa_profit_per_unit: "typed" } },
      { ...w.economics.products[1], artist_profit_per_unit: 310, aa_profit_per_unit: 400, aa_revenue_share: 0.3, frame_conversion: 0.5, frame_profit_per_unit: 80, frame_uplift_per_unit: 40,
        sources: { ...w.economics.products[1].sources, artist_profit_per_unit: "airtable", aa_profit_per_unit: "typed" } },
    ],
  },
};
const m2 = composeEconomicsBlocks(perWork, { mention: null, by: null, today: "2026-10-09" });
const t2 = m2.blocks[2].rows.map((r) => r.map(cellText));
check(t2.length === 4 && t2[1][3] === "650 GBP" && t2[1][4] === "€300" && t2[1][5] === "€421" && t2[1][6] === "€33" && t2[1][7] === "AA 50% of profit", `a work priced in pounds, its deal a profit share: ${t2[1].join("|")}`);
check(t2[2][6] === "€40" && t2[2][7] === "AA 30% of revenue", `a work's own framing terms, and a revenue share reads as one: ${t2[2].join("|")}`);
check(t2[3][6] === "€33" && t2[3][7] === "profit share", `the Total row carries the release's blended frame profit and the deals in force: ${t2[3].join("|")}`);
// ---- more than one person asked: the project manager and the standing reviewer, in that order
const m4 = composeEconomicsBlocks(w, { mentions: [{ mention: "<@U0PMTEST01>", label: "Clare Ferris" }, { mention: "<@U0REVIEW01>", label: "Sam Reviewer" }], today: "2026-10-09" });
check(m4.text === `${w.artist}: unit economics to confirm, Clare Ferris and Sam Reviewer please`, `two names in the notification text: ${m4.text}`);
check(m4.blocks.filter((b) => b.type === "section").at(-1).text.text.startsWith("<@U0PMTEST01> <@U0REVIEW01> please check and confirm in thread."), "both mentioned in the ask, the project manager first");
check(t2[3][2] === "2,440", `the release target stands: ${t2[3].join("|")}`);
const s2 = m2.blocks.filter((b) => b.type === "section").map((b) => b.text.text);
check(s2.at(-1) === "Please check and confirm in thread. They inform our paid ROI model.", `no mention, no stray space, a capital to open: ${s2.at(-1)}`);
check(/^Figures from Airtable, 3 typed over on the Target setting tab\. Sent by the dashboard on 9 Oct\.$/.test(m2.blocks.at(-1).elements[0].text), `the context counts the typed figures: ${m2.blocks.at(-1).elements[0].text}`);
check(m2.text === `${w.artist}: unit economics to confirm`, `no name, no plea: ${m2.text}`);

// ---- a page with no sized works: the release as one row
const bare = { ...w, economics: { ...w.economics, products: [] } };
const m3 = composeEconomicsBlocks(bare, { today: "2026-10-09" });
const t3 = m3.blocks[2].rows.map((r) => r.map(cellText));
check(t3.length === 2 && t3[1][0] === w.title && t3[1][1] === "6,100" && t3[1][2] === "2,440", `one row for the release: ${t3[1].join("|")}`);
check(t3[1][4] === "€507" && t3[1][5] === "€809" && t3[1][6] === "€33", `the release's own figures on its one row: ${t3[1].join("|")}`);

// ---- who to mention: the kinds, and the lookups against a stand-in Slack
check(pmKind("U0PMTEST01") === "id" && pmKind("@U0PMTEST01") === "id" && pmKind("clare@example.com") === "email" && pmKind("@clare") === "handle" && pmKind(" ") === null, "the kind off the shape");
const calls = [];
const members = [
  [{ id: "U0AAAAAAAA", name: "tom", profile: { display_name: "Tom L" } }, { id: "U0BBBBBBBB", name: "someone", deleted: true, profile: { display_name: "clare" } }],
  [{ id: "U0CLARE001", name: "clare.f", real_name: "Clare Ferris", profile: { display_name: "Clare" } }],
];
let scope = true;
global.fetch = async (url, opts) => {
  const u = new URL(url);
  calls.push({ path: u.pathname, email: u.searchParams.get("email"), cursor: u.searchParams.get("cursor"), auth: opts && opts.headers && opts.headers.Authorization });
  const json = (o) => ({ ok: true, json: async () => o });
  if (!scope) return json({ ok: false, error: "missing_scope" });
  if (u.pathname.endsWith("users.lookupByEmail")) {
    return json(u.searchParams.get("email") === "clare@example.com" ? { ok: true, user: { id: "U0CLARE001", real_name: "Clare Ferris" } } : { ok: false, error: "users_not_found" });
  }
  if (u.pathname.endsWith("users.list")) {
    const page = u.searchParams.get("cursor") === "p2" ? 1 : 0;
    return json({ ok: true, members: members[page], response_metadata: { next_cursor: page === 0 ? "p2" : "" } });
  }
  return json({ ok: false, error: "unknown_method" });
};
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_API = "https://slack.example/api/chat.postMessage";
const id = await resolveMention("@U0PMTEST01");
check(id.mention === "<@U0PMTEST01>" && id.label === "U0PMTEST01" && calls.length === 0, "a member ID is used as typed, without a call");
const byEmail = await resolveMention("clare@example.com");
check(byEmail.mention === "<@U0CLARE001>" && byEmail.label === "Clare Ferris", `an email is looked up: ${JSON.stringify(byEmail)}`);
check(calls.length === 1 && calls[0].path === "/api/users.lookupByEmail" && calls[0].email === "clare@example.com" && calls[0].auth === "Bearer xoxb-test", `one call, with the token: ${JSON.stringify(calls[0])}`);
calls.length = 0;
const byHandle = await resolveMention("@Clare");
check(byHandle.mention === "<@U0CLARE001>" && byHandle.label === "Clare Ferris", `a handle is found by display name, case aside, on the second page, a deleted member skipped: ${JSON.stringify(byHandle)}`);
check(calls.length === 2 && calls[0].path === "/api/users.list" && calls[1].cursor === "p2", `the list is paged: ${JSON.stringify(calls)}`);
check((await resolveMention("clare.f")).id === "U0CLARE001", "or by username");
let err = null;
try { await resolveMention("nobody@example.com"); } catch (e) { err = e.message; }
check(/^no Slack member has the email nobody@example\.com, or paste their member ID instead \(Slack profile menu, Copy member ID\)$/.test(err || ""), `an unknown email: ${err}`);
err = null;
try { await resolveMention("@nobody"); } catch (e) { err = e.message; }
check(/^no Slack member is @nobody - check the handle, or paste their member ID instead/.test(err || ""), `an unknown handle: ${err}`);
scope = false;
err = null;
try { await resolveMention("clare@example.com"); } catch (e) { err = e.message; }
check(/add the users:read\.email scope and reinstall it, or paste their member ID/.test(err || ""), `the email scope missing: ${err}`);
err = null;
try { await resolveMention("@clare"); } catch (e) { err = e.message; }
check(/add the users:read scope and reinstall it/.test(err || ""), `the list scope missing: ${err}`);
err = null;
try { await resolveMention(""); } catch (e) { err = e.message; }
check(/Set the project manager for this release on the Target setting tab first/.test(err || ""), `nobody set: ${err}`);

console.log(failed ? `${failed} check(s) failed` : "ok: the unit economics message and the mention");
process.exit(failed ? 1 : 0);
