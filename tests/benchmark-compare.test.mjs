/**
 * Tests of `bench.mjs compare` and benchmarks/lib/compare.mjs, which put the
 * records of several runs side by side. They start no session.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { compareRuns, renderComparison } from "../benchmarks/lib/compare.mjs";
import { summarize } from "../benchmarks/lib/report.mjs";
import { BENCH } from "./benchmark-support.mjs";
import { runNode, tempDir } from "./support.mjs";

const RENAME = "A/rename-function/10";
const MOVE = "A/move-function/10";

const PLAN = {
  codebases: [{ label: "A", commit: "abc123", modules: 12, lines: 3400 }],
  tasks: [RENAME, MOVE].map((id) => ({ id, codebase: "A", type: id.split("/")[1], level: 10, files: 12, prompt: `Do ${id} in src/Secret.elm`, expect: [], facts: {} })),
};

// A session of a made-up run. A failed one names a file of the codebase in its problems, as real ones do.
const session = (task, arm, { outcome = "passed", wallS, costUsd = null, inputTokens, outputTokens, toolCalls, problems = [] }, run) => ({
  id: `${task.replaceAll("/", "--")}--${arm}--1`,
  task,
  codebase: "A",
  type: task.split("/")[1],
  level: 10,
  files: 12,
  arm,
  repetition: 1,
  ...run,
  agentVersion: "1.0.0",
  languageServer: "0.3.39 (abcdef0)",
  outcome,
  failure: null,
  problems,
  changedFiles: 2,
  wallMs: wallS * 1000,
  costUsd,
  turns: 3,
  replies: 4,
  inputTokens,
  cacheReadInputTokens: 0,
  outputTokens,
  toolCalls,
  lspCalls: Object.entries(toolCalls).filter(([name]) => name.startsWith("mcp__elm-lsp__")).reduce((total, [, calls]) => total + calls, 0),
  apiRetries: 0,
});

// Claude Code, whose records of old name no harness, and which reports a cost
const CLAUDE = { model: "claude-opus-5-5" };
const CLAUDE_RECORDS = [
  session(RENAME, "baseline", { wallS: 100, costUsd: 1, inputTokens: 100, outputTokens: 10, toolCalls: { Bash: 4 } }, CLAUDE),
  session(RENAME, "lsp", { wallS: 50, costUsd: 0.5, inputTokens: 60, outputTokens: 5, toolCalls: { "mcp__elm-lsp__elm_rename_function": 1, Bash: 1 } }, CLAUDE),
  session(MOVE, "baseline", { wallS: 100, costUsd: 1, inputTokens: 100, outputTokens: 10, toolCalls: { Bash: 4 } }, CLAUDE),
  session(
    MOVE,
    "lsp",
    { outcome: "wrong-result", wallS: 50, costUsd: 0.5, inputTokens: 60, outputTokens: 5, toolCalls: { Bash: 2 }, problems: ["changed files that are no Elm sources of the project: secret-notes.txt"] },
    CLAUDE
  ),
];

// The Codex CLI, which reports tokens and no cost
const CODEX = { harness: "codex", model: "gpt-6" };
const CODEX_RECORDS = [
  session(
    RENAME,
    "baseline",
    { outcome: "wrong-result", wallS: 100, inputTokens: 100, outputTokens: 10, toolCalls: { command_execution: 3 }, problems: ['src/Secret.elm changed in more than the name: "hiddenName" became "renamed"'] },
    CODEX
  ),
  session(RENAME, "lsp", { wallS: 80, inputTokens: 90, outputTokens: 8, toolCalls: { "mcp__elm-lsp__elm_rename_function": 1, command_execution: 1 } }, CODEX),
  session(MOVE, "baseline", { wallS: 100, inputTokens: 100, outputTokens: 10, toolCalls: { command_execution: 3 } }, CODEX),
  session(MOVE, "lsp", { wallS: 80, inputTokens: 90, outputTokens: 8, toolCalls: { "mcp__elm-lsp__elm_move_function": 1, command_execution: 1 } }, CODEX),
];

// The settings of a run as run.json holds them
const SETTINGS = { maxBudgetUsd: 5, maxTokens: null, timeoutMin: 20, benchmark: "0123456789abcdef0123456789abcdef01234567", arms: ["baseline", "lsp"] };

// A run directory as `run` leaves it, with its plan, its settings and a record per session
function runDirectory(root, name, records, plan = PLAN, settings = SETTINGS) {
  const dir = join(root, name);
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "run.json"), JSON.stringify(settings));
  for (const record of records) writeFileSync(join(dir, "runs", `${record.id}.json`), JSON.stringify(record));
  return dir;
}

const compare = (args) => runNode(BENCH, ["compare", ...args]);

test("compare puts two runs side by side, with the figures of their reports", async (t) => {
  const root = tempDir(t);
  const [claude, codex] = [runDirectory(root, "claude", CLAUDE_RECORDS), runDirectory(root, "codex", CODEX_RECORDS, PLAN, { ...SETTINGS, maxBudgetUsd: null })];
  const out = join(root, "compared");
  const result = await compare(["--out", out, claude, codex]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Wrote .*comparison\.html/);

  const comparison = JSON.parse(readFileSync(join(out, "comparison.json"), "utf-8"));
  const [one, two] = comparison.runs;
  assert.deepEqual([one.name, two.name], ["claude-opus-5-5 in Claude Code", "gpt-6 in Codex CLI"]);
  assert.deepEqual([one.solved, two.solved], [
    { baseline: { solved: 2, sessions: 2 }, lsp: { solved: 1, sessions: 2 } },
    { baseline: { solved: 1, sessions: 2 }, lsp: { solved: 2, sessions: 2 } },
  ]);
  // 200 s against 100 s, $2 against $1, 200 tokens in against 120 and 20 out against 10. Two tasks are too few for an interval.
  const saved = (run, figure) => [run.savings[figure].savedPercent, run.savings[figure].interval];
  assert.deepEqual(["wallMs", "costUsd", "inputTokens", "outputTokens"].map((figure) => saved(one, figure)), [[50, null], [50, null], [40, null], [50, null]]);
  // The Codex CLI reports no cost: 200 s against 160 s, 200 tokens in against 180
  assert.equal(two.savings.costUsd, null);
  assert.deepEqual(["wallMs", "inputTokens", "outputTokens"].map((figure) => saved(two, figure)), [[20, null], [10, null], [20, null]]);
  // Each run has one task that one arm solved more often, so p is 1
  assert.deepEqual([one.savings.solved.signP, two.savings.solved.signP], [1, 1]);
  assert.deepEqual([one.serverUse.called, two.serverUse.called], [1, 2]);
  assert.deepEqual([one, two].map(({ activity }) => [activity.baseline.toolCalls.mean, activity.lsp.toolCalls.mean]), [[4, 2], [3, 2]]);
  // Each figure is there once, and nothing that the page leaves out
  assert.deepEqual(Object.keys(one), ["name", "coverage", "setup", "model", "harness", "costReported", "solved", "savings", "activity", "serverUse", "failures"]);
  // On the two rounds that both did, each arm has one task that one run solved more often, and one tie
  assert.deepEqual(comparison.differences, {
    baseline: [{ runs: ["claude-opus-5-5 in Claude Code", "gpt-6 in Codex CLI"], rounds: 2, solved: [2, 1], tasks: { firstMore: 1, secondMore: 0, tied: 1 }, signP: 1 }],
    lsp: [{ runs: ["claude-opus-5-5 in Claude Code", "gpt-6 in Codex CLI"], rounds: 2, solved: [1, 2], tasks: { firstMore: 0, secondMore: 1, tied: 1 }, signP: 1 }],
  });
  // Each run did one round of each of the plan's two tasks, and says how it was set up
  assert.deepEqual([one.coverage, two.coverage], [{ planned: 2, rounds: [{ rounds: 1, tasks: 2 }] }, { planned: 2, rounds: [{ rounds: 1, tasks: 2 }] }]);
  assert.deepEqual([one.setup, two.setup], [
    { agent: "Claude Code 1.0.0", languageServers: ["0.3.39 (abcdef0)"], recorded: true, timeoutMin: 20, maxBudgetUsd: 5, maxTokens: null, benchmark: SETTINGS.benchmark },
    { agent: "Codex CLI 1.0.0", languageServers: ["0.3.39 (abcdef0)"], recorded: true, timeoutMin: 20, maxBudgetUsd: null, maxTokens: null, benchmark: SETTINGS.benchmark },
  ]);
  assert.deepEqual(one.failures.map(({ id, baseline, lsp }) => [id, baseline, lsp]), [["non-elm-file", 0, 1]]);
  assert.deepEqual(two.failures.map(({ id, baseline, lsp }) => [id, baseline, lsp]), [["inside-string", 1, 0]]);

  const html = readFileSync(join(out, "comparison.html"), "utf-8");
  assert.match(
    html,
    /<tr><td>claude-opus-5-5 in Claude Code<\/td><td class="number">1 round of 2 tasks<\/td><td class="number">2 of 2<\/td><td class="number">1 of 2<\/td><td class="number">50%<\/td><td class="number">50%<\/td><td class="number">40%<\/td><td class="number">50%<\/td><td class="number">1 of 2<\/td><td class="number">4\.0<\/td><td class="number">2\.0<\/td><td class="number">1<\/td><td class="number">0<\/td><td class="number">1\.000<\/td><\/tr>/
  );
  assert.match(
    html,
    /<tr><td>gpt-6 in Codex CLI<\/td><td class="number">1 round of 2 tasks<\/td><td class="number">1 of 2<\/td><td class="number">2 of 2<\/td><td class="number">20%<\/td><td class="number">not reported<\/td><td class="number">10%<\/td>/
  );
  // How each run was set up, and what differs between them
  assert.match(html, /<tr><td>gpt-6 in Codex CLI<\/td><td class="number">Codex CLI 1\.0\.0<\/td><td class="number">0\.3\.39 \(abcdef0\)<\/td><td class="number">20 min<\/td><td class="number">none<\/td><td class="number">none<\/td><td class="number">0123456<\/td><\/tr>/);
  assert.match(html, /The runs differ in budget per session\. Their figures can differ for that reason as well as for the model and the harness\. A harness that reports no cost cannot be held to a budget\./);
  assert.match(
    html,
    /<td>claude-opus-5-5 in Claude Code and gpt-6 in Codex CLI<\/td><td class="number">2<\/td><td class="number">2 of 2<\/td><td class="number">1 of 2<\/td><td class="number">1<\/td><td class="number">0<\/td><td class="number">1\.000<\/td>/
  );
  assert.match(html, /Two runs are compared in one arm on the rounds that both did, each repetition of a task beside the one of the same number in the other run\. /);
  // Each run's section: the tool split per arm, the server's use by kind of task and the failures by kind
  assert.match(html, /<h2>gpt-6 in Codex CLI<\/h2><h3>Tool calls by tool, all of the server's as one<\/h3>/);
  assert.match(html, /<td>command_execution<\/td><td class="number">6<\/td><td class="number">3\.0<\/td><td class="number">2<\/td><td class="number">1\.0<\/td><\/tr>/);
  assert.match(html, /<td>Move a function to another module<\/td><td class="number">1<\/td><td class="number">0<\/td><\/tr>/);
  assert.match(html, /<td>Changed a file that is no Elm source<\/td><td class="number">0<\/td><td class="number">1<\/td><\/tr>/);
  assert.match(html, /<td>Changed a string literal<\/td><td class="number">1<\/td><td class="number">0<\/td><\/tr>/);
  assert.ok(!html.includes("A reading of these figures"), "no notes were given");
  // What the check said, the prompts and the commit stay in the records
  for (const secret of ["Secret", "hiddenName", "secret-notes", "abc123"]) {
    assert.ok(!(JSON.stringify(comparison) + html).includes(secret), `${secret} stays out of the comparison`);
  }
  // Nothing on the page loads from the network
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\//.test(html));
});

test("compare shows the notes it is given as a reading of the figures, and refuses notes about a model no run has", async (t) => {
  const root = tempDir(t);
  const claude = runDirectory(root, "claude", CLAUDE_RECORDS);
  const notes = join(root, "notes.json");
  writeFileSync(notes, JSON.stringify({ "claude-opus-5-5": ["The <b>server</b> saved half the time.", "A second paragraph."] }));
  const out = join(root, "compared");
  // One run alone is a comparison too, and its directory may stand before the options
  const result = await compare([claude, "--out", out, "--notes", notes]);
  assert.equal(result.code, 0, result.stderr);
  const html = readFileSync(join(out, "comparison.html"), "utf-8");
  assert.match(html, /<h2>claude-opus-5-5 in Claude Code<\/h2><h3>A reading of these figures, written by hand<\/h3><p class="lede">What follows is someone's reading of the figures above and below, and no output of the benchmark\.<\/p>/);
  assert.match(html, /<p class="note">The &lt;b&gt;server&lt;\/b&gt; saved half the time\.<\/p><p class="note">A second paragraph\.<\/p>/);
  assert.match(html, /<p class="lede">One run, of one model in one harness\. /);
  assert.match(html, /One run, so there is nothing to compare between runs\./);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "comparison.json"), "utf-8")).differences, { baseline: [], lsp: [] });

  writeFileSync(notes, JSON.stringify({ "claude-opus-5-5": ["Fine."], "gpt-7": ["No such run."] }));
  const unknown = await compare(["--out", out, "--notes", notes, claude]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /The notes name gpt-7, which is no run here\. The runs are claude-opus-5-5 in Claude Code\./);
  writeFileSync(notes, JSON.stringify({ "claude-opus-5-5": "Not a list." }));
  assert.match((await compare(["--out", out, "--notes", notes, claude])).stderr, /The notes must map the name of a run, or the id of its model, to a list of paragraphs/);

  // A note names its run, which tells two runs of a model apart. It shows in that run's section alone.
  const harder = runDirectory(root, "harder", CLAUDE_RECORDS.map((record) => ({ ...record, effort: "high" })));
  const codex = runDirectory(root, "codex", CODEX_RECORDS);
  writeFileSync(notes, JSON.stringify({ "claude-opus-5-5 at effort high in Claude Code": ["Thought harder."], "gpt-6": ["Codex alone."] }));
  assert.equal((await compare(["--out", out, "--notes", notes, claude, harder, codex])).code, 0);
  const sections = readFileSync(join(out, "comparison.html"), "utf-8").split('<section class="card section"><h2>').slice(1);
  const notesOf = (name) => sections.find((section) => section.startsWith(`${name}</h2>`)).match(/<p class="note">([^<]*)<\/p>/g) ?? [];
  assert.deepEqual(notesOf("claude-opus-5-5 in Claude Code").filter((note) => /Thought|Codex alone/.test(note)), []);
  assert.deepEqual(notesOf("claude-opus-5-5 at effort high in Claude Code").filter((note) => /Thought|Codex alone/.test(note)), ['<p class="note">Thought harder.</p>']);
  assert.deepEqual(notesOf("gpt-6 in Codex CLI").filter((note) => /Thought|Codex alone/.test(note)), ['<p class="note">Codex alone.</p>']);
  // The id of a model with two runs here names neither
  writeFileSync(notes, JSON.stringify({ "claude-opus-5-5": ["Which one?"] }));
  assert.match(
    (await compare(["--out", out, "--notes", notes, claude, harder])).stderr,
    /The notes name claude-opus-5-5, which is the model of 2 runs: claude-opus-5-5 in Claude Code, claude-opus-5-5 at effort high in Claude Code\. Name the run that each note is about\./
  );
});

test("compare refuses runs of other plans, and two runs of the same model in the same harness", async (t) => {
  const root = tempDir(t);
  const claude = runDirectory(root, "claude", CLAUDE_RECORDS);
  const out = join(root, "compared");
  const codexOf = (name, plan) => runDirectory(root, name, CODEX_RECORDS, plan);

  const reworded = codexOf("reworded", { ...PLAN, tasks: PLAN.tasks.map((task) => (task.id === MOVE ? { ...task, prompt: "Something else" } : task)) });
  const other = await compare(["--out", out, claude, reworded]);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /The runs were planned differently, so their figures cannot be compared: the task A\/move-function\/10 has other words in .*reworded than in .*claude\./);
  assert.ok(!other.stderr.includes("Something else"), "the error names no prompt");

  const wider = codexOf("wider", { ...PLAN, tasks: PLAN.tasks.map((task) => (task.id === RENAME ? { ...task, files: 13 } : task)) });
  assert.match((await compare(["--out", out, claude, wider])).stderr, /the task A\/rename-function\/10 has other files in .*wider than in .*claude\./);
  const fewer = codexOf("fewer", { ...PLAN, tasks: PLAN.tasks.slice(0, 1) });
  assert.match((await compare(["--out", out, claude, fewer])).stderr, /.*fewer has no task A\/move-function\/10, which .*claude has\./);
  const more = codexOf("more", { ...PLAN, tasks: [...PLAN.tasks, { ...PLAN.tasks[0], id: "A/rename-function/50" }] });
  assert.match((await compare(["--out", out, claude, more])).stderr, /.*more has a task A\/rename-function\/50, which .*claude does not have\./);

  const again = join(root, "again");
  cpSync(claude, again, { recursive: true });
  const twice = await compare(["--out", out, claude, again]);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /.*claude and .*again are both runs of claude-opus-5-5 in Claude Code\. Compare each run once\./);
  // The same model at another effort is another run
  const harder = runDirectory(root, "harder", CLAUDE_RECORDS.map((record) => ({ ...record, effort: "high" })));
  assert.equal((await compare(["--out", out, claude, harder])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "comparison.json"), "utf-8")).runs.map(({ name }) => name), ["claude-opus-5-5 in Claude Code", "claude-opus-5-5 at effort high in Claude Code"]);

  // What decides where a session starts and how it is judged: the codebase's commit, its check command and its time,
  // and what the task expects. None of the values is named.
  const codebaseWith = (change) => ({ ...PLAN, codebases: [{ ...PLAN.codebases[0], ...change }] });
  for (const [name, change, words] of [
    ["later", { commit: "def456" }, "another starting commit"],
    ["checked", { check: ["lamdera", "make", "src/Secret.elm"] }, "another check command"],
    ["slower", { checkTimeoutMs: 999 }, "another time limit for its check command"],
  ]) {
    const result = await compare(["--out", out, claude, codexOf(name, codebaseWith(change))]);
    assert.match(result.stderr, new RegExp(`the codebase A has ${words} in .*${name} than in .*claude\\.`), name);
    assert.ok(!/def456|Secret|999/.test(result.stderr), "the error names no value");
  }
  const expecting = codexOf("expecting", { ...PLAN, tasks: PLAN.tasks.map((task) => (task.id === MOVE ? { ...task, expect: [{ kind: "declares-function", file: "src/Secret.elm", name: "hidden" }] } : task)) });
  assert.match((await compare(["--out", out, claude, expecting])).stderr, /the task A\/move-function\/10 has another expected result in .*expecting than in .*claude\./);
  // What a plan counts about a codebase, and the state of the benchmark that planned it, decide nothing of a session
  const recounted = codexOf("recounted", { ...codebaseWith({ modules: 13, lines: 3401 }), benchmark: "fedcba9" });
  assert.equal((await compare(["--out", out, claude, recounted])).code, 0);

  // A run whose arms have no round in common yet has nothing to compare
  const waiting = runDirectory(root, "waiting", CODEX_RECORDS.filter((record) => record.arm === "baseline"));
  const lonely = await compare(["--out", out, claude, waiting]);
  assert.equal(lonely.code, 1);
  assert.match(lonely.stderr, /.*waiting has no round of a task that both arms did, so it has no figure to compare yet\./);

  const none = await compare(["--out", out]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /compare needs the directory of at least one run/);
  const empty = join(root, "empty");
  mkdirSync(empty);
  assert.match((await compare(["--out", out, empty])).stderr, /does not exist|No run records/);
});

// The records of a made-up run of `tasks`, whose sessions of each arm solved theirs where `solves` holds for the task
// and the round. `roundsOf` gives the rounds that both arms did of a task.
const recordsOfRun = (run, tasks, solves, roundsOf = () => [1]) =>
  tasks.flatMap((task) =>
    roundsOf(task).flatMap((repetition) =>
      ["baseline", "lsp"].map((arm) => ({
        ...session(task, arm, { outcome: solves(task, repetition, arm) ? "passed" : "wrong-result", wallS: 10, costUsd: 1, inputTokens: 10, outputTokens: 1, toolCalls: { Bash: 1 } }, run),
        id: `${task}--${arm}--${repetition}`,
        repetition,
      }))
    )
  );

const summaryOfRun = (...run) => summarize({ codebases: PLAN.codebases }, recordsOfRun(...run));

test("two runs are compared by task, on the rounds that both did", () => {
  const tasks = Array.from({ length: 10 }, (_, at) => `A/rename-function/${10 * (at + 1)}`);
  const plan = { ...PLAN, tasks: tasks.map((id) => ({ ...PLAN.tasks[0], id })) };
  const twice = () => [1, 2];
  // In the baseline, one run solved every task and the other none: ten tasks for the first, 2 × (1/2)^10
  const always = summaryOfRun(CLAUDE, tasks, () => true, twice);
  // One session of the second run ended before the Codex CLI counted its tokens
  const records = recordsOfRun(CODEX, tasks, (task, round, arm) => arm === "lsp", twice);
  records[0] = { ...records[0], inputTokens: null, outputTokens: null };
  const never = summarize({ codebases: PLAN.codebases }, records);
  const comparison = compareRuns([always, never].map((summary) => ({ plan, summary, settings: SETTINGS })));
  const { differences } = comparison;
  assert.deepEqual(differences.baseline[0].tasks, { firstMore: 10, secondMore: 0, tied: 0 });
  assert.ok(Math.abs(differences.baseline[0].signP - 2 / 1024) < 1e-12);
  assert.deepEqual([differences.lsp[0].tasks, differences.lsp[0].signP], [{ firstMore: 0, secondMore: 0, tied: 10 }, 1]);
  // Every saving has its interval, the tokens' too, and those of the second run rest on 19 pairs of 20,
  // which the comparison says as the run's own page does
  const html = renderComparison(comparison, [always, never]);
  assert.match(html, /<tr><td>gpt-6 in Codex CLI<\/td>(<td class="number">[^<]*<\/td>){3}<td class="number">0% \(0% to 0%\)<\/td><td class="number">not reported<\/td><td class="number">0% \(0% to 0%, 19 pairs\)<\/td>/);
});

test("a run stopped before its last round is compared with another on the rounds that both did, and keeps its own", () => {
  const tasks = [10, 20, 30, 40].map((level) => `A/rename-function/${level}`);
  const plan = { ...PLAN, tasks: tasks.map((id) => ({ ...PLAN.tasks[0], id })) };
  // The full run solved every round of the baseline. The stopped one did two rounds of each task and a third of the first,
  // and its baseline solved only that third round.
  const full = summaryOfRun(CLAUDE, tasks, () => true, () => [1, 2, 3]);
  const stopped = summaryOfRun(CODEX, tasks, (task, round, arm) => arm === "lsp" || round === 3, (task) => (task === tasks[0] ? [1, 2, 3] : [1, 2]));
  const { runs, differences } = compareRuns([full, stopped].map((summary) => ({ plan, summary, settings: SETTINGS })));
  assert.deepEqual(runs[1].coverage, { planned: 4, rounds: [{ rounds: 2, tasks: 3 }, { rounds: 3, tasks: 1 }] });
  // Each run's own figures keep every pair it has
  assert.deepEqual([runs[0].savings.pairs, runs[1].savings.pairs], [12, 9]);
  // On the nine rounds that both did, the full run solved all and the stopped one a single round: four tasks for the first,
  // where a comparison of every session of each would set nine of nine against one of twelve
  assert.deepEqual(differences.baseline[0], {
    runs: ["claude-opus-5-5 in Claude Code", "gpt-6 in Codex CLI"],
    rounds: 9,
    solved: [9, 1],
    tasks: { firstMore: 4, secondMore: 0, tied: 0 },
    signP: 2 / 16,
  });
  const html = renderComparison(compareRuns([full, stopped].map((summary) => ({ plan, summary, settings: SETTINGS }))), [full, stopped]);
  assert.match(html, /<td>gpt-6 in Codex CLI<\/td><td class="number">2 rounds of 3 tasks and 3 rounds of 1, out of the plan&#39;s 4<\/td>/);
});

test("compare says so where no arm ran in every run", async (t) => {
  const root = tempDir(t);
  const without = runDirectory(root, "without", CLAUDE_RECORDS.filter((record) => record.arm === "baseline"), PLAN, { ...SETTINGS, arms: ["baseline"] });
  const withIt = runDirectory(root, "with", CODEX_RECORDS.filter((record) => record.arm === "lsp"), PLAN, { ...SETTINGS, arms: ["lsp"] });
  const out = join(root, "compared");
  const result = await compare(["--out", out, without, withIt]);
  assert.equal(result.code, 0, result.stderr);
  const html = readFileSync(join(out, "comparison.html"), "utf-8");
  assert.match(html, /<h2>Which runs solved tasks more often<\/h2><p class="lede">No arm ran in every run, so no two runs can be compared in the same arm\.<\/p><\/section>/);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "comparison.json"), "utf-8")).differences, {});
});
