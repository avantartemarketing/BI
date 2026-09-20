/* Audit of the allocator tool against the admin's draw-entries export.
 *
 * The admin exports one CSV per draw (draw-<draw id>-entries.csv): one row
 * per entry with Winner, Claimed, Exclusion, Removal and Processing Error
 * columns. The allocator tool loads the same draw, removes the claimed
 * winners as buyers, and allocates every entry left that is not removed or
 * excluded, up to the inventory. So an export says, on its own, how many
 * entries the tool can see, how many of those can still be allocated, and
 * how many are winners whose payment failed and who the tool will hand a
 * unit to again. With the three numbers the tool prints for the product
 * (Sold, Entries, Expected) the audit says whether it allocates more than
 * there are people to allocate to.
 *
 * Runs in the browser on the file the user picks: nothing leaves the page,
 * and only draw entry ids are ever shown, never a name or an email. */

/* A small CSV reader: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const yes = (v) => String(v || "").trim().toLowerCase() === "yes";
const set = (v) => String(v || "").trim() !== "";

/* What one export says. Every row lands in exactly one bucket:
 *   claimedWinner   won and claimed (the tool removes these as buyers)
 *   failedWinner    won, not claimed: the payment failed or was never made
 *   flagged         removed or excluded (the tool skips these)
 *   allocatable     everyone else: still in the draw and can be allocated */
export function auditExport(rows) {
  const out = { total: rows.length, claimedWinners: 0, failedWinners: 0, cardDeclined: 0, flagged: 0, allocatable: 0,
    ids: { failedWinners: [], allocatable: [] } };
  for (const r of rows) {
    const winner = set(r["Winner"]) && String(r["Winner"]).trim().toLowerCase() !== "no";
    const claimed = yes(r["Claimed"]);
    const flagged = set(r["Removal"]) || set(r["Exclusion"]);
    if (winner && claimed) out.claimedWinners += 1;
    else if (winner) {
      out.failedWinners += 1;
      if (/declin/i.test(String(r["Processing Error"] || ""))) out.cardDeclined += 1;
      out.ids.failedWinners.push(r["ID"]);
    } else if (flagged) out.flagged += 1;
    else { out.allocatable += 1; out.ids.allocatable.push(r["ID"]); }
  }
  // what the tool's list holds once the claimed winners are removed
  out.toolList = out.total - out.claimedWinners;
  return out;
}

/* The tool's three numbers for the product against the export. */
export function compareWithTool(audit, tool) {
  const num = (v) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : null);
  const entries = num(tool && tool.entries), sold = num(tool && tool.sold), expected = num(tool && tool.expected);
  const out = { entries, sold, expected, allocations: null, excess: null, slipped: null, lines: [] };
  const L = out.lines;
  L.push(`The export has ${audit.total} entries: ${audit.claimedWinners} claimed winners the tool removes as buyers, ` +
    `${audit.failedWinners} winners whose payment failed${audit.cardDeclined ? ` (${audit.cardDeclined} card declined)` : ""}, ` +
    `${audit.flagged} removed or excluded, and ${audit.allocatable} who can still be allocated.`);
  if (entries !== null) {
    out.slipped = entries - audit.toolList;
    if (out.slipped > 0) L.push(`The tool shows ${entries} entries, ${out.slipped} more than the ${audit.toolList} left once the claimed winners go: claimed winners its buyer check did not remove, or entries made after this export.`);
    else if (out.slipped < 0) L.push(`The tool shows ${entries} entries, ${-out.slipped} fewer than the ${audit.toolList} the export leaves once the claimed winners go; its list is older than the export.`);
    else L.push(`The tool shows ${entries} entries, exactly the export less its claimed winners.`);
  }
  if (sold !== null && expected !== null) {
    out.allocations = expected - sold;
    out.excess = out.allocations - audit.allocatable;
    L.push(`The tool expects ${expected} sales against ${sold} sold, so it allocates ${out.allocations} units.`);
    if (out.excess > 0) L.push(`That is ${out.excess} more than the ${audit.allocatable} people who can be allocated one: at least ${out.excess} unit${out.excess === 1 ? "" : "s"} go to people who cannot take it.`);
    else if (audit.failedWinners > 0) L.push(`That is within the ${audit.allocatable} who can be allocated, but the tool's list still holds ${audit.failedWinners} winners whose payment failed, and it allocates every entry in its list that is not removed while the inventory lasts, so some of these units are theirs.`);
    else L.push(`That is within the ${audit.allocatable} who can be allocated.`);
  }
  return out;
}

/* The draw id in an export's file name (draw-draw_XXXX-entries.csv). */
export function drawIdFromName(name) {
  const m = String(name || "").match(/(draw_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
