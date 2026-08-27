/* The LE target model (docs/DATA_MODEL.md §3) as one pure function, shared by the
 * server (snapshot retargeting on save, via dynamic import) and the web app (live rail).
 * Kept in exact agreement with etl/build.py compute_targets/group_targets. */

export const ORGANIC_CHANNELS = [
  "AA Email Auto", "AA Email Man", "AA Meta", "AA Other", "AA X", "Direct",
  "Organic Search", "Other", "Referral Artist", "Referral Meta", "Referral Other", "Referral X",
];

// Display grouping (docs §1.3); private-room units ride with aa_email (workbook convention).
export const GROUP_CHANNELS = {
  aa_email: ["AA Email Auto", "AA Email Man"],
  aa_social: ["AA Meta", "AA X"],
  referral_artist: ["Referral Artist"],
  search_direct_other: ["Direct", "Organic Search", "Other", "AA Other",
    "Referral Meta", "Referral Other", "Referral X"],
};

const SIZE_PICK = { Small: "Low", Medium: "Medium", Large: "High", Low: "Low", High: "High" };

export function computeTargets(inp, b) {
  const size = inp.edition_size || 0;
  const paidPct = b.paid_share_of_units[SIZE_PICK[inp.paid_channel_size]];
  const paidUnits = Math.round(size * paidPct);
  const organicUnits = size - paidUnits;
  const prPct = b.pv_other_share_of_units[inp.reference_point];
  const prUnits = organicUnits * prPct;
  const drawUnits = organicUnits - prUnits;

  const qualityFor = (c) =>
    (inp.channel_quality_overrides && inp.channel_quality_overrides[c]) ||
    inp.channel_quality_default[c];

  let shareSum = 0;
  const rawShares = {};
  for (const c of ORGANIC_CHANNELS) {
    const q = qualityFor(c);
    rawShares[c] = q === "N/A" ? 0 : b.order_split[c][q];
    shareSum += rawShares[c];
  }

  const e2o = b.eligible_entry_to_order;
  const perChannel = {};
  let organicEntries = 0, organicSessions = 0;
  for (const c of ORGANIC_CHANNELS) {
    const q = qualityFor(c);
    const split = shareSum ? rawShares[c] / shareSum : 0;
    const purchases = drawUnits * split;
    const entries = purchases / e2o;
    const conv = q === "N/A" ? 0 : b.session_to_eligible_entry[c][q];
    const sessions = conv ? entries / conv : 0;
    perChannel[c] = { quality: q, order_split: split, purchases, eligible_entries: entries,
      sessions, session_to_entry: conv };
    organicEntries += entries;
    organicSessions += sessions;
  }

  const prSessions = prUnits / b.email_session_to_purchase;
  const paidConv = b.paid_session_to_eligible_entry[inp.paid_conv_quality];
  const paidEntries = paidUnits / e2o;
  const paidSessions = paidEntries / paidConv;
  const cpp = b.cost_per_purchase[inp.cpp_pick];
  const budget = cpp * paidUnits;
  const launchValue = size * (inp.unit_price || 0);

  const groupUnits = {};
  const groupEntries = {};
  const groupSessions = {};
  for (const [g, chans] of Object.entries(GROUP_CHANNELS)) {
    let purch = 0, ent = 0, sess = 0;
    for (const c of chans) {
      purch += perChannel[c].purchases;
      ent += perChannel[c].eligible_entries;
      sess += perChannel[c].sessions;
    }
    groupUnits[g] = purch + (g === "aa_email" ? prUnits : 0);
    groupEntries[g] = ent;
    groupSessions[g] = sess;
  }
  groupUnits.paid = paidUnits;
  groupEntries.paid = paidEntries;
  groupSessions.paid = paidSessions;

  const framing = inp.framing_available !== false;
  const ppuArtist = size ? (inp.artist_profit || 0) / size : 0;
  const ppuAA = size ? (inp.aa_group_profit || 0) / size + (framing ? b.frame_conversion * b.frame_profit_per_unit : 0) : 0;

  return {
    edition_size: size, paid_pct: paidPct, paid_units: paidUnits,
    organic_units: organicUnits, pr_other_pct: prPct, pr_units: prUnits, draw_units: drawUnits,
    per_channel: perChannel, pr_sessions: prSessions,
    paid: {
      units: paidUnits, eligible_entries: paidEntries, sessions: paidSessions,
      session_to_entry: paidConv, cost_per_purchase: cpp, budget,
      budget_pct_of_launch_value: launchValue ? budget / launchValue : null,
      sense_check_breached: launchValue ? budget / launchValue > b.budget_sense_check_max_pct_of_launch_value : false,
    },
    launch_value: launchValue,
    organic_sessions_draw: organicSessions,
    total_sessions: organicSessions + prSessions + paidSessions,
    entries_target: organicEntries + paidEntries,
    group_units: groupUnits, group_entries: groupEntries, group_sessions: groupSessions,
    ppu_artist: ppuArtist, ppu_aa: ppuAA,
    buffer: b.target_buffer,
  };
}
