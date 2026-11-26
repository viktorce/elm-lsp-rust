/**
 * Tests of benchmarks/lib/report.mjs, which sums up the records of a run and
 * writes its report. They start no process and read no clock.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "fs";
import { join } from "path";
import { FORMAT, renderReport, summarize } from "../benchmarks/lib/report.mjs";
import { DRAWS, generator, MIN_TASKS, quantile, savedInterval, SEED, signP, signTest } from "../benchmarks/lib/stats.mjs";
import { REPO } from "./support.mjs";

// `outcome` is one of the outcomes, or what stopped a failed session
const record = (arm, outcome, costUsd, wallMs, repetition = 1) => ({
  id: "private-id",
  task: "A/rename-function/10",
  codebase: "A",
  type: "rename-function",
  level: 10,
  files: 12,
  arm,
  repetition,
  model: "claude-opus-5-5",
  agentVersion: "2.1.0",
  languageServer: "0.3.39 (abcdef0)",
  outcome: ["time-limit", "budget-limit", "error"].includes(outcome) ? "agent-failed" : outcome,
  failure: ["time-limit", "budget-limit", "error"].includes(outcome) ? outcome : null,
  problems: ["src/Secret.elm does not declare hiddenName"],
  changedFiles: 3,
  wallMs,
  costUsd,
  turns: 4,
  toolCalls: { Bash: 2, "mcp__elm-lsp__elm_rename_function": arm === "lsp" ? 1 : 0 },
  lspCalls: arm === "lsp" ? 1 : 0,
  apiRetries: 0,
});

test("the summary counts and takes medians per arm, and leaves the codebase's names out", () => {
  const plan = { codebases: [{ label: "A", commit: "abc123", modules: 12, lines: 3400 }] };
  const summary = summarize(plan, [
    record("baseline", "passed", 0.2, 30000, 1),
    record("lsp", "passed", 0.1, 10000, 1),
    record("baseline", "does-not-compile", 0.6, 90000, 2),
    record("lsp", "passed", 0.3, 20000, 2),
    // Killed at its time limit, so it has a time and no cost
    record("baseline", "time-limit", null, 50000, 3),
    record("lsp", "passed", 0.5, 30000, 3),
    // The other arm has not done round 4 yet, so this session is in no figure
    record("baseline", "passed", 9, 999000, 4),
  ]);

  const endings = (counts) => ({
    passed: 0,
    "wrong-result": 0,
    "does-not-compile": 0,
    "time-limit": 0,
    "budget-limit": 0,
    error: 0,
    "server-failed": 0,
    ...counts,
  });
  assert.deepEqual(summary.overall, {
    baseline: {
      sessions: 3,
      solved: 1,
      endings: endings({ passed: 1, "does-not-compile": 1, "time-limit": 1 }),
      withoutCost: 1,
      costUsd: 0.4,
      wallMs: 50000,
      turns: 4,
      toolCalls: 2,
    },
    lsp: { sessions: 3, solved: 3, endings: endings({ passed: 3 }), withoutCost: 0, costUsd: 0.3, wallMs: 20000, turns: 4, toolCalls: 3 },
  });
  assert.equal(summary.unpaired, 1);
  assert.equal(summary.runs.length, 6);
  assert.deepEqual(summary.codebases, [{ label: "A", modules: 12, lines: 3400 }]);
  assert.equal(summary.taskTypes.length, 1);
  assert.equal(summary.taskTypes[0].lsp.solved, 3);

  const html = renderReport(summary);
  assert.match(html, /6 sessions in total\..*1 more session left out: the other arm has not done the same round of the same task yet\./);
  assert.match(html, /Ended without reporting a cost, and left out of the cost medians: 1 session without language server\./);
  // The heads of the levels' table, as they were before there was a choice of harness
  assert.match(html, /<th class="number">Median cost<\/th><th class="number">Median time<\/th><th class="number">Median tool calls<\/th>/);
  // How the sessions of each arm ended, one column per ending
  assert.match(html, /Without language server<\/td>(<td class="number">\d<\/td>){7}<\/tr>/);
  assert.match(html, /Without language server<\/td><td class="number">1<\/td><td class="number">0<\/td><td class="number">1<\/td><td class="number">1<\/td>/);

  for (const secret of ["Secret", "hiddenName", "private-id", "abc123"]) {
    assert.ok(!(JSON.stringify(summary) + html).includes(secret), `${secret} stays out of the summary and the report`);
  }

  // Both arms were asked for and only one has run so far: its session waits, and no figure counts it
  const waiting = summarize(plan, [record("baseline", "passed", 0.2, 30000, 1)], ["baseline", "lsp"]);
  assert.deepEqual(
    [waiting.unpaired, waiting.runs.length, waiting.arms.map((arm) => arm.id), waiting.overall.lsp.sessions],
    [1, 0, ["baseline", "lsp"], 0]
  );
  assert.match(renderReport(waiting), /in 0 Elm codebases\. 0 sessions in total\..*1 more session left out/);
  // No session counts yet, which the failures say, rather than that every session solved its task
  assert.match(renderReport(waiting), /No session counts yet, since no round of a task has been done in every arm\./);
  assert.ok(!renderReport(waiting).includes("Every session solved its task"));
  // One arm alone was asked for, which the page says
  const alone = summarize(plan, [record("baseline", "passed", 0.2, 30000, 1)], ["baseline"]);
  assert.deepEqual([alone.unpaired, alone.runs.length], [0, 1]);
  assert.match(renderReport(alone), /Only one arm was run, so this page compares nothing\./);
  // That arm had no language server, so the page names none
  assert.ok(!renderReport(alone).includes("language server is"));
  assert.ok(!html.includes("Only one arm"));
});

test("the report states the headline figures and lists every session", () => {
  const plan = { codebases: [{ label: "A", commit: "abc123", modules: 12, lines: 3400 }] };
  const summary = summarize(plan, [record("baseline", "wrong-result", 0.25, 75000), { ...record("lsp", "passed", 0.125, 9000), apiRetries: 3 }]);
  const html = renderReport(summary);

  assert.match(
    html,
    /claude-opus-5-5 at Claude Code&#39;s default effort in Claude Code 2\.1\.0 worked on 1 kind of refactoring in 1 Elm codebase: A \(12 modules, 3,400 lines\)\. 2 sessions in total\. The language server is elm-lsp-rust 0\.3\.39 \(abcdef0\)\./
  );
  // The effort a run named is beside the model, and each one is named where the records differ
  const atHigh = summarize(plan, [record("baseline", "passed", 0.2, 30000), record("lsp", "passed", 0.1, 10000)].map((run) => ({ ...run, effort: "high" })));
  assert.deepEqual(atHigh.efforts, ["high"]);
  assert.match(renderReport(atHigh), /claude-opus-5-5 at effort high in Claude Code 2\.1\.0 worked on/);
  const mixed = summarize(plan, [{ ...record("baseline", "passed", 0.2, 30000), effort: "high" }, { ...record("lsp", "passed", 0.1, 10000), effort: null }]);
  assert.deepEqual(mixed.efforts, ["high", null]);
  assert.match(renderReport(mixed), /claude-opus-5-5 at effort high and Claude Code&#39;s default effort in Claude Code 2\.1\.0 worked on/);
  assert.match(html, /<span class="value">0 of 1<\/span>/);
  assert.match(html, /<span class="value">1 of 1<\/span>/);
  // Each session's level and the files of its target stand beside its outcome
  assert.match(html, /<td>Wrong result<\/td><td class="number">10<\/td><td class="number">12<\/td><td class="number">1 min 15 s<\/td><td class="number">\$0\.25<\/td>/);
  assert.match(html, /<td>Solved<\/td><td class="number">10<\/td><td class="number">12<\/td><td class="number">9 s<\/td><td class="number">\$0\.13<\/td>/);
  // How often a session had to ask the API again, which tells waiting from slow work
  assert.deepEqual(summary.runs.map((run) => run.apiRetries), [0, 3]);
  assert.match(html, /<th class="number">Files<\/th><th class="number">API retries<\/th><\/tr>/);
  assert.match(html, /<td>Solved<\/td>(<td class="number">[^<]+<\/td>){8}<td class="number">3<\/td><\/tr>/);
  // Every bar can be read without hovering: its value is printed at its tip and in its tooltip
  assert.match(html, /data-tip="Rename a function with a unique name · With language server · Median cost: \$0\.13 \(1 session\)"/);
  assert.match(html, /<text x="[\d.]+" y="[\d.]+">\$0\.13<\/text>/);
  assert.ok(!html.includes("left out") && !html.includes("without reporting a cost"), "notes appear only when they apply");
  // After a run of one codebase alone, the page names that one and not every codebase of the plan
  const both = { codebases: [...plan.codebases, { label: "B", commit: "def456", modules: 30, lines: 9000 }] };
  const one = summarize(both, [record("baseline", "passed", 0.2, 30000), record("lsp", "passed", 0.1, 10000)]);
  assert.deepEqual(one.codebases, [{ label: "A", modules: 12, lines: 3400 }]);
  assert.match(renderReport(one), /worked on 1 kind of refactoring in 1 Elm codebase: A \(12 modules, 3,400 lines\)\. 2 sessions in total\./);

  // A failed session is listed by what stopped it
  const failed = renderReport(
    summarize(plan, [record("baseline", "budget-limit", 5, 75000), record("lsp", "error", 0.4, 9000)])
  );
  assert.match(failed, /<td>Out of budget<\/td>/);
  assert.match(failed, /<td>Session error<\/td>/);
  // Claude Code is held by its budget and its time, and counts no tokens as a session goes
  assert.match(failed, / "Out of time" and "Out of budget" are the limits the benchmark was run with\. /);
  assert.match(failed, /<th class="number">Out of time<\/th><th class="number">Out of budget<\/th><th class="number">Session error<\/th>/);

  // Sessions of several minutes get a time axis in minutes, like the labels at their bars
  const long = renderReport(summarize(plan, [record("baseline", "passed", 1, 300000), record("lsp", "passed", 1, 200000)]));
  assert.match(long, />5 min 0 s<\/text>/);
  assert.match(long, />2 min<\/text>.*>4 min<\/text>.*>6 min<\/text>/);
  assert.ok(!/>\d+ s<\/text>/.test(long.replace(/>0 s<\/text>/g, "")), "no tick in seconds beside bars in minutes");

  // 119.6 seconds are two minutes, and an axis that ends at four cents needs more than cents
  const small = renderReport(summarize(plan, [record("baseline", "passed", 0.031, 119600), record("lsp", "passed", 0.012, 59400)]));
  assert.match(small, /<td class="number">2 min 0 s<\/td>/);
  assert.match(small, /<td class="number">59 s<\/td>/);
  assert.match(small, />\$0\.010<\/text>.*>\$0\.020<\/text>.*>\$0\.030<\/text>.*>\$0\.040<\/text>/);
  // So does one that ends at ten cents, whose steps are two and a half
  const dime = renderReport(summarize(plan, [record("baseline", "passed", 0.09, 1000), record("lsp", "passed", 0.05, 1000)]));
  assert.match(dime, />\$0\.025<\/text>.*>\$0\.050<\/text>.*>\$0\.075<\/text>.*>\$0\.100<\/text>/);
});

test("the summary and the page give the figures of each task type per level and arm, with the files of each target", () => {
  const plan = { codebases: [{ label: "A", modules: 12, lines: 3400 }, { label: "B", modules: 30, lines: 9000 }] };
  // A session at a level of a codebase, whose target involves `files` files
  const at = (codebase, level, files, arm, costUsd, wallMs, outcome = "passed") => ({
    ...record(arm, outcome, costUsd, wallMs),
    task: `${codebase}/rename-function/${level}`,
    codebase,
    level,
    files,
  });
  const summary = summarize(plan, [
    at("B", 50, 51, "baseline", 0.6, 120000),
    at("B", 50, 51, "lsp", 0.3, 60000),
    at("A", 10, 10, "baseline", 0.2, 30000),
    at("A", 10, 10, "lsp", 0.2, 20000),
    at("A", 50, 45, "baseline", 0.8, 180000, "wrong-result"),
    at("A", 50, 45, "lsp", 0.4, 90000),
  ]);
  const [type] = summary.taskTypes;
  // Smallest level first, and the codebases in the plan's order
  assert.deepEqual(
    type.levels.map(({ level, targets, baseline, lsp }) => [level, targets, baseline.solved, baseline.sessions, baseline.costUsd, lsp.costUsd, lsp.wallMs]),
    [
      [10, [{ codebase: "A", files: 10 }], 1, 1, 0.2, 0.2, 20000],
      [50, [{ codebase: "A", files: 45 }, { codebase: "B", files: 51 }], 1, 2, 0.7, 0.35, 75000],
    ]
  );
  // The task type's own figures cover every level
  assert.equal(type.baseline.sessions, 3);
  assert.deepEqual(summary.runs.map(({ level, files }) => [level, files]), [[50, 51], [50, 51], [10, 10], [10, 10], [50, 45], [50, 45]]);

  const html = renderReport(summary);
  // One chart of cost and one of time, a line and a point per level for each arm
  assert.match(html, /aria-label="Median cost per level of Rename a function with a unique name, one line per arm\./);
  assert.match(html, /aria-label="Median time per level of Rename a function with a unique name, one line per arm\./);
  assert.equal(html.match(/<path class="trend lsp"/g).length, 2);
  assert.equal(html.match(/<circle class="dot baseline"/g).length, 4);
  assert.match(html, /data-tip="Rename a function with a unique name · level 50 · With language server · Median cost: \$0\.35 \(2 sessions\)"/);
  // The last point of a line has its value beside it
  assert.match(html, /<circle class="dot lsp"[^>]*\/><text x="[\d.]+" y="[\d.]+">\$0\.35<\/text>/);
  // The table: a level, the files of each codebase's target, then a row per arm
  assert.match(
    html,
    /<tr class="level"><td rowspan="2">50<\/td><td rowspan="2">A 45, B 51<\/td><td><span class="key baseline"><\/span>Without language server<\/td><td class="number">1 of 2<\/td><td class="number">\$0\.70<\/td><td class="number">2 min 30 s<\/td><td class="number">2<\/td><\/tr>/
  );

  // A record of a run made before plans had levels has none, and the page says so
  const { level, files, ...unlevelled } = record("baseline", "passed", 0.2, 30000);
  const old = summarize(plan, [unlevelled, { ...unlevelled, arm: "lsp" }]);
  assert.deepEqual(old.taskTypes[0].levels.map(({ level, targets }) => [level, targets]), [[null, [{ codebase: "A", files: null }]]]);
  assert.match(renderReport(old), /<td rowspan="2">n\/a<\/td><td rowspan="2">A n\/a<\/td>/);
});

test("every kind of task has its title and its levels on the page and in the summary", () => {
  const plan = { codebases: [{ label: "A", commit: "abc123", modules: 12, lines: 3400 }] };
  const records = ["rename-type", "move-function", "remove-variant", "remove-field"].flatMap((type) =>
    [10, 50].flatMap((level) =>
      ["baseline", "lsp"].map((arm) => ({ ...record(arm, "passed", 0.1, 10000), type, task: `A/${type}/${level}`, level, files: level + 1 }))
    )
  );
  const summary = summarize(plan, records);
  assert.deepEqual(
    summary.taskTypes.map(({ id, title, levels }) => [id, title, levels.map(({ level, targets }) => [level, targets])]),
    [
      ["rename-type", "Rename a custom type or a type alias", [[10, [{ codebase: "A", files: 11 }]], [50, [{ codebase: "A", files: 51 }]]]],
      ["move-function", "Move a function to another module", [[10, [{ codebase: "A", files: 11 }]], [50, [{ codebase: "A", files: 51 }]]]],
      ["remove-variant", "Remove a variant and every branch that matches on it", [[10, [{ codebase: "A", files: 11 }]], [50, [{ codebase: "A", files: 51 }]]]],
      ["remove-field", "Remove a record field and replace every read of it", [[10, [{ codebase: "A", files: 11 }]], [50, [{ codebase: "A", files: 51 }]]]],
    ]
  );
  const html = renderReport(summary);
  // The bars name each kind short, and its card and its charts by its whole title
  for (const short of ["Rename type", "Move function", "Remove variant", "Remove field"]) assert.match(html, new RegExp(`text-anchor="end">${short}</text>`));
  const titles = ["Rename a custom type or a type alias", "Move a function to another module", "Remove a variant and every branch that matches on it", "Remove a record field and replace every read of it"];
  for (const title of titles) {
    assert.match(html, new RegExp(`<h2>${title}</h2>`));
    assert.match(html, new RegExp(`aria-label="Median cost per level of ${title}, one line per arm\\.`));
  }
});

test("the README's account of the run holds the figures of the run's summary", () => {
  const summary = JSON.parse(readFileSync(join(REPO, "benchmarks/results/summary.json"), "utf-8"));
  const readme = readFileSync(join(REPO, "benchmarks/README.md"), "utf-8");
  const section = readme.slice(readme.indexOf("\n## A run on three codebases\n"), readme.indexOf("\n## What it does not tell you\n"));
  // The records again, as far as the summary holds them, so the report's own code takes the medians
  const records = summary.runs.map((run) => ({
    ...run,
    task: `${run.codebase}/${run.type}`,
    failure: run.outcome === "agent-failed" ? run.ending : null,
    toolCalls: { Bash: run.toolCalls },
    model: summary.model,
  }));
  const plan = { codebases: summary.codebases };
  assert.deepEqual(summarize(plan, records).overall, summary.overall);
  assert.deepEqual(
    summarize(plan, records).taskTypes.map(({ id, baseline, lsp }) => ({ id, baseline, lsp })),
    summary.taskTypes.map(({ id, baseline, lsp }) => ({ id, baseline, lsp }))
  );

  // The four figures of the page's tiles, for each arm, as the page writes them
  const tiles = (subset) => {
    const page = renderReport(summarize(plan, subset));
    return ["Tasks solved", "Median cost per session", "Median time per session", "Median tool calls per session"].map((label) => {
      const tile = page.slice(page.indexOf(`<div class="label">${label}</div>`)).split('<div class="card tile">')[0];
      return [...tile.matchAll(/<span class="value">([^<]*)<\/span>/g)].map((match) => match[1]);
    });
  };
  const KINDS = {
    "Rename a function": "rename-function",
    "Rename a function whose name other modules use": "rename-shared-function",
    "Rename a variant": "rename-variant",
    "Rename a record field whose name other records use": "rename-field",
    "Rename a module": "rename-module",
    "Add a variant": "add-variant",
  };
  const rowsUnder = (header) => {
    const lines = section.split("\n");
    const start = lines.indexOf(header);
    assert.notEqual(start, -1, header);
    const rows = [];
    for (let index = start + 2; lines[index]?.startsWith("| "); index++) {
      rows.push(lines[index].slice(2, -2).split(" | "));
    }
    return rows;
  };

  const byKind = rowsUnder("| Kind of task | Without the server | With the server |");
  assert.deepEqual(byKind.map(([kind]) => KINDS[kind]), summary.taskTypes.map((type) => type.id));
  for (const [kind, ...cells] of byKind) {
    const [solved, cost, time, calls] = tiles(records.filter((record) => record.type === KINDS[kind]));
    assert.deepEqual(cells, [0, 1].map((arm) => `${solved[arm]}, ${cost[arm]}, ${time[arm]}, ${calls[arm]} tool calls`), kind);
  }

  const byCodebase = rowsUnder("| Kind of task | Codebase | Without the server | With the server | Files changed |");
  assert.equal(byCodebase.length, summary.taskTypes.length * summary.codebases.length);
  for (const [kind, codebase, without, withIt, files] of byCodebase) {
    const subset = records.filter((record) => record.type === KINDS[kind] && record.codebase === codebase);
    const [solved, cost, time, calls] = tiles(subset);
    // The section says that every one of those sessions solved its task
    assert.deepEqual(solved, ["3 of 3", "3 of 3"], `${kind} on ${codebase}`);
    assert.deepEqual([without, withIt], [0, 1].map((arm) => `${cost[arm]}, ${time[arm]}, ${calls[arm]} tool calls`), `${kind} on ${codebase}`);
    // Every session of the row changed that many files, in both arms
    assert.deepEqual(subset.map((record) => String(record.changedFiles)), Array(6).fill(files), `${kind} on ${codebase}`);
  }

  // The overall figures: the tiles, and beside them the totals, the means and the rounds of the two arms
  const [solved, cost, time, calls] = tiles(records);
  assert.ok(section.includes(`each arm solved ${solved[0]}. `) && solved[0] === solved[1], "both arms solved as many");
  assert.ok(section.includes(`The median session cost ${cost[0]}, took ${time[0]} and made ${calls[0]} tool calls without the server.`));
  assert.ok(section.includes(`With it, the median session cost ${cost[1]}, took ${time[1]} and made ${calls[1]} tool calls.`));
  const arms = ["baseline", "lsp"].map((arm) => records.filter((record) => record.arm === arm));
  const total = (runs, figure) => runs.reduce((sum, run) => sum + run[figure], 0);
  const both = (format) => arms.map(format).join(" and ");
  assert.ok(
    section.includes(
      `the sessions cost ${both((runs) => `$${total(runs, "costUsd").toFixed(2)}`)} in total and ${both((runs) => `$${(total(runs, "costUsd") / runs.length).toFixed(3)}`)} on average, ` +
        `took ${both((runs) => `${(total(runs, "wallMs") / runs.length / 1000).toFixed(1)} s`)} on average, ` +
        `and made ${both((runs) => (total(runs.map((run) => ({ calls: run.toolCalls.Bash })), "calls") / runs.length).toFixed(1))} tool calls on average.`
    )
  );
  const rounds = arms[0].map((without) => [without, arms[1].find((other) => other.task === without.task && other.repetition === without.repetition)]);
  const count = (holds) => rounds.filter(([without, withIt]) => holds(without, withIt)).length;
  assert.ok(
    section.includes(
      `The session with the server was the cheaper one in ${count((a, b) => b.costUsd < a.costUsd)} of the ${rounds.length} rounds and the faster one in ${count((a, b) => b.wallMs < a.wallMs)}. ` +
        `It made fewer tool calls in ${count((a, b) => b.toolCalls.Bash < a.toolCalls.Bash)} and the same number in ${count((a, b) => b.toolCalls.Bash === a.toolCalls.Bash)}.`
    )
  );
  assert.ok(section.includes(`Every session of the \`lsp\` arm but one called a tool of the server, ${arms[1].filter((run) => run.lspCalls > 0).length} of ${arms[1].length}.`));

  // Where one arm lies wholly above the other: a row of the table by codebase, and its cost or its time
  const apart = byCodebase.flatMap(([kind, codebase]) =>
    ["costUsd", "wallMs"].map((figure) => {
      const [without, withIt] = arms.map((runs) => runs.filter((run) => run.type === KINDS[kind] && run.codebase === codebase).map((run) => run[figure]));
      return Math.min(...withIt) > Math.max(...without) ? "above" : Math.max(...withIt) < Math.min(...without) ? "below" : "neither";
    })
  );
  const times = (where) => apart.filter((order) => order === where).length;
  assert.ok(section.includes(`The run shows it ${times("above") + times("below")} times, ${times("above")} with the server above and ${times("below")} with the server below.`));
});

// A session of `task`, a type and a level of codebase A, with the figures that the savings are made of
// `lspCalls` are the calls that the server answered, every one of its calls in `toolCalls` where it is not given
const session = (task, arm, repetition, { outcome = "passed", wallS, costUsd, inputTokens, outputTokens, replies = 10, toolCalls, lspCalls, problems = [] }) => {
  const [, type, level] = task.split("/");
  const failed = ["time-limit", "budget-limit", "token-limit", "error"].includes(outcome);
  return {
    ...record(arm, outcome, costUsd, wallS * 1000, repetition),
    task,
    type,
    level: Number(level),
    outcome: failed ? "agent-failed" : outcome,
    failure: failed ? outcome : null,
    problems,
    inputTokens,
    outputTokens,
    replies,
    toolCalls,
    lspCalls: lspCalls ?? Object.entries(toolCalls).filter(([name]) => name.startsWith("mcp__elm-lsp__")).reduce((total, [, calls]) => total + calls, 0),
  };
};

const RENAME = "A/rename-function/10";
const WIDER = "A/rename-function/50";
const MOVE = "A/move-function/10";
const BASELINE_TOOLS = { Bash: 3, Read: 1 };
// Four rounds. The baseline ran out of time in the second round of RENAME, so that pair has no cost, and no tokens:
// Claude Code counts them where it reports the cost. A record of an older run holds zeros for them.
const SAVINGS_RECORDS = [
  session(RENAME, "baseline", 1, { wallS: 100, costUsd: 1, inputTokens: 1000, outputTokens: 100, toolCalls: BASELINE_TOOLS }),
  session(RENAME, "lsp", 1, { wallS: 50, costUsd: 0.5, inputTokens: 800, outputTokens: 50, replies: 4, toolCalls: { "mcp__elm-lsp__elm_rename_function": 1, Bash: 1 } }),
  { ...session(RENAME, "baseline", 2, { outcome: "time-limit", wallS: 120, costUsd: null, inputTokens: 0, outputTokens: 0, toolCalls: BASELINE_TOOLS }), finished: false },
  session(RENAME, "lsp", 2, { wallS: 60, costUsd: 0.6, inputTokens: 900, outputTokens: 60, replies: 6, toolCalls: { "mcp__elm-lsp__elm_rename_function": 2, Bash: 2 } }),
  session(WIDER, "baseline", 1, {
    outcome: "wrong-result",
    wallS: 200,
    costUsd: 2,
    inputTokens: 2000,
    outputTokens: 200,
    toolCalls: BASELINE_TOOLS,
    problems: ['src/Secret.elm changed in more than the name: "hiddenName" became "hiddenNameRenamed"'],
  }),
  session(WIDER, "lsp", 1, {
    wallS: 100,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    replies: 8,
    toolCalls: { "mcp__elm-lsp__elm_rename_function": 1, "mcp__elm-lsp__elm_references": 1, Read: 1 },
  }),
  session(MOVE, "baseline", 1, { wallS: 80, costUsd: 0.8, inputTokens: 500, outputTokens: 80, toolCalls: BASELINE_TOOLS }),
  // This one tried the server once, and the call failed, so the server answered none. Its result does not compile.
  session(MOVE, "lsp", 1, {
    outcome: "does-not-compile",
    wallS: 100,
    costUsd: 1.2,
    inputTokens: 700,
    outputTokens: 90,
    replies: 10,
    toolCalls: { Bash: 5, "mcp__elm-lsp__elm_move_function": 1 },
    lspCalls: 0,
    problems: ["the check command fails: -- NAMING ERROR in src/Secret.elm", "src/Secret.elm does not declare hiddenName"],
  }),
];
const PLAN = { codebases: [{ label: "A", commit: "abc123", modules: 12, lines: 3400 }] };

test("the summary and the page say how much the server saved, on the rounds that both arms did", () => {
  const summary = summarize(PLAN, SAVINGS_RECORDS);
  const { savings } = summary;
  const point = (figure) => [savings[figure].pairs, savings[figure].baseline, savings[figure].lsp, savings[figure].savedPercent];
  assert.equal(savings.pairs, 4);
  // Time: 500 s without the server and 310 s with it, which is 38% less
  assert.deepEqual(point("wallMs"), [4, 500000, 310000, 38]);
  // Cost: the pair whose baseline ran out of time reported none, so three pairs, $3.80 and $2.70, 1.1 / 3.8 less
  assert.deepEqual(point("costUsd").slice(0, 3), [3, 3.8, 2.7]);
  assert.ok(Math.abs(savings.costUsd.savedPercent - (100 * 1.1) / 3.8) < 1e-9);
  // Tokens come from the same three pairs: 3,500 and 2,500 in, 380 and 240 out
  assert.deepEqual(point("inputTokens").slice(0, 3), [3, 3500, 2500]);
  assert.ok(Math.abs(savings.inputTokens.savedPercent - (100 * 1000) / 3500) < 1e-9);
  assert.deepEqual(point("outputTokens").slice(0, 3), [3, 380, 240]);
  assert.ok(Math.abs(savings.outputTokens.savedPercent - (100 * 140) / 380) < 1e-9);
  // A record that holds no tokens at all for that session is read the same
  const nulls = SAVINGS_RECORDS.map((each) => (each.costUsd === null ? { ...each, inputTokens: null, outputTokens: null } : each));
  assert.deepEqual(summarize(PLAN, nulls).savings, savings);
  // Only the lsp arm solved two rounds, only the baseline one. By task, the lsp arm solved RENAME and WIDER more often and
  // the baseline MOVE: 2 × P(X ≤ 1) for three tosses of a coin is 1.
  assert.deepEqual(savings.solved, { both: 1, baselineOnly: 1, lspOnly: 2, neither: 0, tasks: { baselineMore: 1, lspMore: 2, tied: 0 }, signP: 1 });
  // Three tasks are too few to draw again, so no figure has an interval
  for (const figure of ["wallMs", "costUsd", "inputTokens", "outputTokens"]) assert.deepEqual([savings[figure].tasks, savings[figure].interval], [3, null], figure);
  assert.equal(summary.draws, 4000);

  // By task type and by level, without intervals: rename-function has 420 s against 210 s, and two pairs with a cost
  const [rename, move] = summary.taskTypes;
  assert.deepEqual([rename.savings.pairs, rename.savings.wallMs.savedPercent, rename.savings.costUsd.pairs, rename.savings.costUsd.savedPercent], [3, 50, 2, 50]);
  assert.equal(rename.savings.wallMs.interval, undefined);
  assert.deepEqual([move.savings.pairs, move.savings.wallMs.savedPercent, move.savings.solved.baselineOnly], [1, -25, 1]);
  assert.deepEqual(rename.levels.map(({ level, savings }) => [level, savings.pairs, savings.wallMs.savedPercent]), [[10, 2, 50], [50, 1, 50]]);
  // Level 10 over every task type: 300 s against 210 s
  assert.deepEqual(summary.levels.map(({ level, savings }) => [level, savings.pairs, savings.wallMs.savedPercent]), [[10, 3, 30], [50, 1, 50]]);

  const html = renderReport(summary);
  const tileOf = (label) => html.slice(html.indexOf(`<div class="label">${label}</div>`)).split('<div class="card tile">')[0];
  assert.match(tileOf("Time saved by the server"), /<span class="value">38%<\/span>.*<div class="detail">8 min 20 s without, 5 min 10 s with, over 4 pairs<\/div>/);
  assert.match(tileOf("Cost saved by the server"), /<span class="value">29%<\/span>.*<div class="detail">\$3\.80 without, \$2\.70 with, over 3 pairs<\/div>/);
  assert.match(tileOf("Input tokens saved by the server"), /<span class="value">29%<\/span>.*3,500 without, 2,500 with, over 3 pairs/);
  assert.match(tileOf("Output tokens saved by the server"), /<span class="value">37%<\/span>/);
  assert.match(tileOf("Time saved by the server"), /<div class="detail">No interval: 3 tasks, and an interval needs 10<\/div>/);
  assert.match(
    tileOf("Tasks that one arm solved more often"),
    /key baseline"><\/span><span class="value">1<\/span>.*key lsp"><\/span><span class="value">2<\/span>.*p = 1\.000 by the exact sign test\. 0 of 3 tasks were solved as often by both\..*Sessions solved by one arm only, with each repetition beside the one of the same number: 1 without the server, 2 with it\./
  );
  // Within the first screen: the savings stand right under the headline tiles, above the chart
  assert.ok(html.indexOf("Tasks solved") < html.indexOf("Time saved by the server") && html.indexOf("Time saved by the server") < html.indexOf("<h2>By kind of task</h2>"));
  assert.match(html, /The range of each saving is its 95% interval: the run&#39;s tasks were drawn again with replacement 4,000 times, all repetitions of a task together/);
  assert.match(html, /A saving of fewer than 10 tasks gets no range, since drawing so few again shows little of how it can vary\./);
  assert.match(html, /A task counts for the arm that solved more of its rounds, and for neither where both arms solved as many\. /);
  assert.match(html, /A small p-value says that such a split would seldom come from chance alone\. It does not say how large the difference is/);
  // A figure that rests on fewer pairs than its row says so
  assert.match(html, /<td>Rename a function with a unique name<\/td><td class="number">3<\/td><td class="number">50%<\/td><td class="number">50% \(2 pairs\)<\/td>/);
  assert.match(html, /<td>Move a function to another module<\/td><td class="number">1<\/td><td class="number">−25%<\/td>/);
  assert.match(html, /<td>10<\/td><td class="number">3<\/td><td class="number">30%<\/td>/);
  for (const secret of ["Secret", "hiddenName", "NAMING ERROR"]) assert.ok(!(JSON.stringify(summary) + html).includes(secret), secret);
});

// Twelve tasks of two rounds each, every one with savings of its own. The lsp arm solved every round, the baseline none.
const TWELVE = Array.from({ length: 12 }, (_, at) => `A/rename-function/${10 * (at + 1)}`).flatMap((task, at) =>
  [1, 2].flatMap((repetition) => [
    session(task, "baseline", repetition, { outcome: "wrong-result", wallS: 100 + 10 * at, costUsd: 1, inputTokens: 100, outputTokens: 10, toolCalls: {} }),
    session(task, "lsp", repetition, { wallS: 40 + 13 * ((at * 5 + repetition) % 12), costUsd: 1, inputTokens: 100, outputTokens: 10, toolCalls: {} }),
  ])
);

// The interval worked out again in the plainest way: each task's sums, in the order of its id, drawn with the same generator
function intervalByHand(records) {
  const sums = new Map();
  for (const { task, arm, wallMs } of records) {
    const [without, withIt] = sums.get(task) ?? [0, 0];
    sums.set(task, arm === "baseline" ? [without + wallMs, withIt] : [without, withIt + wallMs]);
  }
  const tasks = [...sums.keys()].sort().map((task) => sums.get(task));
  const random = generator(SEED);
  const shares = [];
  for (let draw = 0; draw < DRAWS; draw++) {
    let [without, withIt] = [0, 0];
    for (let pick = 0; pick < tasks.length; pick++) {
      const [one, other] = tasks[Math.floor(random() * tasks.length)];
      without += one;
      withIt += other;
    }
    shares.push((100 * (without - withIt)) / without);
  }
  shares.sort((a, b) => a - b);
  return [quantile(shares, 0.025), quantile(shares, 0.975)];
}

test("the interval draws tasks, the same ones from the same records in any order, and takes the middle 95%", () => {
  const { savings } = summarize(PLAN, TWELVE);
  assert.equal(savings.wallMs.tasks, 12);
  assert.deepEqual(savings.wallMs.interval, intervalByHand(TWELVE));
  // The quantile reads between the two nearest values
  assert.equal(quantile([0, 10, 20, 30, 40], 0.025), 0.4 * 0.25 * 10);
  // A narrower or a wider share of the draws would give other bounds, as would the saving itself
  const [low, high] = savings.wallMs.interval;
  assert.ok(low < savings.wallMs.savedPercent && savings.wallMs.savedPercent < high);
  // The order of the records does not change the draws
  const twice = [summarize(PLAN, TWELVE), summarize(PLAN, [...TWELVE].reverse())].map(({ savings }) => savings);
  assert.deepEqual(twice[0], twice[1]);
  // The generator is the same on every machine
  const random = generator(SEED);
  assert.deepEqual([random(), random()], [0.6270739405881613, 0.002735721180215478]);

  // The rounds of a task are drawn together. Each task saved 80% in one round and took 80% more in the other,
  // so every draw of tasks saves nothing, where a draw of single rounds would spread from one side to the other.
  const evened = TWELVE.map((record) =>
    record.arm === "baseline" ? { ...record, wallMs: 100000 } : { ...record, wallMs: record.repetition === 1 ? 20000 : 180000 }
  );
  assert.deepEqual(summarize(PLAN, evened).savings.wallMs.interval, [0, 0]);

  // Twelve tasks that the lsp arm solved more often: 2 × (1/2)^12, which the tile says as less than a thousandth
  assert.match(renderReport(summarize(PLAN, TWELVE)), /p &lt; 0\.001 by the exact sign test\. 0 of 12 tasks were solved as often by both\./);
  assert.deepEqual([FORMAT.pIs(0.0004), FORMAT.pIs(0.25), FORMAT.p(0.0004)], ["p < 0.001", "p = 0.250", "< 0.001"]);
});

test("no interval where too few tasks carry a saving, or where a draw has nothing to save from", () => {
  const even = Array.from({ length: MIN_TASKS }, () => [100, 60]);
  assert.deepEqual(savedInterval(even).map((bound) => Math.round(bound * 1e9) / 1e9), [40, 40]);
  assert.equal(savedInterval(even.slice(1)), null);
  // Nine tasks whose baseline took nothing: a third of the draws holds none but those, and no bound can stand for them
  assert.equal(savedInterval([...Array(9).fill([0, 5]), [100, 50]]), null);
  // The page says why a tile has no interval, and what an interval rests on
  const page = renderReport(summarize(PLAN, TWELVE));
  assert.match(page, /<div class="detail">95% interval −?\d+% to −?\d+%, from 12 tasks<\/div>/);
});

test("the sign test gives the p-values worked out by hand, and counts each task once", () => {
  // Six tasks, all for the same side: 2 × (1/2)^6
  assert.ok(Math.abs(signP(0, 6) - 2 / 64) < 1e-12);
  // Twelve split 10 and 2: 2 × (1 + 12 + 66) / 4096
  assert.ok(Math.abs(signP(10, 2) - (2 * 79) / 4096) < 1e-12);
  assert.equal(signP(0, 0), 1);
  // A task counts for the side that solved more of its rounds, and a tie for neither
  assert.deepEqual(signTest([[3, 1], [2, 2], [0, 1], [3, 0]]), { firstMore: 2, secondMore: 1, tied: 1, signP: 1 });
  assert.deepEqual(signTest([]), { firstMore: 0, secondMore: 0, tied: 0, signP: null });
});

test("which arm solved a task more often does not depend on how the repetitions are numbered", () => {
  // Six tasks of three rounds each. The baseline solved the first round of each, the lsp arm two rounds of each.
  const tasks = [10, 20, 30, 40, 50, 60].map((level) => `A/rename-function/${level}`);
  const run = (lspSolved) =>
    tasks.flatMap((task) =>
      [1, 2, 3].flatMap((repetition) => [
        session(task, "baseline", repetition, { outcome: repetition === 1 ? "passed" : "wrong-result", wallS: 10, costUsd: 1, inputTokens: 1, outputTokens: 1, toolCalls: {} }),
        session(task, "lsp", repetition, { outcome: lspSolved.includes(repetition) ? "passed" : "wrong-result", wallS: 10, costUsd: 1, inputTokens: 1, outputTokens: 1, toolCalls: {} }),
      ])
    );
  const [apart, together] = [run([2, 3]), run([1, 2])].map((records) => summarize(PLAN, records).savings.solved);
  // Paired by number, the sessions solved by one arm only depend on which repetitions the lsp arm solved
  assert.deepEqual([apart.baselineOnly, apart.lspOnly, together.baselineOnly, together.lspOnly], [6, 12, 0, 6]);
  // By task they do not: the lsp arm solved each task more often, and six of six for one side is 2 × (1/2)^6
  for (const solved of [apart, together]) {
    assert.deepEqual(solved.tasks, { baselineMore: 0, lspMore: 6, tied: 0 });
    assert.ok(Math.abs(solved.signP - 2 / 64) < 1e-12);
  }
  assert.match(renderReport(summarize(PLAN, run([2, 3]))), /p = 0\.031 by the exact sign test\. 0 of 6 tasks were solved as often by both\./);
});

test("the summary and the page say what the sessions did, and why they failed, by kind", () => {
  const summary = summarize(PLAN, SAVINGS_RECORDS);
  const { baseline, lsp } = summary.activity;
  assert.deepEqual([baseline.toolCalls, lsp.toolCalls], [{ mean: 4, median: 4 }, { mean: 3.75, median: 3.5 }]);
  assert.deepEqual([baseline.replies, lsp.replies], [{ mean: 10, median: 10 }, { mean: 7, median: 7 }]);
  // The session that was killed counted no tokens, so the baseline's are those of the other three: 100, 200 and 80
  assert.deepEqual([baseline.outputTokens.mean, baseline.outputTokens.median, lsp.outputTokens], [380 / 3, 100, { mean: 75, median: 75 }]);
  assert.deepEqual([baseline.withoutTokens, lsp.withoutTokens], [1, 0]);
  // The server's tools are one row, first, then the harness's own by how often the run called them
  assert.deepEqual(baseline.tools, [
    { tool: "language server", calls: 0, perSession: 0 },
    { tool: "Bash", calls: 12, perSession: 3 },
    { tool: "Read", calls: 4, perSession: 1 },
  ]);
  assert.deepEqual(lsp.tools, [
    { tool: "language server", calls: 6, perSession: 1.5 },
    { tool: "Bash", calls: 8, perSession: 2 },
    { tool: "Read", calls: 1, perSession: 0.25 },
  ]);
  // The session whose one call to the server failed did not call it, though the server's tools count the call it tried
  assert.deepEqual(summary.serverUse, {
    sessions: 4,
    called: 3,
    answeredCalls: 5,
    calledSolved: 3,
    notCalledSolved: 0,
    calledWallMs: 60000,
    notCalledWallMs: 100000,
    taskTypes: [
      { id: "rename-function", sessions: 3, called: 3 },
      { id: "move-function", sessions: 1, called: 0 },
    ],
    tools: [
      { tool: "elm_rename_function", calls: 4 },
      { tool: "elm_move_function", calls: 1 },
      { tool: "elm_references", calls: 1 },
    ],
  });
  // A failed session counts once: under its limit, or else under the first problem, which is the build where it fails
  assert.deepEqual(summary.failures, [
    { id: "does-not-compile", title: "Does not compile", baseline: 0, lsp: 1, calledServer: 0, notCalledServer: 1 },
    { id: "inside-string", title: "Changed a string literal", baseline: 1, lsp: 0, calledServer: 0, notCalledServer: 0 },
    { id: "time-limit", title: "Out of time", baseline: 1, lsp: 0, calledServer: 0, notCalledServer: 0 },
  ]);
  // Each session's own kind, beside its outcome
  assert.deepEqual(summary.runs.map((run) => run.failureKind), [null, null, "time-limit", null, "inside-string", null, null, "does-not-compile"]);

  const html = renderReport(summary);
  assert.match(html, /<td>Tool calls<\/td><td class="number">4\.0<\/td><td class="number">4<\/td><td class="number">3\.8<\/td><td class="number">4<\/td><\/tr>/);
  assert.match(html, /<td>language server<\/td><td class="number">0<\/td><td class="number">0\.0<\/td><td class="number">6<\/td><td class="number">1\.5<\/td><\/tr>/);
  assert.match(html, /Ended before Claude Code counted their tokens, and left out of the output tokens: 1 session without language server\./);
  assert.match(
    html,
    /3 of 4 sessions with the language server called it and had at least one call answered\. 3 of those 3 solved their task\. Their median time, solved or not, was 1 min 0 s\. 0 of the 1 session that did not call it solved theirs, and their median time, solved or not, was 1 min 40 s\./
  );
  assert.match(html, /<h3>The server's tools by calls tried<\/h3>.*<td>elm_move_function<\/td><td class="number">1<\/td><\/tr>/);
  assert.match(html, /The server answered 5 of the 6, and Claude Code reports the others as failed\./);
  assert.match(html, /<td>Move a function to another module<\/td><td class="number">1<\/td><td class="number">0<\/td><\/tr>/);
  assert.match(html, /<td>elm_rename_function<\/td><td class="number">4<\/td><\/tr>/);
  assert.match(html, /<td>Changed a string literal<\/td><td class="number">1<\/td><td class="number">0<\/td><\/tr>/);
  assert.match(html, /<td>Does not compile<\/td><td class="number">0<\/td><td class="number">0<\/td><td class="number">1<\/td><\/tr>/);
});

test("a session has one name for how it failed, from the kind its record keeps beside the problem", () => {
  const failed = (arm, repetition, outcome, problems, problemKinds) => ({
    ...session(RENAME, arm, repetition, { outcome, wallS: 10, costUsd: 1, inputTokens: 1, outputTokens: 1, toolCalls: {}, problems }),
    ...(problemKinds ? { problemKinds } : {}),
  });
  const records = [
    // The check could not read the checkout, so the record counts it with those that do not compile
    failed("baseline", 1, "does-not-compile", ["the result could not be judged: fatal: not a git repository"], ["not-judged"]),
    failed("lsp", 1, "passed", []),
    // A record written with kinds is read by its kind and not by its words
    failed("baseline", 2, "wrong-result", ['src/Secret.elm changed in more than the name: "hiddenName" became "x"'], ["code-beyond-task"]),
    failed("lsp", 2, "passed", []),
    // A wrong result whose record holds no sentence
    failed("baseline", 3, "wrong-result", []),
    failed("lsp", 3, "passed", []),
  ];
  const summary = summarize(PLAN, records);
  assert.deepEqual(summary.runs.filter(({ arm }) => arm === "baseline").map(({ ending, failureKind }) => [ending, failureKind]), [
    ["not-judged", "not-judged"],
    ["wrong-result", "code-beyond-task"],
    ["wrong-result", "unstated"],
  ]);
  assert.deepEqual(summary.overall.baseline.endings["not-judged"], 1);
  assert.deepEqual(summary.overall.baseline.endings["does-not-compile"], 0);
  const html = renderReport(summary);
  // The same words in the table of endings, in the table of failures and in the row of the session
  assert.match(html, /<th class="number">Does not compile<\/th><th class="number">Could not be judged<\/th>/);
  assert.match(html, /<td>Could not be judged<\/td><td class="number">1<\/td><td class="number">0<\/td><\/tr>/);
  assert.match(html, /Without language server<\/td><td>Could not be judged<\/td>/);
  assert.match(html, /<td>Failed in a way that its record does not say<\/td><td class="number">1<\/td>/);
  // A run where every result was judged has no such column
  assert.ok(!renderReport(summarize(PLAN, SAVINGS_RECORDS)).includes("Could not be judged"));
});

test("a run whose harness reports no cost saves tokens and time, and names no cost", () => {
  // The Codex CLI counts no tokens for a session that it ended before the end of a turn
  const tokensOnly = SAVINGS_RECORDS.map((each) => ({ ...each, harness: "codex", model: "gpt-6", costUsd: null, ...(each.finished === false ? { inputTokens: null, outputTokens: null } : {}) }));
  const summary = summarize(PLAN, tokensOnly);
  assert.equal(summary.savings.costUsd, null);
  assert.deepEqual([summary.savings.wallMs.pairs, summary.savings.inputTokens.pairs, summary.savings.outputTokens.pairs], [4, 3, 3]);
  assert.equal(summary.overall.baseline.withoutTokens, 1);
  assert.equal(summary.taskTypes[0].savings.costUsd, null);
  const html = renderReport(summary);
  assert.ok(!html.includes("Cost saved"));
  assert.match(html, /Input tokens saved by the server/);
  assert.match(html, /Codex CLI reports no cost, so there is none to save\./);
  // A run of one arm compares nothing, so it saves nothing either
  const alone = summarize(PLAN, SAVINGS_RECORDS.filter((each) => each.arm === "baseline"));
  assert.deepEqual([alone.savings.pairs, alone.savings.wallMs.savedPercent, alone.savings.solved.signP, alone.serverUse], [0, null, null, null]);
  assert.ok(!renderReport(alone).includes("saved by the server"));
});

test("tools that were called as often come in the order of their names, the same on every machine", () => {
  const records = ["baseline", "lsp"].map((arm) => session(RENAME, arm, 1, { wallS: 10, costUsd: 1, inputTokens: 1, outputTokens: 1, toolCalls: { apply_patch: 1, Bash: 1, "mcp__elm-lsp__elm_symbols": 1, "mcp__elm-lsp__elm_Symbols": 1 } }));
  const summary = summarize(PLAN, records);
  // In the order of code points an upper case letter comes before every lower case one, where a locale's order puts "a" first
  assert.deepEqual(summary.activity.baseline.tools.map(({ tool }) => tool), ["language server", "Bash", "apply_patch"]);
  assert.deepEqual(summary.serverUse.tools.map(({ tool }) => tool), ["elm_Symbols", "elm_symbols"]);
});
