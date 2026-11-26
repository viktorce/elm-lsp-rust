/**
 * The Antigravity CLI as the harness of a session: `agy --print` with its
 * stream-json events, run as a custom agent of the checkout that names its
 * tools and its MCP server, in a settings directory of its own that holds
 * nothing of the operator's.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";
import { SERVER_NAME } from "../../../mcp-wrapper/harnesses.mjs";
import { agentNamer, EFFORTS, figuresOf, FORBIDDEN_GIT, LSP_PREFIX, lostTheApi, mcpTool, namesOfPlaces, serversOf, sessionEnvironment, statusIn, tokens, versionOf } from "../harness.mjs";

// The tools that Antigravity CLI 1.5.13 has for reading, editing and running commands. It searches
// with commands: it calls the older search tools deprecated and leaves them out of an agent that names them.
const TOOLS = ["read_file", "edit_file", "write_file", "run_command", "manage_task"];

// What an agent with an MCP server has besides the call itself, the reading of the server's resources
const MCP_PLUMBING = ["list_resources", "read_resource"];

// The name of the agent that a session runs as. It says nothing of the arm or the benchmark.
const AGENT = "session";

// Where the agent of a session lies in the directory it starts in
const AGENT_PATH = [".agents", "agents", AGENT];

// Where Antigravity looks for the customizations of a workspace, in every directory from the one a
// session starts in up to the root of its repository
const CUSTOMIZATION_DIRS = [".agents", ".agent", "_agents", "_agent"];

const yaml = (value) => JSON.stringify(value);

/**
 * The custom agent of a session. It inherits none of the operator's skills, rules, plugins, subagents
 * and MCP servers, nor the rules of the workspace, and has the tools of its arm and nothing else, the
 * language server in the lsp arm among them. Its prompt is Antigravity's own, since the file adds
 * nothing to it.
 */
function agentFile(arm, tools) {
  const servers = serversOf(arm).flatMap(({ name, command, args }) => [`  - name: ${yaml(name)}`, `    command: ${yaml(command)}`, `    args: ${yaml(args)}`]);
  return [
    "---",
    `name: ${AGENT}`,
    "description: Works on the task it is given.",
    `tools: ${yaml(tools)}`,
    "inheritCustomizations: false",
    "subagent: false",
    "mainAgent: true",
    ...(servers.length > 0 ? ["mcpServers:", ...servers] : []),
    "---",
    "",
  ].join("\n");
}

/**
 * Write the agent of a session into the directory it starts in, as a new file in directories that
 * lie in it. A link among them could lead to a file outside the checkout, which another session or
 * the operator reads too, so the benchmark refuses one, and a file of that name that is there already.
 */
function writeAgent(dir, arm, tools) {
  const root = realpathSync(dir);
  let at = root;
  for (const part of AGENT_PATH) {
    at = join(at, part);
    const entry = lstatSync(at, { throwIfNoEntry: false });
    if (entry && !(entry.isDirectory() && !entry.isSymbolicLink())) {
      throw new Error(
        `${relative(root, at)} in the checkout is ${entry.isSymbolicLink() ? "a link" : "a file"}, and the benchmark writes the agent of a session only into directories of the checkout. ` +
          `Remove it from the commit or from the links of the config.`
      );
    }
    if (!entry) mkdirSync(at);
  }
  const file = join(at, "agent.md");
  if (existsSync(file)) {
    throw new Error(`The checkout already holds ${relative(root, file)}, the agent that the benchmark makes for a session. Remove it from the commit, or run this codebase in another harness.`);
  }
  writeFileSync(file, agentFile(arm, tools), { flag: "wx" });
}

// Antigravity's own settings for one session, never saved: the git subcommands of the operator's
// repository are denied, and no web page is read or opened. Nothing is allowed without the rules
// or held for a person to approve, who is not there to.
const settings = () =>
  JSON.stringify({ permissions: { allow: [], ask: [], deny: [...FORBIDDEN_GIT.map((subcommand) => `command(git ${subcommand})`), "read_url(*)", "execute_url(*)"] } });

// Where the operator can move Antigravity's settings directory and its data, as its binary names the variables
const ELSEWHERE = ["ANTIGRAVITY_GEMINI_DIR", "ANTIGRAVITY_APP_DATA_DIR", "ANTIGRAVITY_CONFIG_REL_DIR", "JETSKI_APP_DATA_DIR", "GEMINI_DIR"];

// The operator's AGY_CLI_ variables change how a session runs, as when it compacts its conversation, how often
// it asks the API again and what share of a command's output it reads. An update in the background would make
// it another agent in the middle of a run.
const environment = () =>
  sessionEnvironment({ drop: (name) => name.startsWith("AGY_CLI_") || ELSEWHERE.includes(name), set: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } });

/**
 * What a session was given, as Antigravity noted it in the settings directory made for the session:
 * the tools of each MCP server that the agent has, one file each under antigravity-cli/mcp, and the
 * hooks that it loaded, which its log counts. A server that did not start has no directory there.
 * Null until the log says that the session was set up.
 */
function setupIn(home) {
  const data = join(home, "antigravity-cli");
  const logs = join(data, "log");
  const hooks = (existsSync(logs) ? readdirSync(logs) : []).flatMap((file) =>
    [...readFileSync(join(logs, file), "utf-8").matchAll(/loaded (\d+) named hooks? from/g)].map(([, count]) => Number(count))
  );
  if (hooks.length === 0) return null;
  const mcp = join(data, "mcp");
  const servers = Object.fromEntries(
    (existsSync(mcp) ? readdirSync(mcp, { withFileTypes: true }) : [])
      .filter((entry) => entry.isDirectory())
      .map((entry) => [entry.name, readdirSync(join(mcp, entry.name)).filter((file) => file.endsWith(".json")).length])
  );
  return { servers, hooks: Math.max(...hooks) };
}

const steps = (events, type) => [
  ...new Map(
    events
      .filter((event) => event.event === "step_update" && (type === undefined || event.step_update?.step_type === type))
      .map((event) => [event.step_update.step_index, event.step_update])
  ).values(),
];

// The tool that a step stands for, by the name a record counts it under. Antigravity calls the tool of an MCP server
// through call_mcp_tool, and one that a server marks as eager under a name of its own, "mcp_<server>_<tool>". Only
// the name of a server that the benchmark gives tells where that name parts.
function toolOf(step) {
  const { ServerName, ToolName } = step.tool_info?.parameters ?? {};
  if (step.tool_name === "call_mcp_tool") return mcpTool(ServerName, ToolName);
  const eager = serversOf("lsp").find(({ name }) => step.tool_name?.startsWith(`mcp_${name}_`));
  return eager ? mcpTool(eager.name, step.tool_name.slice(`mcp_${eager.name}_`.length)) : step.tool_name;
}

// Tokens as one count of the model's use reports them: what it was given, what of that came from the
// cache, and what it wrote. Antigravity CLI 1.5.13 counts the input apart from the cache: in a session of
// four answers its input fell from 4,288 to 2,122 tokens as the cache reads rose from 0 to 4,068, while the
// two together grew with the conversation, and its total leaves the cache reads out. Its output holds the
// thinking, which it also counts on its own: a session that thought 21,601 tokens and answered "yes"
// reported 21,603 output tokens. A record holds every input token, as Claude Code's and Codex's do, and
// the thinking among the output.
const usageOf = (usage = {}) => ({
  input: (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0),
  cacheRead: usage.cache_read_tokens ?? 0,
  output: usage.output_tokens ?? 0,
});

// Every count of a session's steps that has finished, whatever their kind: an answer, a compaction of the conversation
const countedSoFar = (events) => {
  const counted = steps(events)
    .filter((step) => step.state === "DONE" && step.usage)
    .map((step) => usageOf(step.usage));
  return counted.length === 0 ? null : counted.reduce((total, each) => ({ input: total.input + each.input, cacheRead: total.cacheRead + each.cacheRead, output: total.output + each.output }));
};

/**
 * What one session did, read from the stream-json events of `agy --print`,
 * and what it was given, read from its settings directory. Its first event
 * lists every tool of the CLI whatever the agent has, so what a session was
 * not given beyond that shows in what it does. Antigravity reports no cost,
 * and its tokens with every step of the model.
 */
function read(events, { arm, tools: given, given: setup }) {
  const init = events.find((event) => event.event === "init")?.init;
  const result = events.find((event) => event.event === "result")?.result;
  const calls = steps(events, "tool");
  const answers = steps(events, "agent_response").filter((step) => step.state === "DONE");
  // A call that failed got no answer from the server
  const lspCalls = calls.filter((step) => toolOf(step).startsWith(LSP_PREFIX) && step.state === "DONE" && !step.tool_info?.error).length;
  const finished = result?.status === "SUCCESS" && !result.finished_reason;
  const failureText = !finished && typeof result?.error === "string" && result.error !== "" ? result.error : null;
  // A turn that was interrupted or ran out of time says so. Any other end without a success is an error, of the API or the session's own.
  const cutShort = ["interrupted", "print_timeout"].includes(result?.finished_reason);
  const setUp = init !== undefined && setup !== null && setup !== undefined;
  // Counted by the steps where the session ended before its result
  const counted = result?.usage ? usageOf(result.usage) : countedSoFar(events);
  return {
    finished,
    // The reason is left out where the turn finished, and a result may say nothing at all of how it ended
    stopReason: result ? result.finished_reason || result.status?.toLowerCase() || "no status" : "no result",
    endedOnApiError: !finished && !cutShort && failureText !== null && lostTheApi(failureText),
    apiErrorStatus: statusIn(failureText),
    // The CLI waits and asks the API again without a word in its events
    apiRetries: null,
    waitingForApi: false,
    failureText,
    replies: answers.length,
    // Its result counts the turns of the user, one for a prompt, and not those of the agent
    turns: null,
    ...tokens(counted),
    ...figuresOf({
      setUp,
      arm,
      calls: calls.map(toolOf),
      lspCalls,
      servers: setUp ? [...new Set([...Object.keys(setup.servers), ...calls.map(toolOf).filter((name) => name.startsWith("mcp__")).map((name) => name.split("__")[1])])] : [],
      lspTools: setUp ? (setup.servers[SERVER_NAME] ?? null) : null,
      // A session that ran in another agent than its own has every tool of the CLI
      strayTools: setUp
        ? [
            ...(init.agent === AGENT ? [] : ["every tool of Antigravity's default agent"]),
            ...[...new Set(calls.map(toolOf))].filter((name) => !given.includes(name) && !(arm === "lsp" && MCP_PLUMBING.includes(name)) && !name.startsWith("mcp__")),
          ]
        : [],
    }),
  };
}

// Where a session would pick up instructions, and the word planted in each place. Antigravity reads
// the rules of a workspace from its directory up to the root of its repository. A workspace's skills,
// hooks and MCP servers are planted nowhere: Antigravity CLI 1.5.13 loads them for every agent, and the
// benchmark takes them out of a checkout before a session starts in it.
const PLANTED = [
  { place: "AGENTS.md in the project", file: "project/AGENTS.md", word: "AGENTSSENTINEL" },
  { place: "GEMINI.md in the project", file: "project/GEMINI.md", word: "GEMINISENTINEL" },
  { place: "AGENTS.md in .agents of the project", file: "project/.agents/AGENTS.md", word: "DOTAGENTSSENTINEL" },
  { place: "AGENTS.md in a directory above the project", file: "AGENTS.md", word: "PARENTSENTINEL" },
  { place: "GEMINI.md in a directory above the project", file: "GEMINI.md", word: "PARENTGEMINISENTINEL" },
  {
    place: "a rule in .agents/rules of the project",
    file: "project/.agents/rules/benchmark.md",
    word: "RULESENTINEL",
    text: (instruction) => `---\ntrigger: always_on\n---\n${instruction}`,
  },
];

// What a workspace holds that Antigravity CLI 1.5.13 hands every session, its own agent's as well, whatever
// the agent inherits: its skills, and the files that name more of them elsewhere, its hooks and its MCP
// servers. No setting keeps them out: a session of an isolation check found a planted hook loaded and a
// planted server started, and "trustedWorkspaces" set to none left the hook loaded. A plugin of the
// workspace can bring all three.
const WORKSPACE_WIDE = ["skills", "skills.json", "hooks.json", "mcp_config.json", "plugins", "plugins.json"];

// The operator's own settings directory of Antigravity, which holds their rules, skills, agents, plugins,
// hooks and MCP servers, and the conversations of their sessions. A session has one of its own instead.
const configDir = () => join(homedir(), ".gemini", "config");

/** @type {import("../harness.mjs").Harness} */
export const antigravity = {
  id: "antigravity",
  name: "Antigravity CLI",
  executable: "agy",
  defaultModel: null,
  efforts: EFFORTS,
  tools: TOOLS,
  reportsCost: false,
  countsTokens: true,
  environment,
  async start({ prompt, model, effort, home }) {
    const args = [
      // The settings directory of the session, made for it and removed with it, in place of ~/.gemini. The
      // operator's rules, skills, plugins, hooks, MCP servers and conversations stay out, and so does every
      // earlier session. Antigravity CLI 1.5.13 keeps the login in the system's keychain, and none is here.
      `--gemini_dir=${home}`,
      "--print",
      prompt,
      "--model",
      model,
      ...(effort ? ["--effort", effort] : []),
      "--output-format",
      "stream-json",
      "--agent",
      AGENT,
      // Every tool call goes ahead without a person to approve it, as in Claude Code's print mode. The deny rules hold.
      "--dangerously-skip-permissions",
      // A prompt that begins with a slash is the prompt, and no command or skill
      "--disable-slash-commands",
      "--settings",
      settings(),
    ];
    return { args, env: environment(), given: () => setupIn(home) };
  },
  // A step of the model or of a tool: by then the agent has its tools, those of its MCP servers among them
  describesSetup: (event) => event.event === "step_update" && ["tool", "agent_response"].includes(event.step_update?.step_type) && event.step_update.state === "DONE",
  read,
  tokensSoFar: (events) => {
    const counted = countedSoFar(events);
    return counted === null ? 0 : counted.input + counted.output;
  },
  answer: (events) => events.find((event) => event.event === "result")?.result?.response ?? "",
  version: versionOf,
  agentName: agentNamer("Antigravity CLI"),
  // The agent is written before the benchmark takes the checkout's state, so it is no change of the session's
  prepareCheckout: writeAgent,
  // Every directory from the one a session starts in up to the root of its repository counts
  handedOn(elmRoot, top) {
    const found = [];
    for (let dir = resolve(elmRoot); ; dir = dirname(dir)) {
      // A file of such a name holds no customizations
      const holders = CUSTOMIZATION_DIRS.map((name) => join(dir, name)).filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());
      const paths = holders.flatMap((holder) => WORKSPACE_WIDE.map((entry) => join(holder, entry)));
      found.push(...paths.filter((path) => lstatSync(path, { throwIfNoEntry: false })).map((path) => relative(top, path)));
      if (dir === resolve(top) || dir === dirname(dir)) return found;
    }
  },
  isolation: {
    planted: PLANTED,
    repository: true,
    settings: "Antigravity CLI setup",
    // The operator's settings directory with what lies in it, the rule files in ~/.gemini, and the other places of
    // skills that later versions read
    personalNames: () =>
      namesOfPlaces({
        dirs: [
          ...["", "rules", "skills", "agents", "plugins"].map((sub) => join(configDir(), sub)),
          ...[[".gemini", "skills"], [".gemini", "antigravity-cli", "skills"], [".agents", "skills"]].map((parts) => join(homedir(), ...parts)),
        ],
        files: ["GEMINI.md", "AGENTS.md"].map((file) => join(homedir(), ".gemini", file)),
      }),
    // A hook speaks only when its event comes, and the log of the session counts every one that it loaded
    loaded(home) {
      const hooks = setupIn(home)?.hooks ?? 0;
      return hooks > 0 ? [`${hooks === 1 ? "a hook" : `${hooks} hooks`} of a hooks.json, as the log of the session says`] : [];
    },
  },
};
