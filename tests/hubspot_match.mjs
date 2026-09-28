/* How the HubSpot pull joins a send to a release (server/hubspot.js
 * matchCampaign). The artist+year join exists for a release whose sends carry
 * a sibling token nobody else uses (emails named AndyWarhol_LE_26 joining the
 * AndyWarhol_TL_26 Meta code). It must never fold a code some feed already
 * uses into its sibling: ZengFanzhi_TL_26 is the July Rainbow launch's own
 * code (its Meta campaign, its posts, its sends), and the fold counted the
 * Rainbow's sends as the LE's (ZengFanzhi_LE_26).
 *   node tests/hubspot_match.mjs */
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { matchCampaign, campaignIndex, codesInUse } = require("../server/hubspot.js");

const known = ["ZengFanzhi_LE_26", "AndyWarhol_TL_26", "JuliaSchna_LE_26"];

/* ---- the codes the feeds use: the sends' Campaign column, the Meta
 * campaigns' codes, the content feed's campaign_code; nothing else */
const dir = mkdtempSync(join(tmpdir(), "hubspot-match-"));
const emailsCsv = join(dir, "emails.csv"), spendCsv = join(dir, "spend.csv"), contentCsv = join(dir, "content.csv");
writeFileSync(emailsCsv, "Email Name,Send Date (Your time zone),Campaign,Delivered,Opened,Clicked,Unsubscribed\n"
  + "\"260626_CUS_ZengFanzhi_TL_26 - Announcement (LE), resend\",2026-06-26 08:00:55,ZengFanzhi_TL_26,140656,16263,1072,866\n"
  + "240624_INS_INSIDERSEA - Curtis,2024-06-24 09:00:00,INSIDERSEA,10,5,1,0\n");
writeFileSync(spendCsv, "campaign_name,spend_date,impressions,reach,link_clicks,spend\n"
  + "ZengFanzhi_TL_26 · Enter draw,2026-07-01,1,1,1,10\nAndyWarhol_TL_26 · Enter draw,2026-09-05,1,1,1,10\nNot a code · Sign-ups,2026-09-05,1,1,1,10\n");
writeFileSync(contentCsv, "campaign_code,Date,Profile name\nZengFanzhi_TL_26,2026-06-15,x\nNobodyFake_TL_25,2025-11-10,x\n");
const inUse = codesInUse({ emailsCsv, spendCsv, contentCsv });
assert.deepStrictEqual([...inUse].sort(), ["AndyWarhol_TL_26", "NobodyFake_TL_25", "ZengFanzhi_TL_26"],
  "code-shaped values from the three feeds, the Meta code before its ' · '");
// a feed that cannot be read adds nothing (the sends fall back to the
// checked-in copy, as the pull itself does) and nothing throws
const fallback = codesInUse({ emailsCsv: join(dir, "none.csv"), spendCsv: join(dir, "none.csv"), contentCsv: join(dir, "none.csv") });
assert.ok(fallback.has("ZengFanzhi_TL_26") && !fallback.has("NobodyFake_TL_25"), "the checked-in sends, and nothing from the missing feeds");

const index = campaignIndex(known, inUse);

/* ---- Zeng Fanzhi: the Rainbow's sends keep their own code */
for (const [name, campaign] of [
  ["140726_CUS_ZengFanzhi_TL_26 - Announcement (LE) (Resend to non-openers)", "ZengFanzhi_TL_26"],
  ["200726_CUS_ZengFanzhi_TL_26 - Last Chance (LE)", ""],
]) {
  const m = matchCampaign(name, campaign, index);
  assert.notStrictEqual(m.code, "ZengFanzhi_LE_26", `${name}: not folded into the LE's code`);
  assert.strictEqual(m.via, null);
}
assert.deepStrictEqual(matchCampaign("140726_CUS_ZengFanzhi_TL_26 - Announcement (LE)", "ZengFanzhi_TL_26", index),
  { code: "ZengFanzhi_TL_26", via: null }, "the HubSpot campaign stands");
// before: the known codes alone let the fold through
assert.deepStrictEqual(matchCampaign("140726_CUS_ZengFanzhi_TL_26 - Announcement (LE)", "ZengFanzhi_TL_26", campaignIndex(known)),
  { code: "ZengFanzhi_LE_26", via: "ZengFanzhi_TL_26" }, "the fold the feeds' codes stop");
// the LE's own sends still join it
assert.deepStrictEqual(matchCampaign("270726_CUS_ZengFanzhi_LE_26 - Early Access (LE) Plain text V2", "", index),
  { code: "ZengFanzhi_LE_26", via: null });

/* ---- the join the fold is for still works: a sibling token no feed uses */
assert.deepStrictEqual(matchCampaign("010926_CUS_AndyWarhol_LE_26 - Early Access (LE)", "", index),
  { code: "AndyWarhol_TL_26", via: "AndyWarhol_LE_26" }, "Warhol's LE-named sends join the Meta code");
assert.deepStrictEqual(matchCampaign("x_CUS_JuliaSchna_TL_26 - Announcement", "", index),
  { code: "JuliaSchna_LE_26", via: "JuliaSchna_TL_26" }, "and so does any sibling no feed uses");
// an unmatched send keeps its raw campaign name
assert.deepStrictEqual(matchCampaign("240624_INS_INSIDERSEA - Curtis", "INSIDERSEA", index), { code: "INSIDERSEA", via: null });
// an array index (the older call) still works, on the known codes alone
assert.strictEqual(matchCampaign("x_CUS_AndyWarhol_LE_26 - y", "", known).code, "AndyWarhol_TL_26");

console.log("hubspot match: ok");
