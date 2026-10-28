/* The Agent: questions about the data, answered by Claude with read-only
 * tools (server/agent/tools.js) and the project's docs in front of it
 * (server/agent/prompt.js), streamed back to the chat (web/src/Agent.jsx).
 *
 * POST /api/agent { messages: [{role, content}], context: {view, release, display} }
 * answers as a stream of server-sent events:
 *   status {text}        what it is doing ("Reading the Warhol page")
 *   delta {text}         answer text as it is written
 *   reset {}             drop the text streamed so far (it was a preamble to more tool calls)
 *   chart {id, spec}     a chart to draw in the chat
 *   done {text, charts}  the whole answer
 *   error {error}        something went wrong; nothing more follows
 *
 * The key is ANTHROPIC_API_KEY from the environment and is never logged; nor
 * are the questions or the answers - only the release id, the number of
 * steps, the tokens and the time. Nothing here writes to the dashboard's
 * state: the tools only read. */
const AnthropicSDK = require("@anthropic-ai/sdk");
const { createTools, TOOL_DEFS, mask } = require("./tools");
const { createPrompt } = require("./prompt");

const Anthropic = AnthropicSDK.default || AnthropicSDK;
const MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const EFFORT = process.env.AGENT_EFFORT || "medium";
const MAX_STEPS = 12;              // model calls per question; the last one must answer
const MAX_MS = 180000;             // a question gives up after three minutes
const HOURLY = Number(process.env.AGENT_HOURLY_LIMIT) || 60;   // questions per person per hour
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function install(app, { ROOT, DATA, SOURCES, readSnapshot, sessionEmail }) {
  const tools = createTools({ ROOT, DATA, SOURCES, readSnapshot });
  const systemText = createPrompt({ ROOT, tools });
  let client = null;
  const getClient = () => {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
    return client;
  };

  const asked = new Map();   // email -> timestamps of questions in the last hour
  const allow = (who) => {
    const now = Date.now();
    const list = (asked.get(who) || []).filter((t) => now - t < 3600000);
    if (list.length >= HOURLY) { asked.set(who, list); return false; }
    list.push(now); asked.set(who, list);
    return true;
  };

  /* the page the reader is on, in words, for the message after the cached prompt */
  function contextText(ctx) {
    const ix = tools.readIndex();
    const today = new Date().toISOString().slice(0, 10);
    const lines = [`Today is ${today}. The dashboard's data runs to ${ix.asOf || "an unknown date"}.`];
    const id = ctx && typeof ctx.release === "string" ? ctx.release.replace(/[^a-z0-9_]/g, "") : "";
    const row = id && (ix.releases || []).find((r) => r.id === id);
    if (row) {
      lines.push(`The reader is on the page of ${row.releaseName} (id ${row.id}, ${row.type}, ${row.status}${row.targeted ? ", targeted" : ", no targets"}), ${ctx.tab === "targets" ? "Targets" : "Overview"} tab. "This release" means this one.`);
    } else if (ctx && ctx.view === "releases") {
      lines.push("The reader is on the Releases list (every launch).");
    } else {
      lines.push("The reader is not on a release page.");
    }
    lines.push(`Their Direct display is ${ctx && ctx.display === "channel" ? "Channel (Direct as its own channel)" : "Spread (Direct spread over the other channels)"}; get_release applies it unless you pass display.`);
    lines.push("Reply in plain English and keep it short: the answer first, two to four sentences, no field, table or doc names, no jargon, only the numbers that matter, rounded.");
    return lines.join(" ");
  }

  /* a few words on what a tool call is doing, for the chat's status line, in the reader's words */
  const PLAIN = {
    releases: "the list of launches", units_paid: "units sold by day", orders_by_product: "orders by work", draw_products: "the draws",
    spend_daily: "ad spend", content_posts: "social posts", email_sends: "email sends", release_clusters: "past launches",
    release_pricing: "editions and prices", release_people: "entrants and buyers", release_windows: "campaign dates",
    tl_panel: "past timed launches", tl_signups_by_product: "signups", tl_units_hourly: "sales by hour", tl_buyers: "buyers",
  };
  const nameOf = (id) => {
    const r = id && (tools.readIndex().releases || []).find((x) => x.id === id);
    return r ? r.artist || r.releaseName : "the release";
  };
  function statusOf(name, input) {
    const i = input || {};
    switch (name) {
      case "list_releases": return i.search ? `Looking up releases matching "${i.search}"` : "Looking through the releases";
      case "get_release": return `Reading ${nameOf(i.id)}'s page`;
      case "describe_table":
      case "query_table": return `Checking ${PLAIN[i.table] || "the data"}`;
      case "read_docs": return "Checking how the dashboard works this out";
      case "make_chart": return "Drawing a chart";
      default: return "Working";
    }
  }

  function runTool(name, input, charts) {
    const i = input && typeof input === "object" ? input : {};
    switch (name) {
      case "list_releases": return tools.listReleases(i);
      case "get_release": return tools.getRelease(i);
      case "describe_table": return tools.describeTable(i);
      case "query_table": return tools.queryTable(i);
      case "read_docs": return tools.readDocs(i);
      case "make_chart": {
        const spec = tools.makeChart(i);
        const id = `chart-${charts.length + 1}`;
        charts.push({ id, spec });
        return { id, marker: `[[${id}]]`, note: `Drawn. Put [[${id}]] on its own line in your answer where it belongs.` };
      }
      default: throw new Error(`Unknown tool ${name}`);
    }
  }

  /* the conversation as the chat sends it: plain text turns, the last a question */
  function cleanMessages(raw) {
    const list = Array.isArray(raw) ? raw
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) })) : [];
    let tail = list.slice(-20);
    while (tail.length && tail[0].role !== "user") tail = tail.slice(1);
    return tail;
  }

  app.post("/api/agent", async (req, res) => {
    const body = req.body || {};
    const ctx = body.context && typeof body.context === "object" ? body.context : {};
    // an older chat sends { release, messages }
    if (!ctx.release && typeof body.release === "string") ctx.release = body.release;
    const rel = typeof ctx.release === "string" ? ctx.release.replace(/[^a-z0-9_]/g, "") : "";
    const log = (status, extra) => console.log(`agent: ${rel || "-"} ${status}${extra ? " " + extra : ""}`);
    const c = getClient();
    if (!c) { log(503); return res.status(503).json({ error: "The agent is not configured (no ANTHROPIC_API_KEY on the server)." }); }
    const history = cleanMessages(body.messages);
    if (!history.length || history[history.length - 1].role !== "user") { log(400); return res.status(400).json({ error: "Ask a question" }); }
    const who = (sessionEmail && sessionEmail(req)) || req.ip || "anon";
    if (!allow(who)) { log(429); return res.status(429).json({ error: "That is a lot of questions for one hour - try again a little later." }); }

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let open = true;
    const send = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ping = setInterval(() => { if (open) res.write(": ping\n\n"); }, 15000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MAX_MS);
    res.on("close", () => { open = false; ac.abort(); });
    const started = Date.now();
    const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    const charts = [];
    let steps = 0;

    const messages = [...history, { role: "system", content: contextText(ctx) }];
    const system = [{ type: "text", text: systemText(), cache_control: { type: "ephemeral" } }];
    let lean = false;   // set when the API turns down an optional parameter: retried without them

    try {
      let answer = "";
      for (; steps < MAX_STEPS; steps++) {
        const last = steps === MAX_STEPS - 1;
        const params = {
          model: MODEL,
          max_tokens: 16000,
          system,
          tools: TOOL_DEFS,
          messages,
          output_config: { effort: EFFORT },
          ...(last ? { tool_choice: { type: "none" } } : {}),
          ...(lean ? {} : { cache_control: { type: "ephemeral" }, betas: [FALLBACK_BETA], fallbacks: "default" }),
        };
        let msg;
        try {
          const stream = c.beta.messages.stream(params, { signal: ac.signal });
          stream.on("text", (d) => send("delta", { text: d }));
          msg = await stream.finalMessage();
        } catch (e) {
          if (!lean && e instanceof Anthropic.BadRequestError) {
            log("retrying lean", `(${String(e.message).slice(0, 160)})`);
            lean = true; steps--; send("reset", {});
            // and the page context as text in the question, for a model that takes no system turns
            const at = messages.findIndex((m) => m.role === "system");
            if (at > 0) {
              const q = messages[at - 1];
              messages.splice(at - 1, 2, { role: "user", content: [{ type: "text", text: `<context>${messages[at].content}</context>` }, { type: "text", text: q.content }] });
            }
            continue;
          }
          throw e;
        }
        const u = msg.usage || {};
        usage.in += u.input_tokens || 0; usage.out += u.output_tokens || 0;
        usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0;

        if (msg.stop_reason === "refusal") { answer = "I can't help with that one."; break; }
        messages.push({ role: "assistant", content: msg.content });
        const calls = msg.content.filter((b) => b.type === "tool_use");
        const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (!calls.length || msg.stop_reason === "max_tokens") { answer = text; break; }

        // more tools to run: whatever text came first was a preamble
        if (text) send("reset", {});
        const results = [];
        for (const call of calls) {
          send("status", { text: statusOf(call.name, call.input) });
          let content, isError = false;
          try {
            content = JSON.stringify(runTool(call.name, call.input, charts));
            if (call.name === "make_chart") send("chart", charts[charts.length - 1]);
          } catch (e) {
            content = `Error: ${mask(e.message)}`; isError = true;
          }
          results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
        }
        if (steps === MAX_STEPS - 2) results.push({ type: "text", text: "That is the last of the tool calls for this question: answer now from what you have, and say if anything is missing." });
        messages.push({ role: "user", content: results });
      }
      if (!answer) answer = "I ran out of steps before I had an answer. Try a narrower question.";
      send("done", { text: answer, charts });
      log(200, `steps=${steps + 1} in=${usage.in} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} out=${usage.out} ms=${Date.now() - started}${lean ? " lean" : ""}`);
    } catch (e) {
      let error = "The agent could not answer. Try again.";
      if (e instanceof Anthropic.APIUserAbortError || ac.signal.aborted) error = open ? "That took too long - try a narrower question." : "cancelled";
      else if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && (e.status === 529 || e.status === 503))) error = "The agent is busy, try again in a moment.";
      else if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) error = "The agent's API key was refused - an admin needs to check ANTHROPIC_API_KEY.";
      else if (e instanceof Anthropic.APIConnectionError) error = "The agent could not be reached.";
      send("error", { error });
      log(e && e.status ? e.status : "failed", `${e && e.constructor ? e.constructor.name : "Error"}: ${String(e && e.message).slice(0, 200)} steps=${steps + 1}`);
    } finally {
      clearInterval(ping); clearTimeout(timer);
      if (open) res.end();
    }
  });
}

module.exports = { install };
