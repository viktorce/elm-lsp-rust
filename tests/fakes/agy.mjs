#!/usr/bin/env node
/**
 * Stands in for the Antigravity CLI in the benchmark tests. It answers
 * `--version` as agy 1.5.13 does, and for `--print` with `--agent` it reads the
 * custom agent of its working directory, writes its log and the tools of its
 * MCP servers into the settings directory that `--gemini_dir` names, acts on
 * the directory as FAKE_AGENT says and prints the stream-json events that a
 * real session printed. As agy does, it takes the skills, hooks and MCP
 * servers of every directory up to the root of the repository, whatever the
 * agent inherits, and notes the skills it would have told the model of.
 *
 *   FAKE_AGENT=solve        carry out a "Rename the function" prompt, with a shell command or the language server's tool
 *   FAKE_AGENT=idle         change nothing
 *   FAKE_AGENT=break        leave a file the stand-in compiler rejects
 *   FAKE_AGENT=unreachable  end on an exhausted quota before the model answered once
 *   FAKE_AGENT=limited      start to work, and end on the quota of the subscription
 *   FAKE_AGENT=quota        start to work, and end on the quota with an error that names no reason
 *   FAKE_AGENT=crashing     start to work, and end on an error of the session's own
 *   FAKE_AGENT=busy         start a command and work on until told to stop, then say what it spent
 *   FAKE_AGENT=greedy       answer again and again, a thousand tokens each time, and compact the conversation, until told to stop
 *
 * FAKE_AGENT_STOPPED is the error with which a session that was told to stop ends, "interrupted" where it is unset.
 *   FAKE_AGENT=searching    search the web, which no arm is given
 *   FAKE_AGENT=serverless   solve without the language server, as when its server did not start
 *   FAKE_AGENT=hooked       load a hook, as the log of a session that found a hooks.json says
 *   FAKE_AGENT=nosy         answer the isolation check with every planted word from its directory up
 *   FAKE_AGENT=named        name the path in FAKE_AGENT_NAMED when the isolation check asks for paths
 *
 * See stand-in.mjs for the variables that every stand-in reads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { setTimeout as sleep } from "timers/promises";
import { dirname, join, relative } from "path";
import { answerVersion, interrupted, isIsolationCheck, isolationAnswer, mode, note, selfDestruct, work } from "./stand-in.mjs";

const args = process.argv.slice(2);
const valueOf = (flag) => args[args.indexOf(flag) + 1];
const emit = (event) => console.log(JSON.stringify(event));
selfDestruct();

if (args[0] === "--version") answerVersion((named) => named ?? "");

const prompt = valueOf("--print");
const conversation = "26de48a7-1f69-4e43-82fb-a4754f716340";
// The CLI counts the input apart from the cache, its output holds the thinking that it also counts on its own,
// and its total is the input and the output alone, as in a real session
const usage = (input, output, thinking = Math.min(10, output)) => ({ input_tokens: input, output_tokens: output, thinking_tokens: thinking, cache_read_tokens: 100, total_tokens: input + output });
const total = [];
const result = (fields) => {
  const sum = (field) => total.reduce((counted, each) => counted + each[field], 0);
  const counted = { input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), thinking_tokens: sum("thinking_tokens"), cache_read_tokens: sum("cache_read_tokens"), total_tokens: sum("total_tokens") };
  emit({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", duration_seconds: 2, num_turns: 1, usage: counted, ...fields } });
};

// A settings directory of its own, which an unknown flag would have refused
const gemini = args.find((arg) => arg.startsWith("--gemini_dir="))?.slice("--gemini_dir=".length);
if (!gemini || !existsSync(gemini)) {
  console.error("flags provided but not defined: -gemini_dir");
  process.exit(2);
}

// A custom agent is found by its name in the workspace, and the CLI stops at once without one
const agent = join(".agents", "agents", valueOf("--agent"), "agent.md");
if (!existsSync(agent)) {
  result({ conversation_id: "", status: "ERROR", response: "", error: `unknown agent "${valueOf("--agent")}" (no custom agents are available)`, finished_reason: "error" });
  process.exit(1);
}
const definition = readFileSync(agent, "utf-8");

// What the workspace hands every session, from the working directory up to the root of its repository
const handed = (kind) => {
  const found = [];
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    for (const name of [".agents", ".agent", "_agents", "_agent"]) if (existsSync(join(dir, name, kind))) found.push(relative(process.cwd(), join(dir, name, kind)));
    if (existsSync(join(dir, ".git")) || dir === dirname(dir)) return found;
  }
};
const hooks = handed("hooks.json").length + (mode === "hooked" ? 1 : 0);
note({ args, agent: definition, skills: handed("skills") });

// What the CLI notes as it starts: the hooks it loaded, and the tools of each MCP server of the agent and of the workspace
const data = join(gemini, "antigravity-cli");
mkdirSync(join(data, "log"), { recursive: true });
writeFileSync(join(data, "log", "cli-20261125_081626.log"), `I1125 08:16:26.000000 1 hooks_manager.go:54] loaded ${hooks} named hooks from ${hooks} hooks.json file(s)\n`);
const workspaceServers = handed("mcp_config.json").flatMap((file) => Object.keys(JSON.parse(readFileSync(file, "utf-8")).mcpServers ?? {}));
for (const server of [...[...definition.matchAll(/- name: "([^"]+)"/g)].map(([, name]) => name), ...workspaceServers]) {
  if (mode === "serverless") continue;
  mkdirSync(join(data, "mcp", server), { recursive: true });
  for (const tool of ["elm_rename_function", "elm_references"]) writeFileSync(join(data, "mcp", server, `${tool}.json`), "{}\n");
  writeFileSync(join(data, "mcp", server, "instructions.md"), "Code intelligence and refactoring for Elm projects.\n");
}

let step = 0;
const counted = (type, counts) => {
  total.push(counts);
  emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: ++step, state: "DONE", step_type: type, usage: counts } });
};
const answer = (input = 1000, output = 20) => counted("agent_response", usage(input, output));
const tool = (name, parameters = {}) => {
  const update = { conversation_id: conversation, step_index: ++step, step_type: "tool", tool_name: name, tool_info: { name, parameters } };
  emit({ event: "step_update", step_update: { ...update, state: "ACTIVE" } });
  emit({ event: "step_update", step_update: { ...update, state: "DONE", tool_info: { ...update.tool_info, output: "" } } });
};
const ended = (error, reason = "error") => {
  result({ status: "ERROR", response: "", error, ...(reason ? { finished_reason: reason } : {}) });
  process.exit(1);
};

emit({ event: "init", conversation_id: conversation, init: { model: valueOf("--model"), cwd: process.cwd(), agent: valueOf("--agent"), tools: ["read_file", "run_command", "search_web", "invoke_subagent"], permission_mode: "always-proceed" } });
emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: 0, state: "DONE", step_type: "user_input" } });
if (isIsolationCheck(prompt)) {
  answer();
  result({ response: isolationAnswer(prompt, "") });
  process.exit(0);
}
if (mode === "unreachable") ended("You have exhausted your quota on this model. Your quota resets in 4h12m.");
answer();
tool("run_command", { CommandLine: "ls src" });
if (mode === "limited") ended("RESOURCE_EXHAUSTED (429): You have exhausted your quota on this model. Your quota resets in 4h12m.");
if (mode === "quota") ended("RESOURCE_EXHAUSTED (429): You have exhausted your quota on this model. Your quota resets in 4h12m.", null);
if (mode === "crashing") ended("model output must contain either output text or tool calls");
if (mode === "searching") tool("search_web", { query: "elm rename function" });
if (mode === "busy" || mode === "greedy") {
  const stop = interrupted();
  let asked = false;
  stop.then(() => (asked = true));
  while (!asked) {
    if (mode === "greedy") {
      answer(1000, 0);
      // A compaction of the conversation is paid for too, and counted in a step of its own
      counted("checkpoint", usage(500, 0, 0));
    }
    await sleep(100);
  }
  // As agy 1.5.13 ends a turn that Ctrl-C cut short
  const error = process.env.FAKE_AGENT_STOPPED ?? "interrupted";
  result({ status: "ERROR", response: "", error, ...(error === "interrupted" ? { finished_reason: "interrupted" } : {}) });
  console.error(`error: ${error}`);
  process.exit(1);
}
if (mode === "solve" && definition.includes("elm-lsp")) {
  tool("call_mcp_tool", { ServerName: "elm-lsp", ToolName: "elm_rename_function", Arguments: {} });
} else if (["solve", "break", "serverless"].includes(mode)) {
  tool("edit_file", { TargetFile: "src/Main.elm" });
}
work(prompt, mode === "break" ? "break" : mode === "idle" || mode === "hooked" ? "idle" : "solve");
answer(3000, 60);
result({ response: "Done." });
