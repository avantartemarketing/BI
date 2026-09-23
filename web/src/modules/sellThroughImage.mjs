/* The sell-through card as a PNG, for posting to Slack.
 *
 * Slack renders an image, not a React tree, so the card is drawn a second
 * time here on a canvas. Only the DRAWING is repeated: every number, colour
 * and label arrives in the model the card builds from what it is already
 * showing (SellThrough.jsx, `imageModel`), so the picture in Slack cannot
 * disagree with the page it was posted from.
 *
 * It is drawn to stand alone in a channel, which the card on the page does
 * not have to: the release and the campaign day are along the top, the rate
 * and the horizon are named, and the key carries the release's totals. And
 * it is drawn at the width Slack shows a picture inline, about 400 CSS
 * pixels, not the page's, so the type survives the fit.
 *
 * No library. The card is rectangles and text, which the 2D context draws
 * directly, and a dependency loaded from a CDN would be blocked on a page
 * this service serves itself. `.mjs` like shared/, because node loads this
 * file itself in tests/slack_image.mjs to hold its naming rule to Slack's. */

const FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// the page's own tokens (web/src/tokens.css), so the image is the same card
const INK = "#141413";
const MUTED = "#6c6b68";
const CARD = "#ffffff";
const HAIRLINE = "#f2f0ea";
const TRACK = "#ece9e1";
const REF_TRACK = "#f3f6fc";
const BORDER = "#e5e4df";
const AMBER = "#8a5f00";

// The card's own geometry (web/src/modules/SellThrough.jsx and tokens.css),
// in CSS pixels: a wide card, 824 by 320, drawn at `scale` times that. The
// picture is the card as it is on the page, so the layout is the card's
// layout and nothing else: the head with the title, the horizon and the
// rate; the headline with the key beside it; the rows on a pitch shared by
// the count, capped, with the bar half the pitch.
const W = 824;
const H = 320;
const PAD_X = 24;
const PAD_Y = 20;
const HEAD_H = 20;
const LEAD_TOP = PAD_Y + HEAD_H + 4;
const LEAD_H = 36;
const ROWS_TOP = LEAD_TOP + LEAD_H + 10;
const ROWS_H = 196;
const PITCH_MAX = 60;
const NAME_MAX = 260;
const UNITS_W = 92;
const PCT_W = 56;
const COL_GAP = 14;
const BG = "#faf9f5";
const DOT = "#8a7a52";
const DOTTED = "#ddd9cf";

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rad); return; }
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
const fill = (ctx, x, y, w, h, r, color) => { roundRect(ctx, x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); };

/* A segment of a bar: square where it meets its neighbours, rounded at the
 * ends of the run, so a row reads as one bar rather than a row of tiles. */
function segment(ctx, x, y, w, h, color, first, last, radius = 4) {
  if (w <= 0.4) return;
  const r = Math.min(radius, h / 2);
  ctx.save();
  roundRect(ctx, x - (first ? 0 : r), y, w + (first ? 0 : r) - (last ? 0 : r) + (last ? 0 : r), h, r);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/* Product names without the part they all share: three prints called
 * "Don't Let It Bring You Down, It's Only Castles Burning (For Neil Young)
 * I/II/III" become I, II and III. The message beside the picture is composed
 * with this rule (server/slack.js shortNames, which tests/slack_image.mjs
 * holds this to); the picture itself names the products as the card does. */
export function shortNames(names) {
  if (names.length < 2) return names.slice();
  let p = names[0];
  for (const n of names) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  p = p.replace(/[^\s(]*$/, "");   // back to the last space or opening bracket
  if (p.length < 8) return names.slice();
  return names.map((n) => n.slice(p.length).replace(/^[\s(]+|[\s)]+$/g, "") || n);
}

function ellipsis(ctx, text, maxW) {
  const s = String(text ?? "");
  if (ctx.measureText(s).width <= maxW) return s;
  let cut = s;
  while (cut.length > 1 && ctx.measureText(cut + "…").width > maxW) cut = cut.slice(0, -1);
  return cut + "…";
}

/* One chip of the key, as the card draws it: a 9px swatch, the label, the
 * value in ink. Returns the width it took. */
function chip(ctx, x, cy, item, measureOnly = false) {
  let w = 0;
  if (!measureOnly) fill(ctx, x, cy - 4.5, 9, 9, 2, item.color);
  w += 14;
  ctx.font = `400 11.5px ${FONT}`;
  ctx.textAlign = "left";
  if (!measureOnly) { ctx.fillStyle = MUTED; ctx.fillText(String(item.label ?? ""), x + w, cy + 4); }
  w += ctx.measureText(String(item.label ?? "")).width;
  if (item.value !== null && item.value !== undefined) {
    w += 5;
    ctx.font = `600 11.5px ${FONT}`;
    if (!measureOnly) { ctx.fillStyle = INK; ctx.fillText(String(item.value), x + w, cy + 4); }
    w += ctx.measureText(String(item.value)).width;
  }
  return w;
}

/* Draws the card onto a canvas sized for it. `model` is what SellThrough.jsx
 * is showing: see imageModel there. */
export function drawSellThrough(canvas, model, scale = 3) {
  const rows = model.rows || [];
  const n = Math.max(rows.length, 1);
  const pitch = Math.min(PITCH_MAX, Math.floor(ROWS_H / n));
  const barH = Math.floor(pitch / 2);
  const radius = Math.max(4, Math.round(barH / 5));
  const inset = Math.max(2, Math.round(barH * 0.14));
  const innerR = Math.max(2, radius - 2);

  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";

  // the card
  fill(ctx, 0, 0, W, H, 0, CARD);
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 12);
  ctx.stroke();

  // the head: the section dot, the title, the horizon; the rate at the right
  const headCy = PAD_Y + HEAD_H / 2;
  ctx.beginPath();
  ctx.arc(PAD_X + 4, headCy, 4, 0, Math.PI * 2);
  ctx.fillStyle = DOT;
  ctx.fill();
  let x = PAD_X + 8 + 8;
  ctx.font = `600 13.5px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  const title = model.title || "Sell-through by product";
  ctx.fillText(title, x, headCy + 5);
  x += ctx.measureText(title).width + 8;
  if (model.horizon) {
    ctx.font = `600 12.5px ${FONT}`;
    const w = ctx.measureText(model.horizon).width + 16;
    fill(ctx, x, headCy - 10, w, 20, 5, BG);
    ctx.strokeStyle = BORDER;
    roundRect(ctx, x + 0.5, headCy - 9.5, w - 1, 19, 5);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(model.horizon, x + 8, headCy + 4.5);
  }
  if (model.rateLine) {
    ctx.font = `400 12px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(model.rateLine, W - PAD_X, headCy + 4);
    const w = ctx.measureText(model.rateLine).width;
    ctx.save();
    ctx.setLineDash([1, 2]);
    ctx.strokeStyle = DOTTED;
    ctx.beginPath();
    ctx.moveTo(W - PAD_X - w, headCy + 7.5);
    ctx.lineTo(W - PAD_X, headCy + 7.5);
    ctx.stroke();
    ctx.restore();
  }

  // the headline line: the release's figure, and the key beside it
  const leadBase = LEAD_TOP + 29;
  ctx.textAlign = "left";
  ctx.font = `600 32px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(model.headline.text, PAD_X, leadBase);
  const headW = ctx.measureText(model.headline.text).width;
  if (model.headline.sub) {
    ctx.font = `400 12px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(model.headline.sub, PAD_X + headW + 10, leadBase);
  }
  const legend = model.legend || [];
  const keyW = legend.reduce((sum, item) => sum + chip(ctx, 0, 0, item, true), 0) + Math.max(0, legend.length - 1) * 16;
  x = W - PAD_X - keyW;
  for (const item of legend) x += chip(ctx, x, LEAD_TOP + LEAD_H / 2, item) + 16;

  // the rows: one grid, the name column as wide as the longest name up to
  // NAME_MAX, the units and the percentage in columns of their own
  ctx.font = `400 13px ${FONT}`;
  const nameW = Math.min(NAME_MAX, Math.max(...rows.map((r) => ctx.measureText(String(r.name || "")).width), 0));
  const barX = PAD_X + nameW + COL_GAP;
  const barW = W - PAD_X - PCT_W - COL_GAP - UNITS_W - COL_GAP - barX;
  for (const [i, row] of rows.entries()) {
    const top = ROWS_TOP + i * pitch;
    const base = top + pitch / 2 + 4.5;
    ctx.textAlign = "left";
    ctx.font = `400 13px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(ellipsis(ctx, row.name, nameW), PAD_X, base);

    const bt = top + (pitch - barH) / 2;
    fill(ctx, barX, bt, barW, barH, radius, TRACK);
    const maxV = row.maxV > 0 ? row.maxV : 1;
    const px = (v) => Math.max(0, Math.min((v / maxV) * barW, barW));
    if (row.edition > 0) fill(ctx, barX, bt, px(row.edition), barH, radius, REF_TRACK);
    const segs = (row.segs || []).filter((s) => s.v > 0);
    let at = 0;
    segs.forEach((s, k) => {
      const x0 = px(at); at += s.v;
      segment(ctx, barX + x0, bt + inset, px(at) - x0, barH - inset * 2, s.color, k === 0, k === segs.length - 1 && !(row.over > 0), innerR);
    });
    if (row.over > 0 && row.edition > 0) {
      const x0 = px(row.edition);
      segment(ctx, barX + x0, bt + inset, px(row.edition + row.over) - x0, barH - inset * 2, row.overColor, false, true, innerR);
    }

    ctx.textAlign = "right";
    if (row.unitsText) {
      ctx.font = `400 12.5px ${FONT}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(String(row.unitsText), W - PAD_X - PCT_W - COL_GAP, base);
    }
    if (row.pctText) {
      ctx.font = `600 13px ${FONT}`;
      ctx.fillStyle = INK;
      ctx.fillText(String(row.pctText), W - PAD_X, base);
    }
  }

  // the stamp the card wears while a feed is missing, over the rows
  if (model.note) {
    const text = "INCOMPLETE DATA";
    ctx.save();
    ctx.translate(W / 2, ROWS_TOP + (rows.length * pitch) / 2);
    ctx.rotate(-7 * Math.PI / 180);
    ctx.font = `700 12px ${FONT}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "1.4px";
    const w = ctx.measureText(text).width + 24;
    fill(ctx, -w / 2, -14, w, 28, 6, "rgba(255,254,251,0.78)");
    ctx.lineWidth = 2;
    ctx.strokeStyle = AMBER;
    roundRect(ctx, -w / 2, -14, w, 28, 6);
    ctx.stroke();
    ctx.fillStyle = AMBER;
    ctx.textAlign = "center";
    ctx.fillText(text, 0, 4.5);
    ctx.restore();
  }
  return canvas;
}

/* The card as a PNG Blob. Waits for the page's own face to load first, so
 * the image is set in Inter like the page and not in a fallback. */
export async function sellThroughPng(model, { scale = 3 } = {}) {
  if (typeof document === "undefined") throw new Error("no document to draw on");
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* draw in whatever is loaded */ }
  }
  const canvas = document.createElement("canvas");
  drawSellThrough(canvas, model, scale);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("the browser could not make a PNG of the card");
  return blob;
}
