/**
 * Claude Code as the harness of a session: `claude --print` with its
 * stream-json events, and nothing of the operator's own setup.
 */

import { homedir } from "os";
import { join, resolve } from "path";
import { SERVER_NAME } from "../../../mcp-wrapper/harnesses.mjs";
import { ARMS } from "../arms.mjs";
import { agentNamer, EFFORTS, FORBIDDEN_GIT, LSP_PREFIX, namesOfPlaces, sessionEnvironment, tokens } from "../harness.mjs";

// The same built-in tools for both arms, named when a session starts: what it reads, searches and edits files with
export const BUILT_IN_TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob"];

// How hard the model thinks and how long its answers may grow. A run is held to the effort it names,
// or to the default of Claude Code for its model where it names none, and not to what the shell that
// started it happens to set. These are the ones I found by name in Claude Code 2.1.311, so a switch
// of the kind that a later version adds reaches a session until someone adds it here.
const EFFORT = [
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_MAX_EFFORT_REMINDER",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
];

// All worktrees of a repository share one auto memory directory, the operator's
// own. With it on, a session could read what an earlier one noted, and leave
// notes behind in the operator's memory. No command-line flag turns it off.
// And a run is held to the version of Claude Code that its first session
// reported, which an update in the background of a session would change. The
// operator's settings cannot turn that off here, since a session reads none.
function environment(effort) {
  return sessionEnvironment({
    drop: (name) => EFFORT.includes(name),
    set: {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTOUPDATER: "1",
      // The variable takes precedence over --effort in a session, so it says the same
      ...(effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {}),
    },
  });
}

function claudeArguments({ prompt, model, effort, arm, tools, maxBudgetUsd }) {
  const { mcpServers } = ARMS[arm];
  const allowed = [...tools, ...Object.keys(mcpServers).map((server) => `mcp__${server}`)];
  return [
    "--print",
    prompt,
    "--model",
    model,
    ...(effort ? ["--effort", effort] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    // No user or project settings: no plugins, hooks, skills or instruction files of the person running this
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers }),
    "--tools",
    tools.join(","),
    ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
    "--disallowedTools",
    ...FORBIDDEN_GIT.map((subcommand) => `Bash(git ${subcommand} *)`),
    "--max-budget-usd",
    String(maxBudgetUsd),
  ];
}

// Claude Code reports a failed API request as a message of its own, in the model's place
const isOwnWords = (event) => event.is_api_error_message === true || event.message?.model === "<synthetic>";

// And it says so each time it asks the API again for an answer that did not come
const isRetry = (event) => event.type === "system" && event.subtype === "api_retry";

const isInit = (event) => event.type === "system" && event.subtype === "init";

/**
 * What one session did, read from Claude Code's stream-json events.
 * `finished` is false when the session ended without a result event or with
 * an error. `replies` counts the model's messages: a session without one
 * never got to work, as when the API turns the first request down.
 * `lspStatus`, `lspTools`, `memoryOff`, `strayTools`, `strayServers`,
 * `strayPlugins` and `agentVersion` are null when the session never got as
 * far as its first event, which describes its setup.
 * @param {object[]} events
 * @param {string[]} [given]  The built-in tools the session was started with
 * @param {string} [arm]  The arm it ran in. Only the lsp arm is given the language server's tools.
 */
export function summarizeTranscript(events, given = BUILT_IN_TOOLS, arm) {
  const init = events.find(isInit);
  const result = events.find((event) => event.type === "result");
  const toolCalls = {};
  let replies = 0;
  for (const event of events) {
    if (event.type !== "assistant" || isOwnWords(event)) continue;
    replies++;
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") {
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
      }
    }
  }

  // Claude Code 2.1.311 ends a session over its budget with is_error and the subtype "error_max_budget_usd".
  // Its other subtypes that begin with "error_" are not known to come with is_error, so those count on their own.
  const failed = result?.is_error === true || /^error_/.test(result?.subtype ?? "");
  const usage = result?.usage ?? {};
  const lspCalls = Object.entries(toolCalls)
    .filter(([name]) => name.startsWith(LSP_PREFIX))
    .reduce((total, [, count]) => total + count, 0);
  return {
    finished: result !== undefined && !failed,
    stopReason: result?.subtype ?? "no result",
    // True when the session ended on a request that the API did not answer, or turned down
    endedOnApiError: result?.terminal_reason === "api_error" || (result?.api_error_status ?? null) !== null,
    // The HTTP status of the API error that ended the session, if one did and had one
    apiErrorStatus: result?.api_error_status ?? null,
    // How often Claude Code had to ask the API again, which tells a session that waited from one that worked slowly
    apiRetries: events.filter(isRetry).length,
    // True when the session's last request was never answered: Claude Code asked again, and no word of the model followed
    waitingForApi: events.findLastIndex(isRetry) > events.findLastIndex((event) => event.type === "assistant" && !isOwnWords(event)),
    // What Claude Code said about a session that ended on an error, as far as it said anything
    failureText: failed && typeof result.result === "string" && result.result !== "" ? result.result : null,
    replies,
    agentVersion: init?.claude_code_version ?? null,
    // The first event names the memory directories the session loads from. The
    // field is not part of Claude Code's documented output: without it, the
    // session counts as having none.
    memoryOff: init ? Object.keys(init.memory_paths ?? {}).length === 0 : null,
    // "connected", "failed", "pending" while it was still starting, or "absent"
    lspStatus: init ? ((init.mcp_servers ?? []).find((server) => server.name === SERVER_NAME)?.status ?? "absent") : null,
    // How many of the language server's tools the session was handed. A server can be connected and hand over none.
    lspTools: init ? (init.tools ?? []).filter((tool) => tool.startsWith(LSP_PREFIX)).length : null,
    // Tools that the session was not given: neither built in for it, nor the language server's in the arm that has it
    strayTools: init ? (init.tools ?? []).filter((tool) => !given.includes(tool) && !(arm === "lsp" && tool.startsWith(LSP_PREFIX))) : null,
    // MCP servers other than the language server in the arm that has it, whatever their status. One that is
    // still starting lists no tools yet, and can hand some over later.
    strayServers: init ? (init.mcp_servers ?? []).map((server) => server.name).filter((name) => !(arm === "lsp" && name === SERVER_NAME)) : null,
    // Plugins beyond the ones that Claude Code has built in, which the first event lists with "builtin" for their path
    strayPlugins: init ? (init.plugins ?? []).filter((plugin) => plugin.path !== "builtin").map((plugin) => plugin.name ?? "without a name") : null,
    costUsd: result?.total_cost_usd ?? null,
    apiMs: result?.duration_api_ms ?? null,
    turns: result?.num_turns ?? null,
    // Every input token counts, the ones written to the cache and the ones read from it among them. The arms have
    // different tools and so a cached prompt each, and whether a session finds its arm's still there depends on
    // how long the other arm's sessions took since one of its own ran.
    ...tokens({
      input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      cacheWrite: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      output: usage.output_tokens,
    }),
    toolCalls,
    lspCalls,
  };
}

// Where a session would pick up instructions, and the word planted in each place. A settings file
// gives the instruction through a hook, whose output a session that loads the file is told as it starts.
const hook = (instruction) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${instruction}` }] }] } });
const PLANTED = [
  { place: "CLAUDE.md in the project", file: "project/CLAUDE.md", word: "PROJECTSENTINEL" },
  { place: "CLAUDE.local.md in the project", file: "project/CLAUDE.local.md", word: "LOCALSENTINEL" },
  { place: ".claude/CLAUDE.md in the project", file: "project/.claude/CLAUDE.md", word: "DOTCLAUDESENTINEL" },
  { place: "a rule in .claude/rules of the project", file: "project/.claude/rules/benchmark.md", word: "RULESENTINEL" },
  { place: "a SessionStart hook in .claude/settings.json of the project", file: "project/.claude/settings.json", word: "SETTINGSSENTINEL", text: hook },
  { place: "a SessionStart hook in .claude/settings.local.json of the project", file: "project/.claude/settings.local.json", word: "LOCALCONFIGSENTINEL", text: hook },
  { place: "AGENTS.md in the project", file: "project/AGENTS.md", word: "AGENTSSENTINEL" },
  { place: "CLAUDE.md in a directory above the project", file: "CLAUDE.md", word: "PARENTSENTINEL" },
];

/** @type {import("../harness.mjs").Harness} */
export const claudeCode = {
  id: "claude-code",
  name: "Claude Code",
  executable: "claude",
  defaultModel: "claude-opus-5-5",
  efforts: EFFORTS,
  reportsTurns: true,
  reportsRetries: true,
  tools: BUILT_IN_TOOLS,
  reportsCost: true,
  countsTokens: false,
  environment,
  async start({ prompt, model, effort, arm, tools, maxBudgetUsd }) {
    return { args: claudeArguments({ prompt, model, effort, arm, tools, maxBudgetUsd }), env: environment(effort), finish: () => null };
  },
  describesSetup: isInit,
  read: (events, { arm, tools }) => summarizeTranscript(events, tools, arm),
  answer: (events) => events.find((event) => event.type === "result")?.result ?? "",
  // Claude Code names its version in the first event of a session
  agentName: agentNamer("Claude Code"),
  isolation: {
    planted: PLANTED,
    settings: "Claude Code setup",
    // Claude Code keeps the user's settings in a directory of its own, and names the path of each instruction
    // file that it hands a session: a CLAUDE.md or a rule of the user's own there. Claude Code 2.1.311 reads
    // the variable with ||, so to it one that is set and empty means ~/.claude.
    personalNames() {
      const dir = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
      return namesOfPlaces({ dirs: [dir, join(dir, "rules")] });
    },
  },
};
