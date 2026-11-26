#!/usr/bin/env node
/**
 * Benchmark: how does a coding agent do on Elm refactoring tasks with the
 * language server and without it? See README.md in this directory.
 */

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { join, resolve } from "path";
import { runChecks } from "../mcp-wrapper/doctor.mjs";
import { RUST_LSP_PATH } from "../mcp-wrapper/lsp-client.mjs";
import { ARMS, assertMcpServer, benchmarkVersion, languageServerBuilt, languageServerVersion, serverBuild } from "./lib/agent.mjs";
import { DEFAULT_HARNESS, harnessIdOf, harnessOf, HARNESSES } from "./lib/harnesses/index.mjs";
import { loadConfig } from "./lib/config.mjs";
import { widenCheck } from "./lib/entries.mjs";
import { assertIsolated } from "./lib/isolation.mjs";
import { DEFAULT_LEVELS } from "./lib/levels.mjs";
import { planCodebase, shortfallLines } from "./lib/plan.mjs";
import { runProbe } from "./lib/probe.mjs";
import { assertProcessesVisible, Interrupted, isStopped, LONGEST_TIMEOUT_MS, stopAll } from "./lib/process.mjs";
import { assertComparable, checkedNotes, compareRuns, renderComparison } from "./lib/compare.mjs";
import { renderReport, summarize } from "./lib/report.mjs";
import { plural, TASK_TYPES, triedTargets } from "./lib/tasks.mjs";
import { executeRun, runId } from "./lib/run.mjs";
import { closeLeftovers } from "./lib/sandbox.mjs";

const USAGE = `Usage: node benchmarks/bench.mjs <command> --out <dir> [options]

  plan     Pick one target per task type and level in each codebase and write <out>/plan.json
  run      Run every planned task in every arm and write one record per session to <out>/runs/
  report   Summarize the records into <out>/report.html and <out>/summary.json
  compare  Put several runs side by side from their records, and write <out>/comparison.html
           and <out>/comparison.json: compare --out <dir> <run directory>...
  entries  Print a check command for each codebase that also compiles the modules nothing imports
  probe    Call the language server's tools on many targets of each task type, with no agent,
           and write the verdicts to <out>/probe/ and their counts to <out>/probe.json

Options
  --out <dir>            Where the plan, the records and the report go
  --config <file>        The codebases to run on (plan, run, entries and probe)
  --min-files <n>        Fewest files a target must involve (plan and probe, default 5)
  --levels <list>        Files a target should involve, one target per level (plan, default ${DEFAULT_LEVELS.join(",")}),
                         or the levels whose tasks to run (run, default every level of the plan)
  --per-type <n>         Targets per task type and codebase, spread over their sizes, or all (probe, default 30)
  --harness <name>       Harness that runs every session: ${Object.keys(HARNESSES).join(", ")} (run, default ${DEFAULT_HARNESS.id})
  --model <id>           Model for every session (run, default ${DEFAULT_HARNESS.defaultModel} in ${DEFAULT_HARNESS.name},
                         required in the others)
  --effort <level>       Effort of every session, one that the harness takes, ${DEFAULT_HARNESS.efforts.join(", ")} in
                         ${DEFAULT_HARNESS.name} (run, default the harness's own for the model)
  --arms <list>          Arms to run (run, default ${Object.keys(ARMS).join(",")})
  --repeat <n>           Sessions per task and arm (run, default 1)
  --concurrency <n>      Sessions running at the same time (run, default 1)
  --only <text>          Only tasks whose id contains this text (run), or task types whose
                         <label>/<type> does (probe)
  --max-budget-usd <n>   Spending limit per session, where the harness reports a cost (run, default 5)
  --max-tokens <n>       Limit of tokens per session, where the harness counts them as a session goes (run, default none)
  --timeout-min <n>      Time limit per session (run, default 20)
  --agent <path>         The harness's executable (run, default ${Object.values(HARNESSES).map((harness) => harness.executable).join(", ")})
  --notes <file>         A JSON file that maps a run's name, or its model's id, to paragraphs about it (compare)

A run that stops, or is stopped with Ctrl-C, goes on from its last finished
session when the same command is given again. So does a probe, from its last
finished target.`;

class UsageError extends Error {}

// Turn ["--out", "dir", "--repeat", "2"] into { out: "dir", repeat: "2" }.
// `known` lists the options the command takes. Any other one is a mistake.
// A command that takes `paths` gets every other word, before its options or after them, in `paths`.
function parseOptions(argv, known, paths = false) {
  const options = paths ? { paths: [] } : {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "");
    if (paths && !argv[i].startsWith("--")) {
      options.paths.push(argv[i]);
      i -= 1;
      continue;
    }
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      throw new UsageError(`Expected --<option> <value>, got "${argv.slice(i, i + 2).join(" ")}"`);
    }
    if (!known.includes(name)) {
      throw new UsageError(`Unknown option --${name}. This command takes: ${known.map((option) => `--${option}`).join(", ")}`);
    }
    options[name] = argv[i + 1];
  }
  return options;
}

function required(options, name) {
  if (options[name] === undefined) throw new UsageError(`--${name} is required`);
  return options[name];
}

function positiveNumber(options, name, fallback) {
  const value = Number(options[name] ?? fallback);
  if (!(Number.isFinite(value) && value > 0)) throw new UsageError(`--${name} must be a positive number`);
  return value;
}

// In minutes, for a timer that takes milliseconds
function timeLimit(options) {
  const minutes = positiveNumber(options, "timeout-min", 20);
  const longest = Math.floor(LONGEST_TIMEOUT_MS / 60000);
  if (minutes > longest) throw new UsageError(`--timeout-min must be at most ${longest}, the longest that a timer of Node.js waits`);
  return minutes;
}

// For options that count things: sessions, files
function wholeNumber(options, name, fallback) {
  const value = options[name] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`--${name} must be a whole number of 1 or more`);
  return Number(value);
}

// "100,10,50" as [10, 50, 100]. A level named twice is one level.
function levelList(options) {
  const words = options.levels.split(",");
  if (!words.every((word) => /^[1-9]\d*$/.test(word))) {
    throw new UsageError(`--levels must be whole numbers of 1 or more, separated by commas, as in ${DEFAULT_LEVELS.join(",")}`);
  }
  return [...new Set(words.map(Number))].sort((a, b) => a - b);
}

const hasRecords = (runsDir) => existsSync(runsDir) && readdirSync(runsDir).some((file) => file.endsWith(".json"));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`${path} cannot be read: ${error.message}`);
  }
}

// The records of the sessions in `runsDir`, in the order of their names
const readRecords = (runsDir) =>
  existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => readJson(join(runsDir, file)))
    : [];

// Written under another name and moved to its own in one step, so a file is whole or not there.
// A record that was cut short would count as a session that is done.
function writeJson(path, value) {
  const unfinished = `${path}.part`;
  writeFileSync(unfinished, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(unfinished, path);
}

// True when a process with this id is running, whoever owns it.
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Take the output directory for this process until it exits. A second
 * benchmark in the same directory would take the checkouts of the first for
 * leftovers and remove them from under its sessions.
 */
function takeOutputDirectory(out) {
  const lock = join(out, "lock");
  const taken = (holder) =>
    new Error(
      `Another benchmark, process ${holder}, is working in ${out}. Wait for it, or use another --out. ` +
        `If no benchmark is running there, delete ${lock}.`
    );
  // The positive process id that a lock file names, or null when it names none
  const holderOf = (file) => {
    try {
      const pid = Number(readFileSync(file, "utf-8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };
  mkdirSync(out, { recursive: true });
  // Publish the holder and the lock together. Creating the lock before writing its id would
  // let another benchmark take an empty lock for one that was left behind.
  const own = `${lock}.${process.pid}.holder`;
  writeFileSync(own, String(process.pid));
  try {
    // Try a few times at most. A lock can go, or be taken over, between two looks at it
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(own, lock);
        process.on("exit", () => rmSync(lock, { force: true }));
        return;
      } catch (error) {
        // A file system without hard links refuses the link, and the lock cannot be made there
        if (["EPERM", "ENOTSUP", "EXDEV"].includes(error.code)) {
          throw new Error(`The file system of ${out} takes no hard links, so it cannot hold the lock of the benchmark. Use another --out.`);
        }
        if (error.code !== "EEXIST") throw error;
      }
      const holder = holderOf(lock);
      // A lock that names this process was left behind by an earlier benchmark with the same id, as a
      // container gives the benchmark the same id each time
      if (holder !== null && holder !== process.pid && isRunning(holder)) throw taken(holder);

      // Left by a benchmark that was killed. Of two that find it, one gets to move it aside. What
      // was moved is looked at once more, since the other may have put its own lock there by then,
      // and is put back in that case. A third that starts in the instant in between can get in.
      const aside = `${lock}.${process.pid}`;
      try {
        renameSync(lock, aside);
      } catch {
        continue;
      }
      const moved = holderOf(aside);
      if (moved !== holder && isRunning(moved)) {
        try {
          linkSync(aside, lock);
        } catch {
          // A third one holds the directory now
        }
        rmSync(aside, { force: true });
        throw taken(moved);
      }
      rmSync(aside, { force: true });
    }
    throw new Error(`Could not take ${lock}. Other benchmarks keep taking it.`);
  } finally {
    rmSync(own, { force: true });
  }
}

function readPlan(out) {
  const path = join(out, "plan.json");
  if (!existsSync(path)) throw new Error(`${path} does not exist. Run the plan command first.`);
  return readJson(path);
}

async function plan(options) {
  const out = resolve(required(options, "out"));
  const minFiles = wholeNumber(options, "min-files", 5);
  const levels = options.levels === undefined ? DEFAULT_LEVELS : levelList(options);
  const { codebases } = loadConfig(resolve(required(options, "config")));
  // Records are matched to tasks by name. A new plan under old records would pair them with other targets.
  if (hasRecords(join(out, "runs"))) {
    throw new Error(`${join(out, "runs")} holds the records of an earlier plan. Use another --out, or delete that directory.`);
  }
  takeOutputDirectory(out);
  await closeLeftovers(join(out, "work"), codebases);

  // The state of the code that made the plan: what a task expects is written here, and checked later
  const planned = { minFiles, levels, benchmark: benchmarkVersion(), codebases: [], tasks: [] };
  for (const codebase of codebases) {
    const { codebase: facts, tasks, skipped, short } = await planCodebase(codebase, { workDir: join(out, "work"), minFiles, levels });
    planned.codebases.push(facts);
    planned.tasks.push(...tasks);
    // A target is only taken from what the check command compiles, so this says how much of the project was in play
    console.log(
      `${codebase.label}: ${plural(tasks.length, "task", "tasks")} in ${plural(facts.modules, "module", "modules")}, of which the check command compiles ${facts.compiled}`
    );
    if (facts.outsiders > 0) {
      console.log(
        `${codebase.label}: ${plural(facts.outsiders, "Elm file lies", "Elm files lie")} outside the project's source directories. ` +
          `${plural(facts.usedByOutsiders, "possible target was", "possible targets were")} left out because such a file can use them.`
      );
    }
    if (facts.linked > 0) {
      console.log(
        `${codebase.label}: ${plural(facts.linked, "possible target was", "possible targets were")} left out because a file they involve is reached through a link.`
      );
    }
    for (const { type, heldBack, largest, unbroken, untried, leftOut } of skipped) {
      const tooSmall =
        largest === null
          ? ". Nothing in the project is a candidate for it"
          : largest < minFiles
            ? `. No candidate involves more than ${plural(largest, "file", "files")}, and --min-files asks for ${minFiles}`
            : "";
      // One file is named, the one that holds back the most. A project can have hundreds of them.
      const others = heldBack && heldBack.files > 1 ? `, and ${plural(heldBack.files - 1, "other such file holds", "other such files hold")} candidates back too` : "";
      // Targets whose trial came out otherwise than it has to are the nearest cause, whatever else was
      // held back. Next come targets whose trial could not be made at all.
      const { trial } = TASK_TYPES.find((taskType) => taskType.id === type);
      const sentence = (text) => `. ${text[0].toUpperCase()}${text.slice(1)}`;
      const unbrokenBuild = unbroken > 0 ? sentence(trial.vain(triedTargets(unbroken))) : "";
      const notLaidOut = untried > 0 ? sentence(trial.unmade(untried)) : "";
      // Then the candidates that suited and were left out all the same, each kind with its count
      const kinds = [
        leftOut.outside > 0 && `${leftOut.outside} that an Elm file outside the project can use`,
        leftOut.linked > 0 && `${leftOut.linked} that ${leftOut.linked === 1 ? "involves" : "involve"} a file that is reached through a link`,
        leftOut.occupied > 0 && `${leftOut.occupied} whose new path holds a file already`,
        leftOut.named > 0 && `${leftOut.named} whose name Lamdera looks for`,
      ].filter(Boolean);
      const noneLeft = `. Its candidates were left out: ${kinds.join(", ")}`;
      const reason =
        unbroken > 0
          ? unbrokenBuild
          : untried > 0
            ? notLaidOut
            : kinds.length > 0
              ? noneLeft
              : heldBack
                ? `. ${heldBack.candidates} of its candidates ${heldBack.candidates === 1 ? "involves" : "involve"} ${heldBack.file}, which the check command does not compile${others}`
                : tooSmall;
      console.log(`${codebase.label}: no suitable target for ${type}${reason}`);
    }
    for (const line of shortfallLines(codebase.label, short)) console.log(line);
  }
  // A stop lets the benchmark's own git commands finish, the last one that removes a checkout among them
  if (isStopped()) throw new Interrupted();
  writeJson(join(out, "plan.json"), planned);
  console.log(`Wrote ${join(out, "plan.json")}`);
}

async function entries(options) {
  const out = resolve(required(options, "out"));
  const { codebases } = loadConfig(resolve(required(options, "config")));
  takeOutputDirectory(out);
  await closeLeftovers(join(out, "work"), codebases);
  for (const codebase of codebases) {
    await widenCheck(codebase, { workDir: join(out, "work"), say: console.log });
  }
  // A stop lets the benchmark's own git commands finish, the last one that removes a checkout among them
  if (isStopped()) throw new Interrupted();
}

const seconds = (ms) => `${Math.round(ms / 1000)}s`;

/**
 * Why the lsp arm cannot start a session with the binary of the language
 * server as it is, or null when it can. The report names the sources as they
 * are, and a binary built before an edit to them is not of those. Nor is one
 * whose sources nobody knows.
 */
function unfitServer() {
  const build = serverBuild();
  const known = "The lsp arm needs a language server whose sources are known, and";
  switch (build.unknown) {
    case "unbuilt":
      return `The lsp arm needs the language server, and ${RUST_LSP_PATH} is missing. Run scripts/setup.sh to build it.`;
    case "unlisted":
      return `${known} ${RUST_LSP_PATH}.d, the list of the files it was built from, is missing. Build it with scripts/setup.sh, which writes that list.`;
    case "gone":
      return `${known} none of the files that ${RUST_LSP_PATH}.d names as its sources is there any more, as after the checkout was moved. Build it again with scripts/setup.sh, which writes that list anew.`;
  }
  if (build.newer === null) return null;
  return `The lsp arm needs a language server built from its sources as they are, and ${RUST_LSP_PATH} is older than ${build.newer}. Run scripts/setup.sh to build it again.`;
}

// What every session of an output directory must have in common to be compared, as the operator named it
const SHARED = {
  harness: "--harness",
  model: "--model",
  effort: "--effort",
  maxBudgetUsd: "--max-budget-usd",
  maxTokens: "--max-tokens",
  timeoutMin: "--timeout-min",
  languageServer: "the language server",
  serverSettings: "the settings of the language server",
  benchmark: "the benchmark's own code",
  // Not the operator's to name: the first session of a run says what it is
  agent: "the agent",
};

/**
 * Hold a run to the settings its output directory was started with. Records
 * made under another model, limit, language server or version of Claude
 * Code, or judged by another state of the benchmark, would sit in the same
 * rounds as the new ones and be compared with them. Only the lsp arm starts
 * the language server, so a directory is held to the server from the first
 * record of a session of that arm on, and to none before. A run of the arm
 * whose sessions recorded nothing leaves no record that names its server.
 * @returns {(agent: string) => void}  Takes what the first session of this run said it is, holds
 *   the run to that as well and writes the settings down, with the arms of this run. To be called
 *   once a task's session is about to start: an arm that was only asked for has no round waiting for it.
 */
function keepSettings(out, runsDir, shared, arms) {
  const path = join(out, "run.json");
  const before = existsSync(path) && hasRecords(runsDir) ? readJson(path) : null;
  // A run.json of the time before the choice of a harness holds none, and its sessions ran in Claude Code
  const recorded = (key) => (key === "harness" ? harnessIdOf(before[key]) : (before[key] ?? null));
  const hold = (settings) => {
    // A setting that run.json does not hold is one that was not set, as an effort is where --effort was not given
    const changed = Object.keys(settings).filter((key) => before && recorded(key) !== (settings[key] ?? null));
    if (changed.length > 0) {
      // An effort that was not set is the default of the harness of those sessions. A limit that was not set is none.
      const shown = (key, value, harness) => value ?? (key === "effort" ? `${harnessOf(harness)?.name ?? harness}'s default` : "none");
      const differences = changed
        .map((key) => `${SHARED[key]} was ${shown(key, recorded(key), recorded("harness"))} and is now ${shown(key, settings[key], shared.harness)}`)
        .join(", ");
      throw new Error(`${runsDir} holds records of sessions that ran differently: ${differences}. Run as before, or use another --out.`);
    }
  };
  // A server that no recorded session of the lsp arm ran with is none to hold a run to. The arm is read
  // from the records and not from their names, which hold the label of a codebase, and a label can hold "--lsp--".
  const { languageServer, serverSettings, ...withoutServer } = shared;
  hold(readRecords(runsDir).some((record) => record.arm === "lsp") ? shared : withoutServer);
  // Every arm that sessions were ever started for. The report waits for each of them before it counts a round.
  const asked = Object.keys(ARMS).filter((arm) => arms.includes(arm) || before?.arms?.includes(arm));
  return (agent) => {
    hold({ agent });
    writeJson(path, { ...before, ...shared, agent, arms: asked });
  };
}

async function run(options) {
  const out = resolve(required(options, "out"));
  const { codebases } = loadConfig(resolve(required(options, "config")));
  // Named twice, an arm still runs once
  const arms = [...new Set((options.arms ?? Object.keys(ARMS).join(",")).split(","))];
  for (const arm of arms) {
    if (!ARMS[arm]) throw new UsageError(`Unknown arm "${arm}". Known: ${Object.keys(ARMS).join(", ")}`);
  }
  const harness = HARNESSES[options.harness ?? DEFAULT_HARNESS.id];
  if (!harness) throw new UsageError(`Unknown harness "${options.harness}". Known: ${Object.keys(HARNESSES).join(", ")}`);
  const model = options.model ?? harness.defaultModel;
  if (!model) throw new UsageError(`--model is required with --harness ${harness.id}. Name the model as ${harness.executable} takes it.`);
  // Without one, a session runs at the effort that its harness picks for its model
  const effort = options.effort ?? null;
  if (effort !== null && harness.efforts.length === 0) {
    throw new UsageError(`${harness.name} has no setting of effort, so --effort cannot be given with --harness ${harness.id}. Leave it out.`);
  }
  if (effort !== null && !harness.efforts.includes(effort)) {
    throw new UsageError(`Unknown effort "${effort}". Known: ${harness.efforts.join(", ")}, the levels that ${harness.name} takes`);
  }
  // A limit holds a session only where the harness says what the session has spent
  if (!harness.reportsCost && options["max-budget-usd"] !== undefined) {
    throw new UsageError(`${harness.name} reports no cost, so --max-budget-usd cannot hold its sessions. Leave it out${harness.countsTokens ? ", and use --max-tokens for a limit" : ""}.`);
  }
  if (!harness.countsTokens && options["max-tokens"] !== undefined) {
    throw new UsageError(
      harness.reportsCost
        ? `${harness.name} is held by --max-budget-usd, and --max-tokens cannot be given with --harness ${harness.id}. Leave it out.`
        : `${harness.name} counts tokens only when a session has ended, so --max-tokens cannot hold its sessions. Leave it out.`
    );
  }
  const repeat = wholeNumber(options, "repeat", 1);
  const concurrency = wholeNumber(options, "concurrency", 1);
  const runsDir = join(out, "runs");
  const told = new Set();
  const shared = {
    harness: harness.id,
    model,
    effort,
    maxBudgetUsd: harness.reportsCost ? positiveNumber(options, "max-budget-usd", 5) : null,
    maxTokens: options["max-tokens"] === undefined ? null : wholeNumber(options, "max-tokens"),
    timeoutMin: timeLimit(options),
    benchmark: benchmarkVersion(),
  };
  const settings = {
    ...shared,
    harness,
    workDir: join(out, "work"),
    runsDir,
    // A session runs in its checkout, so a path is resolved here. A bare name is looked up on PATH.
    agentCommand: [options.agent?.includes("/") ? resolve(options.agent) : (options.agent ?? harness.executable)],
    timeoutMs: shared.timeoutMin * 60 * 1000,
    // A record names it, since the time of a session depends on what runs beside it. A resumed run may take another.
    concurrency,
    // What a harness hands every session is said once for each codebase, at its first session
    tell: (label, text) => {
      if (told.has(label)) return;
      told.add(label);
      console.log(text);
    },
  };
  mkdirSync(runsDir, { recursive: true });
  takeOutputDirectory(out);
  // What a benchmark left here when it was killed, also for a session that has its record
  await closeLeftovers(settings.workDir, codebases);

  // The arms of a task run next to each other, so both see the same time of day and the same machine load
  const planned = readPlan(out);
  if (planned.benchmark !== shared.benchmark) {
    throw new Error(
      `${join(out, "plan.json")} was made by another state of the benchmark's code (${planned.benchmark ?? "an earlier one"}, and this is ${shared.benchmark}). ` +
        `What its tasks expect may not be what this code checks. Plan again, into another --out where this one holds records.`
    );
  }
  const levels = options.levels === undefined ? planned.levels : levelList(options);
  const unplanned = levels.filter((level) => !planned.levels.includes(level));
  if (unplanned.length > 0) {
    throw new Error(`The plan has no level ${unplanned.join(" or ")}. Its levels are ${planned.levels.join(", ")}.`);
  }
  const tasks = planned.tasks.filter((task) => task.id.includes(options.only ?? "") && levels.includes(task.level));
  // A text that matches no task is a mistake, and not a run with nothing left to do
  if (tasks.length === 0 && planned.tasks.length > 0) {
    const asked = [options.only !== undefined && `"${options.only}" in its id`, options.levels !== undefined && `the level ${levels.join(" or ")}`].filter(Boolean);
    throw new Error(`No task of the plan has ${asked.join(" and ")}. The plan's tasks are: ${planned.tasks.map((task) => task.id).join(", ")}`);
  }
  const jobs = [];
  for (let repetition = 1; repetition <= repeat; repetition++) {
    for (const [index, task] of tasks.entries()) {
      const configured = codebases.find((candidate) => candidate.label === task.codebase);
      if (!configured) throw new Error(`The plan names codebase "${task.codebase}", which is not in the config`);
      // The targets were picked in the planned commit. The configured ref may have moved on since.
      const { commit, ...plannedWith } = planned.codebases.find((candidate) => candidate.label === task.codebase);
      // The prompts name the check command, and the targets were chosen for what it compiles.
      // Under another time limit the same build can get another verdict.
      for (const key of ["elmRoot", "check", "checkTimeoutMs", "link"]) {
        if (JSON.stringify(configured[key]) !== JSON.stringify(plannedWith[key])) {
          throw new Error(`The config's "${key}" for ${task.codebase} is not the one the plan was made with. Plan again, in another --out.`);
        }
      }
      const codebase = { ...configured, ref: commit };
      // The arms take turns at going first, so whatever that costs or saves is shared between them
      const inTurn = arms.map((_, position) => arms[(position + index + repetition) % arms.length]);
      for (const arm of inTurn) {
        // A record that is already there is kept, so an interrupted benchmark resumes where it stopped
        if (!existsSync(join(runsDir, `${runId(task, arm, repetition)}.json`))) {
          jobs.push({ task, codebase, arm, repetition });
        }
      }
    }
  }
  const needsServer = jobs.some((job) => job.arm === "lsp");
  if (needsServer) {
    const unfit = unfitServer();
    if (unfit !== null) throw new Error(unfit);
    shared.languageServer = languageServerVersion();
    // How the harness was told to hand a session the server's tools, where it needs more than the command
    if (harness.serverSettings) shared.serverSettings = harness.serverSettings;
    const built = languageServerBuilt();
    // A record names the build too. The run is held to its version and sources alone.
    settings.languageServer = built ? `${shared.languageServer}, built ${built}` : shared.languageServer;
  }
  const writeSettings = keepSettings(out, runsDir, shared, arms);
  console.log(`${plural(jobs.length, "session", "sessions")} to run with ${settings.model} in ${harness.name}`);
  if (jobs.length === 0) return;
  // Claude Code stops a session at the first turn that ends above its limit, so a session can pass it by that turn
  const limits = harness.reportsCost
    ? `Each is stopped once it has spent $${settings.maxBudgetUsd}, which makes about $${(jobs.length * settings.maxBudgetUsd).toFixed(0)} if every one gets that far.`
    : `${harness.name} reports no cost, so only the time limit of ${plural(settings.timeoutMin, "minute", "minutes")}` +
      (settings.maxTokens ? ` and the limit of ${settings.maxTokens} tokens hold each session.` : ` holds each session.`);
  console.log(`${limits} The isolation check before them is one short session more.`);

  assertProcessesVisible();
  // The wrapper starts the binary at a session's first tool call. One that cannot start, or does not answer what
  // every tool call asks, would make each session of the lsp arm a baseline whose tool calls fail.
  if (needsServer) {
    const { ok, report } = await runChecks();
    if (!ok) throw new Error(`The lsp arm needs a language server that starts and answers, and the checks of "cli.mjs doctor" fail:\n${report}`);
    await assertMcpServer({ env: harness.environment(null) });
  }
  // A harness updates itself, also between two runs into one directory, so its version is held like the model
  settings.agentVersion = await assertIsolated(settings);
  writeSettings(harness.agentName(settings.agentVersion));

  // A session that cannot run at all, or that lost the API, stops the
  // benchmark. No new session starts, and the ones under way finish first,
  // since they are paid for.
  let failure = null;
  // Each session of the lsp arm starts the server afresh from this checkout, at its first tool call and
  // again after ten idle minutes. A build or an edit here since the run began would give it another
  // server than its record names, before the session and while it runs.
  const assertSameServer = (consequence) => {
    const now = languageServerVersion();
    if (now !== shared.languageServer) {
      throw new Error(
        `The language server was ${shared.languageServer} when this run began, and is now ${now}. ${consequence} ` +
          `Put this checkout back as it was, or use another --out, and leave the checkout as it is while a run goes on.`
      );
    }
    const unfit = unfitServer();
    if (unfit !== null) throw new Error(unfit);
  };
  const worker = async () => {
    for (let job = jobs.shift(); job && !failure && !isStopped(); job = jobs.shift()) {
      try {
        const lsp = job.arm === "lsp";
        if (lsp) assertSameServer("A session of the lsp arm would run another server than its record names.");
        const record = await executeRun({
          ...job,
          options: settings,
          afterSession: lsp ? () => assertSameServer("The session of the lsp arm that ran meanwhile may have run another one, and nothing was recorded for it.") : undefined,
        });
        writeJson(join(runsDir, `${record.id}.json`), record);
        const cost = record.costUsd === null ? "" : `  $${record.costUsd.toFixed(2)}`;
        console.log(`${record.task}  ${record.arm}  #${record.repetition}  ${record.outcome}  ${seconds(record.wallMs)}${cost}`);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  // Interrupted sessions leave no record, so the next run starts them again
  if (isStopped()) throw new Interrupted();
  if (failure) throw failure;
}

// The plan of the run in `out`, the summary of its records and its settings, which its report and a comparison draw on
function summaryOf(out) {
  const runsDir = join(out, "runs");
  const records = readRecords(runsDir);
  if (records.length === 0) throw new Error(`No run records in ${runsDir}. Run the run command first.`);
  // Written by "run". Records that were made before it existed speak for themselves.
  const settingsPath = join(out, "run.json");
  const settings = existsSync(settingsPath) ? readJson(settingsPath) : null;
  const plan = readPlan(out);
  return { plan, summary: summarize(plan, records, settings?.arms), settings };
}

function report(options) {
  const out = resolve(required(options, "out"));
  const { summary } = summaryOf(out);
  writeJson(join(out, "summary.json"), summary);
  writeFileSync(join(out, "report.html"), renderReport(summary));
  if (summary.unpaired > 0) {
    const left = plural(summary.unpaired, "session is", "sessions are");
    console.log(`${left} left out of the report: the other arm has not done the same round of the same task yet`);
  }
  console.log(`Wrote ${join(out, "report.html")}`);
}

// Reads the records of each run and starts nothing, so it can run beside a run that is under way
function compare(options) {
  const out = resolve(required(options, "out"));
  if (options.paths.length === 0) throw new UsageError("compare needs the directory of at least one run");
  const runs = options.paths.map((dir) => ({ dir, ...summaryOf(resolve(dir)) }));
  assertComparable(runs);
  const summaries = runs.map(({ summary }) => summary);
  const notes = options.notes === undefined ? {} : checkedNotes(readJson(resolve(options.notes)), summaries);
  const comparison = compareRuns(runs);
  mkdirSync(out, { recursive: true });
  writeJson(join(out, "comparison.json"), comparison);
  writeFileSync(join(out, "comparison.html"), renderComparison(comparison, summaries, notes));
  console.log(`Wrote ${join(out, "comparison.html")}`);
}

async function probe(options) {
  const out = resolve(required(options, "out"));
  const minFiles = wholeNumber(options, "min-files", 5);
  const perType = options["per-type"] === "all" ? Infinity : wholeNumber(options, "per-type", 30);
  const { codebases } = loadConfig(resolve(required(options, "config")));
  takeOutputDirectory(out);
  await closeLeftovers(join(out, "work"), codebases);
  console.log(await runProbe({ codebases, out, minFiles, perType, only: options.only ?? "", readJson, writeJson, unfitServer }));
}

const COMMANDS = {
  plan: { run: plan, options: ["out", "config", "min-files", "levels"], interrupted: "No plan was written." },
  run: {
    run,
    options: ["out", "config", "harness", "model", "effort", "arms", "repeat", "concurrency", "only", "levels", "max-budget-usd", "max-tokens", "timeout-min", "agent"],
    interrupted: "Finished sessions keep their records, and the same command picks up from there.",
  },
  report: { run: report, options: ["out"], interrupted: "" },
  compare: { run: compare, options: ["out", "notes"], paths: true, interrupted: "" },
  entries: { run: entries, options: ["out", "config"], interrupted: "" },
  probe: {
    run: probe,
    options: ["out", "config", "min-files", "per-type", "only"],
    interrupted: "Finished targets keep their records, and the same command picks up from there.",
  },
};

async function main([command, ...rest]) {
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (!COMMANDS[command]) throw new UsageError(`Unknown command "${command}"`);
  // A hook, or a command that "git rebase -x" runs, is told by git where its repository is. Every
  // git command below would follow that, the benchmark's own and a session's, into that repository.
  const place = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].find((name) => process.env[name] !== undefined);
  if (place && !["report", "compare"].includes(command)) {
    throw new Error(`${place} is set, so git would work in the repository it names and not in the codebases of the config. Unset it and run again.`);
  }
  // Ctrl-C, a kill and a closed terminal end the check commands and the sessions under way, each
  // with what it started. They are process groups of their own, so no signal from the terminal
  // reaches them by itself. A second signal does not wait for them to end in their own way.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, stopAll);
  }
  // An exception that nothing catches would end the benchmark like a kill and leave the sessions
  // running, as when the reader of stdout went away and a later line meets EPIPE. It ends them as
  // an interrupt does instead, and Node hands an unhandled rejection over the same way. Its message
  // goes to a stderr that may be gone as well. Where nothing was left to end, the status still says
  // that something went wrong.
  process.on("uncaughtException", (error) => {
    try {
      writeSync(2, `${error?.message ?? error}\n`);
    } catch {
      // Nobody reads stderr either
    }
    process.exitCode = 1;
    stopAll();
  });
  await COMMANDS[command].run(parseOptions(rest, COMMANDS[command].options, COMMANDS[command].paths));
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof Interrupted) {
    console.error(`Interrupted. Whatever was running has been ended. ${COMMANDS[process.argv[2]].interrupted}`.trim());
    process.exitCode = 130;
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
});
