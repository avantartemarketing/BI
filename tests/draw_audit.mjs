/* The draw-entries audit on a synthetic export.  node tests/draw_audit.mjs */
import { parseCsv, auditExport, compareWithTool, drawIdFromName } from "../shared/drawAudit.mjs";

let failed = 0;
const check = (c, m) => { if (!c) { failed += 1; console.log("FAIL " + m); } };
const csv = [
  "ID,Account ID,Email,Tier,Score,Framed,MaxQuantity,PreOrder,Winner,Claimed,Exclusion,Removal,KYC Completed,Processing Error,Shopify Draft Order ID,Entered At,Note,Remaining Eligible Entries,Opportunity Cost",
  "draw_ent_1,acc_1,a@example.com,Prospect,1,No,N/A,Yes,No,No,,,No,,1,2026-09-19T23:15:25Z,,No Eligible Entries,0",
  "draw_ent_2,acc_2,b@example.com,Prospect,1,No,N/A,Yes,PreOrder Winner,No,,,No,\"card_error - card_declined - insufficient_funds -- Your card has insufficient funds. [https://x.example/logs?object=req_1, more]\",2,2026-09-16T16:54:02Z,,No Eligible Entries,0",
  "draw_ent_3,acc_3,c@example.com,Potential,0,No,N/A,Yes,PreOrder Winner,Yes,,,No,,3,2026-09-15T19:33:37Z,,No Eligible Entries,0",
  "draw_ent_4,acc_4,d@example.com,Prospect,1,No,N/A,Yes,No,No,,Customer(Self),No,,4,2026-09-19T20:30:31Z,,No Eligible Entries,0",
  "draw_ent_5,acc_5,e@example.com,Prospect,1,No,N/A,No,No,No,,,No,,5,2026-09-20T02:22:49Z,,No Eligible Entries,0",
  "draw_ent_6,acc_6,f@example.com,Prospect,0,No,N/A,Yes,PreOrder Winner,No,,,No,,6,2026-09-14T19:39:42Z,,No Eligible Entries,0",
].join("\r\n");
const rows = parseCsv(csv);
check(rows.length === 6 && rows[1]["Processing Error"].includes("req_1, more"), "quoted field with a comma survives");
const a = auditExport(rows);
check(a.total === 6 && a.claimedWinners === 1 && a.failedWinners === 2 && a.cardDeclined === 1 && a.flagged === 1 && a.allocatable === 2, `buckets ${JSON.stringify(a)}`);
check(a.toolList === 5 && a.ids.failedWinners.join() === "draw_ent_2,draw_ent_6" && a.ids.allocatable.join() === "draw_ent_1,draw_ent_5", "ids and the tool's list");
const c = compareWithTool(a, { entries: 5, sold: 70, expected: 74 });
check(c.allocations === 4 && c.excess === 2 && c.slipped === 0, `comparison ${JSON.stringify(c)}`);
check(c.lines.some((l) => /2 more than the 2 people/.test(l)), "the verdict names the excess: " + c.lines.join(" | "));
const c2 = compareWithTool(a, { entries: "", sold: "", expected: "" });
check(c2.allocations === null && c2.lines.length === 1, "no tool numbers, the export alone");
check(drawIdFromName("draw-draw_3IEOEIfPMNVKnBpmyhlLLOZe1X8-entries (1).csv") === "draw_3IEOEIfPMNVKnBpmyhlLLOZe1X8", "draw id from the file name");
console.log(failed ? `${failed} check(s) failed` : "ok: draw audit");
process.exit(failed ? 1 : 0);
