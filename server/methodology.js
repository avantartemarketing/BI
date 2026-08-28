/* GET /methodology - docs/METHODOLOGY.md rendered as a tidy standalone page.
 * Tiny renderer for the subset of markdown that file uses (headings, paragraphs,
 * lists, tables, fenced code, `code`, **bold**, links, hr). Cached by mtime. */
const fs = require("fs");
const path = require("path");

const MD_PATH = path.resolve(__dirname, "..", "docs", "METHODOLOGY.md");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function render(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  const isTableRow = (l) => /^\|.*\|\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(esc(lines[i++]));
      i++;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push(`<h${lvl} id="${id}">${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (isTableRow(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push("<table><thead><tr>" + head.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const re = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      const items = [];
      // an item continues over indented follow-on lines
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>` + items.map((it) => `<li>${inline(it)}</li>`).join("") + `</${tag}>`);
      continue;
    }
    // paragraph: gather until a blank or block starter
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,3}\s|```|---+\s*$|[-*]\s|\d+\.\s|\|)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

const PAGE = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Methodology · Launch Performance</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #faf9f5; color: #141413; font-family: "Inter", -apple-system, sans-serif;
         font-feature-settings: "cv05","ss01"; font-size: 14.5px; line-height: 1.65; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 28px 96px; }
  h1 { font-size: 26px; letter-spacing: -0.015em; line-height: 1.25; margin: 0 0 8px; }
  h2 { font-size: 18px; letter-spacing: -0.01em; margin: 40px 0 10px; padding-top: 18px; border-top: 1px solid #e5e4df; }
  h3 { font-size: 15px; margin: 26px 0 8px; }
  h1, h2, h3 { font-weight: 600; }
  p { margin: 0 0 14px; }
  hr { border: none; border-top: 1px solid #e5e4df; margin: 32px 0; }
  a { color: #8f3415; }
  code { background: #f2f0ea; border-radius: 4px; padding: 1px 5px; font-size: 13px;
         font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  pre { background: #ffffff; border: 1px solid #e5e4df; border-radius: 10px; padding: 14px 18px;
        overflow-x: auto; margin: 0 0 16px; }
  pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.6; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 16px; font-size: 13.5px; }
  th, td { text-align: left; padding: 7px 12px; border-bottom: 1px solid #ece9e1; vertical-align: top; }
  th { font-weight: 600; font-size: 12.5px; color: #6c6b68; border-bottom: 1px solid #d9d5ca; }
  ul, ol { margin: 0 0 14px; padding-left: 24px; }
  li { margin-bottom: 5px; }
  .top { font-size: 12.5px; margin-bottom: 28px; }
  .top a { color: #6c6b68; text-decoration: none; }
  .top a:hover { color: #141413; }
</style></head><body><main>
<div class="top"><a href="/">&larr; Back to the dashboard</a></div>
${body}
</main></body></html>`;

let cache = null; // { mtimeMs, html }

function install(app) {
  app.get("/methodology", (_req, res) => {
    try {
      const { mtimeMs } = fs.statSync(MD_PATH);
      if (!cache || cache.mtimeMs !== mtimeMs) {
        cache = { mtimeMs, html: PAGE(render(fs.readFileSync(MD_PATH, "utf8"))) };
      }
      res.type("html").send(cache.html);
    } catch (e) {
      res.status(500).type("text").send("methodology page unavailable: " + e.message);
    }
  });
}

module.exports = { install, render };
