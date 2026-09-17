/* The Slack sell-through update, composed from real snapshots and a synthetic
 * one, checked line by line.  node tests/slack_message.mjs [--print] */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { composeSellThrough, shortNames, entrants } = require(path.join(here, "..", "server", "slack.js"));
const print = process.argv.includes("--print");
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };

// names lose what they share
check(JSON.stringify(shortNames(["Untitled (White on White)", "Untitled (Black on Black)"])) === JSON.stringify(["White on White", "Black on Black"]), "bracketed titles");
check(JSON.stringify(shortNames(["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"])) === JSON.stringify(["Green Landscape", "Lifesize"]), "brillo titles");
check(JSON.stringify(shortNames(["Castles Burning (For Neil Young) I", "Castles Burning (For Neil Young) II", "Castles Burning (For Neil Young) III"])) === JSON.stringify(["I", "II", "III"]), "numbered prints");
check(JSON.stringify(shortNames(["Red", "Blue"])) === JSON.stringify(["Red", "Blue"]), "short unrelated names stay");
check(JSON.stringify(shortNames(["Only one"])) === JSON.stringify(["Only one"]), "a single name stays");

// entrants from patterns: people, not entries
const en = entrants([
  { open: ["d1"], won: [], n: 5 }, { open: ["d1", "d2"], won: [], n: 3 }, { open: [], won: ["d2"], n: 2 }, { open: [], won: [], sold: ["d1"], n: 9 },
]);
check(en.open === 8 && en.won === 2 && en.any === 10, `entrants ${JSON.stringify(en)}`);

// a synthetic release
const snap = {
  id: "test_le_26", releaseName: "Test Artist · Multiple · 2026 Q3", asOf: "2026-09-17", day: 11, of: 24,
  sellthrough: {
    edition: 600, sold: 94, drafts: 5, conversion: 0.8, incomplete: [],
    products: [
      { name: "Castles Burning (For Neil Young) I", edition: 200, sold: 46, soldAssumed: 0, drafts: 2, inHand: { open: 24, won: 1 }, shown: 14.4 },
      { name: "Castles Burning (For Neil Young) II", edition: 200, sold: 32, soldAssumed: 0, drafts: 1, inHand: { open: 13, won: 0 }, shown: 7.2 },
      { name: "Castles Burning (For Neil Young) III", edition: 200, sold: 16, soldAssumed: 0, drafts: 2, inHand: { open: 5, won: 2 }, shown: 5.6 },
    ],
    patterns: [{ open: ["a"], won: [], n: 21 }, { open: ["a", "b"], won: [], n: 6 }, { open: ["a", "b", "c"], won: [], n: 3 }, { open: [], won: ["c"], n: 2 }],
  },
};
const text = composeSellThrough(snap, { link: "https://example.test/" });
const lines = text.split("\n");
check(lines[0] === "*Test Artist · Multiple · 2026 Q3* - sales update, 17 Sep (day 11 of 24)", `head: ${lines[0]}`);
check(lines[1] === "Paid = 94 units (16% of 600)", `paid: ${lines[1]}`);
check(lines[2] === "• I: 46/200" && lines[4] === "• III: 16/200", `paid rows: ${lines[2]} ${lines[4]}`);
check(lines[5] === "Draw = 32 unique entrants (2 with a win to pay)", `draw: ${lines[5]}`);
check(lines[6] === "• I: 24 open + 1 to pay" && lines[7] === "• II: 13 open", `draw rows: ${lines[6]} ${lines[7]}`);
check(lines[9] === "Drafts = 5" && lines[10] === "• I: 2 · II: 1 · III: 2", `drafts: ${lines[9]} ${lines[10]}`);
check(lines[12] === "• I: ~62 units → 31%" && lines[14] === "• III: ~24 units → 12%", `estimate rows: ${lines[12]} ${lines[14]}`);
check(lines[15] === "Total ~126 units → 21% of 600", `total: ${lines[15]}`);
check(lines[16] === "<https://example.test/|Open in Launch Performance>", `link: ${lines[16]}`);
check(!text.includes("\u2014"), "no em dash");

// a release without products: the release-level figures
const bare = composeSellThrough({ id: "x", releaseName: "X · Y · 2026 Q1", asOf: "2026-09-17", day: 3, of: 20,
  sellthrough: { edition: 100, sold: 12, drafts: 2, soldPredicted: 8, conversion: 0.8, incomplete: ["products"] } });
check(bare.includes("Paid = 12 units (12% of 100)") && bare.includes("~22 units → 22% of 100") && bare.includes("_Incomplete data: products_"), `bare: ${bare}`);

// the real snapshots on disk, if any: they must compose without throwing
const dir = path.join(here, "..", "data", "app", "releases");
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const t = composeSellThrough(s);
    check(t.split("\n").length >= 3, `${f} composes`);
    if (print && /schnabel|warhol/.test(f)) console.log("\n" + t);
  }
}
console.log(failed ? `${failed} failure(s)` : "ok: slack message");
process.exit(failed ? 1 : 0);
