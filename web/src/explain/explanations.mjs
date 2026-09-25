/* What a figure on the page is and how it is worked out, in plain words, for
 * the explainer: shift-click (or Shift+Enter on) a number and the panel at the
 * right shows it (Explain.jsx). One builder per kind of figure, keyed as the
 * cards mark them, reading the same snapshot fields the card reads, so the
 * working always lands on the figure printed.
 *
 * A builder takes (arg, ctx): arg is what the card passed with the figure
 * (which channel, which horizon, the values it computed), ctx is { snap, st },
 * the page's snapshot (with Direct spread over it when that switch is on,
 * as the cards read it) and the refresh status. It returns
 *
 *   { where, when, name, value, unit, say,
 *     steps: [[segment, ...], ...],    a segment is text, or a drill link
 *     total: { v, label },             the "=" line closing the steps
 *     compare: [{ label, v, note, k?, arg? }],
 *     sources: [{ key, gave }],        keys of SOURCES (sources.mjs)
 *     notes: [text], method }
 *
 * or null when the figure is not on this page. Plain JavaScript (no JSX), so
 * tests/explain.mjs runs every builder against every snapshot on file. */
import { fmt, fmtSigned, fmtPct, fmtDay, MINUS, paidDayFrac } from "../format.mjs";

/* ---- formatting ---- */
const n = (v, d = 0) => fmt(v, d);
const u = (v) => fmt(v, v > 0 && v < 10 ? 1 : 0);            // the channels card's units
const pct = (x, d = 0) => fmtPct(x, d);
const eur = (v, d = 0) => (v === null || v === undefined ? "–" : (v < 0 ? MINUS : "") + "€" + fmt(Math.abs(v), d));
const signed = (v, d = 0) => fmtSigned(v, d);
const dayOf = (iso) => (iso ? fmtDay(new Date(String(iso).slice(0, 10) + "T00:00:00Z")) : null);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const ratio = (a, b) => (finite(a) && finite(b) && b !== 0 ? a / b : null);
const sum = (xs) => xs.reduce((t, x) => t + (finite(x) ? x : 0), 0);

/* A drill link: the figure in a step that has its own explanation. */
export const drill = (text, k, arg) => ({ d: String(text), k, arg });

/* A step as segments: `seg\`Add the ${drill("161", "st.draw")} units\``. */
export function seg(strings, ...vals) {
  const out = [];
  strings.forEach((s, i) => {
    if (s) out.push(s);
    if (i < vals.length) {
      const v = vals[i];
      if (v && typeof v === "object" && v.k) out.push(v);
      else if (v !== null && v !== undefined && v !== "") out.push(String(v));
    }
  });
  return out;
}

/* Whole numbers that add up to the rounded total they are parts of (the
 * largest remainders take the spare units), so a reader adding the steps
 * gets the figure printed, not one off it. */
export function roundParts(values, total) {
  const vs = values.map((v) => (finite(v) ? v : 0));
  const target = Math.round(finite(total) ? total : sum(vs));
  const floors = vs.map((v) => Math.floor(v));
  let spare = target - sum(floors);
  if (Math.abs(spare) > vs.length) return vs.map((v) => Math.round(v));   // not parts of this total
  // the largest remainders take the spare units; a tie goes to the larger
  // value, where one unit moves the figure least
  const order = vs.map((v, i) => ({ i, v, r: Math.round((v - Math.floor(v)) * 1e6) }))
    .sort((a, b) => b.r - a.r || b.v - a.v);
  const out = floors.slice();
  for (let j = 0; spare > 0 && j < order.length; j++, spare--) out[order[j].i] += 1;
  for (let j = order.length - 1; spare < 0 && j >= 0; j--, spare++) out[order[j].i] -= 1;
  return out;
}

/* ---- what the page is ---- */
const CHANNEL_NAMES = { aa_email: "AA Email", aa_social: "AA Meta", referral_artist: "Artist", search_direct_other: "Direct etc.", paid: "Paid" };
const channelOf = (s, key) => (s.channels || []).find((c) => c.key === key) || null;
const chName = (s, key) => (channelOf(s, key) || {}).name || CHANNEL_NAMES[key] || key;
const ORGANIC = ["aa_email", "aa_social", "referral_artist", "search_direct_other"];
const hasBasket = (s) => !!s.benchmark;
const editionTotal = (s) => (s.edition && s.edition.total) || (s.sellthrough && s.sellthrough.edition) || null;
const closeDay = (s) => dayOf(s.windowEnd);
const dayText = (s) => (s.day && s.of ? `day ${s.day} of ${s.of}` : "today");
const rateOf = (s) => {
  const st = s.sellthrough || {};
  return finite(st.conversion) ? st.conversion : 1 - ((s.benchmarks && s.benchmarks.chargeDropOff) ?? 0.2);
};
const rateSource = (s) => {
  const st = s.sellthrough || {};
  const r = rateOf(s), pre = st.preorderConversion;
  return `The ${pct(r)} entry → order rate${finite(pre) && pre !== r ? ` (${pct(pre)} for a pre-order entry)` : ""}` +
    (r === 0.8 ? ", the standard rate unless one is typed for this release" : ", typed for this release");
};
/* Works named without the words they all share ("Brillo Box Collectable
 * (White Portrait)" -> "White Portrait"), for the lists in the steps. */
function shortNames(names) {
  if (names.length < 2) return names.slice();
  const words = names.map((x) => String(x).split(" "));
  let k = 0;
  while (words.every((w) => w.length > k + 1 && w[k] === words[0][k])) k++;
  return words.map((w) => {
    const rest = w.slice(k).join(" ");
    return /^\(.*\)$/.test(rest) ? rest.slice(1, -1) : rest;
  });
}
const basketName = (s) => {
  const b = s.benchmark && s.benchmark.basket;
  return b ? `"${b.name}", ${b.n} past launches` : "the matched basket";
};

/* The sell-through's own count, the units the hero adopts (docs 6.3½). */
function securedParts(s) {
  const st = s.sellthrough || {};
  const sold = st.sold ?? 0, drafts = finite(st.drafts) ? st.drafts : 0, draw = st.soldPredicted ?? 0;
  return { sold, drafts, draw, total: sold + drafts + draw };
}

/* ---- the builders ---- */
export const EXPLAIN = {};

/* Units secured to date: the hero's lead today, and the units every card counts. */
EXPLAIN["hero.secured"] = (a, { snap: s }) => {
  const h = s.hero || {};
  const { sold, drafts, draw, total } = securedParts(s);
  const now = finite(h.now) ? h.now : total;
  const cap = editionTotal(s);
  const capped = total - now > 0.5;
  const [rSold, rDrafts, rDraw] = roundParts([sold, drafts, draw], capped ? total : now);
  const shut = !!s.complete && draw === 0 && drafts === 0;
  const steps = [
    s.catalogue
      ? seg`Start with the ${n(rSold)} units paid for in the last 90 days, on every route including the private room.`
      : seg`Start with the ${n(rSold)} units paid for, on every route including the private room.`,
  ];
  if (rDrafts > 0) steps.push(seg`Add the ${n(rDrafts)} units on draft orders raised and not yet paid. They take room in the edition like a sale.`);
  if (draw > 0) steps.push(seg`Add the ${drill(n(rDraw), "st.draw")} units expected from the people still in the draw, at the ${pct(rateOf(s))} rate entries turn into orders.`);
  if (capped) steps.push(seg`Hold the total at the ${n(cap)} units in the edition: the other ${n(total - now)} is demand the edition cannot hold.`);
  const targeted = s.targeted !== false && !s.catalogue;
  const compare = [];
  if (targeted && finite(h.expectedToday)) {
    compare.push({ label: "Target today", v: n(h.expectedToday), k: "hero.target", arg: { close: false },
      note: `What the plan asked for by ${dayText(s)}. Secured is ${n(Math.abs(now - h.expectedToday))} ${now >= h.expectedToday ? "ahead of" : "behind"} it.` });
  }
  if (targeted && hasBasket(s) && finite(h.benchmarkToday)) {
    compare.push({ label: "Benchmark today", v: n(h.benchmarkToday), k: "hero.bm", arg: { close: false },
      note: `What launches like this one typically had by now. Secured is ${n(Math.abs(now - h.benchmarkToday))} ${now >= h.benchmarkToday ? "ahead of" : "behind"} it.` });
  }
  const notes = [];
  if (shut) notes.push("The window has shut, so drafts and entries still in the draw no longer count: secured is the units paid.");
  else notes.push("Only entries that have not become orders carry the rate: an entry that became an order is already in units paid.");
  notes.push("The same count runs through the hero, the trajectory, the channels and the waterfall, so they all add up to it.");
  return {
    where: s.targeted === false ? "Secured units" : "Units vs target", when: "Today",
    name: "Units secured", value: n(now), unit: s.catalogue ? "units secured in the last 90 days" : "units secured to date",
    say: "Everything sold or as good as sold: units paid for, orders raised and waiting for payment, and the orders expected from people still in the draw.",
    steps, total: { v: n(now), label: "units secured" }, compare,
    sources: [
      { key: "orders", gave: "Units paid and draft orders, work by work" },
      ...(draw > 0 ? [{ key: "entries", gave: "Who is still in the draw, and how many works each wants" }] : []),
      ...(draw > 0 ? [{ key: "settings", gave: rateSource(s) }] : []),
    ],
    notes, method: "Data model 6.3½",
  };
};

/* The draw's expected orders: entries in hand, allocated, at the rate. */
EXPLAIN["st.draw"] = (a, { snap: s }) => {
  if (!s.sellthrough) return null;
  const st = s.sellthrough;
  const draw = st.soldPredicted ?? 0;
  const rate = rateOf(s), pre = st.preorderConversion;
  const products = Array.isArray(st.products) && st.products.length ? st.products : null;
  const alloc = st.allocation || null;
  const allocated = products ? sum(products.map((p) => p.allocated)) : null;
  const steps = [];
  const notes = [];
  if (products && alloc) {
    const people = Math.max((alloc.entrants || 0) - (alloc.unpaidWinners || 0), 0);
    steps.push(seg`Start with the ${n(people)} people still in the draw: eligible, and not yet won or bought.`);
    steps.push(alloc.flexibleEntrants > 0
      ? seg`Count each of them on the number of works they want at most, placed on the works with room, the priciest first (${n(alloc.flexibleEntrants)} entered more works than they want): ${n(allocated)} units.`
      : seg`Count each of them on the works they entered, placed on the works with room: ${n(allocated)} units.`);
  } else if (finite(st.inHandUnits)) {
    steps.push(seg`Start with the ${n(st.inHandUnits)} units entered by people still in the draw, as the funnel counts them.`);
  }
  steps.push(finite(pre) && pre !== rate
    ? seg`Multiply by the ${pct(rate)} of entries that usually become orders, or ${pct(pre)} for an entry made as a pre-order, with the card already authorised.`
    : seg`Multiply by the ${pct(rate)} of entries that usually become orders.`);
  const base = products ? allocated * rate : finite(st.inHandUnits) ? st.inHandUnits * rate : null;
  if (base !== null && draw - base >= 0.5 && finite(pre) && pre > rate) {
    notes.push(`${n(products ? allocated : st.inHandUnits)} × ${pct(rate)} is ${n(base)}; the pre-order entries, at ${pct(pre)}, add the other ${n(draw - base)}.`);
  } else if (base !== null && base - draw >= 0.5) {
    notes.push(`${n(products ? allocated : st.inHandUnits)} × ${pct(rate)} is ${n(base)}, held to ${n(draw)} by the room left in the works.`);
  }
  if (alloc && alloc.unpaidWinners > 0) {
    notes.push(`${n(alloc.unpaidWinners)} people who won and have not paid are not counted. The order sent after a failed payment is in the drafts for 72 hours; after that it is out.`);
  }
  notes.push("A work's room is its edition less what is paid and on draft orders.");
  return {
    where: "Sell-through by product", when: "Today",
    name: "Expected from the draw", value: n(draw), unit: "units expected from the draw",
    say: "The orders expected from the people still in the draw, at the rate draw entries usually turn into orders.",
    steps, total: { v: n(draw), label: "expected from the draw" },
    sources: [
      { key: "entries", gave: "Each entry's works, the most the entrant wants, and whether it was a pre-order" },
      { key: "orders", gave: "What each work has left: its paid and draft units" },
      { key: "settings", gave: rateSource(s) },
    ],
    notes, method: "Data model 6.3",
  };
};

/* The projection at close: secured so far plus each channel's course. */
EXPLAIN["hero.proj"] = (a, { snap: s }) => {
  const h = s.hero || {};
  if (!finite(h.projected)) return null;
  const chans = s.channels || [];
  const now = h.now ?? 0;
  if (s.complete) {
    return {
      where: "Units vs target", when: "At close",
      name: "Final units", value: n(h.projected), unit: "units at close",
      say: "The campaign has closed, so the projection is what was secured: the units paid in the window.",
      steps: [seg`The window closed on ${closeDay(s)}: the ${drill(n(now), "hero.secured")} units secured are the final figure.`],
      total: { v: n(h.projected), label: "units at close" },
      sources: [{ key: "orders", gave: "Units paid, work by work" }],
      notes: [], method: "Data model 6.3½",
    };
  }
  const paid = channelOf(s, "paid");
  const paidMore = paid ? Math.max((paid.proj ?? 0) - (paid.now ?? 0), 0) : 0;
  const orgMore = sum(chans.filter((c) => c.key !== "paid").map((c) => Math.max((c.proj ?? 0) - (c.now ?? 0), 0)));
  const demand = now + paidMore + orgMore;
  const capped = demand - h.projected > 0.5;
  const [rNow, rPaid, rOrg] = roundParts([now, paidMore, orgMore], capped ? demand : h.projected);
  const steps = [seg`Start from the ${drill(n(rNow), "hero.secured")} units secured so far.`];
  if (paid) {
    steps.push(rPaid > 0
      ? seg`Add the ${n(rPaid)} more that paid should bring if today's daily spend carries on to the close, at a cost per entry that rises a little each day.`
      : seg`Add nothing more from paid: there has been no spend in the last three days, so none is projected.`);
  }
  steps.push(seg`Add the ${n(rOrg)} more the organic channels should bring, each following the shape its past launches took, scaled to how it is doing against plan so far.`);
  if (capped) steps.push(seg`Hold it at the ${n(editionTotal(s))} units in the edition: the other ${n(demand - h.projected)} is demand the edition cannot hold.`);
  const compare = [];
  if (s.targeted !== false && finite(h.target)) {
    compare.push({ label: "Target", v: n(h.target), k: "hero.target", arg: { close: true },
      note: `${pct(ratio(h.projected, h.target))} of the target, ${n(Math.abs(h.projected - h.target))} ${h.projected >= h.target ? "over" : "short"}.` });
  }
  if (hasBasket(s) && finite(h.benchmark)) {
    compare.push({ label: "Benchmark", v: n(h.benchmark), k: "hero.bm", arg: { close: true },
      note: "What launches like this one typically reach." });
  }
  return {
    where: "Units vs target", when: "At close",
    name: "Projected at close", value: n(h.projected), unit: `units by the close${closeDay(s) ? " on " + closeDay(s) : ""}`,
    say: "Where units secured should land by the close if each channel keeps to its current course.",
    steps, total: { v: n(h.projected), label: "projected at close" }, compare,
    sources: [
      { key: "funnel", gave: "Each channel's entries and sales so far" },
      { key: "meta", gave: "Paid's daily spend and its cost per entry" },
      { key: "curves", gave: "The shape each channel's volume takes over a campaign" },
    ],
    notes: [
      "It is the course the launch is on today. The extra spend the Paid spend card recommends is not in it.",
      "The Unit trajectory card's By channel view shows each channel's part.",
    ],
    method: "Data model 5.4",
  };
};

/* The hero's lead: secured today, projected at close. */
EXPLAIN["hero.fill"] = (a, c) => ((a && a.close) ? EXPLAIN["hero.proj"](a, c) : EXPLAIN["hero.secured"](a, c));

/* The target: by today, or for the whole campaign. */
EXPLAIN["hero.target"] = (a, c) => {
  const s = c.snap, h = s.hero || {};
  if (a && a.close) return EXPLAIN["release.target"](a, c);
  if (!finite(h.expectedToday)) return null;
  const chans = s.channels || [];
  const exps = roundParts(chans.map((ch) => ch.exp ?? 0), h.expectedToday);
  const paidOn = chans.some((ch) => ch.key === "paid");
  return {
    where: "Units vs target", when: "Today",
    name: "Target today", value: n(h.expectedToday), unit: `units by ${dayText(s)}`,
    say: "What the plan asked to have secured by today: the campaign's target, spread over the days the way launches like this one build up.",
    steps: [
      seg`The target for the whole campaign is ${drill(n(h.target), "release.target")} units, split across the channels.`,
      paidOn
        ? seg`Spread each organic channel's share over the days on the curve that channel follows in past launches, and paid evenly over the days it runs, counting the part of today seen so far.`
        : seg`Spread each channel's share over the days on the curve that channel follows in past launches, counting the part of today seen so far.`,
      seg`By today that asks for ${chans.map((ch, i) => `${ch.name} ${n(exps[i])}`).join(", ")}.`,
    ],
    total: { v: n(h.expectedToday), label: "target by today" },
    compare: finite(h.now) ? [{ label: "Secured", v: n(h.now), k: "hero.secured", arg: {},
      note: `${pct(ratio(h.now, h.expectedToday))} of the target by today.` }] : [],
    sources: [
      { key: "settings", gave: "The campaign's target" },
      { key: "curves", gave: "How each channel's units build up over a campaign" },
      ...(hasBasket(s) ? [{ key: "basket", gave: "The launches the curves are read from" }] : []),
    ],
    notes: [`By ${dayText(s)} the plan asks for ${pct(ratio(h.expectedToday, h.target))} of the whole target.`],
    method: "Data model 4a.4",
  };
};

/* The campaign's target, and the header's target chip. */
EXPLAIN["release.target"] = (a, { snap: s }) => {
  const h = s.hero || {};
  const target = (s.edition && s.edition.target) ?? h.target;
  if (!finite(target)) return null;
  const total = editionTotal(s);
  const partial = finite(total) && total > target;
  const e = s.economics || {};
  const products = Array.isArray(e.products) ? e.products : [];
  const productSum = sum(products.map((p) => p.target_units));
  const chans = s.channels || [];
  const tParts = roundParts(chans.map((ch) => ch.target ?? 0), target);
  const k = s.benchmark && s.benchmark.k;
  const steps = [];
  if (e.mode === "products" && products.length) {
    steps.push(seg`Each work's target is its edition × its target sell-through: ${products.map((p) => `${p.name} ${n(p.target_units)}`).join(", ")}.`);
    steps.push(seg`Added up, that is ${n(target)} units${partial ? `: ${pct(target / total)} of the ${n(total)} edition` : ""}.`);
  } else {
    steps.push(seg`The target is ${n(target)} units, the figure typed for the release on the Target setting tab${partial ? `: ${pct(target / total)} of the ${n(total)} edition` : ""}.`);
  }
  if (chans.length) steps.push(seg`It is split across the channels in the shares the basket's launches took: ${chans.map((ch, i) => `${ch.name} ${n(tParts[i])}`).join(", ")}.`);
  if (hasBasket(s) && finite(k)) steps.push(seg`Against the benchmark of ${drill(n(h.benchmark), "hero.bm", { close: true })} units, that is ${drill("×" + n(k, 2), "k")}: the same uplift on every channel and every day.`);
  const notes = [];
  if (e.mode !== "products" && productSum > 0 && Math.abs(productSum - target) >= 1) {
    notes.push(`The works' own targets in Airtable add up to ${n(productSum)}. The figure typed for the release stands until it is cleared on the Target setting tab.`);
  }
  if (partial) notes.push("The sellout, the room left and the sell-through read against the whole edition; the targets read against this.");
  return {
    where: "Units vs target", when: "At close",
    name: "Target", value: n(target), unit: "units by the close",
    say: "What the business asked this launch to sell by the close.",
    steps, total: { v: n(target), label: "target at close" },
    compare: finite(h.projected) && s.targeted !== false ? [{ label: "Projected", v: n(h.projected), k: "hero.proj", arg: { close: true },
      note: `Where the launch is heading: ${pct(ratio(h.projected, target))} of the target.` }] : [],
    sources: [
      e.mode === "products" ? { key: "airtable", gave: "Each work's edition and target sell-through" } : { key: "settings", gave: "The release's target" },
      ...(hasBasket(s) ? [{ key: "basket", gave: "The channel shares the target is split in" }] : []),
    ],
    notes, method: "Data model 4a.3",
  };
};

/* The benchmark: by today, or at close. */
EXPLAIN["hero.bm"] = (a, { snap: s }) => {
  const h = s.hero || {}, b = s.benchmark;
  if (!b) return null;
  const close = !!(a && a.close);
  const v = close ? h.benchmark : h.benchmarkToday;
  if (!finite(v)) return null;
  const chans = s.channels || [];
  const parts = roundParts(chans.map((ch) => (close ? ch.bm : ch.bmExp) ?? 0), v);
  const steps = [
    seg`The basket is ${basketName(s)} like this one, chosen on the Target setting tab. This release is never one of them.`,
    seg`Their median result is ${n(b.units)} units${finite(b.unitsP25) && finite(b.unitsP75) ? ` (half of them landed between ${n(b.unitsP25)} and ${n(b.unitsP75)})` : ""}, split across the channels in their median shares.`,
  ];
  if (close) steps.push(seg`That gives ${chans.map((ch, i) => `${ch.name} ${n(parts[i])}`).join(", ")}.`);
  else {
    steps.push(seg`Spread over the days on the curve each channel follows in those launches, by ${dayText(s)} they typically had ${chans.map((ch, i) => `${ch.name} ${n(parts[i])}`).join(", ")}.`);
  }
  return {
    where: "Units vs target", when: close ? "At close" : "Today",
    name: close ? "Benchmark" : "Benchmark today", value: n(v), unit: close ? "units by the close" : `units by ${dayText(s)}`,
    say: close ? "What launches like this one typically reach by the close." : "What launches like this one typically had secured by this point.",
    steps, total: { v: n(v), label: close ? "benchmark at close" : "benchmark by today" },
    compare: [
      ...(finite(close ? h.projected : h.now) ? [{ label: close ? "Projected" : "Secured", v: n(close ? h.projected : h.now),
        k: close ? "hero.proj" : "hero.secured", arg: { close }, note: `${pct(ratio(close ? h.projected : h.now, v))} of the benchmark.` }] : []),
      ...(finite(close ? h.target : h.expectedToday) ? [{ label: close ? "Target" : "Target today", v: n(close ? h.target : h.expectedToday),
        k: "hero.target", arg: { close }, note: finite(b.k) ? `The target is ×${n(b.k, 2)} the benchmark.` : "" }] : []),
    ],
    sources: [
      { key: "basket", gave: "The launches the median is taken over" },
      { key: "funnel", gave: "Each past launch's units by channel and by day" },
    ],
    notes: ["Per channel it is the median share × the median total, not the median of each channel on its own, so the channels add up to the total."],
    method: "Data model 4a.1",
  };
};

/* The lead's delta against the target. */
EXPLAIN["hero.delta"] = (a, c) => {
  const s = c.snap, h = s.hero || {};
  const close = !!(a && a.close);
  const fill = close ? h.projected : h.now, target = close ? h.target : h.expectedToday;
  if (!finite(fill) || !finite(target)) return null;
  const d = fill - target;
  return {
    where: "Units vs target", when: close ? "At close" : "Today",
    name: close ? "Projection against target" : "Against target today", value: signed(Math.round(fill) - Math.round(target)),
    unit: close ? "units against the target" : "units against the target by today",
    say: close ? "How far the projection at close is from the target." : "How far units secured are from where the plan wanted them by today.",
    steps: [
      close ? seg`Take the ${drill(n(fill), "hero.proj", { close: true })} units projected at close.` : seg`Take the ${drill(n(fill), "hero.secured")} units secured so far.`,
      close ? seg`Take away the ${drill(n(target), "hero.target", { close: true })} unit target.` : seg`Take away the ${drill(n(target), "hero.target", { close: false })} units the plan asked for by today.`,
    ],
    total: { v: signed(Math.round(fill) - Math.round(target)), label: d >= 0 ? "ahead of target" : "behind target" },
    compare: hasBasket(s) && finite(close ? h.benchmark : h.benchmarkToday) ? [{
      label: close ? "Benchmark" : "Benchmark today", v: n(close ? h.benchmark : h.benchmarkToday), k: "hero.bm", arg: { close },
      note: `${close ? "The projection" : "Secured"} is ${n(Math.abs(fill - (close ? h.benchmark : h.benchmarkToday)))} ${fill >= (close ? h.benchmark : h.benchmarkToday) ? "ahead of" : "behind"} it.`,
    }] : [],
    sources: [{ key: "orders", gave: "Units paid and draft orders" }, { key: "funnel", gave: "Entries and sessions by channel" }],
    notes: close ? [] : ["The sidebar's dot reads the same comparison: green at or ahead of target, amber behind it but at or ahead of the benchmark, red behind both."],
    method: "Data model 6.2",
  };
};

/* The stretch multiple: target over benchmark. */
EXPLAIN["k"] = (a, { snap: s }) => {
  const b = s.benchmark, h = s.hero || {};
  if (!b || !finite(b.k)) return null;
  const target = (s.edition && s.edition.target) ?? h.target;
  return {
    where: "Channels vs targets", when: null,
    name: "Target over benchmark", value: "×" + n(b.k, 2), unit: "the benchmark",
    say: "How much more the business asked for than launches like this one typically reach, as one multiple.",
    steps: [
      seg`The target is ${drill(n(target), "release.target")} units.`,
      seg`The basket's median is ${drill(n(b.units), "hero.bm", { close: true })} units.`,
      seg`${n(target)} ÷ ${n(b.units)} = ×${n(b.k, 2)}.`,
    ],
    total: { v: "×" + n(b.k, 2), label: "the benchmark" },
    sources: [{ key: "settings", gave: "The target" }, { key: "basket", gave: "The benchmark" }],
    notes: ["The same multiple lifts every volume (sessions, entries, units, spend) on every channel and every day. Conversion rates are held at the benchmark: the plan is the same launch, bigger."],
    method: "Data model 4a.1",
  };
};

/* A channel's share of its target, on the channels card. */
EXPLAIN["channel.pct"] = (a, { snap: s }) => {
  const ch = channelOf(s, a && a.key);
  if (!ch) return null;
  const close = !!(a && a.close);
  const bar = (close ? ch.proj : ch.now) ?? 0;
  const target = (close ? ch.target : ch.exp) ?? 0;
  const bm = hasBasket(s) ? (close ? ch.bm : ch.bmExp) : null;
  const p = ratio(bar, target);
  if (p === null) return null;
  const parts = (ch.parts || []).filter((x) => (x.value ?? 0) > 0);
  const steps = [];
  if (close) {
    steps.push(seg`${ch.name} has secured ${u(ch.now)} units so far and is projected to reach ${u(bar)} by the close.`);
    steps.push(seg`Its target for the campaign is ${u(target)} units, its share of the ${drill(n((s.hero || {}).target), "release.target")} target.`);
  } else {
    steps.push(parts.length > 1
      ? seg`${ch.name} has secured ${u(bar)} units so far: ${parts.map((x) => `${x.name} ${u(x.value)}`).join(", ")}.`
      : seg`${ch.name} has secured ${u(bar)} units so far.`);
    steps.push(seg`Its target by today is ${u(target)} units: its share of the target, spread over the days on its curve.`);
  }
  steps.push(seg`${u(bar)} ÷ ${u(target)} = ${Math.round(p * 100)}%.`);
  return {
    where: "Channels vs targets", when: close ? "At close" : "Today",
    name: `${ch.name} against target`, value: `${Math.round(p * 100)}%`, unit: close ? `of ${ch.name}'s target, projected at close` : `of ${ch.name}'s target by today`,
    say: close ? `How much of its target ${ch.name} is on course to deliver by the close.` : `How much of its target by today ${ch.name} has secured.`,
    steps, total: { v: `${Math.round(p * 100)}%`, label: "of target" },
    compare: bm !== null && finite(bm) ? [{ label: close ? "Benchmark" : "Benchmark today", v: u(bm),
      note: `What this channel typically reaches in the basket's launches${close ? "" : " by now"}: ${ch.name} is at ${pct(ratio(bar, bm))} of it.` }] : [],
    sources: [
      { key: "orders", gave: "Units paid, each order on the channel of its purchase event" },
      { key: "funnel", gave: "Entries still in the draw, by channel" },
      ...(hasBasket(s) ? [{ key: "basket", gave: "The channel's share of the target" }] : []),
    ],
    notes: [
      "A channel's units are its units paid plus its share of the entries still in the draw, scaled so the channels add up to the hero's units secured.",
    ],
    method: "Data model 6.3½",
  };
};

/* A funnel rung's reading against its target (the funnel and the organic funnel cards). */
const RUNG_SOURCES = {
  "Sessions": [["funnel", "Sessions by channel"]],
  "Session → sale": [["funnel", "Sessions and entries by channel"], ["orders", "Units paid by channel"]],
  "Session → buyer": [["funnel", "Sessions and entries by channel"], ["orders", "Buyers by channel"]],
  "Session → entry": [["funnel", "Sessions and entries"]],
  "Delivered emails": [["hubspot", "Emails delivered for this release"]],
  "Open rate": [["hubspot", "Emails delivered and opened"]],
  "Click rate": [["hubspot", "Emails opened and clicked"]],
  "Sessions per click": [["hubspot", "Email clicks"], ["funnel", "AA Email sessions"]],
  "Posts": [["social", "Posts and stories"]],
  "Spend": [["meta", "Spend to date"], ["settings", "The paid budget"]],
  "Cost per secured unit": [["meta", "Spend to date"], ["orders", "Paid's units secured"]],
};
/* the email stages' rates read against the cohort of past sends, not the basket */
const EMAIL_RATES = new Set(["Open rate", "Click rate", "Sessions per click"]);
function fmtRung(v, unit) {
  if (!finite(v)) return "–";
  if (unit === "%") return n(v, 1) + "%";
  if (unit === "eur") return eur(v, Math.abs(v) < 100 ? 2 : 0);
  if (unit === "ratio") return n(v, 2);
  return n(v);
}
EXPLAIN["funnel.rung"] = (a, { snap: s }) => {
  if (!a || !a.label) return null;
  const { group, label, kind, unit, v, target, bm, inv, note } = a;
  const k = a.k ?? (s.benchmark && s.benchmark.k);
  if (!finite(v) || !finite(target) || target === 0) return null;
  const rel = (v / target - 1) * 100;
  const delta = (rel >= 0 ? "+" : MINUS) + Math.abs(Math.round(rel)) + "%";
  const steps = [seg`${label} so far: ${fmtRung(v, unit)}.`];
  const cohort = EMAIL_RATES.has(label);
  if (cohort) {
    steps.push(seg`Its reference is the median across completed draw launches with sends on file: ${fmtRung(target, unit)}.`);
  } else if (finite(bm) && bm !== 0) {
    steps.push(kind === "vol"
      ? seg`The target by today is the basket's ${fmtRung(bm, unit)} lifted ×${n(k, 2)}, the even uplift: ${fmtRung(target, unit)}.`
      : seg`Rates are held at the basket's, so the target is the benchmark itself: ${fmtRung(target, unit)}.`);
  } else {
    steps.push(seg`The plan's figure by today is ${fmtRung(target, unit)}.`);
  }
  steps.push(seg`${fmtRung(v, unit)} against ${fmtRung(target, unit)} is ${delta}${inv ? ": lower is better here, so this is " + (rel <= 0 ? "good" : "bad") : ""}.`);
  const sources = (RUNG_SOURCES[label] || [["funnel", "The rung's actual"]]).map(([key, gave]) => ({ key, gave }));
  if (finite(bm) && !cohort) sources.push({ key: "basket", gave: "The benchmark by today" });
  return {
    where: a.card || "Funnel by channel", when: "Today",
    name: group ? `${group} · ${label}` : label, value: delta, unit: "against target",
    say: `How far ${label.toLowerCase()} is from its target by today, as a share of the target.`,
    steps, total: { v: delta, label: "against target" },
    sources, notes: note ? [note] : [], method: "Data model 9",
  };
};

/* A contributor on the organic funnel card's Adding and Costing lists. */
EXPLAIN["drivers.step"] = (a, { snap: s }) => {
  const g = (s.funnelByGroup || {})[a && a.key];
  if (!g) return null;
  const name = chName(s, a.key);
  const traffic = a.step === "Traffic";
  const v = traffic ? g.contrib_traffic : g.contrib_conversion;
  if (!finite(v)) return null;
  const sa = g.sessions_actual ?? 0, se = g.sessions_expected ?? 0, ca = g.conv_actual ?? 0, ce = g.conv_expected ?? 0;
  const steps = traffic ? [
    seg`${name} had ${n(sa)} sessions against the ${n(se)} the plan expected by today: ${signed(sa - se)}.`,
    seg`Price the difference at the plan's conversion, ${pct(ce, 2)} of sessions becoming units: ${signed(sa - se)} × ${pct(ce, 2)}.`,
  ] : [
    seg`${name} converted ${pct(ca, 2)} of its sessions into units, against the plan's ${pct(ce, 2)}.`,
    seg`Apply the difference to its ${n(sa)} actual sessions: ${n(sa)} × (${pct(ca, 2)} − ${pct(ce, 2)}).`,
  ];
  return {
    where: "Funnel key drivers", when: "Today",
    name: `${name} · ${a.step}`, value: signed(v, 1), unit: "units against the plan by today",
    say: traffic ? `What ${name}'s traffic added or cost against the plan, in units.` : `What ${name}'s conversion added or cost against the plan, in units.`,
    steps, total: { v: signed(v, 1), label: "units" },
    sources: [{ key: "funnel", gave: "Sessions and entries by channel" }, { key: "orders", gave: "Units paid by channel" }],
    notes: ["Each step is repriced one at a time against the plan, so a channel's traffic and conversion add up to its gap to target today."],
    method: "Data model 9",
  };
};

/* ---- paid ---- */
const fullDays = (s) => ((s.paid && s.paid.daily) || []).filter((d) => !d.partial);
function lastThree(s) {
  const rows = fullDays(s);
  if (!rows.length) return null;
  const last = rows[rows.length - 1].date;
  const t = Date.parse(last + "T00:00:00Z");
  const within = rows.filter((d) => t - Date.parse(d.date + "T00:00:00Z") < 3 * 86400000);
  return { rows: within, spend: sum(within.map((d) => d.spend)), entries: sum(within.map((d) => d.entries)), from: within[0].date, to: last };
}

EXPLAIN["paid.cpe"] = (a, { snap: s }) => {
  const p = s.paid || {};
  const drop = p.dropOff ?? 0.2;
  const whole = !!(a && a.whole);
  const v = whole ? p.cumCpe : p.l3dCpe;
  if (!finite(v)) return null;
  let spend, entries, span;
  if (whole) {
    const rows = fullDays(s);
    spend = sum(rows.map((d) => d.spend)); entries = sum(rows.map((d) => d.entries));
    const first = rows.find((d) => (d.spend ?? 0) > 0);
    span = first ? `from ${dayOf(first.date)} to ${dayOf(rows[rows.length - 1].date)}` : "";
  } else {
    const w = lastThree(s);
    if (!w) return null;
    spend = w.spend; entries = w.entries; span = `from ${dayOf(w.from)} to ${dayOf(w.to)}`;
  }
  const conv = entries * (1 - drop);
  return {
    where: "Paid ROI", when: null,
    name: whole ? "Cost per converting entry, whole campaign" : "Cost per converting entry, last 3 days",
    value: eur(v, 2), unit: "per entry that becomes an order",
    say: "What paid spent for each draw entry that goes on to become an order.",
    steps: [
      seg`Add up the spend on the paid campaign ${span}: ${eur(spend)}.`,
      seg`Count the paid entries on those days: ${n(entries, 1)}.`,
      seg`${pct(1 - drop)} of entries become orders, so ${n(entries, 1)} × ${pct(1 - drop)} = ${n(conv, 1)} converting entries.`,
      seg`${eur(spend)} ÷ ${n(conv, 1)} = ${eur(v, 2)}.`,
    ],
    total: { v: eur(v, 2), label: "per converting entry" },
    sources: [
      { key: "meta", gave: "Daily spend on this release's campaigns" },
      { key: "funnel", gave: "Paid Social's eligible entries by day" },
    ],
    notes: ["Only full days count: today so far is left out until it is complete."],
    method: "Data model 7",
  };
};

EXPLAIN["paid.roi"] = (a, c) => {
  const s = c.snap, p = s.paid || {};
  const artist = !!(a && a.party === "artist");
  const whole = !!(a && a.whole) || !!s.complete;
  if (s.targeted === false) return EXPLAIN["paid.cpe"]({ whole }, c);
  const view = artist ? p.artist || {} : p;
  const v = whole ? view.cumRoi : view.l3dRoi;
  const ppu = artist ? view.profitPerUnit : p.profitPerUnitAA;
  const share = artist ? view.budgetShare : p.aaBudgetShare;
  const cann = p.cannibalisation ?? 0.2;
  const cpe = whole ? p.cumCpe : p.l3dCpe;
  if (!finite(v) || !finite(ppu) || !finite(share) || !finite(cpe)) return null;
  const who = artist ? "the artist" : "Avant Arte";
  const Who = artist ? "The artist" : "Avant Arte";
  const net = ppu * (1 - cann);
  const notes = [];
  if (!artist && p.aaBudgetShareAssumed) notes.push("No product records its deal yet, so half the spend is assumed to be Avant Arte's. Type each product's AA profit share (or AA revenue share) on the Target setting tab: the spend divides as the profit does.");
  if (!artist) notes.push("Avant Arte's profit per unit includes the framing uplift, which is Avant Arte's alone.");
  notes.push(whole ? "The whole campaign's full days." : "The last three full days, so the figure moves with the latest spend rather than the campaign's average.");
  return {
    where: "Paid ROI", when: null,
    name: `${artist ? "Artist" : "AA"} ROI${whole ? (s.complete ? ", final" : ", whole campaign") : ", last 3 days"}`,
    value: n(v, 2), unit: `profit back per euro ${who} spends`,
    say: `What ${who} makes on the units paid brings in, for each euro of ${artist ? "their" : "its"} share of the spend.`,
    steps: [
      seg`Start with ${who}'s profit per unit: ${eur(ppu, 2)}.`,
      seg`Take off ${pct(cann)} for sales that would have come anyway: ${eur(net, 2)}.`,
      seg`Divide by what paid spent for each entry that becomes an order, ${drill(eur(cpe, 2), "paid.cpe", { whole })}: ${n(net / cpe, 2)}.`,
      seg`Divide by ${who}'s share of the spend, ${pct(share)}: ${n(net / cpe / share, 2)}.`,
    ],
    total: { v: n(v, 2), label: "ROI" },
    compare: [
      ...(!artist && finite(p.roiTarget) ? [{ label: "Target ROI", v: n(p.roiTarget, 2), note: "The spend rules' target for the last day's forecast." }] : []),
      ...(!whole && finite(view.cumRoi) ? [{ label: "Whole campaign", v: n(view.cumRoi, 2), k: "paid.roi", arg: { party: artist ? "artist" : "aa", whole: true }, note: "The same reading over every full day." }] : []),
    ],
    sources: [
      { key: "settings", gave: `Profit per unit, ${who}'s share of the spend and the cannibalisation` },
      { key: "meta", gave: "The spend" },
      { key: "funnel", gave: "Paid Social's entries" },
    ],
    notes, method: "Data model 7",
  };
};

/* The recommended daily budget. */
/* The rule that set the figure, as the last step (docs 7, 11a). */
function capStep(b) {
  const cur = b.current, cum = b.cumRoi;
  switch (b.cap) {
    case "supply": return seg`The spend that reaches the target is the lower, so it is the figure: more would buy entries the target does not need.`;
    case "roi_floor": return seg`The spend at the ROI floor is the lower, so it is the figure: more would take the ROI at the close under ${n(b.floor ?? 1, 1)}.`;
    case "pacing": return seg`The pacing rule then holds the move to 30% of today's spend, ${eur(cur)} × ${b.recommended >= cur ? "1.3" : "0.7"}: a bigger jump in a day resets Meta's learning, and the price with it.`;
    case "roi_band_hold": return seg`Cumulative ROI is ${n(cum, 2)}, between 0.9 and 1.3, where the spend rules say hold: the budget stays where it is.`;
    case "roi_band_decrease": return seg`Cumulative ROI is ${n(cum, 2)}, below 0.9, where the spend rules say cut, by up to 30% a day.`;
    case "forced_decrease": return seg`The forecast ROI has been below target three days running, which forces a cut.`;
    case "plan_rate": return seg`There is no spend yet to price from, so the first day runs at the plan's daily rate.`;
    case "zero_conversion": return seg`The last day spent and bought no entries, which cuts the budget by 30%.`;
    case "zero_conversion_pause": return seg`Three days of spend with no entries pause the campaign.`;
    case "hold_small_change": return seg`The change would be under 10%, which the spend rules treat as no change.`;
    default: return b.paced ? seg`The pacing rule then holds the move to 30% of today's spend in a day.` : null;
  }
}
EXPLAIN["paid.rec"] = (a, { snap: s }) => {
  const b = (s.paid || {}).budget || {};
  const cur = b.current, rec = b.recommended;
  if (!finite(rec)) return null;
  const steps = [];
  if (finite(cur)) steps.push(seg`Today's daily spend is ${eur(cur)}: the last full day's spend on the campaign.`);
  if (finite(b.supplySpend)) {
    steps.push(finite(b.selloutGap) && finite(b.entriesNeeded)
      ? seg`The spend that would reach the target by the close is ${eur(b.supplySpend)} a day: after units secured and what the organic channels are on course to bring, ${n(b.selloutGap)} units are still needed, ${n(b.entriesNeeded)} entries at the ${pct(rateOf(s))} rate, bought at the cost per entry that spend implies.`
      : seg`The spend that would reach the target by the close is ${eur(b.supplySpend)} a day.`);
  }
  if (finite(b.roiSpend)) steps.push(seg`The spend at which the ROI at the close ends on the floor of ${n(b.floor ?? 1, 1)} is ${eur(b.roiSpend)} a day: the cost per entry rises with spend and with time.`);
  if (finite(b.supplySpend) && finite(b.roiSpend)) steps.push(seg`The lower of the two, ${eur(Math.min(b.supplySpend, b.roiSpend))} a day, is as far as it is worth going.`);
  const rule = capStep(b);
  if (rule) steps.push(rule);
  const move = finite(cur) ? Math.round(rec) - Math.round(cur) : null;
  return {
    where: "Paid spend / day", when: null,
    name: "Recommended daily budget", value: eur(rec), unit: "a day",
    say: "The daily spend worth running from here: enough to reach the target, never past the point where the ROI at the close drops under the floor, moved within the spend rules.",
    steps, total: { v: eur(rec), label: "a day" },
    compare: move !== null ? [{ label: "Change", v: move === 0 ? "none" : (move > 0 ? "+" : MINUS) + "€" + n(Math.abs(move)), note: `Against today's ${eur(cur)}.` }] : [],
    sources: [
      { key: "meta", gave: "Daily spend and the campaign's cost per entry" },
      { key: "funnel", gave: "Paid's entries, and the organic channels' course" },
      { key: "rules", gave: "The ±30% a day pacing, the ROI bands and the floor" },
    ],
    notes: [
      `Cost per entry is priced to rise with daily spend (spend to the power ${n(b.elasticity, 2)}) and by ${pct(b.driftPerDay, 1)} a day.`,
      "Implement writes the figure to Meta and logs it; Ignore logs the decision and keeps the budget.",
    ],
    method: "Data model 7",
  };
};

/* The paid card's bars: units against the paid target, and the spend. */
EXPLAIN["paid.units"] = (a, { snap: s }) => {
  const p = s.paid || {};
  const close = !!(a && a.close);
  const frac = paidDayFrac(s, close);
  const now = p.unitsToDate ?? 0;
  const fill = close ? (s.complete ? now : p.unitProjected ?? now) : now;
  const target = (p.unitTarget ?? 0) * frac;
  const pc = ratio(fill, target);
  if (pc === null) return null;
  return {
    where: "Paid spend / day", when: close ? "At close" : "Today",
    name: "Paid units against target", value: `${Math.round(pc * 100)}%`, unit: close ? "of paid's target, projected at close" : "of paid's target by today",
    say: "The units paid has secured against the share of its target due by now.",
    steps: [
      close ? seg`Paid is projected to secure ${n(fill)} units by the close.` : seg`Paid has secured ${n(fill)} units so far: units paid on its orders plus its share of the entries still in the draw.`,
      close ? seg`Its target is ${n(p.unitTarget)} units.` : seg`Its target is ${n(p.unitTarget)} units over the ${s.of - (p.paidStartDays ?? 1)} days it runs, evenly: ${pct(frac)} of them are gone, so ${n(target)} are due by today.`,
      seg`${n(fill)} ÷ ${n(target)} = ${Math.round(pc * 100)}%.`,
    ],
    total: { v: `${Math.round(pc * 100)}%`, label: "of target" },
    sources: [
      { key: "orders", gave: "Paid's units paid" },
      { key: "funnel", gave: "Paid's entries still in the draw" },
      ...(hasBasket(s) ? [{ key: "basket", gave: "Paid's share of the target" }] : []),
    ],
    notes: ["The same figure as the Paid column on the Channels card."],
    method: "Data model 7",
  };
};

EXPLAIN["paid.spend"] = (a, { snap: s }) => {
  const p = s.paid || {};
  const close = !!(a && a.close);
  if (close && !s.complete && finite(p.spendProjectedTotal)) {
    const days = Math.max((s.of ?? 0) - (s.day ?? 0), 0);
    return {
      where: "Paid spend / day", when: "At close",
      name: "Spend projected at close", value: eur(p.spendProjectedTotal),
      unit: "by the close",
      say: "What the campaign will have spent by the close if today's daily spend carries on.",
      steps: [
        seg`Start from the ${eur(p.spendToDate)} spent so far.`,
        seg`Add today's daily spend of ${eur((p.budget || {}).current)} for each of the ${days} days left, and the rest of today.`,
      ],
      total: { v: eur(p.spendProjectedTotal), label: "projected spend" },
      compare: finite(p.spendBudget) ? [{ label: "Budget", v: eur(p.spendBudget), note: "The paid budget for the campaign." }] : [],
      sources: [{ key: "meta", gave: "Daily spend" }],
      notes: ["The recommendation on this card is not in it: it is the course the campaign is on today."],
      method: "Data model 7",
    };
  }
  if (!((p.spendToDate ?? 0) > 0)) {
    return {
      where: "Paid spend / day", when: null,
      name: "Spend to date", value: eur(0), unit: "spent on Meta ads so far",
      say: "What Meta has charged for this release's ads so far.",
      steps: [s.campaignName
        ? seg`The Meta spend feed has no spend on ${s.campaignName} yet.`
        : seg`No Meta campaign is matched to this release, so there is no spend to add up. Set one on the Target setting tab.`],
      total: { v: eur(0), label: "spent to date" },
      sources: [{ key: "meta", gave: "Spend by day" }, { key: "settings", gave: "Which Meta campaigns are this release's" }],
      notes: [], method: "Data model 7",
    };
  }
  const rows = (p.daily || []);
  const full = rows.filter((d) => !d.partial), part = rows.find((d) => d.partial);
  const fullSpend = sum(full.map((d) => d.spend));
  const first = rows.find((d) => (d.spend ?? 0) > 0);
  return {
    where: "Paid spend / day", when: close ? "At close" : "Today",
    name: "Spend to date", value: eur(p.spendToDate ?? 0),
    unit: "spent on Meta ads so far",
    say: "What Meta has charged for this release's ads so far.",
    steps: [
      seg`Add up the spend on each full day${first ? ` from the first ad on ${dayOf(first.date)}` : ""}${full.length ? ` to ${dayOf(full[full.length - 1].date)}` : ""}: ${eur(fullSpend)}.`,
      ...(part ? [seg`Add today's spend so far: ${eur(part.spend)}.`] : []),
    ],
    total: { v: eur(p.spendToDate), label: "spent to date" },
    compare: finite(p.spendBudget) ? [{ label: close ? "Budget" : "Budget today", v: eur(p.spendBudget * paidDayFrac(s, close)),
      note: close ? "The paid budget for the campaign." : "The budget's even share of the days paid runs." }] : [],
    sources: [
      { key: "meta", gave: `Spend by day on ${((s.campaignNames || [])[0]) || s.campaignName || "the release's campaigns"}` },
      { key: "settings", gave: "Which Meta campaigns are this release's" },
    ],
    notes: [(p.spendCurrency && p.spendCurrency !== "EUR") ? `Meta bills in ${p.spendCurrency}; converted to euros at ${p.spendRate}.` : "In euros, the page's currency."],
    method: "Data model 7",
  };
};

/* ---- sell-through ---- */
EXPLAIN["st.head"] = (a, { snap: s }) => {
  const st = s.sellthrough;
  if (!st) return null;
  const close = !!(a && a.close);
  const ed = finite(st.edition) ? st.edition : null;
  const { sold, drafts, draw } = securedParts(s);
  const future = close ? st.futureEntriesPredicted ?? 0 : 0;
  const units = sold + drafts + draw + future;
  const head = ed ? (close ? st.pct ?? 0 : Math.min(units / ed, 1)) : null;
  const [rSold, rDrafts, rDraw, rFuture] = roundParts([sold, drafts, draw, future], units);
  const steps = [seg`Units paid: ${n(rSold)}.`];
  if (rDrafts > 0) steps.push(seg`Add the draft orders awaiting payment: ${n(rDrafts)}.`);
  if (draw > 0) steps.push(seg`Add the orders expected from the draw: ${drill(n(rDraw), "st.draw")}.`);
  if (close && future > 0) steps.push(seg`Add the units still to come by the close, the projection's further units spread over the room left: ${n(rFuture)}.`);
  if (ed) steps.push(seg`${n(units)} of the ${n(ed)} units in the edition${head >= 1 && units > ed ? ", held at the whole edition" : ""}.`);
  const value = ed ? `${Math.round(head * 100)}%` : n(units);
  return {
    where: "Sell-through by product", when: close ? "At close" : "Today",
    name: close ? "Sell-through at close" : "Sell-through", value, unit: ed ? `of the ${n(ed)} edition` : "units",
    say: close ? "The share of the edition expected to be sold by the close." : "The share of the edition spoken for today: paid, raised on draft orders, or expected from the draw.",
    steps, total: { v: value, label: ed ? "of the edition" : "units" },
    sources: [
      { key: "orders", gave: "Units paid and draft orders, work by work" },
      { key: "entries", gave: "The entries still in the draw" },
      { key: "settings", gave: rateSource(s) },
      ...(close ? [{ key: "funnel", gave: "The projection's further units" }] : []),
    ],
    notes: ["No target or benchmark on this card: it counts against the edition. The rows below add up to it."],
    method: "Data model 6.3",
  };
};

EXPLAIN["st.row"] = (a, { snap: s }) => {
  const st = s.sellthrough || {};
  const r = (st.products || []).find((p) => p.key === (a && a.key));
  if (!r) return null;
  const close = !!(a && a.close);
  const rate = rateOf(s);
  const sold = (r.sold ?? 0) + (r.soldAssumed ?? 0), drafts = finite(r.drafts) ? r.drafts : 0;
  const shown = r.shown ?? 0, future = close ? r.futurePredicted ?? 0 : 0;
  const units = sold + drafts + shown + future;
  const pr = close ? r.pctClose : r.pct;
  const [rSold, rDrafts, rShown, rFuture] = roundParts([sold, drafts, shown, future], units);
  const steps = [(r.soldAssumed ?? 0) > 0.05
    ? seg`Units paid: ${n(rSold)}, of which ${n(r.soldAssumed, 1)} are the release's sales no work is named for, shared out by edition size.`
    : seg`Units paid: ${n(rSold)}.`];
  if (rDrafts > 0) steps.push(seg`Add the draft orders awaiting payment: ${n(rDrafts)}.`);
  if (shown > 0) {
    const pre = st.preorderConversion;
    const held = finite(r.predicted) && r.predicted - shown >= 0.05;
    steps.push(seg`Add the ${n(r.allocated)} units the people still in the draw are counted on here, at ${pct(rate)}${finite(pre) && pre !== rate ? ` (${pct(pre)} for pre-order entries)` : ""}${held ? ", held to the room left" : ""}: ${n(rShown)}.`);
  }
  if (close && future > 0) steps.push(seg`Add its share of the units still to come by the close: ${n(rFuture)}.`);
  if (finite(r.edition) && r.edition > 0) steps.push(seg`${n(units)} of its ${n(r.edition)} edition.`);
  const value = finite(pr) ? `${Math.round(pr * 100)}%` : n(units);
  return {
    where: "Sell-through by product", when: close ? "At close" : "Today",
    name: r.name, value, unit: finite(r.edition) ? `of its ${n(r.edition)} edition` : "units",
    say: `The share of ${r.name}'s edition ${close ? "expected to be sold by the close" : "spoken for today"}.`,
    steps, total: { v: value, label: finite(r.edition) ? "of the edition" : "units" },
    sources: [
      { key: "orders", gave: "Its units paid and draft orders" },
      { key: "entries", gave: "The entries naming it" },
      { key: "settings", gave: "Its name and edition, where typed" },
    ],
    notes: (r.oversubscribed ?? 0) > 0 ? [`${n(r.oversubscribed)} more units of demand than the edition has room for.`] : [],
    method: "Data model 6.3",
  };
};

/* ---- framing ---- */
EXPLAIN["framing.head"] = (a, { snap: s }) => {
  const f = s.framing;
  if (!f) return null;
  const close = !!(a && a.close);
  const fc = f.forecast && f.forecast[close ? "close" : "today"];
  const head = fc && fc.prints > 0 && finite(fc.rate) ? fc : null;
  if (!head) return EXPLAIN["framing.buyers"](a, { snap: s });
  const pt = head.parts || null;
  const steps = [];
  if (pt) {
    const line = (x) => `${n(x.frames)} frames on ${n(x.prints)} prints`;
    steps.push(seg`Paid: ${line(pt.paid)} that a frame was on offer for.`);
    if (pt.drafts && pt.drafts.prints > 0.5) steps.push(seg`Draft orders awaiting payment: ${line(pt.drafts)}.`);
    if (pt.draw && pt.draw.prints > 0.5) steps.push(seg`Orders expected from the draw: ${line(pt.draw)}, at the rate the entrants ask for on their pre-authorisations.`);
    if (close && pt.future && pt.future.prints > 0.5) steps.push(seg`Units still to come by the close: ${line(pt.future)}, at the same rate.`);
  } else {
    steps.push(seg`The ${drill(n(f.prints), "framing.buyers")} paid prints a frame was on offer for went out with ${n(f.frames)} frames.`);
    steps.push(seg`Add the draft orders and the orders expected from the draw${close ? ", and the units still to come" : ""}: ${n(head.prints - f.prints)} more prints with ${n(head.frames - f.frames)} frames, at the rate the entrants ask for.`);
  }
  steps.push(seg`${n(head.frames)} frames ÷ ${n(head.prints)} prints = ${pct(head.rate)}.`);
  return {
    where: "Framing", when: close ? "At close" : "Today",
    name: "Frames per print", value: pct(head.rate), unit: close ? "of prints framed at close" : "of prints framed",
    say: "Of the prints the sell-through counts that a frame is on offer for, the share going out with a frame.",
    steps, total: { v: pct(head.rate), label: "frames per print" },
    compare: [
      ...(finite(f.plan) ? [{ label: "Plan", v: pct(f.plan), k: "framing.plan", arg: {}, note: `The rate the economics assume. ${Math.round(head.rate * 100) - Math.round(f.plan * 100) >= 0 ? "+" : MINUS}${Math.abs(Math.round(head.rate * 100) - Math.round(f.plan * 100))} points against it.` }] : []),
      ...(f.benchmark && finite(f.benchmark.rate) ? [{ label: "Benchmark", v: pct(f.benchmark.rate), k: "framing.bm", arg: {}, note: `The median of ${f.benchmark.n} of the basket's ${f.benchmark.of} launches.` }] : []),
    ],
    sources: [
      { key: "orders", gave: "Prints sold, whether each could be framed, the frames on each order and on the draw's pre-authorisations" },
      { key: "entries", gave: "The orders expected from the draw" },
    ],
    notes: [
      "A frame counts against the print its product code names; on the rare order where it names none, it is shared across the order's prints. A frame per print at most.",
      ...((f.notOffered && f.notOffered.works && f.notOffered.works.length) ? [`No frame is on offer for ${f.notOffered.works.join(", ")}: left out, and counted in the key.`] : []),
    ],
    method: "Data model 6.4",
  };
};

EXPLAIN["framing.buyers"] = (a, { snap: s }) => {
  const f = s.framing;
  if (!f || !(f.prints > 0)) return null;
  const works = f.works || [];
  return {
    where: "Framing", when: null,
    name: "Buyers' frames per print", value: pct(f.rate), unit: "of paid prints went out framed",
    say: "Of the prints paid for that a frame was on offer for, the share bought with a frame.",
    steps: [
      seg`Count the frames on paid orders, a frame per print at most: ${n(f.frames)}.`,
      seg`Divide by the paid prints a frame was on offer for: ${n(f.prints)}.`,
      ...(works.length > 1 ? [seg`By work: ${shortNames(works.map((w) => w.name)).map((nm, i) => `${nm} ${pct(works[i].rate)}`).join(", ")}.`] : []),
    ],
    total: { v: pct(f.rate), label: "frames per print" },
    sources: [{ key: "orders", gave: "Paid prints, the framing option on each, and the frame lines" }],
    notes: (f.notOffered && f.notOffered.units > 0) ? [`${n(f.notOffered.units)} paid units had no frame on offer (${(f.notOffered.works || []).join(", ")}) and are left out.`] : [],
    method: "Data model 6.4",
  };
};

EXPLAIN["framing.entrants"] = (a, { snap: s }) => {
  const e = s.framing && s.framing.entrants;
  if (!e) return null;
  return {
    where: "Framing", when: null,
    name: "Entrants' frames per print", value: pct(e.rate), unit: "of pre-authorised prints with a frame",
    say: "The frames the people still in the draw asked for on their pre-authorisations: the rate the prints still to be won will frame at.",
    steps: [
      seg`Count the frame lines on the app's pre-authorisation drafts: ${n(e.frames)}.`,
      seg`Divide by the prints on those drafts a frame is on offer for: ${n(e.prints)}.`,
    ],
    total: { v: pct(e.rate), label: "frames per print" },
    sources: [{ key: "orders", gave: "The draw's pre-authorisation drafts and their frame lines" }],
    notes: ["A pre-authorisation is what an entrant agrees to pay if they win, so its frames are what allocation brings."],
    method: "Data model 6.4",
  };
};

EXPLAIN["framing.plan"] = (a, { snap: s }) => {
  const f = s.framing;
  if (!f || !finite(f.plan)) return null;
  const e = s.economics || {};
  const typed = (e.products || []).some((p) => p.sources && p.sources.frame_conversion);
  return {
    where: "Framing", when: null,
    name: "Plan", value: pct(f.plan), unit: "of prints framed, as planned",
    say: "The frames per print the release's economics assume.",
    steps: [typed
      ? seg`The works' framing take-up from Airtable or the Target setting tab, weighted by their target units: ${pct(f.plan)}.`
      : seg`No framing take-up is set for these works in Airtable or on the Target setting tab, so the standard ${pct(f.plan)} applies.`],
    total: { v: pct(f.plan), label: "planned frames per print" },
    sources: [typed ? { key: "airtable", gave: "The works' framing take-up" } : { key: "settings", gave: "The standard framing take-up" }],
    notes: ["The plan's framing uplift is in Avant Arte's profit per unit, and so in the paid ROI."],
    method: "Data model 6.4",
  };
};

EXPLAIN["framing.bm"] = (a, { snap: s }) => {
  const b = s.framing && s.framing.benchmark;
  if (!b || !finite(b.rate)) return null;
  return {
    where: "Framing", when: null,
    name: "Benchmark", value: pct(b.rate), unit: "of prints framed in comparable launches",
    say: "What launches like this one typically frame.",
    steps: [
      seg`Of the basket's ${n(b.of)} launches, ${n(b.n)} had 30 or more prints with a frame on offer in the orders feed.`,
      seg`The median of their frames per print is ${pct(b.rate)}.`,
    ],
    total: { v: pct(b.rate), label: "frames per print" },
    sources: [{ key: "basket", gave: "The launches" }, { key: "orders", gave: "Their prints and frames" }],
    notes: ["A launch with fewer than 30 prints on offer says too little about take-up to count."],
    method: "Data model 6.4",
  };
};

/* ---- the waterfall ---- */
function wfView(s, close) {
  const wf = s.waterfall;
  if (!wf) return null;
  const td = !close && wf.today ? wf.today : null;
  const view = td || wf;
  const hasBm = !!s.benchmark && finite(view.benchmark) && Array.isArray(view.stepsBm);
  return { wf, view, today: !!td, hasBm, steps: hasBm ? view.stepsBm : view.steps || [] };
}

EXPLAIN["wf.step"] = (a, { snap: s }) => {
  const w = wfView(s, !!(a && a.close));
  if (!w) return null;
  const step = w.steps.find((x) => x.key === (a && a.key));
  if (!step) return null;
  const refWord = w.hasBm ? "the basket" : "the plan";
  const fbg = s.funnelByGroup || {};
  const p = s.paid || {};
  const cpp = s.targets && s.targets.paid && s.targets.paid.cost_per_purchase;
  const tr = w.hasBm ? "contrib_traffic_bm" : "contrib_traffic";
  const cv = w.hasBm ? "contrib_conversion_bm" : "contrib_conversion";
  const steps = [];
  let say = "";
  const raw = {
    organic_traffic: sum(ORGANIC.map((k) => (fbg[k] || {})[tr])),
    organic_conversion: sum(ORGANIC.map((k) => (fbg[k] || {})[cv])),
  };
  const spent = sum(fullDays(s).map((d) => d.spend));
  const frac = paidDayFrac(s);
  const bmBudget = finite(p.benchmarkBudget) ? p.benchmarkBudget
    : (s.benchmark && s.benchmark.unitsByGroup && finite(cpp)) ? s.benchmark.unitsByGroup.paid * cpp : null;
  const planned = w.hasBm ? (bmBudget ?? 0) * frac : (p.spendBudget ?? 0) * frac;
  raw.paid_spend = finite(cpp) && cpp > 0 ? (spent - planned) / cpp : 0;
  raw.paid_efficiency = ((fbg.paid || {})[tr] ?? 0) + ((fbg.paid || {})[cv] ?? 0) - raw.paid_spend;
  if (step.key === "organic_traffic") {
    say = `What sessions on the organic channels added or cost against ${refWord}, in units.`;
    steps.push(seg`For each organic channel, take its sessions against what ${refWord} had by today, priced at ${refWord}'s conversion: ${ORGANIC.filter((k) => fbg[k]).map((k) => `${chName(s, k)} ${signed((fbg[k] || {})[tr] ?? 0)}`).join(", ")}.`);
  } else if (step.key === "organic_conversion") {
    say = `What the organic channels' conversion added or cost against ${refWord}, in units.`;
    steps.push(seg`For each organic channel, apply its conversion against ${refWord}'s to its actual sessions: ${ORGANIC.filter((k) => fbg[k]).map((k) => `${chName(s, k)} ${signed((fbg[k] || {})[cv] ?? 0)}`).join(", ")}.`);
  } else if (step.key === "paid_spend") {
    say = `What spending more or less than ${w.hasBm ? "the basket's launches" : "the budget"} by now is worth, in units.`;
    steps.push(w.hasBm
      ? seg`Paid has spent ${eur(spent)} over its full days, against ${eur(planned)} of the benchmark budget due by now: the basket's paid units at the plan's cost per unit, spread evenly over the days paid runs.`
      : seg`Paid has spent ${eur(spent)} over its full days, against ${eur(planned)} of its budget due by now, spread evenly over the days paid runs.`);
    steps.push(seg`Price the difference at the plan's cost per unit, ${eur(cpp, 2)}: ${eur(spent - planned)} ÷ ${eur(cpp, 2)} = ${signed(raw.paid_spend)}.`);
  } else if (step.key === "paid_efficiency") {
    say = "What paid's cost per unit added or cost: the rest of paid's gap once its spend is accounted for.";
    const gap = ((fbg.paid || {})[tr] ?? 0) + ((fbg.paid || {})[cv] ?? 0);
    steps.push(seg`Paid's units against ${refWord} by today: ${signed(gap)}.`);
    steps.push(seg`Take away what the spend explains, ${signed(raw.paid_spend)}: ${signed(raw.paid_efficiency)}. Each euro bought ${raw.paid_efficiency < 0 ? "fewer" : "more"} units than the plan's cost per unit assumes.`);
  } else if (step.key === "oversubscribed") {
    say = "Demand past the edition cannot convert, so the walk drops back to the capped figure the hero prints.";
    steps.push(seg`The steps above add up to more units than the ${n(editionTotal(s))} in the edition; the difference comes off.`);
  } else return null;
  const notes = [];
  let reading = raw[step.key];
  if (!w.today && step.key !== "oversubscribed") {
    const tot = raw.organic_traffic + raw.organic_conversion + raw.paid_spend + raw.paid_efficiency;
    const outcome = w.view.projection, start = w.hasBm ? w.view.benchmark : w.view.target;
    const scale = tot ? (outcome - start) / tot : null;
    if (finite(scale)) {
      steps.push(seg`That is the reading to date. At close each contributor is scaled by the same factor, ×${n(scale, 2)}, so the four add up to the projection's ${signed(outcome - start)} against ${w.hasBm ? "the benchmark" : "the target"}.`);
      reading = reading * scale;
    }
  }
  if (finite(reading) && step.key !== "oversubscribed" && Math.round(reading) !== step.value) {
    notes.push(`Worked out, it is ${signed(reading)}; the card prints ${signed(step.value)} because the walk parks its rounding on its largest step, so the steps add up exactly to the gap printed.`);
  }
  return {
    where: w.today ? "Actual vs target" : "Projection vs target", when: w.today ? "Today" : "At close",
    name: step.label, value: signed(step.value), unit: `units against ${w.hasBm ? "the benchmark" : "the target"}`,
    say, steps, total: { v: signed(step.value), label: "units" },
    sources: step.key.startsWith("paid")
      ? [{ key: "meta", gave: "Spend by day" }, { key: "funnel", gave: "Paid's sessions and entries" }, { key: "settings", gave: "The paid budget and cost per unit" }]
      : [{ key: "funnel", gave: "Sessions and entries by channel" }, { key: "orders", gave: "Units paid by channel" }],
    notes: [...notes, w.hasBm
      ? "The walk opens at the target, sets the stretch aside and steps from the benchmark, so the steps add up to the outcome less the benchmark."
      : "The steps add up to the outcome less the target."],
    method: "Data model 9",
  };
};

EXPLAIN["wf.channel"] = (a, { snap: s }) => {
  const ch = channelOf(s, a && a.key);
  if (!ch) return null;
  const close = !!(a && a.close);
  const w = wfView(s, close);
  const hasBm = !!(w && w.hasBm);
  const act = close ? ch.proj ?? 0 : ch.now ?? 0;
  const ref = hasBm ? (close ? ch.bm : ch.bmExp) ?? 0 : (close ? ch.target : ch.exp) ?? 0;
  const v = act - ref;
  return {
    where: close ? "Projection vs target" : "Actual vs target", when: close ? "At close" : "Today",
    name: ch.name, value: signed(v), unit: `units against its ${hasBm ? "benchmark" : "target"}`,
    say: `${ch.name}'s ${close ? "projection" : "units secured"} against what ${hasBm ? "the basket's launches" : "the plan"} had for it${close ? " at close" : " by now"}.`,
    steps: [
      seg`${ch.name} ${close ? "is projected to secure" : "has secured"} ${u(act)} units.`,
      seg`Its ${hasBm ? "benchmark" : "target"}${close ? "" : " by today"} is ${u(ref)}.`,
    ],
    total: { v: signed(v), label: "units" },
    sources: [{ key: "orders", gave: "Units paid by channel" }, { key: "funnel", gave: "Entries by channel" }, ...(hasBm ? [{ key: "basket", gave: "The benchmark" }] : [])],
    notes: ["The channels add up to the release's demand, so on a sold-out release the last step drops to the capped figure."],
    method: "Data model 9",
  };
};

EXPLAIN["wf.stretch"] = (a, { snap: s }) => {
  const close = !!(a && a.close);
  const w = wfView(s, close);
  if (!w || !w.hasBm) return null;
  const t = w.view.target, b = w.view.benchmark;
  return {
    where: close ? "Projection vs target" : "Actual vs target", when: close ? "At close" : "Today",
    name: "Stretch", value: signed(b - t), unit: "units: the target's ambition above the basket",
    say: "The part of the gap to target that is ambition rather than performance: what the business asked for over what launches like this one reach.",
    steps: [
      seg`The target${close ? "" : " by today"} is ${drill(n(t), "hero.target", { close })}.`,
      seg`The benchmark${close ? "" : " by today"} is ${drill(n(b), "hero.bm", { close })}.`,
      seg`${n(b)} − ${n(t)} = ${signed(b - t)}.`,
    ],
    total: { v: signed(b - t), label: "units" },
    sources: [{ key: "settings", gave: "The target" }, { key: "basket", gave: "The benchmark" }],
    notes: ["The steps below it read against the basket, so the stretch plus the steps is the whole gap to target."],
    method: "Data model 4a.1",
  };
};

EXPLAIN["wf.net"] = (a, c) => {
  const ex = EXPLAIN["hero.delta"](a, c);
  return ex && { ...ex, notes: ["The steps below the bar add up to it: the stretch, then each contributor against the basket."] };
};

/* ---- the trajectory ---- */
EXPLAIN["traj.end"] = (a, c) => {
  const s = c.snap;
  if (!a) return null;
  if (a.sel === "all" || !a.sel) {
    if (a.byChannel) return EXPLAIN["hero.proj"]({ close: true }, c);
    const h = s.hero || {};
    if (!finite(h.projected) || !finite(h.target) || !h.target) return null;
    const p = Math.round((h.projected / h.target) * 100);
    return {
      where: "Unit trajectory", when: "At close",
      name: "Projected against target", value: `${p}%`, unit: "of the target at close",
      say: "Where the dashed projection ends, as a share of the target.",
      steps: [
        seg`The projection at close is ${drill(n(h.projected), "hero.proj", { close: true })} units.`,
        seg`The target is ${drill(n(h.target), "hero.target", { close: true })}.`,
        seg`${n(h.projected)} ÷ ${n(h.target)} = ${p}%.`,
      ],
      total: { v: `${p}%`, label: "of target" },
      sources: [{ key: "funnel", gave: "The channels' course" }, { key: "meta", gave: "Paid's spend and cost per entry" }],
      notes: ["The line between today and the close follows each channel's usual shape, not a straight line."],
      method: "Data model 5.4",
    };
  }
  const ch = channelOf(s, a.sel);
  if (!ch || !finite(ch.target) || !ch.target) return null;
  const p = Math.round(((ch.proj ?? 0) / ch.target) * 100);
  return {
    where: "Unit trajectory", when: "At close",
    name: `${ch.name} projected against target`, value: `${p}%`, unit: `of ${ch.name}'s target at close`,
    say: `Where ${ch.name}'s projection ends, as a share of its target.`,
    steps: [
      seg`${ch.name} has secured ${u(ch.now)} units and is projected to reach ${u(ch.proj)} by the close.`,
      seg`Its target is ${u(ch.target)}.`,
      seg`${u(ch.proj)} ÷ ${u(ch.target)} = ${p}%.`,
    ],
    total: { v: `${p}%`, label: "of target" },
    sources: [{ key: "funnel", gave: "The channel's entries and sales" }, { key: "curves", gave: "The channel's usual shape" }],
    notes: ["A single channel's demand is its own and is not capped at the edition."],
    method: "Data model 5.4",
  };
};

EXPLAIN["traj.group"] = (a, { snap: s }) => {
  const ch = channelOf(s, a && a.key);
  if (!ch || !finite(a.value)) return null;
  const ahead = !!a.ahead;
  const total = a.total;
  const scale = ahead ? ratio(a.value, ch.proj) : ratio(a.value, ch.now);
  const steps = [seg`${ch.name} has secured ${u(ch.now)} units so far.`];
  if (ahead) steps.push(seg`Its projection adds ${u(Math.max((ch.proj ?? 0) - (ch.now ?? 0), 0))} more by the close: ${u(ch.proj)}.`);
  if (scale !== null && Math.abs(scale - 1) > 0.005) steps.push(seg`The total is held at the edition, so every channel is scaled by the same factor, ×${n(scale, 3)}: ${u(a.value)}.`);
  if (finite(total) && total > 0) steps.push(seg`That is ${pct(a.value / total)} of the ${n(total)} ${ahead ? "projected at close" : "secured to date"}.`);
  return {
    where: "Unit trajectory · By channel", when: ahead ? "At close" : "Today",
    name: ch.name, value: n(a.value), unit: ahead ? "units projected at close" : "units secured to date",
    say: `${ch.name}'s part of the total, the band it contributes under the line.`,
    steps, total: { v: n(a.value), label: "units" },
    sources: [{ key: "orders", gave: "Units paid by channel" }, { key: "funnel", gave: "Entries by channel, and the course" }],
    notes: ["The bands add up to the line: secured to today, projected after."],
    method: "Data model 6.3½",
  };
};

/* ---- the campaign clock ---- */
EXPLAIN["launch.days"] = (a, { snap: s }) => {
  if (!s.windowStart || !s.windowEnd || !s.asOf) return null;
  const D = 86400000, t = (x) => Date.parse(x + "T00:00:00Z");
  const span = Math.round((t(s.windowEnd) - t(s.windowStart)) / D);
  const elapsed = Math.round((t(s.asOf) - t(s.windowStart)) / D);
  const left = span - elapsed;
  if (left <= 0) return null;
  const early = elapsed < 0;
  return {
    where: "Campaign clock", when: null,
    name: "Days to launch", value: `${left} ${left === 1 ? "day" : "days"}`, unit: `to the launch on ${dayOf(s.windowEnd)}`,
    say: "How long the campaign has left, from the day the data runs to.",
    steps: early ? [
      seg`The campaign announces on ${dayOf(s.windowStart)} and launches on ${dayOf(s.windowEnd)}: a ${span}-day window.`,
      seg`The data runs to ${dayOf(s.asOf)}, ${-elapsed} ${elapsed === -1 ? "day" : "days"} before the announce.`,
      seg`${-elapsed} + ${span} = ${left}.`,
    ] : [
      seg`The campaign was announced on ${dayOf(s.windowStart)} and launches on ${dayOf(s.windowEnd)}: a ${span}-day window.`,
      seg`The data runs to ${dayOf(s.asOf)}, day ${elapsed} of the window.`,
      seg`${span} − ${elapsed} = ${left}.`,
    ],
    total: { v: String(left), label: left === 1 ? "day to launch" : "days to launch" },
    sources: [{ key: "dates", gave: "The announce and launch dates" }, { key: "funnel", gave: "The day the data runs to" }],
    notes: [], method: "Data model 1.5",
  };
};

/* The whole edition: the hero's sellout. */
EXPLAIN["release.edition"] = (a, { snap: s }) => {
  const total = editionTotal(s);
  if (!finite(total)) return null;
  const e = s.economics || {};
  const products = (Array.isArray(e.products) ? e.products : []).filter((p) => finite(p.edition));
  const target = s.edition && s.edition.target;
  const steps = products.length > 1 && Math.abs(sum(products.map((p) => p.edition)) - total) < 0.5
    ? [seg`Add up the works' editions: ${shortNames(products.map((p) => p.name)).map((nm, i) => `${nm} ${n(products[i].edition)}`).join(", ")}.`]
    : [seg`The edition is ${n(total)} units, as recorded for the release.`];
  return {
    where: "Units vs target", when: null,
    name: "Sellout", value: n(total), unit: "units in the edition",
    say: "Every unit there is to sell: the right-hand end of the bar.",
    steps, total: { v: n(total), label: "units in the edition" },
    compare: finite(target) && target < total ? [{ label: "Target", v: n(target), k: "release.target", arg: {}, note: `${pct(target / total)} of the edition.` }] : [],
    sources: [products.length ? { key: "airtable", gave: "Each work's edition" } : { key: "settings", gave: "The edition" }],
    notes: ["Units secured are held at the edition: demand past it is named as oversubscribed, not counted."],
    method: "Data model 6.3½",
  };
};

/* Demand past the sellout, at close. */
EXPLAIN["hero.over"] = (a, { snap: s }) => {
  const h = s.hero || {};
  const total = editionTotal(s);
  const chans = s.channels || [];
  const demand = sum(chans.map((c) => c.proj));
  const over = h.oversubscribedUnits > 0 ? h.oversubscribedUnits : Math.max(demand - (total ?? demand), 0);
  if (!(over > 0)) return null;
  return {
    where: "Units vs target", when: "At close",
    name: "Over sellout", value: "+" + n(over), unit: "units of demand past the edition",
    say: "Demand the edition cannot hold: it cannot convert, so it is named rather than counted.",
    steps: [
      seg`The channels' projections add up to ${n(demand)} units of demand by the close.`,
      seg`The edition holds ${drill(n(total), "release.edition")}.`,
      seg`${n(demand)} − ${n(total)} = ${n(over)} over.`,
    ],
    total: { v: "+" + n(over), label: "over sellout" },
    sources: [{ key: "funnel", gave: "Each channel's course" }, { key: "orders", gave: "Units paid" }],
    notes: ["A single work can be oversubscribed while the release is not: the Sell-through card shows each work's own."],
    method: "Data model 6.3½",
  };
};

/* Units paid, drafts and the units still to come: the sell-through's key. */
EXPLAIN["st.paid"] = (a, { snap: s }) => {
  const st = s.sellthrough;
  if (!st) return null;
  const w = s.unitsSource === "orders" ? s.salesWindow || null : null;
  const out = w ? st.unitsOutsideWindow || null : null;
  const steps = [w
    ? seg`Count the units on paid orders for this release's works, on every route including the private room, from ${dayOf(w.start)} to ${dayOf(w.end)}: the days every card counts.`
    : seg`Count the units on paid orders for this release's works, on every route including the private room.`];
  if ((st.unattributedSold ?? 0) > 0) steps.push(seg`${n(st.attributedSold)} of them are named by work; the other ${n(st.unattributedSold)} are shared across the works by edition size until the sales feed names them.`);
  const notes = [];
  if (out && out.before > 0) notes.push(`${n(out.before)} units paid before the window opened are not counted.`);
  if (out && out.after > 0) notes.push(`${n(out.after)} units paid after the window shut are not counted.`);
  if (out && out.pending > 0) notes.push(`${n(out.pending)} units paid since ${dayOf(w.end)} count on the next refresh.`);
  notes.push("Refunded, test and merged upsell orders are left out.");
  return {
    where: "Sell-through by product", when: null,
    name: "Units paid", value: n(st.sold ?? 0), unit: "units paid for",
    say: "The units customers have paid for.",
    steps, total: { v: n(st.sold ?? 0), label: "units paid" },
    sources: [{ key: "orders", gave: "Paid order lines, work by work" }],
    notes, method: "Data model 6.3",
  };
};

EXPLAIN["st.drafts"] = (a, { snap: s }) => {
  const st = s.sellthrough;
  if (!st || !finite(st.drafts)) return null;
  const products = Array.isArray(st.products) ? st.products : [];
  const winner = sum(products.map((p) => p.winnerDrafts)), lapsed = sum(products.map((p) => p.winnerDraftsLapsed));
  return {
    where: "Sell-through by product", when: null,
    name: "Draft orders", value: n(st.drafts), unit: "units on orders awaiting payment",
    say: "Orders raised and not yet paid. They take room in the edition like a sale.",
    steps: [
      seg`Count the units on draft orders and orders still pending payment: ${n(st.drafts)}, each held to its work's room left.`,
      ...(winner > 0 ? [winner === 1
        ? seg`1 of them is an order an advisor sent a winner after a failed payment, under 72 hours old.`
        : seg`${n(winner)} of them are orders an advisor sent a winner after a failed payment, under 72 hours old.`] : []),
    ],
    total: { v: n(st.drafts), label: "units on drafts" },
    sources: [{ key: "orders", gave: "Draft and pending orders, work by work" }],
    notes: [
      "The draw's own pre-authorisation drafts are the entries, not drafts: they count in the draw's expected orders.",
      ...(lapsed > 0 ? [`${n(lapsed)} winners' orders unpaid after 72 hours are no longer counted.`] : []),
    ],
    method: "Data model 6.3",
  };
};

EXPLAIN["st.future"] = (a, c) => {
  const s = c.snap, st = s.sellthrough;
  if (!st || !finite(st.futureEntriesPredicted)) return null;
  const h = s.hero || {};
  const more = Math.max((h.projected ?? 0) - (h.now ?? 0), 0);
  return {
    where: "Sell-through by product", when: "At close",
    name: "Still to come", value: n(st.futureEntriesPredicted), unit: "more units by the close",
    say: "The units the projection expects between today and the close, spread over the works with room left.",
    steps: [
      seg`The projection at close adds ${drill(n(more), "hero.proj", { close: true })} units to what is secured today.`,
      seg`Spread over the works with room left, each held to its room: ${n(st.futureEntriesPredicted)}.`,
    ],
    total: { v: n(st.futureEntriesPredicted), label: "still to come" },
    sources: [{ key: "funnel", gave: "The channels' course" }, { key: "orders", gave: "Each work's room left" }],
    notes: [], method: "Data model 6.3",
  };
};

/* A step of the funnel card's walk (the 2 × 2 card prints them). */
EXPLAIN["funnel.step"] = (a, { snap: s }) => {
  if (!a || !finite(a.value)) return null;
  const ref = a.vsBm ? "the benchmark" : "the plan";
  const chain = (a.chain || []).filter(Boolean);
  const steps = [];
  if (a.aText && a.eText) steps.push(seg`${a.label}: ${a.aText} against ${ref}'s ${a.eText}.`);
  if (chain.length > 1) {
    steps.push(seg`${a.group}'s units secured are its stages multiplied together: ${chain.join(" × ")}.`);
    steps.push(seg`Change ${a.label.toLowerCase()} from ${ref}'s figure to the actual, with the stages before it at their actual and the stages after at ${ref}'s. The units move by ${signed(a.value, 1)}.`);
  } else {
    steps.push(seg`The units it moves: ${signed(a.value, 1)}.`);
  }
  return {
    where: "Funnel by channel · Waterfall", when: "Today",
    name: a.full || a.label, value: signed(a.value, 1), unit: `units against ${ref} by today`,
    say: `What ${a.label.toLowerCase()} added or cost against ${a.vsBm ? "the basket's launches" : "the plan"}, in units secured.`,
    steps, total: { v: signed(a.value, 1), label: "units" },
    sources: [{ key: "funnel", gave: "Sessions and entries by channel" }, { key: "orders", gave: "Units paid by channel" },
      ...(/email|open|click/i.test(a.label) ? [{ key: "hubspot", gave: "Emails delivered, opened and clicked" }] : []),
      ...(/spend|cost/i.test(a.label) ? [{ key: "meta", gave: "Spend" }] : [])],
    notes: ["The stages change one at a time, in order, so a channel's steps add up exactly to its gap, and the channels to the page's.",
      ...(a.note ? [`${a.label}: ${a.note}.`] : [])],
    method: "Data model 9",
  };
};

/* The daily spend now, on a release without targets. */
EXPLAIN["paid.current"] = (a, { snap: s }) => {
  const p = s.paid || {};
  const cur = p.budget && p.budget.current;
  if (!finite(cur)) return null;
  const full = fullDays(s);
  const last = full.length ? full[full.length - 1] : null;
  return {
    where: "Paid spend / day", when: null,
    name: "Current daily spend", value: eur(cur), unit: "a day",
    say: "What the matched Meta campaign spent on its last full day.",
    steps: [seg`The spend on ${last ? dayOf(last.date) : "the last full day"} across ${(s.campaignNames || []).length > 1 ? "the release's campaigns" : "the release's campaign"}: ${eur(cur)}.`],
    total: { v: eur(cur), label: "a day" },
    sources: [{ key: "meta", gave: "Daily spend" }, { key: "settings", gave: "Which campaigns are this release's" }],
    notes: ["A recommendation needs targets: set them on the Set up targets tab."],
    method: "Data model 7",
  };
};

/* One explanation, or null: a builder that throws on an odd snapshot shows
 * nothing rather than taking the page down with it. A card that shows a
 * figure another card owns (the waterfall's target, say) names itself with
 * arg.where, so the panel says where the figure was clicked. */
export function explain(k, arg, ctx) {
  const b = EXPLAIN[k];
  if (!b) return null;
  try {
    const ex = b(arg || {}, ctx) || null;
    return ex && arg && arg.where ? { ...ex, where: arg.where } : ex;
  } catch (e) {
    if (typeof console !== "undefined") console.warn(`explain ${k}:`, e);
    return null;
  }
}

/* The explanation as plain text, for the panel's Copy as text. */
export function asText(ex, { release, asOf, sources } = {}) {
  const line = (segs) => segs.map((x) => (typeof x === "string" ? x : x.d)).join("");
  return [
    `${ex.name}: ${ex.value} ${ex.unit}${release ? ` (${release}${asOf ? `, figures to ${asOf}` : ""})` : ""}`,
    ex.say, "",
    ...ex.steps.map((st, i) => `${i + 1}. ${line(st)}`),
    ...(ex.total ? [`= ${ex.total.v} ${ex.total.label}`] : []),
    ...((ex.compare && ex.compare.length) ? ["", ...ex.compare.map((c) => `${c.label}: ${c.v}${c.note ? ". " + c.note : ""}`)] : []),
    "",
    "Sources: " + (sources || []).map((r) => `${r.name} (${r.via}${r.fresh ? ", " + r.fresh : r.set ? ", " + r.set : ""}): ${r.gave}`).join("; "),
    ...(ex.notes || []).map((x) => `Note: ${x}`),
    ...(ex.method ? [`Method: ${ex.method}`] : []),
  ].join("\n");
}
