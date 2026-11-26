#!/usr/bin/env node
/**
 * Stands in for the Codex CLI in the benchmark tests. It answers `--version`,
 * `debug models` and `debug prompt-input` as codex-cli 0.171.0 does, and for
 * `exec --json` it writes the rollout of its session into its home, acts on
 * the working directory as FAKE_AGENT says and prints the events that a real
 * session printed.
 *
 *   FAKE_AGENT=solve        carry out a "Rename the function" prompt, with a shell command or the language server's tool
 *   FAKE_AGENT=idle         change nothing
 *   FAKE_AGENT=break        leave a file the stand-in compiler rejects
 *   FAKE_AGENT=unreachable  get no answer to the first request, after Codex asked again
 *   FAKE_AGENT=limited      start to work, and reach the usage limit of the subscription
 *   FAKE_AGENT=overloaded   start to work, ask the API again five times, and fail the turn on what it said
 *   FAKE_AGENT=overlong     start to work, and run out of room in the model's context window
 *   FAKE_AGENT=crashing     start to work, and fail the turn on an error of the session's own
 *   FAKE_AGENT=flaky        say that it waits to retry and that it falls back to another transport, then solve
 *   FAKE_AGENT=busy         start a command and work on until told to stop, then end without a word, as Codex does
 *   FAKE_AGENT=searching    search the web, which no arm is given
 *   FAKE_AGENT=serverless   solve without the language server's tools, as when its server did not start
 *   FAKE_AGENT=deferring    defer the language server's tools whatever the server was registered with, then solve
 *   FAKE_AGENT=refused      call the language server's tool and get no answer, then solve
 *   FAKE_AGENT=unrecorded   solve without writing a rollout
 *   FAKE_AGENT=refresh      refresh the login as Codex does, writing through the link, then solve
 *   FAKE_AGENT=relogin      replace the link to the login in its home with a file of its own
 *   FAKE_AGENT=nosy         answer the isolation check with every planted word from its directory up
 *   FAKE_AGENT=personal     name the user's own AGENTS.md when the isolation check asks for paths
 *   FAKE_AGENT=named        name the path in FAKE_AGENT_NAMED when the isolation check asks for paths
 *   FAKE_AGENT=showing      show every planted word and a subagent's tools in `debug prompt-input`
 *   FAKE_AGENT=browsing     show a tool of the web among the tools that a script of exec calls
 *   FAKE_AGENT=messaging    offer the tool that sends the user a message, as gpt-6.2-sol has
 *
 * See stand-in.mjs for the variables that every stand-in reads.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { answerVersion, interrupted, isIsolationCheck, isolationAnswer, mode, note, plantedAbove, selfDestruct, work } from "./stand-in.mjs";

const args = process.argv.slice(2);
const emit = (event) => console.log(JSON.stringify(event));
selfDestruct();

if (args[0] === "--version") answerVersion((named) => (named ? `codex-cli ${named}` : "codex-cli"));
if (args[0] === "debug" && args[1] === "models") {
  const levels = (...efforts) => efforts.map((effort) => ({ effort, description: "" }));
  const model = (slug, efforts) => ({ slug, multi_agent_version: "v2", tool_mode: "code_mode_only", experimental_supported_tools: ["clock"], supported_reasoning_levels: levels(...efforts) });
  console.log(JSON.stringify({ models: [model("stand-in", ["low", "medium", "high", "xhigh", "max", "ultra"]), model("stand-in-small", ["low", "medium", "high", "xhigh"])] }));
  process.exit(0);
}

// The prompt is the last argument. What a session is set up with is in the switches before it.
const prompt = args.at(-1);
const home = process.env.CODEX_HOME;
const lsp = args.some((arg) => arg.startsWith("mcp_servers.elm-lsp.command="));
// Codex 0.171.0 defers the tools of a server unless they are left out of both surfaces where a model looks them up
const direct = args.includes('mcp_servers.elm-lsp.omit_tools_from=["code_mode","deferred"]') && mode !== "deferring";
const shell = !args.join(" ").includes("--disable shell_tool");
// The catalog of the home, as the session reads it: a model that names tools of its own gets them
const catalog = (() => {
  const pair = args.find((arg) => arg.startsWith("model_catalog_json="));
  return pair ? JSON.parse(readFileSync(JSON.parse(pair.slice("model_catalog_json=".length)), "utf-8")) : { models: [] };
})();
const subagents = catalog.models.some((model) => model.multi_agent_version);

// What the session is given, as `debug prompt-input` prints it and as the rollout holds it
function prompted() {
  const nested = ["apply_patch", ...(shell ? ["exec_command", "write_stdin"] : []), "list_mcp_resources", "read_mcp_resource", ...(mode === "browsing" ? ["web_search"] : [])];
  const exec = { type: "custom", name: "exec", description: `Run JavaScript code to orchestrate/compose tool calls\n${nested.map((name) => `### \`${name}\`\n`).join("")}` };
  const functions = { type: "namespace", name: "functions", description: "", tools: [exec, { type: "function", name: "wait" }, ...(mode === "messaging" ? [{ type: "function", name: "send_message_to_user_async" }] : [])] };
  const extra = mode === "showing" || subagents ? [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent" }] }] : [];
  const told = mode === "showing" ? plantedAbove().join(" ") : "";
  const started = lsp && mode !== "serverless";
  const deferred = started && !direct ? "<tools>\nDeferred tool namespaces:\n- mcp__elm_lsp: Code intelligence and refactoring for Elm projects.\n</tools>" : "";
  const server = started && direct ? [{ type: "namespace", name: "mcp__elm_lsp", tools: ["elm_rename_function", "elm_references"].map((name) => ({ type: "function", name })) }] : [];
  return [
    { type: "additional_tools", role: "developer", tools: [functions, ...extra, ...server] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: `You are Codex. ${told}` }, ...(deferred ? [{ type: "input_text", text: deferred }] : [])] },
    { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
  ];
}

if (args[0] === "debug" && args[1] === "prompt-input") {
  console.log(JSON.stringify(prompted()));
  process.exit(0);
}

const link = join(home, "auth.json");
note({
  args,
  home: readdirSync(home).sort(),
  login: lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(link) : null,
  rules: readFileSync(join(home, "rules", "benchmark.rules"), "utf-8"),
  // What of a model's own tools the catalog of the home still hands it
  catalog: catalog.models.map(({ slug, multi_agent_version, experimental_supported_tools }) => ({ slug, multi_agent_version, experimental_supported_tools })),
});
if (mode !== "unrecorded") {
  const dir = join(home, "sessions", "2026", "11", "25");
  mkdirSync(dir, { recursive: true });
  const lines = [{ type: "session_meta", payload: { cli_version: process.env.FAKE_AGENT_VERSION ?? null } }, ...prompted().map((payload) => ({ type: "response_item", payload }))];
  writeFileSync(join(dir, "rollout-2026-11-25T08-18-04-01a211c8.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

const isolation = isIsolationCheck(prompt);
const command = (id, text, output = "") => {
  emit({ type: "item.started", item: { id, type: "command_execution", command: `/bin/zsh -c '${text}'`, aggregated_output: "", exit_code: null, status: "in_progress" } });
  emit({ type: "item.completed", item: { id, type: "command_execution", command: `/bin/zsh -c '${text}'`, aggregated_output: output, exit_code: 0, status: "completed" } });
};
const said = (id, text) => emit({ type: "item.completed", item: { id, type: "agent_message", text } });
const completed = () =>
  emit({ type: "turn.completed", usage: { input_tokens: 22216, cached_input_tokens: 10880, cache_write_input_tokens: 0, output_tokens: 73, reasoning_output_tokens: 0 } });
const failed = (message) => {
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
};
const toolCall = (id, status) => {
  const call = { id, type: "mcp_tool_call", server: "elm-lsp", tool: "elm_rename_function", arguments: {}, result: null, error: null, status: "in_progress" };
  emit({ type: "item.started", item: call });
  return (answer) => emit({ type: "item.completed", item: { ...call, ...answer, status } });
};

emit({ type: "thread.started", thread_id: "01a20fa4-1dcd-7842-88f9-e9c1d7752fff" });
emit({ type: "turn.started" });
if (isolation) {
  // The operator's own instruction file, in their home of the Codex CLI
  said("item_0", isolationAnswer(prompt, join(homedir(), ".codex", "AGENTS.md")));
  completed();
  process.exit(0);
}
if (mode === "unreachable") {
  emit({ type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion)" });
  failed("exceeded retry limit, last status: 429 Too Many Requests");
}
if (mode === "flaky") {
  emit({ type: "error", message: "stream connection failed; waiting to retry" });
  emit({ type: "error", message: "Falling back from WebSockets to HTTPS transport." });
}
said("item_0", "I'll look at the project first.");
command("item_1", "ls src", "Main.elm\n");
// As Codex 0.171.0 words them, with its curly apostrophe
if (mode === "limited") failed("You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 10:27 AM.");
if (mode === "overloaded") {
  const busy = "We’re currently experiencing high demand, which may cause temporary errors.";
  for (let attempt = 1; attempt <= 5; attempt++) emit({ type: "error", message: `Reconnecting... ${attempt}/5 (${busy})` });
  failed(busy);
}
if (mode === "overlong") failed("Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.");
if (mode === "crashing") failed("The model produced a tool call that Codex could not parse.");
if (mode === "searching") emit({ type: "item.started", item: { id: "item_2", type: "web_search", query: "elm rename function" } });
if (mode === "busy") {
  emit({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "/bin/zsh -c 'sleep 60'", aggregated_output: "", exit_code: null, status: "in_progress" } });
  await interrupted();
  process.exit(1);
}
if (mode === "refresh") {
  // Codex resolves the link and saves the refreshed login where it leads
  writeFileSync(link, '{"refreshed":true}\n');
}
if (mode === "relogin") {
  rmSync(link, { force: true });
  writeFileSync(link, "{}\n");
}
if (mode === "refused" && lsp) toolCall("item_4", "failed")({ error: { message: "tool call failed" } });
if (["solve", "refresh", "unrecorded"].includes(mode) && lsp) {
  const answer = toolCall("item_2", "completed");
  work(prompt, mode === "break" ? "break" : "solve");
  answer({ result: { content: [{ type: "text", text: "Renamed" }] } });
} else if (["solve", "break", "flaky", "serverless", "deferring", "refused", "refresh", "unrecorded"].includes(mode)) {
  work(prompt, mode === "break" ? "break" : "solve");
  emit({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "src/Main.elm", kind: "update" }], status: "completed" } });
}
said("item_3", "Done.");
completed();
