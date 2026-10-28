/* The Agent's answers as the chat shows them: a small part of Markdown
 * (paragraphs, bullet and numbered lists, tables, bold, italics, inline
 * code) with the charts placed where the answer puts their markers
 * ([[chart-1]] on a line of its own). Built as React elements, never as
 * HTML, so nothing in an answer can run in the page. */
import React from "react";
import AgentChart from "./AgentChart.jsx";

const MARK = /\[\[(chart-\d+)\]\]/g;

function inline(text, key) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<b key={`${key}-${i++}`}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("`")) out.push(<code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>);
    else out.push(<i key={`${key}-${i++}`}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function AnswerText({ text, charts }) {
  const byId = new Map((charts || []).map((c) => [c.id, c.spec]));
  const placed = new Set();
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let i = 0, k = 0;
  const chartAt = (id) => { placed.add(id); return byId.has(id) ? <AgentChart key={`c${k++}`} spec={byId.get(id)} /> : null; };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const only = /^\s*\[\[(chart-\d+)\]\]\s*$/.exec(line);
    if (only) { const c = chartAt(only[1]); if (c) blocks.push(c); i++; continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) { body.push(cells(lines[i])); i++; }
      const numeric = head.map((_, ci) => body.length > 0 && body.every((r) => !r[ci] || /^[-+€£$]?[\d.,]+%?[a-z]*$/i.test(r[ci].replace(/\s/g, ""))));
      blocks.push(
        <div className="atable" key={`b${k++}`}>
          <table>
            <thead><tr>{head.map((h, ci) => <th key={ci} className={numeric[ci] ? "num" : ""}>{inline(h, `h${ci}`)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => <tr key={ri}>{head.map((_, ci) => <td key={ci} className={numeric[ci] ? "num" : ""}>{inline(r[ci] || "", `t${ri}${ci}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { item += " " + lines[i].trim(); i++; }
        items.push(item);
      }
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={`b${k++}`}>{items.map((t, ti) => <li key={ti}>{inline(t, `l${ti}`)}</li>)}</L>);
      continue;
    }
    // a paragraph runs to the next blank line, list, table or chart
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*\[\[chart-\d+\]\]\s*$/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
      && !(lines[i].trim().startsWith("|") && i + 1 < lines.length && isRule(lines[i + 1]))) {
      para.push(lines[i].replace(/^#{1,6}\s+/, ""));
      i++;
    }
    const joined = para.join(" ");
    const heading = para.length === 1 && /^#{1,6}\s/.test(line);
    // a marker inside a paragraph: the chart goes after it
    const inner = [...joined.matchAll(MARK)].map((m) => m[1]);
    const clean = joined.replace(MARK, "").trim();
    if (clean) blocks.push(<p key={`b${k++}`} className={heading ? "ah" : ""}>{inline(clean, `p${k}`)}</p>);
    inner.forEach((id) => { const c = chartAt(id); if (c) blocks.push(c); });
  }
  // a chart the answer did not place goes at the end
  for (const [id] of byId) if (!placed.has(id)) blocks.push(<AgentChart key={`c${k++}`} spec={byId.get(id)} />);
  return <div className="aans">{blocks}</div>;
}

/* the answer as plain text for the next question's history: charts by title */
export function historyText(text, charts) {
  const byId = new Map((charts || []).map((c) => [c.id, c.spec]));
  return String(text || "").replace(MARK, (_, id) => (byId.has(id) ? `[chart drawn: ${byId.get(id).title}]` : ""));
}
