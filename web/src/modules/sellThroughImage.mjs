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
 * and the horizon are named, and the key carries the release's totals.
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
const REF_TRACK = "#faf7f4";
const BORDER = "#e5e4df";
const AMBER = "#8a5f00";

// layout, in CSS pixels; the canvas is drawn at `scale` times this
const W = 1180;
const PAD = 36;
const NAME_W = 300;
const FIG_W = 156;
const GAP = 20;
const BAR_X = PAD + NAME_W + GAP;
const BAR_W = W - PAD - FIG_W - GAP - BAR_X;
const BAR_H = 26;
const ROW_H = 46;

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
function segment(ctx, x, y, w, h, color, first, last) {
  if (w <= 0.4) return;
  const r = Math.min(4, h / 2);
  ctx.save();
  roundRect(ctx, x - (first ? 0 : r), y, w + (first ? 0 : r) - (last ? 0 : r) + (last ? 0 : r), h, r);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/* Product names without the part they all share: three prints called
 * "Don't Let It Bring You Down, It's Only Castles Burning (For Neil Young)
 * I/II/III" become I, II and III. The card can truncate and lean on its
 * hover; a picture in a channel cannot, and three rows reading the same
 * cut-off sentence say nothing at all. The same rule composes the message
 * beside it - server/slack.js shortNames, which tests/slack_image.mjs holds
 * this to. */
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

const height = (model) => {
  const rows = (model.rows || []).length;
  return 150 + rows * ROW_H + 30 + (model.note ? 26 : 0) + PAD;
};

/* Draws the card onto a canvas sized for it. `model` is what SellThrough.jsx
 * is showing: see imageModel there. */
export function drawSellThrough(canvas, model, scale = 2) {
  const H = height(model);
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

  let y = PAD + 18;
  // release and campaign day
  ctx.font = `600 22px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.fillText(ellipsis(ctx, model.releaseName || "", W - PAD * 2 - 260), PAD, y);
  if (model.dayLine) {
    ctx.font = `400 14px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(model.dayLine, W - PAD, y);
  }

  y += 16;
  ctx.fillStyle = HAIRLINE;
  ctx.fillRect(PAD, y, W - PAD * 2, 1);

  // the card's own title, the horizon, and the rate it counts at
  y += 30;
  ctx.textAlign = "left";
  ctx.font = `600 16px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(model.title || "Sell-through by product", PAD, y);
  const titleW = ctx.measureText(model.title || "Sell-through by product").width;
  if (model.horizon) {
    ctx.font = `500 12px ${FONT}`;
    const w = ctx.measureText(model.horizon).width + 16;
    fill(ctx, PAD + titleW + 10, y - 13, w, 20, 5, "#faf9f5");
    ctx.strokeStyle = BORDER;
    roundRect(ctx, PAD + titleW + 10.5, y - 12.5, w - 1, 19, 5);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(model.horizon, PAD + titleW + 18, y + 2);
  }
  if (model.rateLine) {
    ctx.font = `400 13px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(model.rateLine, W - PAD, y);
  }

  // the headline
  y += 46;
  ctx.textAlign = "left";
  ctx.font = `600 40px ${FONT}`;
  ctx.fillStyle = model.headline.color || INK;
  ctx.fillText(model.headline.text, PAD, y);
  const headW = ctx.measureText(model.headline.text).width;
  if (model.headline.sub) {
    ctx.font = `400 15px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(model.headline.sub, PAD + headW + 12, y);
  }

  // the products, named by what tells them apart
  y += 22;
  const names = shortNames((model.rows || []).map((r) => String(r.name || "")));
  for (const [i, row] of (model.rows || []).entries()) {
    const top = y + (ROW_H - BAR_H) / 2;
    ctx.textAlign = "left";
    ctx.font = `400 15px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(ellipsis(ctx, names[i], NAME_W), PAD, top + BAR_H / 2 + 5);

    // track, then the room out to the sellout, then the segments
    fill(ctx, BAR_X, top, BAR_W, BAR_H, 7, TRACK);
    const maxV = row.maxV > 0 ? row.maxV : 1;
    const px = (v) => Math.max(0, Math.min((v / maxV) * BAR_W, BAR_W));
    if (row.edition > 0) fill(ctx, BAR_X, top, px(row.edition), BAR_H, 7, REF_TRACK);
    const inset = 5;
    const segs = (row.segs || []).filter((s) => s.v > 0);
    let at = 0;
    segs.forEach((s, k) => {
      const x0 = px(at); at += s.v;
      segment(ctx, BAR_X + x0, top + inset, px(at) - x0, BAR_H - inset * 2, s.color, k === 0, k === segs.length - 1 && !(row.over > 0));
    });
    if (row.over > 0 && row.edition > 0) {
      const x0 = px(row.edition);
      segment(ctx, BAR_X + x0, top + inset, px(row.edition + row.over) - x0, BAR_H - inset * 2, row.overColor, false, true);
    }

    // the figures
    ctx.textAlign = "right";
    let right = W - PAD;
    if (row.ratioText) {
      ctx.font = `400 12px ${FONT}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(row.ratioText, right, top + BAR_H / 2 + 5);
      right -= ctx.measureText(row.ratioText).width + 7;
    }
    ctx.font = `600 19px ${FONT}`;
    ctx.fillStyle = row.pctColor || INK;
    ctx.fillText(row.pctText, right, top + BAR_H / 2 + 6);
    y += ROW_H;
  }

  // the key, with the release's totals
  y += 8;
  ctx.fillStyle = HAIRLINE;
  ctx.fillRect(PAD, y, W - PAD * 2, 1);
  y += 24;
  ctx.textAlign = "left";
  let x = PAD;
  for (const item of model.legend || []) {
    fill(ctx, x, y - 9, 10, 10, 2, item.color);
    x += 16;
    ctx.font = `400 13.5px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(item.label, x, y);
    x += ctx.measureText(item.label).width + 7;
    if (item.value !== null && item.value !== undefined) {
      ctx.font = `600 13.5px ${FONT}`;
      ctx.fillStyle = INK;
      ctx.fillText(item.value, x, y);
      x += ctx.measureText(item.value).width;
    }
    x += 22;
  }

  if (model.note) {
    y += 26;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = AMBER;
    ctx.fillText(model.note, PAD, y);
  }
  return canvas;
}

/* The card as a PNG Blob. Waits for the page's own face to load first, so
 * the image is set in Inter like the page and not in a fallback. */
export async function sellThroughPng(model, { scale = 2 } = {}) {
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
