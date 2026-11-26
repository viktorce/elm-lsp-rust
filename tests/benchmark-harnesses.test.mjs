/**
 * The benchmark run in the harnesses besides Claude Code: the Codex CLI and
 * the Antigravity CLI, each played by a stand-in in tests/fakes/ that prints
 * the events a real session of it printed and notes what the real one notes
 * of a session's setup. Like tests/benchmark.test.mjs, they start processes,
 * make worktrees and run the command line.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { assertIsolated } from "../benchmarks/lib/isolation.mjs";
import { lostTheApi, statusIn } from "../benchmarks/lib/harness.mjs";
import { HARNESSES } from "../benchmarks/lib/harnesses/index.mjs";
import { summarize } from "../benchmarks/lib/report.mjs";
import { copyFixture, REPO, runNode, tempDir } from "./support.mjs";
import { BENCH, FAKE_COMPILER, gitRepository } from "./benchmark-support.mjs";

const STAND_INS = { codex: join(REPO, "tests/fakes/codex.mjs"), antigravity: join(REPO, "tests/fakes/agy.mjs") };

/**
 * A planned fixture, and a run of its rename-function task in one harness. The operator's home is a
 * directory of the test's, with a login of the Codex CLI that a session's home links. `committed`
 * adds files to the commit, `untracked` puts files beside it, and `codebase` adds to its config.
 */
async function planned(t, harness, { committed = () => {}, untracked = () => {}, codebase = {} } = {}) {
  const repo = copyFixture(t);
  committed(repo);
  gitRepository(repo);
  untracked(repo);
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  const check = [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"];
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check, ...codebase }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1", "--levels", "100"])).code, 0);
  const home = tempDir(t);
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "auth.json"), "{}\n");
  const notes = join(tempDir(t), "started.jsonl");
  const env = (mode, more = {}) => {
    const { CODEX_HOME, ...rest } = process.env;
    return { ...rest, HOME: home, FAKE_AGENT: mode, FAKE_AGENT_STARTED: notes, ...more };
  };
  const args = (...more) => ["run", "--config", config, "--out", out, "--harness", harness, "--model", "stand-in", "--agent", STAND_INS[harness], "--only", "rename-function", "--timeout-min", "1", ...more];
  const run = (mode, more = [], variables = {}) => runNode(BENCH, args(...more), { env: env(mode, variables) });
  const records = () =>
    existsSync(join(out, "runs"))
      ? Object.fromEntries(readdirSync(join(out, "runs")).filter((file) => file.endsWith(".json")).map((file) => [file.replace(".json", ""), JSON.parse(readFileSync(join(out, "runs", file), "utf-8"))]))
      : {};
  const started = () => (existsSync(notes) ? readFileSync(notes, "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { repo, out, config, home, run, args, env, records, started };
}

/**
 * Start a run as a terminal would, wait until its session of the task has begun, and press Ctrl-C.
 * The session ends without a record, and the same command starts it again. Resolves with the exit
 * status and the notes of the sessions.
 */
async function interrupted(t, { args, env }, mode, more) {
  const notes = join(tempDir(t), "started.jsonl");
  const running = spawn(process.execPath, [BENCH, ...args(...more)], { env: env(mode, { FAKE_AGENT_STARTED: notes }), stdio: "ignore", detached: true });
  t.after(() => running.kill("SIGKILL"));
  // The isolation check notes itself first, and the session of the task after it
  const lines = () => (existsSync(notes) ? readFileSync(notes, "utf-8").trim().split("\n") : []);
  for (let waited = 0; lines().length < 2 && waited < 20000; waited += 50) await sleep(50);
  await sleep(300);
  process.kill(-running.pid, "SIGINT");
  const [code] = await once(running, "close");
  return { code, sessions: lines().map((line) => JSON.parse(line)) };
}

// The home of a Codex session, as its switches name it
const codexHome = ({ args }) => dirname(JSON.parse(args.find((arg) => arg.startsWith("model_catalog_json=")).slice("model_catalog_json=".length)));

// The settings directory of an Antigravity session, as its switch names it
const geminiDir = ({ args }) => args.find((arg) => arg.startsWith("--gemini_dir=")).slice("--gemini_dir=".length);

// The directory that the benchmark made for a session's harness: the home itself, or for the isolation check
// the one that holds its homes. Its name says nothing of the arm.
const madeFor = (home) => home.split("/").find((part) => /^home-/.test(part));

// What a process environment would be with these variables, put back as it was when the test ends
function withEnvironment(t) {
  const was = { ...process.env };
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in was)) delete process.env[name];
    Object.assign(process.env, was);
  });
  return (variables) => Object.assign(process.env, variables);
}

test("a Codex session of each arm solves its task in a home of its own, which links the login and goes with the session", async (t) => {
  const { out, home, run, records, started } = await planned(t, "codex");
  const solved = await run("solve", [], { FAKE_AGENT_VERSION: "0.171.0", ELM_HOME: join(home, ".elm") });
  assert.equal(solved.code, 0, solved.stderr);
  assert.match(solved.stdout, /^2 sessions to run with stand-in in Codex CLI\nCodex CLI reports no cost, so only the time limit of 1 minute holds each session\. The isolation check before them is one short session more\.$/m);
  assert.match(solved.stdout, /Fixture\/rename-function\/100  baseline  #1  passed  \d+s\n/);

  const { "Fixture--rename-function--100--baseline--1": baseline, "Fixture--rename-function--100--lsp--1": lsp } = records();
  assert.deepEqual(
    [baseline.harness, baseline.agentVersion, baseline.costUsd, baseline.inputTokens, baseline.cacheReadInputTokens, baseline.outputTokens, baseline.turns],
    ["codex", "0.171.0", null, 22216, 10880, 73, null]
  );
  // A shell command and an edit, and in the other arm the language server's tool in place of the edit
  assert.deepEqual([baseline.toolCalls, baseline.lspCalls, baseline.lspStatus], [{ command_execution: 1, file_change: 1 }, 0, "absent"]);
  // The rollout of the session's home names the server's tools, which is what tells that the session had them
  assert.deepEqual(
    [lsp.toolCalls, lsp.lspCalls, lsp.lspStatus, lsp.lspTools, lsp.outcome],
    [{ command_execution: 1, "mcp__elm-lsp__elm_rename_function": 1 }, 1, "connected", 2, "passed"]
  );
  // The run is held to how the server's tools were handed over, as to the server
  const settings = JSON.parse(readFileSync(join(out, "run.json"), "utf-8"));
  assert.deepEqual(
    [settings.harness, settings.agent, settings.maxBudgetUsd, settings.serverSettings],
    ["codex", "Codex CLI 0.171.0", null, 'omit_tools_from = ["code_mode","deferred"]']
  );

  // The isolation check and both arms. Each home links the operator's login and nothing else of theirs, holds
  // the rules that deny git's writing subcommands and a catalog without subagents or a model's own tools, and is
  // gone after its session. It lies apart from the output directory, under a name that says nothing of the arm.
  const sessions = started();
  assert.equal(sessions.length, 3);
  for (const session of sessions) {
    const { home: listed, login, args, rules, catalog } = session;
    assert.deepEqual(listed, ["auth.json", "catalog.json", "rules"]);
    assert.equal(login, join(home, ".codex", "auth.json"));
    assert.ok(madeFor(codexHome(session)), codexHome(session));
    assert.ok(!codexHome(session).startsWith(out), "the home lies apart from the output directory");
    assert.ok(!existsSync(codexHome(session)), "the session's home is gone");
    assert.match(rules, /^prefix_rule\(pattern = \[\["git",.*\],\["commit","merge",.*"prune"\]\], decision = "forbidden"\)$/m);
    assert.match(rules, /^prefix_rule\(pattern = \[\["env","command"\],\["git",/m);
    assert.match(rules, /^prefix_rule\(pattern = \[\["git",.*\],"-C","\.",\["commit",/m);
    assert.deepEqual(catalog, [
      { slug: "stand-in", experimental_supported_tools: [] },
      { slug: "stand-in-small", experimental_supported_tools: [] },
    ]);
    for (const pair of ["project_doc_max_bytes=0", "skills.include_instructions=false", "allow_login_shell=false", "approval_policy=\"never\""]) assert.ok(args.includes(pair), pair);
    for (const feature of ["multi_agent", "apps", "plugins", "memories", "hooks", "view_image"]) assert.ok(args.join(" ").includes(`--disable ${feature}`), feature);
    // Nothing of a session would be kept anywhere but its home, and its rollout says what it was given
    assert.ok(!args.includes("--ephemeral"));
  }
  const [isolation, ...tasks] = sessions;
  assert.ok(isolation.args.join(" ").includes("--disable shell_tool"), "the isolation check's session has no shell");
  assert.deepEqual(tasks.map(({ args }) => args.some((arg) => arg.startsWith("mcp_servers.elm-lsp.args="))).sort(), [false, true]);
  // The tools of the server are named in the prompt, and not left for the model to look up
  assert.deepEqual(tasks.map(({ args }) => args.includes('mcp_servers.elm-lsp.omit_tools_from=["code_mode","deferred"]')).sort(), [false, true]);
  // The server gets the variables of the session by name, ELM_HOME among them, and no value on the command line
  const variables = tasks.flatMap(({ args }) => args.filter((arg) => arg.startsWith("mcp_servers.elm-lsp.env_vars=")));
  assert.equal(variables.length, 1);
  assert.ok(JSON.parse(variables[0].slice("mcp_servers.elm-lsp.env_vars=".length)).includes("ELM_HOME"));
  assert.ok(!variables[0].includes(join(home, ".elm")));
  // What the run made in its work directory goes with it
  assert.deepEqual(readdirSync(join(out, "work")), []);

  // The report names the harness and shows tokens where it has no cost
  assert.equal((await runNode(BENCH, ["report", "--out", out])).code, 0);
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf-8"));
  assert.deepEqual([summary.harness, summary.costReported, summary.overall.lsp.inputTokens, summary.overall.lsp.withoutTokens], ["Codex CLI", false, 22216, 0]);
  // Codex counts tokens only at the end of a turn, so a session of it cannot run out of them
  assert.deepEqual(Object.keys(summary.overall.lsp.endings), ["passed", "wrong-result", "does-not-compile", "time-limit", "error", "server-failed"]);
  const page = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!page.includes("Out of tokens"));
  assert.match(page, / "Out of time" is the limit the benchmark was run with\. /);
  assert.match(page, /stand-in at Codex CLI&#39;s default effort in Codex CLI 0\.171\.0 worked on/);
  assert.match(page, /<div class="label">Median tokens per session<\/div><div class="row"><span class="key baseline"><\/span><span class="value">22,216 in, 10,880 cached, 73 out<\/span>/);
  assert.match(page, /<th class="number">Time<\/th><th class="number">Input tokens<\/th><th class="number">Cached input<\/th><th class="number">Output tokens<\/th>/);
  assert.match(page, /<th class="number">Median input tokens<\/th><th class="number">Median cached input<\/th><th class="number">Median output tokens<\/th>/);
  assert.match(page, /the same built-in tools of Codex CLI \(command_execution, file_change\)/);
  assert.match(page, /"Turns" is empty, since Codex CLI reports no turns of the agent/);
});

test("a home that a killed benchmark left behind goes with the next run, and what its link led to stays", async (t) => {
  const { out, home, run, records } = await planned(t, "codex");
  // As a benchmark that was killed in the middle of a session leaves it: the home, and the file in the work directory that remembers it
  const left = join(tempDir(t), "home-left");
  mkdirSync(left);
  symlinkSync(join(home, ".codex", "auth.json"), join(left, "auth.json"));
  mkdirSync(join(out, "work"), { recursive: true });
  writeFileSync(join(out, "work", "Fixture--rename-function--100--baseline--1.home"), JSON.stringify({ home: left }));
  // And a file that names a directory the benchmark did not make, which it leaves alone
  const other = join(tempDir(t), "mine");
  mkdirSync(other);
  writeFileSync(join(out, "work", "stray.home"), JSON.stringify({ home: other }));
  const solved = await run("solve", ["--arms", "baseline"], { FAKE_AGENT_VERSION: "0.171.0" });
  assert.equal(solved.code, 0, solved.stderr);
  assert.equal(Object.keys(records()).length, 1);
  assert.ok(!existsSync(left), "the home that was left is gone");
  assert.ok(existsSync(other), "a directory of another name stays");
  assert.equal(readFileSync(join(home, ".codex", "auth.json"), "utf-8"), "{}\n");
  assert.deepEqual(readdirSync(join(out, "work")), []);
});

test("a Codex session that loses the API, reaches its limit, is interrupted or searches the web is no record", async (t) => {
  const { run, records, args, env } = await planned(t, "codex");
  const baseline = ["--arms", "baseline"];

  const lost = await run("unreachable", baseline);
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /the session ended before the model answered once \(exceeded retry limit, last status: 429 Too Many Requests\)\. Nothing was recorded for it\./);
  // A limit of the subscription says when it can go on
  const limited = await run("limited", baseline);
  assert.equal(limited.code, 1);
  assert.match(limited.stderr, /lost the API in the middle of its work \(You’ve hit your usage limit\. .*\)\. Nothing was recorded for it\. Codex CLI said that it can go on at 10:27 AM, and the same command goes on from here\./);
  // Codex asked again five times and gave up, in words that name no limit
  const overloaded = await run("overloaded", baseline);
  assert.equal(overloaded.code, 1);
  assert.match(overloaded.stderr, /lost the API in the middle of its work \(We’re currently experiencing high demand, which may cause temporary errors\.\)\. Nothing was recorded for it\./);
  // What the web says is no part of either arm
  const searching = await run("searching", baseline);
  assert.equal(searching.code, 1);
  assert.match(searching.stderr, /the session was not set up as its arm requires: it had tools that its arm is not given: web_search/);
  // A session that put a file in the place of the link to the login ends the run, and the operator is told to look at it
  const relogin = await run("relogin", baseline);
  assert.equal(relogin.code, 1);
  assert.match(relogin.stderr, /A Codex session replaced the link to your login .* Run "codex login status"/);
  assert.deepEqual(records(), {});

  // Ctrl-C while a session works: Codex ends without a word, the session leaves no record, and its home goes
  const { code, sessions } = await interrupted(t, { args, env }, "busy", baseline);
  assert.equal(code, 130);
  assert.deepEqual(records(), {});
  assert.equal(sessions.length, 2);
  for (const session of sessions) assert.ok(!existsSync(codexHome(session)), "the home of an interrupted session is gone");
});

test("a Codex session's own failure is recorded, and a retry or a notice before a finished turn is no failure", async (t) => {
  const { run, records, home, started } = await planned(t, "codex");
  const baseline = ["--arms", "baseline"];
  // A request that holds more than the model takes, and a turn that fails on an error of the session's own
  for (const mode of ["overlong", "crashing"]) {
    const ended = await run(mode, [...baseline, "--repeat", mode === "overlong" ? "1" : "2"]);
    assert.equal(ended.code, 0, ended.stderr);
  }
  const failed = Object.values(records());
  assert.deepEqual(
    failed.map((record) => [record.outcome, record.failure, record.toolCalls]),
    [
      ["agent-failed", "error", { command_execution: 1 }],
      ["agent-failed", "error", { command_execution: 1 }],
    ]
  );
  // Codex waited to retry and fell back to another transport, and the turn went on to its end
  const flaky = await run("flaky", [...baseline, "--repeat", "3"]);
  assert.equal(flaky.code, 0, flaky.stderr);
  const record = records()["Fixture--rename-function--100--baseline--3"];
  assert.deepEqual([record.outcome, record.finished, record.apiRetries], ["passed", true, 2]);
  // Codex refreshed the login through the link, into the operator's own file, and the run went on
  const refreshed = await run("refresh", [...baseline, "--repeat", "4"]);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.equal(readFileSync(join(home, ".codex", "auth.json"), "utf-8"), '{"refreshed":true}\n');
  assert.ok(started().every((session) => !existsSync(codexHome(session))));
});

test("a Codex session of the lsp arm has the server only where its rollout names the server's tools", async (t) => {
  const { run, records } = await planned(t, "codex");
  const lsp = ["--arms", "lsp"];
  // The server did not start: the session's prompt names none of its tools, and its record says so
  const serverless = await run("serverless", lsp);
  assert.equal(serverless.code, 0, serverless.stderr);
  const [failed] = Object.values(records());
  assert.deepEqual([failed.outcome, failed.lspStatus, failed.lspCalls], ["server-failed", "failed", 0]);
  // A call that the server did not answer is no call to it
  const refused = await run("refused", [...lsp, "--repeat", "2"]);
  assert.equal(refused.code, 0, refused.stderr);
  const record = records()["Fixture--rename-function--100--lsp--2"];
  assert.deepEqual([record.lspStatus, record.lspCalls, record.toolCalls["mcp__elm-lsp__elm_rename_function"]], ["connected", 0, 1]);
  // A server whose tools the prompt does not name is no server of the arm's, though the session could have looked them up
  const deferring = await run("deferring", [...lsp, "--repeat", "4"]);
  assert.equal(deferring.code, 1);
  assert.match(deferring.stderr, /the session was not set up as its arm requires: Codex CLI named the language server and deferred its tools, so the prompt held none of them/);
  assert.equal(records()["Fixture--rename-function--100--lsp--4"], undefined);
  // Without a rollout nothing tells whether the session had the server, and nothing is recorded
  const unrecorded = await run("unrecorded", [...lsp, "--repeat", "3"]);
  assert.equal(unrecorded.code, 1);
  assert.match(unrecorded.stderr, /the session was not set up as its arm requires: Codex CLI did not say what it gave the session, so whether it had the tools of its arm and nothing else cannot be told/);
  assert.equal(records()["Fixture--rename-function--100--lsp--3"], undefined);
  // Nor in the other arm, whose tools are as unknown
  const baseline = await run("unrecorded", ["--arms", "baseline"]);
  assert.equal(baseline.code, 1);
  assert.match(baseline.stderr, /Codex CLI did not say what it gave the session/);
});

test("the isolation check of Codex reads its own view of a session's prompt before it pays for the session", async (t) => {
  const home = tempDir(t);
  const set = withEnvironment(t);
  const notes = join(tempDir(t), "started.jsonl");
  const check = (mode, more = {}) => {
    set({ FAKE_AGENT: mode, HOME: home, FAKE_AGENT_STARTED: notes, ...more });
    return assertIsolated({ harness: HARNESSES.codex, agentCommand: [process.execPath, STAND_INS.codex], model: "stand-in", timeoutMs: 30000 });
  };
  const sessions = () => (existsSync(notes) ? readFileSync(notes, "utf-8").trim().split("\n").length : 0);
  delete process.env.CODEX_HOME;

  assert.equal(await check("idle", { FAKE_AGENT_VERSION: "0.171.0" }), "0.171.0");
  // A tool that sends the user a message, as gpt-6.2-sol has, changes nothing that an arm can do
  assert.equal(await check("messaging", { FAKE_AGENT_VERSION: "0.171.0" }), "0.171.0");
  // Every place in the project and above it that Codex reads instructions from has a file of its own
  const places =
    "AGENTS\\.md in the project, AGENTS\\.override\\.md in a directory above the project, AGENTS\\.md at the root of the project's repository, a skill in \\.agents/skills of the project, " +
    "developer_instructions in \\.codex/config\\.toml of the project, a SessionStart hook in \\.codex/hooks\\.json of the project, a rule in \\.codex/rules of the project";
  await assert.rejects(check("nosy"), new RegExp(`not isolated from this machine's Codex CLI setup\\. A test session loaded: ${places}\\. Its flags may not suit`));
  // What `codex debug prompt-input` shows is looked at before any model is asked, and no session is started then
  const before = sessions();
  await assert.rejects(check("showing"), /A test session loaded: AGENTS\.md in the project, as its own view of a session's prompt shows, .*tools, though it was given none \(spawn_agent\), as its own view of a session's prompt shows/);
  // A tool that a script of exec calls counts as much as one at the top
  await assert.rejects(check("browsing"), /tools, though it was given none \(web_search\), as its own view of a session's prompt shows/);
  assert.equal(sessions(), before);
  // A file of the operator's own home of the Codex CLI, or of the skills in ~/.agents
  await assert.rejects(check("personal"), /A test session loaded: an instruction file of your user settings\./);
  await assert.rejects(check("named", { FAKE_AGENT_NAMED: "~/.agents/skills/mine/SKILL.md" }), /an instruction file of your user settings/);
});

test("a run in Codex is held to its harness, to the version that the executable names and to the efforts of its model", async (t) => {
  const { run, records, out, config } = await planned(t, "codex");
  const baseline = ["--arms", "baseline"];
  const count = join(tempDir(t), "count");
  // Codex updated itself after the isolation check: the session reports another version than the first one
  const updated = await run("solve", baseline, { FAKE_AGENT_VERSION: "0.171.0", FAKE_AGENT_VERSION_LATER: "0.172.0", FAKE_AGENT_COUNT: count });
  assert.equal(updated.code, 1);
  assert.match(updated.stderr, /the session was not set up as its arm requires: it ran in Codex CLI 0\.172\.0, and this run began with Codex CLI 0\.171\.0/);
  assert.deepEqual(records(), {});
  // An executable that answers no longer is no agent that names no version: the run says what failed
  const broken = await run("solve", baseline, { FAKE_AGENT_VERSION: "0.171.0", FAKE_AGENT_VERSION_FAILS: "1", FAKE_AGENT_COUNT: join(tempDir(t), "count") });
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /Codex CLI did not say which version it is, so its session cannot be held to the run's\. .* --version failed: dyld: Library not loaded/);
  assert.deepEqual(records(), {});
  assert.equal((await run("solve", baseline, { FAKE_AGENT_VERSION: "0.171.0" })).code, 0);
  // Sessions of another harness in the same output directory would sit in the same rounds
  const other = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-function", "--arms", "baseline", "--repeat", "2"]);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /runs holds records of sessions that ran differently: --harness was codex and is now claude-code, --model was stand-in and is now claude-opus-5-5, --max-budget-usd was none and is now 5/);
  // A level of effort that the catalog does not list for the model stops the run before any session is paid for
  const elsewhere = join(tempDir(t), "small");
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", elsewhere, "--min-files", "1", "--levels", "100"])).code, 0);
  const small = await runNode(BENCH, ["run", "--config", config, "--out", elsewhere, "--harness", "codex", "--model", "stand-in-small", "--effort", "max", "--agent", STAND_INS.codex]);
  assert.equal(small.code, 1);
  assert.match(small.stderr, /stand-in-small takes the efforts low, medium, high, xhigh in Codex, and not max\. Run it with one of those\./);
});

test("run asks for what a harness without a default needs, and refuses a setting that the harness lacks", async (t) => {
  const { args, env } = await planned(t, "codex");
  const without = (flag) => {
    const all = args();
    const at = all.indexOf(flag);
    return [...all.slice(0, at), ...all.slice(at + 2)];
  };
  const usage = async (argv, message) => {
    const result = await runNode(BENCH, argv, { env: env("solve") });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, message);
  };
  await usage(without("--model"), /^--model is required with --harness codex\. Name the model as codex takes it\./);
  await usage([...args(), "--effort", "ultra"], /^Unknown effort "ultra"\. Known: low, medium, high, xhigh, max, the levels that Codex CLI takes/);
  await usage([...args(), "--max-budget-usd", "2"], /^Codex CLI reports no cost, so --max-budget-usd cannot hold its sessions\. Leave it out\./);
  await usage([...args(), "--max-tokens", "1000"], /^Codex CLI counts tokens only when a session has ended, so --max-tokens cannot hold its sessions\. Leave it out\./);
  await usage([...without("--harness"), "--harness", "aider"], /^Unknown harness "aider"\. Known: claude-code, codex, antigravity/);
  await usage([...without("--harness"), "--harness", "claude-code", "--max-tokens", "1000"], /^Claude Code is held by --max-budget-usd, and --max-tokens cannot be given with --harness claude-code\./);
});

test("an Antigravity session of each arm solves its task as an agent of the checkout, in a settings directory of its own", async (t) => {
  const { out, run, records, started } = await planned(t, "antigravity");
  const solved = await run("solve", ["--effort", "low"], { FAKE_AGENT_VERSION: "1.5.13", AGY_CLI_AUTO_COMPACT_OVERRIDE: "0.1", ANTIGRAVITY_GEMINI_DIR: tempDir(t) });
  assert.equal(solved.code, 0, solved.stderr);
  const { "Fixture--rename-function--100--baseline--1": baseline, "Fixture--rename-function--100--lsp--1": lsp } = records();
  // Two answers of the model. The record holds every input token, the cached ones among them, and the thinking among the output.
  assert.deepEqual(
    [baseline.harness, baseline.agentVersion, baseline.effort, baseline.costUsd, baseline.inputTokens, baseline.cacheReadInputTokens, baseline.outputTokens, baseline.turns, baseline.apiRetries],
    ["antigravity", "1.5.13", "low", null, 4200, 200, 80, null, null]
  );
  assert.deepEqual([baseline.toolCalls, baseline.lspCalls, baseline.lspStatus, baseline.changedFiles], [{ run_command: 1, edit_file: 1 }, 0, "absent", 2]);
  // Its settings directory holds a file for each tool of the server that the agent was given
  assert.deepEqual([lsp.toolCalls, lsp.lspCalls, lsp.lspStatus, lsp.lspTools, lsp.outcome], [{ run_command: 1, "mcp__elm-lsp__elm_rename_function": 1 }, 1, "connected", 2, "passed"]);
  // The agent of the checkout is no change of the session's, and names the tools and the server of its arm
  assert.equal(baseline.problems.length, 0);
  const [isolation, ...tasks] = started();
  assert.match(isolation.agent, /\ntools: \[\]\n/);
  const agents = tasks.map(({ agent }) => agent).sort();
  assert.match(agents[0], /^---\nname: session\n.*\ntools: \["read_file","edit_file","write_file","run_command","manage_task"\]\ninheritCustomizations: false\n/s);
  assert.ok(!agents[0].includes("mcpServers") && agents[1].includes('mcpServers:\n  - name: "elm-lsp"'));
  for (const session of [isolation, ...tasks]) {
    const { args } = session;
    assert.ok(madeFor(geminiDir(session)), geminiDir(session));
    assert.ok(!existsSync(geminiDir(session)), "the session's settings directory is gone");
    assert.match(args[args.indexOf("--settings") + 1], /^\{"permissions":\{"allow":\[\],"ask":\[\],"deny":\["command\(git commit\)",.*"read_url\(\*\)","execute_url\(\*\)"\]\}\}$/);
    // The operator's variables that move Antigravity's directories or change how it runs stay out
    assert.ok(session.variables.includes("AGY_CLI_DISABLE_AUTO_UPDATE"));
    for (const name of ["AGY_CLI_AUTO_COMPACT_OVERRIDE", "ANTIGRAVITY_GEMINI_DIR"]) assert.ok(!session.variables.includes(name), name);
  }
  for (const { args } of tasks) assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "low"]);
  assert.equal(JSON.parse(readFileSync(join(out, "run.json"), "utf-8")).agent, "Antigravity CLI 1.5.13");
  assert.equal((await runNode(BENCH, ["report", "--out", out])).code, 0);
  const page = readFileSync(join(out, "report.html"), "utf-8");
  assert.match(page, /"API retries" is empty where Antigravity CLI does not say when it asks the API again\./);
  assert.match(page, / "Out of time" and "Out of tokens" are the limits the benchmark was run with\. /);
  assert.match(page, /<th class="number">Out of time<\/th><th class="number">Out of tokens<\/th><th class="number">Session error<\/th>/);
});

test("an Antigravity session that loses the API, reaches its quota, is interrupted or spends its tokens is told apart", async (t) => {
  const { run, records, args, env } = await planned(t, "antigravity");
  const baseline = ["--arms", "baseline"];
  const lost = await run("unreachable", baseline);
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /the session ended before the model answered once \(You have exhausted your quota on this model\. .*\)\. Nothing was recorded for it\. Antigravity CLI said that it can go on in 4h12m/);
  const limited = await run("limited", baseline);
  assert.match(limited.stderr, /lost the API in the middle of its work \(RESOURCE_EXHAUSTED \(429\): .*\)\. .*can go on in 4h12m/);
  // The error of an exhausted quota need not say why the turn ended, and it is the API's all the same
  const quota = await run("quota", baseline);
  assert.match(quota.stderr, /lost the API in the middle of its work \(RESOURCE_EXHAUSTED \(429\): .*\)\. Nothing was recorded for it\./);
  const searching = await run("searching", baseline);
  assert.match(searching.stderr, /it had tools that its arm is not given: search_web/);
  assert.deepEqual(records(), {});

  // Ctrl-C while a session works: Antigravity says what it spent, the session leaves no record, and its directory goes
  const { code, sessions } = await interrupted(t, { args, env }, "busy", baseline);
  assert.equal(code, 130);
  assert.deepEqual(records(), {});
  for (const session of sessions) assert.ok(!existsSync(geminiDir(session)));

  // Antigravity counts tokens with every step, a compaction's as well, so a session can be held to a number of them
  const greedy = await run("greedy", [...baseline, "--max-tokens", "5000"]);
  assert.equal(greedy.code, 0, greedy.stderr);
  assert.match(greedy.stdout, /only the time limit of 1 minute and the limit of 5000 tokens hold each session/);
  const [record] = Object.values(records());
  assert.deepEqual([record.outcome, record.failure], ["agent-failed", "token-limit"]);
  assert.ok(record.wallMs < 20000, `a session over its tokens took ${record.wallMs} ms`);
  // An error of the session's own is its record
  const crashing = await run("crashing", [...baseline, "--repeat", "2", "--max-tokens", "5000"]);
  assert.equal(crashing.code, 0, crashing.stderr);
  const own = records()["Fixture--rename-function--100--baseline--2"];
  assert.deepEqual([own.outcome, own.failure, own.endedOnApiError], ["agent-failed", "error", false]);
  // Whatever words the harness ends such a session with, the benchmark ended it, and it lost no API
  const stopped = await run("greedy", [...baseline, "--repeat", "3", "--max-tokens", "5000"], { FAKE_AGENT_STOPPED: "RESOURCE_EXHAUSTED (429): You have exhausted your quota." });
  assert.equal(stopped.code, 0, stopped.stderr);
  const held = records()["Fixture--rename-function--100--baseline--3"];
  assert.deepEqual([held.outcome, held.failure, held.endedOnApiError], ["agent-failed", "token-limit", false]);
});

test("an Antigravity session of the lsp arm whose server did not start is recorded as such", async (t) => {
  const { run, records } = await planned(t, "antigravity");
  const serverless = await run("serverless", ["--arms", "lsp"]);
  assert.equal(serverless.code, 0, serverless.stderr);
  const [record] = Object.values(records());
  assert.deepEqual([record.outcome, record.lspStatus, record.lspTools], ["server-failed", "failed", null]);
});

test("the agent of an Antigravity session is written into directories of the checkout only", async (t) => {
  // A configured link puts the operator's own untracked .agents into the checkout, and the agent would land there
  let elsewhere;
  const linked = await planned(t, "antigravity", {
    untracked: (repo) => {
      elsewhere = join(repo, ".agents");
      mkdirSync(elsewhere);
    },
    codebase: { link: [".agents"] },
  });
  const refused = await linked.run("solve", ["--arms", "baseline"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Fixture: \.agents in the checkout is a link, and the benchmark writes the agent of a session only into directories of the checkout\./);
  assert.deepEqual(readdirSync(elsewhere), []);
  // A commit that holds an agent of the same name
  const committed = await planned(t, "antigravity", {
    committed: (repo) => {
      mkdirSync(join(repo, ".agents", "agents", "session"), { recursive: true });
      writeFileSync(join(repo, ".agents", "agents", "session", "agent.md"), "---\nname: session\n---\n");
    },
  });
  const there = await committed.run("solve", ["--arms", "baseline"]);
  assert.equal(there.code, 1);
  assert.match(there.stderr, /The checkout already holds \.agents\/agents\/session\/agent\.md, the agent that the benchmark makes for a session\./);
});

test("the isolation check of Antigravity plants rules and reads the log of its session", async (t) => {
  const set = withEnvironment(t);
  const check = (mode, more = {}) => {
    set({ FAKE_AGENT: mode, ...more });
    return assertIsolated({ harness: HARNESSES.antigravity, agentCommand: [process.execPath, STAND_INS.antigravity], model: "stand-in", timeoutMs: 30000 });
  };
  assert.equal(await check("idle", { FAKE_AGENT_VERSION: "1.5.13" }), "1.5.13");
  const places =
    "AGENTS\\.md in the project, GEMINI\\.md in the project, AGENTS\\.md in \\.agents of the project, AGENTS\\.md in a directory above the project, " +
    "GEMINI\\.md in a directory above the project, a rule in \\.agents/rules of the project";
  await assert.rejects(check("nosy"), new RegExp(`not isolated from this machine's Antigravity CLI setup\\. A test session loaded: ${places}\\. Its flags`));
  await assert.rejects(check("named", { FAKE_AGENT_NAMED: "~/.gemini/config/rules/mine.md" }), /an instruction file of your user settings/);
  // A hook says nothing until its event comes, and the log of the session counts it all the same
  await assert.rejects(check("hooked"), /A test session loaded: a hook of a hooks\.json, as the log of the session says\./);
});

test("what a checkout holds that Antigravity hands every session is taken out of it for both arms, and is no change of a session's", async (t) => {
  // A skill that would tell either arm what to use, a hook and a server, as a codebase can commit them
  const committed = {
    ".agents/skills/mine/SKILL.md": "---\nname: mine\ndescription: Use the Elm language server.\n---\nUse the Elm language server.\n",
    ".agent/hooks.json": '{"hooks":{}}\n',
    "_agents/mcp_config.json": '{"mcpServers":{"theirs":{"command":"true"}}}\n',
    // A file of the name of a customization directory, which holds none
    _agent: "Not a directory.\n",
  };
  const { repo, out, run, records, started } = await planned(t, "antigravity", {
    committed: (repo) => {
      for (const [file, text] of Object.entries(committed)) {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        writeFileSync(join(repo, file), text);
      }
    },
  });
  const solved = await run("solve", [], { FAKE_AGENT_VERSION: "1.5.13" });
  assert.equal(solved.code, 0, solved.stderr);
  // Said once for the codebase, though two sessions ran in it
  assert.deepEqual(solved.stdout.match(/^Fixture: Antigravity CLI hands .*$/gm), [
    "Fixture: Antigravity CLI hands .agents/skills, .agent/hooks.json and _agents/mcp_config.json to every session, whatever it is started with, so the benchmark takes them out of the checkout of every session of both arms.",
  ]);
  // Neither session was told of the skill or given the server, and what went is no change of either: not among the
  // changed files, not in the patch, not a commit that the session would have made
  const [isolation, ...tasks] = started();
  for (const session of [isolation, ...tasks]) assert.deepEqual(session.skills, []);
  const all = Object.values(records());
  assert.deepEqual(
    all.map(({ arm, outcome, problems, changedFiles, strayServers }) => [arm, outcome, problems, changedFiles, strayServers]).sort(),
    [
      ["baseline", "passed", [], 2, []],
      ["lsp", "passed", [], 2, []],
    ]
  );
  for (const file of readdirSync(join(out, "runs")).filter((name) => name.endsWith(".patch"))) {
    assert.ok(!/agents?\//.test(readFileSync(join(out, "runs", file), "utf-8")), file);
  }
  // The codebase keeps them, and the checkouts went as they came
  for (const [file, text] of Object.entries(committed)) assert.equal(readFileSync(join(repo, file), "utf-8"), text);
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf-8" }), "");
  assert.equal(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8" }).match(/^worktree /gm).length, 1);
  assert.deepEqual(readdirSync(join(out, "work")), []);
});

test("Antigravity's customizations that are no files of the commit stop the run, and what they lead to stays", async (t) => {
  // The config links the operator's own .agents into the checkout, with a skill in it
  let theirs;
  const linked = await planned(t, "antigravity", {
    untracked: (repo) => {
      theirs = join(repo, ".agents", "skills", "mine", "SKILL.md");
      mkdirSync(dirname(theirs), { recursive: true });
      writeFileSync(theirs, "---\nname: mine\n---\n");
    },
    codebase: { link: [".agents"] },
  });
  const refused = await linked.run("solve", ["--arms", "baseline"]);
  assert.equal(refused.code, 1);
  assert.match(
    refused.stderr,
    /^Fixture: Antigravity CLI hands \.agents\/skills to every session, whatever it is started with, and the benchmark takes only files of the commit out of a checkout\. Here \.agents is a link, and what \.agents\/skills holds lies where it leads\. Run this codebase in another harness, or commit what the path holds\.$/m
  );
  assert.ok(existsSync(theirs));
  assert.deepEqual(linked.records(), {});
  // A configured link in the place of the skills
  const inPlace = await planned(t, "antigravity", {
    committed: (repo) => {
      mkdirSync(join(repo, ".agents", "rules"), { recursive: true });
      writeFileSync(join(repo, ".agents", "rules", "style.md"), "Keep it short.\n");
    },
    untracked: (repo) => {
      mkdirSync(join(repo, ".agents", "skills", "mine"), { recursive: true });
      writeFileSync(join(repo, ".agents", "skills", "mine", "SKILL.md"), "---\nname: mine\n---\n");
    },
    codebase: { link: [".agents/skills"] },
  });
  const there = await inPlace.run("solve", ["--arms", "baseline"]);
  assert.equal(there.code, 1);
  assert.match(there.stderr, /Here \.agents\/skills is no file of the commit\. Run this codebase in another harness/);
  assert.ok(existsSync(join(inPlace.repo, ".agents", "skills", "mine", "SKILL.md")));
});

test("a Codex session that ran out of time before its turn ended has no tokens, and the report leaves it out of their medians", async (t) => {
  const { out, run, records } = await planned(t, "codex");
  const slow = await run("busy", ["--arms", "baseline", "--timeout-min", "0.05"]);
  assert.equal(slow.code, 0, slow.stderr);
  const [record] = Object.values(records());
  assert.deepEqual([record.failure, record.inputTokens, record.cacheReadInputTokens, record.outputTokens], ["time-limit", null, null, null]);
  assert.equal((await runNode(BENCH, ["report", "--out", out])).code, 0);
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf-8"));
  assert.deepEqual([summary.overall.baseline.withoutTokens, summary.overall.baseline.inputTokens], [1, null]);
});

test("a report refuses the records of two harnesses or two models, which would sit in the same rounds", () => {
  const plan = { codebases: [{ label: "Fixture", modules: 3, lines: 90 }] };
  const record = (arm, more) => ({ task: "Fixture/rename-function/100", codebase: "Fixture", type: "rename-function", level: 100, arm, repetition: 1, outcome: "passed", toolCalls: {}, model: "m", ...more });
  assert.throws(
    () => summarize(plan, [record("baseline", { harness: "codex" }), record("lsp", {})]),
    /^Error: The records are of sessions in Codex CLI and Claude Code\. A report shows one run: give each harness an --out of its own, and report each one\.$/
  );
  assert.throws(() => summarize(plan, [record("baseline", { model: "a" }), record("lsp", { model: "b" })]), /The records are of sessions with a and b\./);
  assert.throws(() => summarize(plan, [record("baseline", { harness: "aider" })]), /The records name a harness that this benchmark does not know: aider\./);
});

test("Antigravity counts the tokens of finished steps, and tells how a turn ended from what its result holds", () => {
  const { read, tokensSoFar } = HARNESSES.antigravity;
  const step = (index, state, usage) => ({ event: "step_update", step_update: { step_index: index, step_type: "agent_response", state, usage } });
  const usage = (input) => ({ input_tokens: input, output_tokens: 10, cache_read_tokens: 5, total_tokens: input + 10 });
  // A step that is still under way counts nothing yet, neither for the limit nor as an answer
  const events = [step(1, "DONE", usage(100)), step(2, "ACTIVE", usage(90000))];
  assert.equal(tokensSoFar(events), 115);
  const going = read(events, { arm: "baseline", tools: HARNESSES.antigravity.tools, given: null });
  assert.deepEqual([going.replies, going.inputTokens, going.stopReason], [1, 105, "no result"]);
  // A reason left empty is no reason, and a result that names no status is still read
  const ended = (result) => read([...events, { event: "result", result }], { arm: "baseline", tools: HARNESSES.antigravity.tools, given: null });
  assert.deepEqual([ended({ status: "SUCCESS", finished_reason: "" }).finished, ended({ status: "SUCCESS", finished_reason: "" }).stopReason], [true, "success"]);
  assert.deepEqual([ended({ error: "boom" }).finished, ended({ error: "boom" }).stopReason, ended({ error: "boom" }).failureText], [false, "no status", "boom"]);
  // A tool of the server is called through call_mcp_tool, or by a name of its own where the server marks it as eager
  const called = (arm, ...names) =>
    read(
      [{ event: "init", init: { agent: "session" } }, ...names.map((name, index) => ({ event: "step_update", step_update: { step_index: index, step_type: "tool", tool_name: name, state: "DONE", tool_info: {} } }))],
      { arm, tools: HARNESSES.antigravity.tools, given: { servers: arm === "lsp" ? { "elm-lsp": 2 } : {}, hooks: 0 } }
    );
  const eager = called("lsp", "mcp_elm-lsp_elm_rename_function", "read_resource");
  assert.deepEqual([eager.lspCalls, eager.toolCalls, eager.strayTools, eager.strayServers], [1, { "mcp__elm-lsp__elm_rename_function": 1, read_resource: 1 }, [], []]);
  // The resources of a server are no tool of an arm without one
  assert.deepEqual(called("baseline", "list_resources").strayTools, ["list_resources"]);
  // Ctrl-C ends a turn with an error, which is no error of the API
  const interrupted = ended({ status: "ERROR", error: "interrupted", finished_reason: "interrupted" });
  assert.deepEqual([interrupted.finished, interrupted.stopReason, interrupted.endedOnApiError], [false, "interrupted", false]);
  // The counts of a real session of four answers. Its input fell as the cache reads rose, so the input leaves
  // them out, and every input token of the record is the two together, as in the other harnesses.
  const answered = [
    [4288, 0, 302],
    [2882, 2231, 251],
    [2574, 3064, 105],
    [2122, 4068, 275],
  ].map(([input, cached, output], index) => step(index + 1, "DONE", { input_tokens: input, cache_read_tokens: cached, output_tokens: output, total_tokens: input + output }));
  const real = read(answered, { arm: "baseline", tools: HARNESSES.antigravity.tools, given: null });
  assert.deepEqual([real.inputTokens, real.cacheReadInputTokens, real.outputTokens], [21229, 9363, 933]);
  assert.equal(tokensSoFar(answered), 21229 + 933);
});

test("an API's trouble is told by the status or the words of the harness, and the session's own failure is not", () => {
  // A status in brackets behind a word, as Gemini's errors give it
  assert.equal(statusIn("RESOURCE_EXHAUSTED (429): You have exhausted your quota on this model."), 429);
  assert.equal(statusIn("exceeded retry limit, last status: 503 Service Unavailable"), 503);
  for (const text of ["stream disconnected before completion", "You've hit your usage limit.", "Authentication expired. Please log back in.", "unexpected status 401 Unauthorized"]) {
    assert.ok(lostTheApi(text), text);
  }
  for (const text of ["The model produced a tool call that Codex could not parse.", "model output must contain either output text or tool calls", "unexpected status 400 Bad Request"]) {
    assert.ok(!lostTheApi(text), text);
  }
  // A finished turn is the last word on it, whatever Codex said of retries and transports before
  const events = [
    { type: "thread.started" },
    { type: "error", message: "Falling back from WebSockets to HTTPS transport." },
    { type: "item.completed", item: { id: "1", type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
  ];
  const read = HARNESSES.codex.read(events, { arm: "baseline", tools: HARNESSES.codex.tools, given: null });
  assert.deepEqual([read.finished, read.endedOnApiError, read.replies, read.inputTokens], [true, false, 1, 10]);
  // A turn that failed on what Codex had asked the API again for lost the API, whatever its words
  const retried = [
    { type: "thread.started" },
    { type: "item.completed", item: { id: "1", type: "agent_message", text: "Looking." } },
    { type: "error", message: "Reconnecting... 1/5 (Something new went wrong.)" },
    { type: "error", message: "Something new went wrong." },
    { type: "turn.failed", error: { message: "Something new went wrong." } },
  ];
  const gaveUp = HARNESSES.codex.read(retried, { arm: "baseline", tools: HARNESSES.codex.tools, given: null });
  assert.deepEqual([gaveUp.finished, gaveUp.endedOnApiError, gaveUp.apiRetries], [false, true, 1]);
});
