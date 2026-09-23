/* The release's economics as the Target setting form prints them: the launch
 * value and the two profits per unit, with the framing uplift's terms. A
 * mirror of frame_terms() and aa_profit_per_unit() in etl/build.py, so the
 * form says what the build will; blank frame inputs mean the benchmark
 * defaults (the workbook's 0.35 take-up x £94 per frame). */
export function computeEconomics(inp, b) {
  const size = Number(inp.edition_size) || 0;
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const framing = inp.framing_available !== false;
  const frameConv = Math.min(Math.max(num(inp.frame_conversion) ?? Number(b.frame_conversion), 0), 1);
  const frameProfit = Math.max(num(inp.frame_profit_per_unit) ?? Number(b.frame_profit_per_unit), 0);
  const ppuArtist = size ? (Number(inp.artist_profit) || 0) / size : 0;
  const ppuAA = size ? (Number(inp.aa_group_profit) || 0) / size + (framing ? frameConv * frameProfit : 0) : 0;
  return {
    edition_size: size,
    launch_value: size * (Number(inp.unit_price) || 0),
    ppu_artist: ppuArtist, ppu_aa: ppuAA,
    frame_conversion: frameConv, frame_profit_per_unit: frameProfit,
    frame_uplift_per_unit: framing ? frameConv * frameProfit : 0,
  };
}
