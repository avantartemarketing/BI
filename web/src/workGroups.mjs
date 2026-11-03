/* How the sell-through cards lay out a release's works: under a header per
 * line of work when the release sells more than one (docs/LINES_PLAN.md),
 * and, where a header's works are variants of one work ("Toy Brick (Red)",
 * "Toy Brick (Blue)"), each by its variant alone. Shared by Sell-through by
 * product and Sell-through at close so the two read the same. */

/* a work's name and a line's product name name the same work: equal, or one
 * the start of the other */
export function namesTitle(name, title) {
  const a = String(name || "").trim().toLowerCase(), b = String(title || "").trim().toLowerCase();
  return !!a && !!b && (a === b || (a.length >= 4 && b.length >= 4 && (b.startsWith(a) || a.startsWith(b))));
}

/* rows named "Base (Variant)" or "Base - Variant" with one shared base: that
 * base and each row's variant by its key, or null when the names are not of
 * that shape */
export function variantsOf(rows) {
  if (rows.length < 2) return null;
  const parts = rows.map((r) => {
    const n = String(r.name || "").trim();
    const m = n.match(/^(.+?)\s*\(([^()]+)\)$/) || n.match(/^(.+?)\s+[-–:]\s+(.+)$/);
    return m ? { base: m[1].trim(), variant: m[2].trim() } : null;
  });
  if (parts.some((x) => !x)) return null;
  const base = parts[0].base;
  if (parts.some((x) => x.base.toLowerCase() !== base.toLowerCase())) return null;
  return { base, names: new Map(rows.map((r, i) => [r.key, parts[i].variant])) };
}

/* the rows under their lines, [{ key, name, rows }], or null when the page
 * is one line's or the release sells a single line; works no line names go
 * last, under "Other works" */
export function groupByLine(snap, rows) {
  const lineDefs = !snap.line && Array.isArray(snap.lines) && snap.lines.length > 1 ? snap.lines : null;
  if (!lineDefs) return null;
  const out = lineDefs.map((l) => ({ key: l.key, name: l.name, products: l.products || [], rows: [] }));
  const rest = { key: "_rest", name: "Other works", rows: [] };
  for (const r of rows) {
    const g = out.find((l) => l.products.some((n) => namesTitle(n, r.name)));
    (g || rest).rows.push(r);
  }
  if (rest.rows.length) out.push(rest);
  return out.filter((g) => g.rows.length).map(({ key, name, rows: rs }) => ({ key, name, rows: rs }));
}

/* the name each row shows (its variant where its group's rows are variants
 * of one work), the group's shared base, and the longest name shown */
export function shownNames(rows) {
  const v = variantsOf(rows);
  const names = rows.map((r) => (v ? v.names.get(r.key) : null) || r.name);
  return { base: v ? v.base : null, names, longest: Math.max(0, ...names.map((n) => String(n || "").length)) };
}
