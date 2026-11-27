/* The plan's pieces as the table lists them (modules/PlanCard.jsx, "The plan,
 * piece by piece"): a column per fact. The build names a piece in one phrase
 * that carries its sender, what it is, how many and whether it went
 * ("Avant Arte posts and stories (6)", "Artist post and story (dropped)",
 * "Email to 5,000 people, planned": etl/plan_view.py card_rows); here that is
 * read apart, so the sender is the Channel column, the row's mark says where
 * the piece stands, and the Description says what it is and no more.
 *
 * Nothing is worked out here that the build does not already say: the channel
 * is the piece's own `who`, and the words are the build's, less the sender. */

/* the channel a piece went on, as the page names its channels (the two a
 * phase's last lines carry, what search and later arrivals brought and the
 * paid budget, have no sender and are named by what they are) */
export const CHANNELS = {
  email: { name: "AA Email", color: "#b98a00" },
  aa: { name: "AA Social", color: "#1877f2" },
  artist: { name: "Artist", color: "#0f7052" },
  other: { name: "Partner", color: "#8a8a8e" },
  paid: { name: "Paid", color: "#5e6ad2" },
  tail: { name: "", color: "#8a8a8e" },
};

const lead = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/* "Posts and stories (6)" as "6 posts and stories"; a pair of the two kinds is
 * one of each (the build counts two and names both: _post_groups), so it reads
 * as the artist's pair does, "Post and story" */
function counted(s) {
  const m = /^(.*) \((\d+)\)$/.exec(s);
  if (!m) return lead(s);
  if (m[2] === "2" && /^posts and stories$/i.test(m[1])) return "Post and story";
  return `${m[2]} ${lower(m[1])}`;
}

/* A piece read apart: { channel, what, state, share }.
 *   channel  the key into CHANNELS
 *   what     the build's words less the sender, the count first
 *   state    "sent", "to come" (its day is ahead of the page's, the build says
 *            the email is planned, or it has no day and nothing in) or "dropped"
 *   share    how much of its plan it has brought, 0 to 1 (1 with no plan and
 *            something in): what the row's mark draws
 * `asOf` is the page's day (snap.asOf); `x` a piece as PlanCard's model has
 * it, with its whole units (`exp`, `inn`). */
export function describe(x, asOf) {
  let name = String(x.name || ""), state = "sent";
  if (/ \(dropped\)$/.test(name)) { name = name.replace(/ \(dropped\)$/, ""); state = "dropped"; }
  if (/, planned$/.test(name)) { name = name.replace(/, planned$/, ""); if (state === "sent") state = "to come"; }
  if (state === "sent" && ((x.date && asOf && String(x.date).slice(0, 10) > String(asOf).slice(0, 10)) || name === "Email, audience not set")) state = "to come";
  // a line with no day of its own (what search and later arrivals brought, the paid budget still to spend) is to come until something is in
  if (state === "sent" && !x.date && !(Number(x.inn) > 0)) state = "to come";
  const channel = CHANNELS[x.who] ? x.who : "tail";
  let what = name;
  if (x.who === "artist") what = name === "Artist's own email" ? "Email" : counted(name.replace(/^Artist /, ""));
  else if (x.who === "aa") what = counted(name.replace(/^Avant Arte /, ""));
  else if (x.who === "other") what = counted(name.replace(/^Partner /, ""));
  const exp = Number(x.exp) || 0, inn = Number(x.inn) || 0;
  const share = exp > 0 ? Math.min(Math.max(inn / exp, 0), 1) : inn > 0 ? 1 : 0;
  return { channel, what, state, share };
}

/* The pieces in date order: a day's in the order the plan lists them (its emails, then its posts, the bigger
 * first, and an earlier phase's before a later one's), and a line with no day of its own last. */
export function byDay(pieces) {
  const day = (x) => (x.date ? String(x.date).slice(0, 10) : "9999-99-99");
  return pieces.map((x, i) => [x, i]).sort((a, b) => (day(a[0]) < day(b[0]) ? -1 : day(a[0]) > day(b[0]) ? 1 : a[1] - b[1])).map(([x]) => x);
}

/* how many rows the table shows before it folds the rest away: a list one
 * longer than the cap is shown whole, since a fold that hides one row takes
 * the room of the row it hides */
export const ROWS_SHOWN = 8;
export const foldAt = (n, cap = ROWS_SHOWN) => (n > cap + 1 ? cap : n);
