/**
 * Several runs side by side: one model in one harness each, on the same
 * plan. The figures of each run are those of its report, from the same
 * summary. Between runs, the sign test on the rounds that both did says
 * which run solved tasks more often. The page is meant to be passed around,
 * so it shows kinds and counts only, never what the check said about a
 * codebase.
 */

import { ARMS } from "./arms.mjs";
import { escapeHtml, failureTables, FORMAT, htmlPage, isSolved, SAVED, savingCell, savingsNote, serverUseTables, solvedByTask, tableOf, toolTables } from "./report.mjs";
import { plural } from "./tasks.mjs";
import { signTest } from "./stats.mjs";

// What decides where a session of a task starts and how it is judged, with the words that say it differs in an error
const TASK_FIGURES = { codebase: "another codebase", type: "another kind", level: "another level", files: "other files", prompt: "other words", expect: "another expected result" };
const CODEBASE_FIGURES = {
  commit: "another starting commit",
  elmRoot: "another Elm root",
  check: "another check command",
  checkTimeoutMs: "another time limit for its check command",
  link: "other linked paths",
};

// The first entry, by `key`, that one list has and the other does not, or that differs in one of `figures`
function firstDifference(firsts, others, key, figures) {
  const [one, other] = [firsts, others].map((list) => new Map(list.map((entry) => [entry[key], entry])));
  const lacking = [...one.keys()].find((id) => !other.has(id));
  if (lacking !== undefined) return { id: lacking, lacking: "other" };
  const extra = [...other.keys()].find((id) => !one.has(id));
  if (extra !== undefined) return { id: extra, lacking: "first" };
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [id, entry] of one) {
    const figure = Object.keys(figures).find((name) => !same(entry[name], other.get(id)[name]));
    if (figure !== undefined) return { id, figure: figures[figure] };
  }
  return null;
}

/**
 * The first way in which two plans differ in what decides a session's
 * starting point and its judging, in words that name no value, or null.
 */
function planDifference(first, other) {
  const differences = [
    ["codebase", firstDifference(first.plan.codebases, other.plan.codebases, "label", CODEBASE_FIGURES)],
    ["task", firstDifference(first.plan.tasks, other.plan.tasks, "id", TASK_FIGURES)],
  ];
  const [what, difference] = differences.find(([, found]) => found !== null) ?? [];
  if (difference === undefined) return null;
  const { id, lacking, figure } = difference;
  if (lacking === "other") return `${other.dir} has no ${what} ${id}, which ${first.dir} has`;
  if (lacking === "first") return `${other.dir} has a ${what} ${id}, which ${first.dir} does not have`;
  return `the ${what} ${id} has ${figure} in ${other.dir} than in ${first.dir}`;
}

// A run as the comparison names it: its model, the effort it ran at where it named one, and its harness
const runName = (summary) =>
  `${summary.model}${summary.efforts.some((effort) => effort !== null) ? ` at effort ${summary.efforts.map((effort) => effort ?? "default").join(" and ")}` : ""} in ${summary.harness}`;

/**
 * Throws unless the runs can stand side by side: each has a round that both
 * of its arms did, no two have the same name, and every plan has the same
 * codebases and tasks, as far as they decide a session's starting point and
 * its judging. Names the first run or difference that fails. `runs` holds
 * each run's `dir`, `plan` and `summary`.
 */
export function assertComparable(runs) {
  const empty = runs.find(({ summary }) => summary.runs.length === 0);
  if (empty) throw new Error(`${empty.dir} has no round of a task that both arms did, so it has no figure to compare yet. Leave it out until it has.`);
  const seen = new Map();
  for (const { dir, summary } of runs) {
    const name = runName(summary);
    if (seen.has(name)) throw new Error(`${seen.get(name)} and ${dir} are both runs of ${name}. Compare each run once.`);
    seen.set(name, dir);
  }
  const [first, ...others] = runs;
  for (const other of others) {
    const difference = planDifference(first, other);
    if (difference !== null) throw new Error(`The runs were planned differently, so their figures cannot be compared: ${difference}. Compare runs of the same plan.`);
  }
}

/**
 * The notes of a --notes file, checked against the runs and keyed by the
 * name of the run each belongs to. A key is a run's name as the page heads
 * its section, or a model's id where one run alone is of that model. A key
 * that names no run, or a model of several, is a mistake.
 */
export function checkedNotes(notes, summaries) {
  const valid = notes !== null && typeof notes === "object" && !Array.isArray(notes) && Object.values(notes).every((paragraphs) => Array.isArray(paragraphs) && paragraphs.every((paragraph) => typeof paragraph === "string"));
  if (!valid) throw new Error('The notes must map the name of a run, or the id of its model, to a list of paragraphs, as in {"model-id in Claude Code": ["A paragraph."]}.');
  const names = summaries.map(runName);
  const keyed = {};
  for (const [key, paragraphs] of Object.entries(notes)) {
    const runs = names.includes(key) ? [key] : names.filter((name, at) => summaries[at].model === key);
    if (runs.length === 0) throw new Error(`The notes name ${key}, which is no run here. The runs are ${names.join(", ")}.`);
    if (runs.length > 1) throw new Error(`The notes name ${key}, which is the model of ${runs.length} runs: ${runs.join(", ")}. Name the run that each note is about.`);
    if (keyed[runs[0]]) throw new Error(`The notes name ${runs[0]} twice. Give each run one list of paragraphs.`);
    keyed[runs[0]] = paragraphs;
  }
  return keyed;
}

const solvedOf = (group) => ({ solved: group.solved, sessions: group.sessions });

// The sessions of an arm in a run, by the round of a task that both arms of the run did
const roundsOf = (summary, arm) => new Map(summary.runs.filter((run) => run.arm === arm).map((run) => [`${run.task} #${run.repetition}`, run]));

/**
 * Two runs in one arm, on the rounds that both did: the sessions each solved,
 * and which solved each task more often, with the sign test on that.
 */
function betweenRuns(one, other, arm) {
  const [ours, theirs] = [roundsOf(one.summary, arm), roundsOf(other.summary, arm)];
  const pairs = [...ours].filter(([round]) => theirs.has(round)).map(([round, first]) => ({ task: first.task, first, second: theirs.get(round) }));
  const { firstMore, secondMore, tied, signP } = signTest(solvedByTask(pairs));
  const solved = (side) => pairs.filter((pair) => isSolved(pair[side])).length;
  return { runs: [one.name, other.name], rounds: pairs.length, solved: [solved("first"), solved("second")], tasks: { firstMore, secondMore, tied }, signP };
}

/**
 * How many rounds of how many tasks a run has where both of its arms did
 * the round, most tasks first. A run stopped before its last round, or
 * limited to part of the plan, has fewer than the plan.
 */
function coverageOf(summary, plan) {
  const rounds = new Map();
  for (const { task, repetition } of summary.runs) rounds.set(task, new Set(rounds.get(task)).add(repetition));
  const tasksWith = new Map();
  for (const done of rounds.values()) tasksWith.set(done.size, (tasksWith.get(done.size) ?? 0) + 1);
  return {
    planned: plan.tasks.length,
    rounds: [...tasksWith].map(([count, tasks]) => ({ rounds: count, tasks })).sort((a, b) => b.tasks - a.tasks || b.rounds - a.rounds),
  };
}

// What run.json holds of how a run was set up. A run.json of an older run lacks a limit that did not exist yet, which is none.
const SETTINGS = ["timeoutMin", "maxBudgetUsd", "maxTokens", "benchmark"];

// How a run was set up, as far as its records and its run.json say. Records made before run.json existed have none.
const setupOf = (summary, settings) => ({
  agent: summary.agentVersions.length === 0 ? null : `${summary.harness} ${summary.agentVersions.join(" and ")}`,
  languageServers: summary.languageServers,
  recorded: settings !== null,
  ...Object.fromEntries(SETTINGS.map((key) => [key, settings?.[key] ?? null])),
});

/**
 * The figures of the comparison, from each run's plan, summary and
 * run.json, null where it has none: a row per run and, for each arm, every
 * two runs on the rounds that both did.
 */
export function compareRuns(given) {
  const summaries = given.map(({ summary }) => summary);
  const armIds = Object.keys(ARMS).filter((arm) => summaries.every((summary) => summary.arms.some(({ id }) => id === arm)));
  const runs = given.map(({ plan, summary, settings }) => ({
    name: runName(summary),
    coverage: coverageOf(summary, plan),
    setup: setupOf(summary, settings),
    model: summary.model,
    harness: summary.harness,
    costReported: summary.costReported,
    solved: Object.fromEntries(summary.arms.map(({ id }) => [id, solvedOf(summary.overall[id])])),
    savings: summary.savings,
    activity: summary.activity,
    // Null for a run without the lsp arm
    serverUse: summary.serverUse,
    failures: summary.failures,
  }));
  const named = summaries.map((summary, at) => ({ name: runs[at].name, summary }));
  const differences = Object.fromEntries(armIds.map((arm) => [arm, named.flatMap((one, at) => named.slice(at + 1).map((other) => betweenRuns(one, other, arm)))]));
  return { runs, differences };
}

// Each run's section has the figures of what its sessions did in short. Its report has the rest.
const SHORT = { short: true };

// "3 rounds of 81 tasks", or for a run that did less than the plan "2 rounds of 77 tasks and 3 rounds of 4, out of the plan's 81"
function coverageText({ planned, rounds }) {
  const groups = rounds.map(({ rounds: count, tasks }, at) => `${plural(count, "round", "rounds")} of ${at === 0 ? plural(tasks, "task", "tasks") : tasks}`);
  const covered = rounds.reduce((total, { tasks }) => total + tasks, 0);
  return `${groups.join(" and ")}${rounds.length === 1 && covered === planned ? "" : `, out of the plan's ${planned}`}`;
}

// Hashes of the benchmark's code and of the language server's build, as short as git shows them
const shortHashes = (text) => text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, "$1");

// The columns of the table of how each run was set up, and the words of each where it was not set. The records
// say which harness and server a run had, and run.json the rest. A harness's version is compared within that harness.
const SETUP = [
  { title: "Harness", value: (setup) => setup.agent ?? "not reported", fromRecords: true, withinHarness: true },
  { title: "Language server", value: (setup) => (setup.languageServers.length === 0 ? "none" : setup.languageServers.map(shortHashes).join(" and ")), fromRecords: true },
  { title: "Time limit", value: (setup) => (setup.timeoutMin === null ? "none" : `${setup.timeoutMin} min`) },
  { title: "Budget per session", value: (setup) => (setup.maxBudgetUsd === null ? "none" : FORMAT.cost(setup.maxBudgetUsd)) },
  { title: "Token limit", value: (setup) => (setup.maxTokens === null ? "none" : FORMAT.tokens(setup.maxTokens)) },
  { title: "Benchmark's code", value: (setup) => (setup.benchmark === null ? "not recorded" : shortHashes(setup.benchmark)) },
];

// "a", "a and b", "a, b and c"
const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** How each run was set up, and a sentence that names what differs between the runs. */
function setupSection(runs) {
  const shown = (run, column) => (run.setup.recorded || column.fromRecords ? column.value(run.setup) : "not recorded");
  const rows = runs.map((run) => [run.name, ...SETUP.map((column) => shown(run, column))]);
  const differs = SETUP.filter((column) => {
    const groups = column.withinHarness ? [...new Set(runs.map((run) => run.harness))].map((harness) => runs.filter((run) => run.harness === harness)) : [runs];
    return groups.some((group) => new Set(group.map((run) => shown(run, column))).size > 1);
  });
  const budgets = differs.some(({ title }) => title === "Budget per session") && runs.some((run) => !run.costReported);
  const note =
    runs.length < 2
      ? ""
      : differs.length === 0
        ? "The runs were set up alike in each of these."
        : `The runs differ in ${listed(differs.map(({ title }) => title.toLowerCase()))}. Their figures can differ for that reason as well as for the model and the harness.` +
          (budgets ? " A harness that reports no cost cannot be held to a budget." : "");
  return `<section class="card section"><h2>How each run was set up</h2>${tableOf(["Run", ...SETUP.map(({ title }) => title)], rows)}${note === "" ? "" : `<p class="note">${escapeHtml(note)}</p>`}</section>`;
}

// What the tables between runs compare, in the words of the page
const BETWEEN_NOTE =
  "Two runs are compared in one arm on the rounds that both did, each repetition of a task beside the one of the same number in the other run. " +
  "A task counts for the run that solved more of those rounds, and for neither where both solved as many. " +
  "The exact sign test asks how often tossing a coin for each task that counts would split them between the runs as unevenly as this, or more. " +
  "A small p-value says that such a split would seldom come from chance alone. It does not say how large the difference is, and it holds for these tasks only.";

/**
 * The comparison as one self-contained page. `notes` maps the name of a run
 * to paragraphs that someone wrote about it, shown as such.
 */
export function renderComparison(comparison, summaries, notes = {}) {
  const { runs, differences } = comparison;
  const solved = (run, arm) => (run.solved[arm] ? FORMAT.solved(run.solved[arm]) : "not run");
  // Each saving as the run's own page has it, with its interval, and its pairs where a missing figure left some out
  const saved = (run, figure) => (run.savings[figure] === null ? "not reported" : savingCell(run.savings[figure], run.savings.pairs, { interval: true }));
  const rows = runs.map((run) => [
    run.name,
    coverageText(run.coverage),
    solved(run, "baseline"),
    solved(run, "lsp"),
    ...SAVED.map((figure) => saved(run, figure)),
    run.serverUse === null ? "not run" : `${run.serverUse.called} of ${run.serverUse.sessions}`,
    ...["baseline", "lsp"].map((arm) => FORMAT.mean(run.activity[arm]?.toolCalls.mean ?? null)),
    String(run.savings.solved.tasks.baselineMore),
    String(run.savings.solved.tasks.lspMore),
    FORMAT.p(run.savings.solved.signP),
  ]);
  const overview = tableOf(
    [
      "Run",
      "Rounds that both arms did",
      "Solved without the server",
      "Solved with it",
      "Time saved",
      "Cost saved",
      "Input tokens saved",
      "Output tokens saved",
      "Sessions with the server that called it",
      "Tool calls per session without",
      "Tool calls per session with",
      "Tasks solved more often without the server",
      "Tasks solved more often with it",
      "Sign test p",
    ],
    rows
  );

  const between =
    runs.length < 2
      ? `<p class="lede">One run, so there is nothing to compare between runs.</p>`
      : Object.keys(differences).length === 0
        ? `<p class="lede">No arm ran in every run, so no two runs can be compared in the same arm.</p>`
        : Object.entries(differences)
            .map(
              ([arm, pairs]) =>
                `<h3>${escapeHtml(ARMS[arm].title)}</h3>` +
                tableOf(
                  ["Runs", "Rounds that both did", "Solved by the first", "Solved by the second", "Tasks the first solved more often", "Tasks the second solved more often", "Sign test p"],
                  pairs.map((pair) => [
                    pair.runs.join(" and "),
                    String(pair.rounds),
                    `${pair.solved[0]} of ${pair.rounds}`,
                    `${pair.solved[1]} of ${pair.rounds}`,
                    String(pair.tasks.firstMore),
                    String(pair.tasks.secondMore),
                    FORMAT.p(pair.signP),
                  ])
                )
            )
            .join("") + `<p class="note">${escapeHtml(BETWEEN_NOTE)}</p>`;

  const sections = summaries
    .map((summary, at) => {
      const written = notes[runs[at].name] ?? [];
      const reading =
        written.length === 0
          ? ""
          : `<h3>A reading of these figures, written by hand</h3><p class="lede">What follows is someone's reading of the figures above and below, and no output of the benchmark.</p>` +
            written.map((paragraph) => `<p class="note">${escapeHtml(paragraph)}</p>`).join("");
      return `<section class="card section"><h2>${escapeHtml(runs[at].name)}</h2>${reading}${toolTables(summary, SHORT)}${serverUseTables(summary, SHORT)}${failureTables(summary, SHORT)}</section>`;
    })
    .join("");

  const lede =
    `${runs.length === 1 ? "One run, of one model in one harness." : `${runs.length} runs of the same plan, each of one model in one harness.`} ` +
    "A task counts as solved when the project compiles and the change is the one that was asked for. " +
    "The figures of a run rest on every round that both of its arms did, and a comparison of two runs on the rounds that both runs did. Each run's own report has every figure of it.";
  return htmlPage(
    "Elm refactoring across runs",
    `<h1>Elm refactoring across runs</h1>
<p class="lede">${escapeHtml(lede)}</p>
<section class="card section"><h2>The runs side by side</h2>${overview}<p class="note">${escapeHtml(savingsNote())}</p></section>
${setupSection(runs)}
<section class="card section"><h2>Which runs solved tasks more often</h2>${between}</section>
${sections}`
  );
}
