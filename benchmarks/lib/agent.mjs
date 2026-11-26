/**
 * Running the agent: one headless session per task, in the harness that the
 * run names, with or without the Elm language server, and nothing else from
 * the machine's setup. What the server and the benchmark are made of, too.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { createWriteStream, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative, resolve } from "path";
import { RUST_LSP_PATH } from "../../mcp-wrapper/lsp-client.mjs";
import { ARMS, REPO_ROOT } from "./arms.mjs";
import { OWN_SETTINGS, ownEnvironment } from "./git.mjs";
import { claudeCode } from "./harnesses/claude-code.mjs";
import { Interrupted, runGroup } from "./process.mjs";

export { ARMS };

// What the binary of the language server is built from, as git pathspecs. The programs under
// src/bin are binaries of their own, and an edit to one of them leaves the server as it was.
const BINARY_SOURCES = ["src", ":(exclude)src/bin", "Cargo.toml", "Cargo.lock"];

// What the language server is made of: the binary and the wrapper that runs it. A change to anything
// else in this checkout, a document for one, leaves it the server it was, and a run that was started
// with it can go on.
const SERVER_SOURCES = [...BINARY_SOURCES, "mcp-wrapper"];

// What the benchmark is made of: the code that picks the tasks, runs the sessions and judges them, and
// the modules of the wrapper that it imports. workspace.mjs decides which source directories and entry
// files count, harnesses.mjs how a command is quoted and how the server is registered, lsp-client.mjs
// where the binary lies, and doctor.mjs whether the binary answers. The probe calls the tools of
// tools.mjs, which imports move-function.mjs.
export const BENCHMARK_SOURCES = [
  "benchmarks/bench.mjs",
  "benchmarks/lib",
  "mcp-wrapper/doctor.mjs",
  "mcp-wrapper/errors.mjs",
  "mcp-wrapper/harnesses.mjs",
  "mcp-wrapper/lsp-client.mjs",
  "mcp-wrapper/move-function.mjs",
  "mcp-wrapper/tools.mjs",
  "mcp-wrapper/workspace.mjs",
];

// What git prints in `root`, and nothing of what it says about it. Throws where `root` is no git checkout.
const gitOutput = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", env: ownEnvironment(), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 ** 28 });

/**
 * The state of some paths of a git checkout in a few words: the last commit
 * that changed them, and a digest of the files that differ from it there, so
 * that two different edits are two states. A file counts by what it holds and
 * not by how git shows the change, which the operator's settings decide. One
 * that was written again with the bytes it had is no change. A file that git
 * does not track counts too, unless git ignores it: a new module that a
 * tracked one imports is code that runs. A directory that is a repository of
 * its own counts by its name, since git lists it and none of its files. Null
 * where `root` is no git checkout.
 * @param {string} root
 * @param {string[]} paths  Relative to `root`, as git pathspecs: ":(exclude)dir" leaves a directory out
 */
export function stateOfSources(root, paths) {
  try {
    const git = (...args) => gitOutput(root, ...OWN_SETTINGS, ...args);
    const listed = (...args) => git(...args, "--", ...paths).split("\0").filter(Boolean);
    // The whole name of the commit: how many letters git shortens one to is a setting, and grows with the repository.
    // "git log" takes settings of its own, and with log.showSignature it prints a line about the signature first.
    const commit = git("rev-list", "-1", "HEAD", "--", ...paths).trim();
    // Both lists name a file from `root`. A renamed file is the old one gone and a new one there.
    const changed = new Set([
      ...listed("diff", "--name-only", "-z", "--no-renames", "--relative", "HEAD"),
      ...listed("ls-files", "-z", "--others", "--exclude-standard"),
    ]);
    if (changed.size === 0) return commit;

    const digest = createHash("sha256");
    for (const file of [...changed].sort()) {
      const path = join(root, file);
      const entry = lstatSync(path, { throwIfNoEntry: false });
      // What the file is, with its mode, and what it holds. A file that was deleted is none.
      if (entry?.isSymbolicLink()) digest.update(`\0${file}\0link\0`).update(readlinkSync(path));
      else if (entry?.isFile()) digest.update(`\0${file}\0${entry.mode & 0o111 ? "program" : "file"}\0`).update(readFileSync(path));
      else digest.update(`\0${file}\0${entry ? "directory" : "none"}\0`);
    }
    return `${commit}, with uncommitted changes ${digest.digest("hex").slice(0, 8)}`;
  } catch {
    return null;
  }
}

/**
 * Which language server the lsp arm runs: the version of this checkout with
 * the state of its sources, where git knows one. A binary older than its
 * sources does not run, so a build of the same sources is the same server.
 */
export function languageServerVersion() {
  const { version } = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf-8"));
  const sources = stateOfSources(REPO_ROOT, SERVER_SOURCES);
  return sources === null ? version : `${version} (${sources})`;
}

/** When the binary of the language server was built, for the record. Null where there is none. */
export function languageServerBuilt() {
  const binary = statSync(RUST_LSP_PATH, { throwIfNoEntry: false });
  return binary ? `${binary.mtime.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

/**
 * How the binary of the language server stands to the files it was built
 * from. Cargo names those files in a dependency file beside the binary. A
 * module that git does not track is among them where a tracked one declares
 * it, and the other binaries under `src/bin` are not. `newer` is the newest of
 * them that was written after the binary, which is then of older sources than
 * the checkout holds, and null where none was.
 * Cargo.toml and Cargo.lock do not count. Cargo builds again when a source is
 * newer than the binary, and goes by what the manifest and the lock file say
 * and not by when they were written. A checkout of another branch and back
 * writes them again, and scripts/setup.sh then leaves the binary as it was.
 * `unknown` takes the place of `newer` where the sources cannot be told:
 * "unbuilt" where the binary is missing, "unlisted" where its dependency file
 * is, and "gone" where none of the files that it names is there any more, as
 * after the checkout was moved.
 * @returns {{ newer: string | null } | { unknown: "unbuilt" | "unlisted" | "gone" }}
 */
export function serverBuild() {
  const binary = statSync(RUST_LSP_PATH, { throwIfNoEntry: false });
  if (!binary) return { unknown: "unbuilt" };
  let rule;
  try {
    rule = readFileSync(`${RUST_LSP_PATH}.d`, "utf-8").split("\n")[0];
  } catch {
    return { unknown: "unlisted" };
  }
  // One rule in the manner of a makefile: the binary, a colon, and the whole path of each file it
  // was built from, with a backslash in front of a space in a path
  const words = (rule.match(/(?:\\ |\S)+/g) ?? []).map((word) => word.replaceAll("\\ ", " "));
  const colon = words.findIndex((word) => word.endsWith(":"));
  let there = 0;
  let newer = null;
  let written = binary.mtimeMs;
  for (const file of colon === -1 ? [] : words.slice(colon + 1).map((word) => resolve(REPO_ROOT, word))) {
    if (["Cargo.toml", "Cargo.lock"].includes(basename(file))) continue;
    // A file that was deleted has nothing to build from, and the module that declared it changed
    const entry = statSync(file, { throwIfNoEntry: false });
    if (entry) there++;
    if (entry && entry.mtimeMs > written) [newer, written] = [relative(REPO_ROOT, file), entry.mtimeMs];
  }
  return there === 0 ? { unknown: "gone" } : { newer };
}

/** Which benchmark judges the sessions: the state of its own sources. Two states can judge one result differently. */
export const benchmarkVersion = () => stateOfSources(REPO_ROOT, BENCHMARK_SOURCES) ?? "no git checkout";

/**
 * Start the lsp arm's MCP command, as a session does, before any session is paid for.
 * `env` is the environment that the harness of the run gives its sessions.
 */
export async function assertMcpServer({ cwd = REPO_ROOT, timeoutMs = 10000, mcpServers = ARMS.lsp.mcpServers, env = claudeCode.environment() } = {}) {
  for (const [name, { command, args }] of Object.entries(mcpServers)) {
    let send;
    // The id of the request whose answer is awaited: 1 for initialize, 2 for tools/list, null once a tool is listed
    let awaited = 1;
    let problem = null;
    const request = (id, method, params = {}) => send({ jsonrpc: "2.0", id, method, params });
    let result;
    try {
      result = await runGroup([command, ...args], {
        cwd,
        env,
        timeoutMs,
        graceMs: 200,
        onStart(input) {
          send = (message) => input.write(`${JSON.stringify(message)}\n`);
          request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "elm-benchmark", version: "1" } });
        },
        onLine(line, end) {
          let message = null;
          try {
            message = JSON.parse(line);
          } catch {
            // No JSON, and so no JSON-RPC message either
          }
          if (message?.jsonrpc !== "2.0") problem = "sent something other than a JSON-RPC message";
          // A notification, a request of the server's own such as ping, or an answer to another request
          // than the one awaited. Once a tool is listed, nothing is awaited, and the id null answers nothing.
          else if (awaited === null || message.method !== undefined || message.id !== awaited) return;
          else if (message.error) problem = `refused ${awaited === 1 ? "initialize" : "tools/list"}`;
          else if (awaited === 1) {
            awaited = 2;
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            request(2, "tools/list");
            return;
          } else {
            const offered = Array.isArray(message.result?.tools) ? message.result.tools : [];
            if (offered.some((tool) => typeof tool?.name === "string" && tool.name.length > 0)) awaited = null;
            else problem = "listed no tools";
          }
          end();
        },
      });
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      throw new Error(`The lsp arm's MCP server "${name}" could not start. ${error.message}`);
    }
    if (result.timedOut || problem || awaited !== null) {
      const reason = result.timedOut ? `did not answer initialize and tools/list within ${timeoutMs} ms` : (problem ?? `ended before it answered initialize and tools/list (exit ${result.code})`);
      throw new Error(`The lsp arm's MCP server "${name}" ${reason}. No session was started.`);
    }
  }
}

/**
 * A way to run a harness's executable for what a session needs before it starts, as the catalog
 * of its models. It runs as the session's own commands do, a process group that the benchmark
 * watches, ends when the benchmark is interrupted and kills when `deadline` has passed.
 * @returns {import("./harness.mjs").Exec}
 */
export function execOf(command, { cwd, env, deadline }) {
  return async (args, options = {}) => {
    const named = [...command, ...args.slice(0, 2)].join(" ");
    const lines = [];
    const result = await runGroup([...command, ...args], {
      cwd: options.cwd ?? cwd,
      env: options.env ?? env,
      timeoutMs: Math.max(1, deadline - Date.now()),
      // All of it: a collected output is cut to its end, and a catalog of models is longer
      onLine: (line) => lines.push(line),
    });
    if (result.timedOut) throw new Error(`${named} did not finish within the session's time limit.`);
    if (result.code !== 0) throw new Error(`${named} failed: ${result.stderr.trim().split("\n")[0] || `it exited with ${result.code}`}`);
    return lines.join("\n");
  };
}

/**
 * Run one session in `cwd` and wait for it to end, with every process it
 * started. Rejects when the session cannot be started or was interrupted, and
 * when what the harness made for it could not be removed as it should.
 * @param {object} options
 * @param {import("./harness.mjs").Harness} [options.harness]  Claude Code unless named
 * @param {string[]} options.command  The harness's executable, as argv. Tests pass a stand-in.
 * @param {string} [options.effort]  One of the harness's efforts, or none for its default for the model
 * @param {string[]} [options.tools]  Built-in tools of the session. Both arms get the same ones.
 * @param {number | null} [options.maxTokens]  Ends a session that has spent more, where the harness counts them as it goes
 * @param {number} options.timeoutMs  Holds what the harness does before the session, and the session itself
 * @param {string} options.transcriptPath  Every event is appended here as it arrives
 * @param {string} [options.home]  An empty directory for what the harness makes for the session, which the caller
 *   removes. Without it, one is made among the system's temporary files and removed here.
 * @param {number} [options.graceMs]  How long a session over its time limit has to end by itself
 * @param {(session: import("./harness.mjs").Summary) => boolean} [options.stopIf]  Asked once an event that
 *   describes the session's setup is there. True ends the session at that point.
 * @returns {Promise<import("./harness.mjs").Summary & { wallMs: number, timedOut: boolean }>}  `wallMs` from the
 *   start of the session itself, after what the harness did before it
 */
export async function runAgent({ harness = claudeCode, command, cwd, prompt, model, effort, arm, tools = harness.tools, maxBudgetUsd, maxTokens, timeoutMs, transcriptPath, home, graceMs, stopIf }) {
  const deadline = Date.now() + timeoutMs;
  const own = home ?? realpathSync(mkdtempSync(join(tmpdir(), "elm-benchmark-home-")));
  const exec = execOf(command, { cwd, env: harness.environment(effort), deadline });
  const events = [];
  let session = null;
  let transcript = null;
  let ended = false;
  try {
    // A harness whose events name no version is asked for it, just before the session. One that updates
    // itself between two sessions is another agent.
    let version;
    if (harness.version) {
      try {
        version = await harness.version(exec);
      } catch (error) {
        if (error instanceof Interrupted) throw error;
        throw new Error(`${harness.name} did not say which version it is, so its session cannot be held to the run's. ${error.message}`);
      }
    }
    session = await harness.start({ command, cwd, prompt, model, effort, arm, tools, maxBudgetUsd, home: own, exec });
    transcript = createWriteStream(transcriptPath);
    // A transcript that cannot be written fails the session below, where it can be caught
    let unwritten = null;
    transcript.on("error", (error) => {
      unwritten ??= error;
    });
    const summary = () => ({ ...harness.read(events, { arm, tools, given: session.given?.() ?? null }), ...(version === undefined ? {} : { agentVersion: version }) });
    let ending = null;
    const started = Date.now();
    const { timedOut } = await runGroup([...command, ...session.args], {
      cwd,
      env: session.env,
      timeoutMs: Math.max(1, deadline - started),
      stderr: "inherit",
      // As Ctrl-C does in a terminal: the harness ends the turn and its shell commands, and says what it spent
      ask: "SIGINT",
      graceMs,
      onLine(line, end) {
        transcript.write(`${line}\n`);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // Not an event. The line is still in the transcript.
          return;
        }
        // Nor is null, a number or a string, though each is JSON
        if (typeof event !== "object" || event === null) return;
        events.push(event);
        // Each is asked to end once. A second end kills at once, and the session could not say what it spent.
        if (ending) return;
        if (harness.describesSetup(event) && stopIf?.(summary())) ending = "setup";
        // Ended the way a session over its time limit is, so it can say what it spent
        else if (maxTokens && harness.tokensSoFar(events) > maxTokens) ending = "tokens";
        if (ending) end();
      },
    });
    if (unwritten) throw new Error(`Could not write ${transcriptPath}: ${unwritten.message}`);
    ended = true;
    // A session that the benchmark ended for its tokens lost nothing, whatever the harness said as it stopped
    const limited = ending === "tokens" ? { finished: false, stopReason: "token-limit", endedOnApiError: false, waitingForApi: false } : {};
    return { ...summary(), ...limited, wallMs: Date.now() - started, timedOut };
  } finally {
    // What the harness made for the session goes, whatever became of the session. Where that went wrong, a
    // session that ended is no result, and one that failed already says why it failed.
    const left = session?.finish?.() ?? null;
    if (home === undefined) rmSync(own, { recursive: true, force: true });
    if (transcript) await new Promise((resolve) => (transcript.destroyed ? resolve() : transcript.end(resolve)));
    if (left && ended) throw new Error(left);
    if (left) console.error(left);
  }
}
