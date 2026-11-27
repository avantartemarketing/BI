/* Which work each draw is for (docs/DATA_MODEL.md 2.4).
 *
 * Neither feed says it. An entry carries its draw's id and nothing of the
 * work; an order line carries its work and nothing of the draw. What ties the
 * two is the people: entering a draw raises the app's pre-authorisation draft
 * on the entered work, and winning it ends in a paid order for that work. The
 * pull counts that per draw and product (server/bigquery.js drawProductsSql)
 * and this file reads the pairing off the counts. No person is in them.
 *
 * The fit of a draw to a product is two shares added up, each of the draw's
 * own people: its winners who paid for the product, and its entrants who hold
 * a pre-authorisation draft on it. The first is all an older launch has, the
 * second is there from a launch's first entry, weeks before a sale, and in
 * between both count: a winner who bought another work in the private room
 * no longer outvotes the draw's own entrants, as one paid order used to.
 *
 * A release's draws are paired together, not one at a time. People enter
 * several draws at once, so each of those draws fits each of those works and
 * a draw read alone is a coin toss; read together, the pairing with the best
 * fit in total is the one where every draw has its own work, and one entrant
 * who is in a single draw is enough to say which way round. So the pairing
 * taken is the one with the highest total fit, counting SHARED_COST against
 * it for every draw that takes a work another draw already has. Two draws do
 * share a work when the second fits no free work nearly as well: a second
 * draw run for the same work (Jammie Holmes' Fred, Taku Obata's B BOY JUSHI).
 *
 * Where the counts cannot tell two draws apart (every entrant so far is in
 * both), they take the works in order, draws by id and works by title. The
 * page then shows the same figures whichever way round they are, and the
 * first entrant in one draw alone puts them right. */

// what a draw gives up to take a work another draw already has: it shares
// one only when its fit there beats its fit to any free work by more
const SHARED_COST = 0.5;
const EPS = 1e-9;
// the nudge that settles a tie in order (draws by id, works by title). It
// adds up to less than a hundred-thousandth of a fit over a release's draws,
// a person in a hundred thousand, and stays well clear of rounding
const TIE = 1e-6;
const FORBIDDEN = 1e6;

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const share = (part, whole) => (part > 0 && whole > 0 ? Math.min(part / whole, 1) : 0);

/* How well a draw fits a product: the share of its winners who paid for it
 * plus the share of its entrants who hold a draft on it, 0 to 2. */
function fit(r) {
  return share(num(r.won_paid), num(r.winners)) + share(num(r.held), num(r.entrants));
}

/* The cheapest assignment of every row to a column of its own (rows <=
 * columns), by the Hungarian method. cost[i][j]; returns the column of each row. */
function assign(cost) {
  const n = cost.length, m = n ? cost[0].length : 0;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const col = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) col[p[j] - 1] = j - 1;
  return col;
}

/* One release's draws paired with its products. `rows` are the evidence rows
 * of one release ({draw_id, product_title, won_paid, held, winners, entrants});
 * returns {draw id: {title, row, rows}} for every draw with any evidence. */
function pairRelease(rows) {
  const byDraw = new Map();
  for (const r of rows) {
    const s = fit(r);
    if (!(s > 0)) continue;
    const d = String(r.draw_id);
    if (!byDraw.has(d)) byDraw.set(d, []);
    byDraw.get(d).push({ title: String(r.product_title), score: s, row: r });
  }
  const draws = [...byDraw.keys()].sort();
  // a draw's options: the products within SHARED_COST of its best fit. No
  // best pairing puts a draw further from its best than that, since moving
  // it back gains more than the one shared work it could cost.
  const options = new Map();
  for (const d of draws) {
    const all = byDraw.get(d).sort((a, b) => b.score - a.score || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    options.set(d, all.filter((o) => o.score >= all[0].score - SHARED_COST - EPS));
  }
  const titles = [...new Set(draws.flatMap((d) => options.get(d).map((o) => o.title)))].sort();
  // a column per product and place on it: the first place is free, each
  // further one costs SHARED_COST, and a product has as many places as draws
  // that could take it
  const cols = [];
  titles.forEach((t, ti) => {
    const takers = draws.filter((d) => options.get(d).some((o) => o.title === t)).length;
    for (let k = 0; k < takers; k++) cols.push({ ti, shared: k > 0 });
  });
  const cost = draws.map((d, di) => {
    const mine = new Map(options.get(d).map((o) => [o.title, o.score]));
    return cols.map((c) => {
      const s = mine.get(titles[c.ti]);
      if (s === undefined) return FORBIDDEN;
      // draws and works in step on a tie: the squared distance in rank is
      // least for the pairing that keeps both in order
      const rank = (titles.length > 1 ? c.ti / (titles.length - 1) : 0) - (draws.length > 1 ? di / (draws.length - 1) : 0);
      return -s + (c.shared ? SHARED_COST : 0) + TIE * rank * rank;
    });
  });
  const col = assign(cost);
  const out = {};
  draws.forEach((d, di) => {
    const c = cols[col[di]];
    const title = c && cost[di][col[di]] < FORBIDDEN / 2 ? titles[c.ti] : options.get(d)[0].title;
    out[d] = { title, row: byDraw.get(d).find((o) => o.title === title).row, rows: byDraw.get(d).map((o) => o.row) };
  });
  return out;
}

/* The pairing of every release, as the rows of data/draw_products.csv:
 * {release, draw_id, product_title, orders, share}. `orders` is the people
 * the product was read from (the draw's winners who paid for it, else its
 * entrants holding a draft on it) and `share` their share of all the draw's
 * such people across products, as the file has always had them. */
function pairDraws(rows) {
  const byRelease = new Map();
  for (const r of rows || []) {
    if (!r || r.release == null || r.draw_id == null || r.product_title == null) continue;
    const k = String(r.release);
    if (!byRelease.has(k)) byRelease.set(k, []);
    byRelease.get(k).push(r);
  }
  const out = [];
  for (const release of [...byRelease.keys()].sort()) {
    const pairs = pairRelease(byRelease.get(release));
    for (const d of Object.keys(pairs).sort()) {
      const { title, row, rows: all } = pairs[d];
      const key = num(row.won_paid) > 0 ? "won_paid" : "held";
      const total = all.reduce((t, x) => t + num(x[key]), 0);
      out.push({ release, draw_id: d, product_title: title, orders: num(row[key]),
        share: total > 0 ? Math.round((num(row[key]) / total) * 1000) / 1000 : 0 });
    }
  }
  return out;
}

module.exports = { pairDraws, pairRelease, fit, assign, SHARED_COST };
