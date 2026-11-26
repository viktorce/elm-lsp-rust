/**
 * The Codex CLI as the harness of a session: `codex exec --json`, in a home
 * directory made for the session that holds a link to the operator's login
 * and nothing else of theirs.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { delimiter, join, resolve } from "path";
import { SERVER_NAME } from "../../../mcp-wrapper/harnesses.mjs";
import { agentNamer, EFFORTS, figuresOf, FORBIDDEN_GIT, LSP_PREFIX, lostTheApi, mcpTool, namesOfPlaces, serversOf, sessionEnvironment, statusIn, tokens, versionOf } from "../harness.mjs";

// The operator's own home of the Codex CLI, as it reads the variable. Only the login is taken from it.
const operatorHome = () => resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));

// What a session does with its tools, as `codex exec --json` names the items of a turn. A message, a
// thought and a plan are none.
const TOOLS = ["command_execution", "file_change"];
const NO_TOOL = ["agent_message", "reasoning", "todo_list", "error"];

// How Codex names the tools of an MCP server in a session's prompt: the server's name with its dashes
// as underscores, behind "mcp__"
const namespaceOf = (server) => `mcp__${server.replaceAll("-", "_")}`;

// What no arm is given, by how Codex names a tool that hands it over: the web, subagents, skills,
// plugins and apps, the making of images and the use of a computer. Codex adds tools with its releases
// and its models, and these are the kinds that would change what a session can do. The MCP servers
// are looked at apart, and a shell is a tool of its own for the session that was given none.
const DENIED = /web|search_query|literature|browser|url|fetch|agent|collaboration|spawn|skill|plugin|connector|(?:^|[._])apps?(?:[._]|$)|image_gen|computer|screen/i;
const SHELL = /exec_command|write_stdin|shell/i;

const toml = (value) => JSON.stringify(value);

// Codex 0.171.0 defers the tools of an MCP server: a model that has a search of tools sees the server's name and
// a description cut short, and finds its tools only by looking. Every model of its catalog has that search. Left
// out of the two surfaces of tools that a model looks things up in, the tools of the server are named in the prompt
// with their descriptions, as Claude Code and Antigravity name them.
const SERVER_SETTINGS = { omit_tools_from: ["code_mode", "deferred"] };

/**
 * The switches of a session, as `codex exec` and `codex debug prompt-input` both take them. The home
 * made for the session keeps out the operator's config.toml, AGENTS.md, skills, rules, hooks, memories
 * and MCP servers, and it trusts no project, so that the .codex directory of the checkout is not read.
 * These keep out the rest: the instruction files of the project and above it, the skills in the
 * project and in ~/.agents, subagents, web search, apps, plugins, the asking of questions nobody is
 * there to answer, and the check for an update that would make it another agent.
 */
function switches(home, { model, effort, arm, tools }) {
  const servers = serversOf(arm).flatMap(({ name, command, args }) => [
    "-c",
    `mcp_servers.${name}.command=${toml(command)}`,
    "-c",
    `mcp_servers.${name}.args=${toml(args)}`,
    // Codex 0.171.0 hands an MCP server eight variables of its environment and no ELM_HOME, where the
    // compiler keeps its packages. These are passed on by name, every one that the session has, as the
    // check command gets them. No value is on the command line.
    "-c",
    `mcp_servers.${name}.env_vars=${toml(Object.keys(environment(home)).sort())}`,
    ...Object.entries(SERVER_SETTINGS).flatMap(([key, value]) => ["-c", `mcp_servers.${name}.${key}=${toml(value)}`]),
  ]);
  return [
    "-c",
    `model=${toml(model)}`,
    ...(effort ? ["-c", `model_reasoning_effort=${toml(effort)}`] : []),
    // The catalog of the session's own home, as Codex fetched it, without the fields that hand a model
    // the tools of subagents and the experimental tools of its release
    "-c",
    `model_catalog_json=${toml(join(home, "catalog.json"))}`,
    ...["project_doc_max_bytes=0", "skills.include_instructions=false", 'web_search="disabled"'].flatMap((pair) => ["-c", pair]),
    ...["tools.experimental_request_user_input.enabled=false", "check_for_update_on_startup=false"].flatMap((pair) => ["-c", pair]),
    // A login shell reads the operator's profile again, which can set another PATH than the benchmark has, and
    // then a session's commands run another compiler than the check command does
    "-c",
    "allow_login_shell=false",
    ...["multi_agent", "sleep_tool", "apps", "plugins", "memories", "hooks", "image_generation", "browser_use", "computer_use", "goals", "view_image"].flatMap(
      (feature) => ["--disable", feature]
    ),
    // A session that was given no tool, as the isolation check's, has no shell to read the planted files with
    ...(tools.length === 0 ? ["--disable", "shell_tool"] : []),
    ...servers,
  ];
}

const environment = (home) => sessionEnvironment({ set: home ? { CODEX_HOME: home } : {} });

/**
 * The rules that deny git's writing subcommands. A rule matches the words of a command from its
 * first one on, and each place takes a list of words that it matches: git by its name and by the
 * whole path of each git on PATH, behind env and command as well, and with the options before a subcommand that
 * take no value, or with "-C ." for the checkout itself. Another directory after -C, a setting after
 * -c and a command inside a shell's string match no rule, and Codex 0.171.0 matches no rule against
 * a command with a redirection, a substitution, a variable or a wildcard in it.
 */
export const GIT_RULES = () => {
  const gits = ["git", ...new Set((process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "git")).filter((path) => existsSync(path)))];
  return [[gits], [["env", "command"], gits], [gits, ["--no-pager", "-P", "--no-optional-locks", "--no-replace-objects"]], [gits, "-C", "."]].map(
    (prefix) => `prefix_rule(pattern = ${JSON.stringify([...prefix, FORBIDDEN_GIT])}, decision = "forbidden")\n`
  );
};

/**
 * Fill the home that the benchmark made for a session. It links the operator's login, the one
 * file a session needs of theirs, and it holds the rules that deny the git subcommands of the
 * operator's repository and the model catalog without subagents.
 *
 * The login stays one file. Codex follows the link when it saves a login that it refreshed, so
 * the operator's file gets the new one, as when the operator runs Codex. Sessions that run at the
 * same time read and refresh the one file, as several Codex windows of the operator do, and
 * Codex reads it again when another one changed it. A copy would be refreshed apart from the
 * operator's, and once the refresh token rotates, the operator's own would be spent.
 */
async function fillHome(home, exec, { model, effort }) {
  const login = join(operatorHome(), "auth.json");
  // A login through a variable or the keychain has no file here, and nothing is linked
  if (existsSync(login)) symlinkSync(login, join(home, "auth.json"));
  mkdirSync(join(home, "rules"));
  writeFileSync(join(home, "rules", "benchmark.rules"), GIT_RULES().join(""));
  const catalog = JSON.parse(await exec(["debug", "models"], { env: environment(home) }));
  // Each model takes some of the levels, and Codex would run one at another level than the record names
  const levels = catalog.models?.find((entry) => entry.slug === model)?.supported_reasoning_levels?.map((level) => level.effort ?? level);
  if (effort && levels && !levels.includes(effort)) {
    throw new Error(`${model} takes the efforts ${levels.filter((level) => EFFORTS.includes(level)).join(", ")} in Codex, and not ${effort}. Run it with one of those.`);
  }
  for (const model of catalog.models ?? []) {
    delete model.multi_agent_version;
    // A model can name tools of its own here, a clock or a search of the literature. Codex needs the field.
    if (Array.isArray(model.experimental_supported_tools)) model.experimental_supported_tools = [];
  }
  writeFileSync(join(home, "catalog.json"), JSON.stringify(catalog));
  return login;
}

// The link to the login is still there and still leads to it. Where Codex put a file of its own in its
// place, the operator is told to look at their login, since a refresh may be in that file alone.
function loginKept(home, login) {
  const link = join(home, "auth.json");
  const entry = lstatSync(link, { throwIfNoEntry: false });
  return !existsSync(login) || (entry?.isSymbolicLink() && readlinkSync(link) === login)
    ? null
    : `A Codex session replaced the link to your login in the home that the benchmark made for it, and that copy goes with the home. ` +
        `Run "codex login status", log in again with "codex login" if it says so, and run the same command again.`;
}

/**
 * What a session was given, as Codex noted it in the rollout of its home: the tools at the top of the
 * prompt and the messages that come before the first word of the model, which name the tools of each
 * MCP server and hold every instruction. Null until Codex has written them, which it has once a message
 * of the user follows the tools and the messages of the developer.
 */
function rolloutOf(home) {
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : /^rollout-.*\.jsonl$/.test(entry.name) ? [join(dir, entry.name)] : []
    );
  const sessions = join(home, "sessions");
  const [rollout] = existsSync(sessions) ? files(sessions) : [];
  if (!rollout) return null;
  const items = [];
  for (const line of readFileSync(rollout, "utf-8").split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // The line that Codex is still writing
      continue;
    }
    if (entry?.type !== "response_item") continue;
    const item = entry.payload ?? {};
    if (item.role === "assistant" || /call/.test(item.type ?? "")) break;
    items.push(item);
  }
  return items.some((item) => item.type === "additional_tools") && items.some((item) => item.role === "user") ? items : null;
}

/**
 * What a prompt gives a session, from its items as `codex debug prompt-input` prints them and as a
 * rollout holds them: every tool by name, the ones that run the others and the ones that a script
 * of `exec` calls, the MCP servers whose tools it has, and the whole text. A server's tools are named
 * at the top under its namespace, or in the description of `exec`, and the number of them is told.
 * A server whose tools are deferred is only named, and the number is null.
 */
function offeredIn(items) {
  const named = (tools, prefix = "") => tools.flatMap((tool) => (tool.tools ? named(tool.tools, `${prefix}${tool.name}.`) : [`${prefix}${tool.name}`]));
  const declared = items.flatMap((item) => item.tools ?? []);
  // The tools that a script calls are listed in the description of the one that runs it, one heading each
  const descriptions = JSON.stringify(declared);
  const nested = [...descriptions.matchAll(/### `([\w.-]+)`/g)].map(([, name]) => name);
  const texts = items.flatMap((item) => (item.content ?? []).map((part) => part.text ?? "")).join("\n");
  const top = named(declared);
  const namedTools = (namespace) => [...top.filter((name) => name.startsWith(`${namespace}.`)), ...nested.filter((name) => name.startsWith(`${namespace}__`))].length;
  // At the top a server's namespace holds its tools. Deferred ones are listed one to a line under "Deferred tool
  // namespaces:", where a tool's description only names one as an example.
  const direct = [...new Set([...top.map((name) => name.split(".")[0]), ...nested.map((name) => /^(mcp__\w+?)__/.exec(name)?.[1])].filter((name) => name?.startsWith("mcp__")))];
  const deferred = [...texts.matchAll(/^- (mcp__[\w-]+)/gm)].map(([, name]) => name).filter((name) => !direct.includes(name));
  return {
    // The tools of the servers are counted apart
    tools: [...new Set([...top.filter((name) => !name.startsWith("mcp__")).map((name) => name.split(".").at(-1)), ...nested.filter((name) => !name.startsWith("mcp__"))])],
    servers: Object.fromEntries([...direct.map((namespace) => [namespace, namedTools(namespace)]), ...deferred.map((namespace) => [namespace, null])]),
    text: `${descriptions}\n${texts}`,
  };
}

// The tools of a prompt that its session must not have, by name
const deniedIn = (offered, given) => offered.tools.filter((name) => DENIED.test(name) || (given.length === 0 && SHELL.test(name)));

// The name of an MCP server whose tools a prompt names, the one that the arms give it, or Codex's own for another
const serverOf = (namespace) => serversOf("lsp").find(({ name }) => namespaceOf(name) === namespace)?.name ?? namespace;

// The tool that an item of a turn stands for, by the name a record counts it under
const toolOf = (item) => (item.type === "mcp_tool_call" ? mcpTool(item.server, item.tool) : item.type);

// Codex says so in an event of the kind that also tells an error, each time it asks the API again and
// when it goes on another way: "Reconnecting... 1/5 (what the API said)", "stream connection failed;
// waiting to retry", "Falling back from WebSockets to HTTPS transport."
const isRetry = (event) => event.type === "error" && /reconnecting|retrying|waiting to retry|falling back/i.test(event.message ?? "");

// What the API said each time Codex asked it again, as the brackets of a retry hold it
const retriedOn = (events) => events.filter(isRetry).map((event) => /\((.*)\)\s*$/.exec(event.message)?.[1]).filter(Boolean);

/**
 * What one session did, read from the events of `codex exec --json`, and
 * what it was given, read from the rollout in its home. The events name no
 * tools, servers or version, and the rollout names the tools of its prompt
 * and the MCP servers whose tools it can look up, which a server that did
 * not start is not among. Codex reports no cost, and its tokens only at the
 * end of a turn.
 */
function read(events, { arm, tools: given, given: setup }) {
  // Each item once, by its id: a session that was ended in the middle of a command has started it and not finished it
  const items = [...new Map(events.filter((event) => /^item\./.test(event.type)).map((event) => [event.item?.id, event.item])).values()].filter(Boolean);
  const calls = items.filter((item) => !NO_TOOL.includes(item.type));
  // A call that was refused or failed got no answer from the server
  const lspCalls = calls.filter((item) => toolOf(item).startsWith(LSP_PREFIX) && item.status === "completed").length;
  // The last word on the turn decides. Codex reports a retry and a notice the way it reports an error.
  const end = events.findLast((event) => event.type === "turn.completed" || event.type === "turn.failed");
  const finished = end?.type === "turn.completed";
  const errors = events.filter((event) => event.type === "error" && !isRetry(event));
  const failureText = finished ? null : (end?.error?.message ?? errors.at(-1)?.message ?? null);
  const usage = events.filter((event) => event.type === "turn.completed").map((event) => event.usage ?? {});
  const sum = (field) => usage.reduce((total, counts) => total + (counts[field] ?? 0), 0);
  const offered = setup ? offeredIn(setup) : null;
  return {
    finished,
    stopReason: finished ? "completed" : end ? "failed" : errors.length > 0 ? "error" : "no result",
    // Codex asks the API again only on what it takes for trouble on the way there, so a turn that failed on what it
    // had asked again for lost the API, whatever the words
    endedOnApiError: !finished && failureText !== null && (lostTheApi(failureText) || retriedOn(events).includes(failureText)),
    apiErrorStatus: statusIn(failureText),
    apiRetries: events.filter(isRetry).length,
    waitingForApi: events.findLastIndex(isRetry) > events.findLastIndex((event) => /^item\./.test(event.type)),
    failureText,
    // The model's messages. A session without one never got to work.
    replies: items.filter((item) => item.type === "agent_message").length,
    turns: null,
    // Every input token counts, the cached ones among them, as Codex counts them. Its output holds the
    // model's reasoning. A session that ended before its turn did has no count at all.
    ...tokens(usage.length === 0 ? null : { input: sum("input_tokens"), cacheWrite: sum("cache_write_input_tokens"), cacheRead: sum("cached_input_tokens"), output: sum("output_tokens") }),
    ...figuresOf({
      setUp: offered !== null,
      arm,
      calls: calls.map(toolOf),
      lspCalls,
      servers: offered ? [...new Set([...Object.keys(offered.servers).map(serverOf), ...calls.filter((item) => item.type === "mcp_tool_call").map((item) => item.server)])] : [],
      lspTools: offered?.servers[LSP_NAMESPACE] ?? null,
      // Named and not given: the model has to go and look for the server's tools, which no other harness asks of it
      deferred: offered?.servers[LSP_NAMESPACE] === null,
      strayTools: offered
        ? [...new Set([...deniedIn(offered, given), ...calls.map(toolOf).filter((name) => !given.includes(name) && !name.startsWith("mcp__"))])]
        : [],
    }),
  };
}

// Where a session would pick up instructions, and the word planted in each place. Codex reads the
// instruction files of a project from the root of its repository down to its directory, one in each
// directory, an AGENTS.override.md before an AGENTS.md. Each of the three lies in a directory of its
// own, so each would be read. The .codex directory of a project counts only for a project that the
// home trusts, and the home of a session trusts none: Codex 0.171.0 reads none of its files there, with
// the switches or without them. They stay planted for a version that would. A rule of the project
// would let a session run what the benchmark's rules forbid, and Codex's own view of the prompt
// lists the commands that rules allow, as it lists the rule of a trusted project.
const PLANTED = [
  { place: "AGENTS.md in the project", file: "nested/project/AGENTS.md", word: "AGENTSSENTINEL" },
  { place: "AGENTS.override.md in a directory above the project", file: "nested/AGENTS.override.md", word: "OVERRIDESENTINEL" },
  { place: "AGENTS.md at the root of the project's repository", file: "AGENTS.md", word: "PARENTSENTINEL" },
  {
    place: "a skill in .agents/skills of the project",
    file: "nested/project/.agents/skills/benchmark/SKILL.md",
    word: "SKILLSENTINEL",
    text: (instruction) => `---\nname: benchmark\ndescription: ${instruction}\n---\n${instruction}`,
  },
  {
    place: "developer_instructions in .codex/config.toml of the project",
    file: "nested/project/.codex/config.toml",
    word: "CONFIGSENTINEL",
    text: (instruction) => `developer_instructions = ${toml(instruction)}`,
  },
  {
    place: "a SessionStart hook in .codex/hooks.json of the project",
    file: "nested/project/.codex/hooks.json",
    word: "HOOKSENTINEL",
    text: (instruction) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${instruction}` }] }] } }),
  },
  {
    place: "a rule in .codex/rules of the project",
    file: "nested/project/.codex/rules/benchmark.rules",
    word: "RULESENTINEL",
    text: () => `prefix_rule(pattern = ["RULESENTINEL"], decision = "allow")`,
  },
];

/**
 * What `codex debug prompt-input` shows a session of the isolation check would be given, which asks
 * no model: its whole prompt as text, and the tools that it must not have. A deferred tool namespace
 * or a namespace at the top of an MCP server, as an app of the operator's account, counts as one.
 */
async function inspect({ command, cwd, model, effort, home, exec }) {
  await fillHome(home, exec, { model, effort });
  const items = JSON.parse(await exec(["debug", "prompt-input", ...switches(home, { model, effort, arm: "baseline", tools: [] }), "Hello."], { cwd, env: environment(home) }));
  const offered = offeredIn(items);
  return { text: offered.text, strayTools: [...deniedIn(offered, []), ...Object.keys(offered.servers)] };
}

/** @type {import("../harness.mjs").Harness} */
export const codex = {
  id: "codex",
  name: "Codex CLI",
  executable: "codex",
  defaultModel: null,
  efforts: EFFORTS,
  tools: TOOLS,
  reportsCost: false,
  countsTokens: false,
  reportsRetries: true,
  serverSettings: Object.entries(SERVER_SETTINGS)
    .map(([key, value]) => `${key} = ${toml(value)}`)
    .join(", "),
  environment: () => environment(null),
  async start({ prompt, model, effort, arm, tools, home, exec }) {
    const login = await fillHome(home, exec, { model, effort });
    const args = [
      "exec",
      "--json",
      // The rollout says what the session was given. It stays in the session's home, which goes with it.
      "--ignore-user-config",
      "--skip-git-repo-check",
      // Shell commands run as the operator's own, as they do in Claude Code's Bash
      "--sandbox",
      "danger-full-access",
      "-c",
      'approval_policy="never"',
      ...switches(home, { model, effort, arm, tools }),
      prompt,
    ];
    // What the session was given is written once, before the model's first word, so it is read until it is there
    let given = null;
    return { args, env: environment(home), given: () => (given ??= rolloutOf(home)), finish: () => loginKept(home, login) };
  },
  // Any item: Codex has written down what the session was given by the time it does anything
  describesSetup: (event) => /^item\./.test(event.type ?? ""),
  read,
  answer: (events) =>
    events
      .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
      .map((event) => event.item.text ?? "")
      .at(-1) ?? "",
  version: versionOf,
  agentName: agentNamer("Codex CLI"),
  isolation: {
    planted: PLANTED,
    project: "nested/project",
    repository: true,
    settings: "Codex CLI setup",
    // The operator's home of the Codex CLI with its rules and skills, and the skills of ~/.agents
    personalNames: () =>
      namesOfPlaces({ dirs: [operatorHome(), join(operatorHome(), "rules"), join(operatorHome(), "skills"), join(homedir(), ".agents", "skills")] }),
    inspect,
  },
};

// The server's tools, as the prompt of a session of the lsp arm names them
export const LSP_NAMESPACE = namespaceOf(SERVER_NAME);
