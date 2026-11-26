/**
 * What every agent harness of the benchmark shares, and the interface that
 * each of them fills in. A harness is the program that runs a session: Claude
 * Code, the Codex CLI or the Antigravity CLI. What is particular to one lives
 * in its own module under harnesses/. The code that runs and judges a session
 * asks the harness it is handed, and never which one it is. Where a caller
 * hands none, as the tests of Claude Code's path do, agent.mjs and
 * isolation.mjs take Claude Code.
 *
 * @typedef {object} Harness
 * @property {string} id  What `run --harness` takes and a record holds
 * @property {string} name  How a report and a message name it, as in "Claude Code"
 * @property {string} executable  What `--agent` defaults to, looked up on PATH
 * @property {string | null} defaultModel  The model of a run that names none, null where a run has to name one
 * @property {string[]} efforts  The levels its effort setting takes. Empty where it has no such setting.
 * @property {string[]} tools  Its built-in tools that both arms are given, by the names its events give them
 * @property {boolean} reportsCost  Whether a session says what it cost, so that --max-budget-usd can hold it
 * @property {boolean} countsTokens  Whether its events count the tokens while a session goes, so that --max-tokens can hold it
 * @property {boolean} [reportsTurns]  Whether a session says how many turns it took. Claude Code's does.
 * @property {boolean} [reportsRetries]  Whether its events say when it asked the API again
 * @property {string} [serverSettings]  What the lsp arm registers the language server with besides its command, as the
 *   configuration of the harness writes it. A run is held to it, as to the server.
 * @property {(options: StartOptions) => Promise<Session>} start  How a session of an arm is started
 * @property {(event: object) => boolean} describesSetup  An event by which the harness has said enough of a session's
 *   setup to tell whether its arm is as it should be. A session can be ended at such an event, long before its time is up.
 * @property {(events: object[], context: { arm?: string, tools: string[], given?: object | null }) => Summary} read
 *   What a session did, from its events, and what it was given, from `given` where the harness keeps that apart
 * @property {(events: object[]) => number} [tokensSoFar]  The tokens a session has spent so far, where countsTokens
 * @property {(events: object[]) => string} answer  The text of a session's final answer
 * @property {(exec: Exec) => Promise<string | null>} [version]  For a harness whose events name no version: the
 *   version that the executable says it has
 * @property {(version: string | null) => string} agentName  What a run calls the agent of its sessions
 * @property {(effort: string | null) => object} environment  The environment of its sessions, before what start adds for
 *   one of them. The lsp arm's pre-flight starts the server with it.
 * @property {Isolation} isolation  What the isolation check plants and asks
 * @property {(elmRoot: string, arm: string, tools: string[]) => void} [prepareCheckout]  What a checkout needs before a
 *   session starts in it, written before the benchmark takes the checkout's state, so that it is no change of the session's
 * @property {(elmRoot: string, top: string) => string[]} [handedOn]  What of a checkout the harness hands every session
 *   whatever the session is started with, by paths from `top`. The benchmark takes it out of the checkout of either arm
 *   before it takes the checkout's state.
 *
 * @typedef {(args: string[], options?: { cwd?: string, env?: object }) => Promise<string>} Exec
 *   Runs the harness's executable with these arguments and gives what it printed. It runs as a session's own
 *   commands do, under the session's time limit, and it ends when the benchmark is interrupted. Rejects where the
 *   command fails.
 *
 * @typedef {object} StartOptions
 * @property {string} cwd
 * @property {string} prompt
 * @property {string} model
 * @property {string | null} [effort]
 * @property {string} arm
 * @property {string[]} tools  The built-in tools of the session. The isolation check gives none.
 * @property {number | null} [maxBudgetUsd]
 * @property {string[]} command  The executable, as argv
 * @property {string} home  An empty directory for what the harness makes for the session. It goes with the session.
 * @property {Exec} exec
 *
 * @typedef {object} Session
 * @property {string[]} args  What follows the executable
 * @property {object} env
 * @property {() => object | null} [given]  What the harness itself noted of the session's setup in `home`, null
 *   until it has. It is read while the session goes and once it has ended.
 * @property {() => string | null} [finish]  Looks at what start made, before `home` is removed. Says what went wrong, if anything did.
 *
 * @typedef {object} Isolation
 * @property {{ place: string, file: string, word: string, text?: (instruction: string) => string }[]} planted
 *   Where a session could pick up instructions in a project and above it, and the word planted there. A file
 *   holds the instruction itself unless `text` writes it otherwise, as a hook in a settings file.
 * @property {string} [project]  Where the check's session starts, below the directory that the files are planted
 *   in. "project" where it is not named.
 * @property {boolean} [repository]  Whether the check's directory is a git repository, since the harness reads
 *   instruction files only from the project's directory up to the root of its repository
 * @property {() => string[]} personalNames  How a session can name a file of the user's own settings
 * @property {string} settings  How a message names the user's settings, as in "your Claude Code setup"
 * @property {(check: { command: string[], cwd: string, model: string, effort?: string | null, home: string, exec: Exec }) =>
 *   Promise<{ text: string, strayTools: string[] }>} [inspect]  A look at what a session would be given that asks no
 *   model, for a harness that can show it: its whole prompt as text, and the tools that its arm must not have
 * @property {(home: string) => string[]} [loaded]  What the harness noted in the home of the check's session that it
 *   loaded beyond its arm, by how a message names each
 *
 * @typedef {object} Summary
 * The figures of a session, the same for every harness. A record holds them as they are.
 */

import { readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { SERVER_NAME } from "../../mcp-wrapper/harnesses.mjs";
import { ARMS } from "./arms.mjs";

// A run works in a worktree, which shares its repository with the original checkout: branches,
// tags, the stash, the configuration and the remotes are the operator's. Denying these
// subcommands catches the plain way of writing to them. It is a guard against accidents, not a
// sandbox: the agent still has a shell. Each harness denies them in its own way.
export const FORBIDDEN_GIT = [
  ...["commit", "merge", "rebase", "cherry-pick", "revert", "am", "reset", "checkout", "switch"],
  ...["branch", "tag", "stash", "notes", "update-ref", "replace", "config", "remote", "worktree"],
  ...["push", "fetch", "pull", "gc", "prune"],
];

// The levels of effort that Claude Code 2.1.311, the Codex CLI 0.171.0 and the Antigravity CLI 1.5.13 take,
// as far as the model has them
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// What an agent's session sets for the commands it runs: Claude Code 2.1.311 the first eleven,
// and the Codex CLI and the Antigravity CLI the others, as their binaries name them. A benchmark
// that an agent started would hand them on to every session, which would then run as the child
// of another session, and not as one started from a plain shell. How a harness signs in and which
// provider it uses are told by other variables, which stay.
const PARENT_SESSION = [
  "CLAUDECODE",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_CSRF_TOKEN",
];

/**
 * The environment of a session and of the lsp arm's pre-flight: the operator's, without what a
 * parent session set and without what `drop` says sets how the harness thinks, with `set` on top.
 */
export function sessionEnvironment({ drop = () => false, set = {} } = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (PARENT_SESSION.includes(name) || drop(name)) delete environment[name];
  }
  return { ...environment, ...set };
}

// The MCP servers of an arm, as each harness registers them in its own way
export const serversOf = (arm) => Object.entries(ARMS[arm].mcpServers).map(([name, { command, args }]) => ({ name, command, args }));

// An MCP tool as a record counts it, the way Claude Code names it, so that the language server's calls are told
// apart the same way in every harness
export const mcpTool = (server, tool) => `mcp__${server}__${tool}`;
export const LSP_PREFIX = mcpTool(SERVER_NAME, "");

// A tool call counted by its name, as a record holds them
export function countCalls(names) {
  const toolCalls = {};
  for (const name of names) toolCalls[name] = (toolCalls[name] ?? 0) + 1;
  return toolCalls;
}

// What the API says of a request that holds more than the model takes, in the words of the
// harnesses: Claude Code's "Prompt is too long", Codex's "context window exceeded" and "ran out of
// room in the model's context window", Gemini's "input token count exceeds the maximum". A session
// that ends on that has itself to thank.
export const TOO_MUCH = /(prompt|input) is too long|request too large|request_too_large|context (window|length|limit)|token count exceeds/i;

// What the Codex CLI and the Antigravity CLI say when the trouble lies between here and the API: a
// limit of the subscription or of the rate, a login that expired or was revoked, an outage, a
// connection that broke. Their binaries word it so, as in "You've hit your usage limit", "exceeded
// retry limit", "stream disconnected before completion", "We're currently experiencing high demand,
// which may cause temporary errors.", "RESOURCE_EXHAUSTED", "Authentication expired. Please log back
// in." and "Server overloaded".
const API_TROUBLE = new RegExp(
  [
    "usage limit",
    "rate.?limit",
    "quota",
    "resource.?exhausted",
    "too many requests",
    "exceeded retry limit",
    "stream disconnected",
    "connection (?:reset|refused|closed|lost|error|failed)",
    "network (?:error|is down)",
    "overloaded",
    "high demand",
    "temporary errors?",
    "try again later",
    "capacity",
    "unavailable",
    "internal server error",
    "bad gateway",
    "gateway timeout",
    "unauthori[sz]ed",
    "authentication (?:expired|failed|required)",
    "(?:log|sign) (?:back )?in again",
    "please (?:log|sign) (?:back )?in",
    "not logged in",
    "refresh token",
    "token (?:expired|was revoked)",
    "credits",
    "spend.?cap",
    "prepaid",
  ].join("|"),
  "i"
);

// The status of an API error that a text names, as in "last status: 429" or "RESOURCE_EXHAUSTED (429)"
export const statusIn = (text) => {
  const status = /(?:\bstatus:?\s*|\()([45]\d\d)\b/i.exec(text ?? "")?.[1];
  return status ? Number(status) : null;
};

/**
 * Whether the text with which a harness ended a session says that the API was lost: by a status
 * that only the API or the way to it gives, or in words. A failure of any other kind is the
 * session's own, and its record says so.
 */
export function lostTheApi(text) {
  const status = statusIn(text);
  return [401, 403, 408, 429].includes(status) || status >= 500 || API_TROUBLE.test(text ?? "");
}

/**
 * When a session that hit a limit of its subscription can go on, as the harness put it, or null
 * where it did not say. "Try again at 3:05 PM", "resets in 4h 12m" and "resets at 2026-11-25T06:00Z"
 * are the forms the harnesses use.
 */
export function resumesAt(text) {
  const said = /\b(?:try again|resets?|reset after|available again)\s+((?:at|in|after|on)\s+[^.\n]+)/i.exec(text ?? "");
  return said ? said[1].trim() : null;
}

// What a run calls the agent of its sessions: the harness with its version. A stand-in may name none.
export const agentNamer = (name) => (version) => (version ? `${name} ${version}` : "an agent that names no version");

/**
 * The version that an executable says it has with `--version`: the first word of its answer that
 * looks like one, or null where it names none, as a stand-in may. An executable that fails to
 * answer rejects, since a session in it would have no version to be held to.
 * @param {Exec} exec
 */
export async function versionOf(exec) {
  return /\d+\.\d+[\w.+-]*/.exec(await exec(["--version"]))?.[0] ?? null;
}

/**
 * How a session can name a file of the user's own settings: by each directory as it is configured,
 * as the system resolves it and from ~ on, with a slash behind it, and by each file as well. What
 * lies directly in a directory can be a link, as a rule or an instruction file can, and then a
 * session can name what it leads to. This reads the names in those directories and where their
 * links lead. It plants nothing there and reads no file's contents.
 * @param {{ dirs?: string[], files?: string[] }} places
 */
export function namesOfPlaces({ dirs = [], files = [] }) {
  const home = homedir();
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const asDirectory = (path) => (statSync(path, { throwIfNoEntry: false })?.isDirectory() ? `${path}/` : path);
  const linked = dirs.flatMap((parent) => {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => real(resolve(parent, entry.name)))
        .filter(Boolean)
        .map(asDirectory);
    } catch {
      return [];
    }
  });
  const names = [
    ...dirs.flatMap((dir) => [`${dir}/`, real(dir) && `${real(dir)}/`]),
    ...files.flatMap((file) => [file, real(file)]),
    ...linked,
  ].filter(Boolean);
  const fromHome = names.filter((name) => name.startsWith(`${home}/`)).map((name) => `~${name.slice(home.length)}`);
  return [...new Set([...names, ...fromHome])];
}

/**
 * Tokens as a record holds them: every input token, the cached ones among them, and what the model
 * wrote. A harness that counts no cache writes has none. Null for every one where a session ended
 * before its harness counted any, so that a median leaves it out.
 */
export const tokens = (counted) =>
  counted === null
    ? { inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null }
    : {
        inputTokens: counted.input ?? 0,
        cacheCreationInputTokens: counted.cacheWrite ?? 0,
        cacheReadInputTokens: counted.cacheRead ?? 0,
        outputTokens: counted.output ?? 0,
      };

/**
 * The figures of a session of the Codex CLI or the Antigravity CLI, from what each read of its
 * events and of what it was given. Neither reports a cost, the time it waited for the API or a
 * memory of its own, and each has the language server in the lsp arm only where its own record
 * names the server's tools.
 * @param {object} session
 * @param {boolean} session.setUp  Whether the harness has said what the session was given
 * @param {string} [session.arm]
 * @param {string[]} session.calls  The tool of each call, as a record names it
 * @param {number} session.lspCalls  The calls to the language server that it answered
 * @param {string[]} session.servers  The MCP servers that the session was given or called
 * @param {number | null} [session.lspTools]  How many tools the language server handed it, null where that is not told
 * @param {boolean} [session.deferred]  Whether the prompt named the language server and none of its tools, which the
 *   model would have to look up first
 * @param {string[]} session.strayTools  Tools that its arm is not given
 */
export function figuresOf({ setUp, arm, calls, lspCalls, servers, lspTools = null, deferred = false, strayTools, ...rest }) {
  const hasServer = servers.includes(SERVER_NAME) || lspCalls > 0;
  return {
    agentVersion: null,
    // The session's own directory holds no memory of an earlier one
    memoryOff: setUp ? true : null,
    lspStatus: setUp ? (hasServer ? (deferred ? "deferred" : "connected") : arm === "lsp" ? "failed" : "absent") : null,
    lspTools: setUp && hasServer ? lspTools : null,
    strayTools: setUp ? strayTools : null,
    strayServers: setUp ? servers.filter((name) => !(arm === "lsp" && name === SERVER_NAME)) : null,
    strayPlugins: setUp ? [] : null,
    costUsd: null,
    apiMs: null,
    ...rest,
    toolCalls: countCalls(calls),
    lspCalls,
  };
}
