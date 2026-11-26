/**
 * The probe: the language server's refactoring tools called directly, with
 * no agent, on many targets of each task type, and judged as a session is.
 * A session that repairs what a tool got wrong solves its task all the same,
 * so the benchmark's runs show a tool's mistakes only as cost. The probe
 * shows them, and how often a tool is right.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { runChecks } from "../../mcp-wrapper/doctor.mjs";
import { shell } from "../../mcp-wrapper/harnesses.mjs";
import { stopClients } from "../../mcp-wrapper/lsp-client.mjs";
import { runInTurn, tools } from "../../mcp-wrapper/tools.mjs";
import { allowProjectTools } from "../../mcp-wrapper/workspace.mjs";
import { benchmarkVersion, languageServerVersion } from "./agent.mjs";
import { declaredAt } from "./elm-source.mjs";
import { surveyCheckout, targetsOf, trialHolds } from "./plan.mjs";
import { Interrupted, isStopped } from "./process.mjs";
import { judge } from "./run.mjs";
import { changedFiles, closeCheckout, committedFiles, openCheckout, originalsOf, patchOf, realRootOf, runCheck, stateOf } from "./sandbox.mjs";
import { plural, TASK_TYPES } from "./tasks.mjs";

/**
 * How a target ended, from best to worst:
 *   solved            the project compiles and every expectation holds
 *   wrong-result      it compiles, but the change is not the one asked for
 *   does-not-compile  the check command fails
 *   tool-error        a tool call failed
 *   tool-refused      a tool said that it will not make this change, and changed nothing
 */
export const OUTCOMES = ["solved", "wrong-result", "does-not-compile", "tool-error", "tool-refused"];

// What the language server says when it will not make a change, as opposed to a call that went wrong
const REFUSALS = /required by Lamdera|already exists|import cycle|not possible|No file was changed/;

// The sizes that the counts are given for, by the fewest and the most files of each band
export const SIZE_BANDS = [
  [1, 4],
  [5, 9],
  [10, 19],
  [20, 49],
  [50, 99],
  [100, 199],
  [200, Infinity],
];

const bandOf = (size) => SIZE_BANDS.find(([fewest, most]) => fewest <= size && size <= most) ?? [0, 0];
const bandName = ([fewest, most]) => (most === Infinity ? `${fewest}+` : `${fewest}-${most}`);

// Compared by code unit, so the choice does not depend on the machine's locale
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * `count` of the targets, spread evenly over the sizes from `smallest` to the
 * largest target's, the largest among them. For each of `count` sizes at equal
 * steps, from the largest down, the target nearest to it that was not taken
 * yet is taken, the smaller and then the first by key where two are as near.
 * All of them where there are no more than `count`. Sorted by size, and by key
 * within a size.
 * @template {{ key: string, size: number }} T
 * @param {T[]} targets
 * @returns {T[]}
 */
export function spreadBySize(targets, count, smallest) {
  const sorted = [...targets].sort((a, b) => a.size - b.size || byKey(a, b));
  if (sorted.length <= count) return sorted;
  const largest = sorted.at(-1).size;
  const taken = new Set();
  for (let step = count - 1; step >= 0; step--) {
    // The last step is the largest size, which the sorted targets end with
    const size = count === 1 ? largest : smallest + ((largest - smallest) * step) / (count - 1);
    let nearest = -1;
    for (const [at, target] of sorted.entries()) {
      if (taken.has(at)) continue;
      if (nearest === -1 || Math.abs(target.size - size) < Math.abs(sorted[nearest].size - size)) nearest = at;
    }
    taken.add(nearest);
  }
  return sorted.filter((_, at) => taken.has(at));
}

// The tool that a session calls, by its name
const toolNamed = (name) => tools.find((tool) => tool.name === name);

/** Call a tool as the MCP server of the lsp arm does, and resolve with its text. */
const callTool = (name, args) => runInTurn(toolNamed(name), args);

/**
 * Where a tool is pointed at what the target declares, as its arguments
 * `line` and `character` say it: the line from 0 and the column in bytes of
 * UTF-8, as the language server counts it.
 */
function pointAt(path, named) {
  const text = readFileSync(path, "utf-8");
  const place = declaredAt(text, named);
  if (place === null) {
    throw new Error(`The probe found no declaration of ${JSON.stringify(named)} in ${path}, where the scan of the project found one.`);
  }
  return { line: place.line, character: Buffer.byteLength(text.split("\n")[place.line].slice(0, place.index)) };
}

/**
 * The tool calls that a session of the lsp arm makes for a task, each as
 * [name, arguments]. The new names are the ones that the task expects.
 * A module whose new file lies beside the old one is renamed, not moved.
 */
export function callsFor(type, target, task, elmRoot) {
  const file_path = join(elmRoot, target.file);
  const expected = (kind) => task.expect.find((expectation) => expectation.kind === kind);
  switch (type) {
    case "rename-function":
    case "rename-shared-function":
      return [["elm_rename_function", { file_path, ...pointAt(file_path, { function: target.name }), old_name: target.name, newName: expected("declares-function").name }]];
    case "rename-variant":
      return [
        [
          "elm_rename_variant",
          { file_path, ...pointAt(file_path, { type: target.type, variant: target.variant }), old_name: target.variant, newName: expected("type-has-variant").variant },
        ],
      ];
    case "rename-field":
      return [
        ["elm_rename_field", { file_path, ...pointAt(file_path, { alias: target.alias, field: target.field }), old_name: target.field, newName: expected("alias-has-field").field }],
      ];
    case "rename-module": {
      const newFile = expected("declares-module").file;
      if (dirname(newFile) !== dirname(target.file)) throw new Error(`The probe renames a module in its own directory, and ${newFile} lies elsewhere.`);
      return [["elm_rename_file", { file_path, new_name: basename(newFile) }]];
    }
    case "rename-type":
      return [["elm_rename_type", { file_path, ...pointAt(file_path, { typeName: target.name }), old_name: target.name, newName: expected("declares-type").name }]];
    case "move-function":
      return [
        [
          "elm_move_function",
          { file_path, line: pointAt(file_path, { function: target.name }).line, function_name: target.name, target_module: join(elmRoot, target.destinationFile) },
        ],
      ];
    case "remove-variant": {
      const variant = { file_path, ...pointAt(file_path, { type: target.type, variant: target.variant }), variant_name: target.variant };
      return [
        ["elm_prepare_remove_variant", variant],
        ["elm_remove_variant", variant],
      ];
    }
    case "remove-field": {
      const field = { file_path, ...pointAt(file_path, { alias: target.alias, field: target.field }), field_name: target.field };
      return [
        ["elm_prepare_remove_field", field],
        ["elm_remove_field", field],
      ];
    }
    case "add-variant": {
      const variant = { file_path, type_name: target.type, new_variant_name: expected("type-has-variant").variant };
      return [
        ["elm_prepare_add_variant", variant],
        ["elm_add_variant", variant],
      ];
    }
  }
  throw new Error(`The probe knows no tool for the task type ${type}.`);
}

// Lines added and removed in a patch, without the lines that name its files
function diffStat(patch, files) {
  const lines = patch.split("\n");
  return {
    files,
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length,
  };
}

const seconds = (ms) => (ms === null ? null : Math.round(ms / 10) / 100);

// What a record is known by, in its file and in the name of its patch
const recordKey = (type, key) => `${type}\0${key}`;
const patchName = (type, key) => `${createHash("sha256").update(recordKey(type, key)).digest("hex").slice(0, 16)}.patch`;

// What a directory of records is held to. Records made under another server, verdict or
// config would be counted with the new ones. The commit is taken from the records instead.
const HELD = {
  languageServer: "the language server",
  benchmark: "the benchmark's own code",
  minFiles: "--min-files",
  elmRoot: '"elmRoot" of the config',
  check: '"check" of the config',
  checkTimeoutMs: '"checkTimeoutMs" of the config',
  link: '"link" of the config',
};

function holdTo(path, earlier, settings) {
  const changed = Object.keys(HELD).filter((key) => JSON.stringify(earlier[key]) !== JSON.stringify(settings[key]));
  if (changed.length > 0) {
    const differences = changed.map((key) => `${HELD[key]} was ${JSON.stringify(earlier[key])} and is now ${JSON.stringify(settings[key])}`).join(", ");
    throw new Error(`${path} holds records that were made differently: ${differences}. Probe as before, or use another --out.`);
  }
}

/**
 * Probe one codebase in a checkout of its own, which `<out>/work` keeps track
 * of, and write its records to `<out>/probe/<label>.json` as they come, with
 * the patch of each target in `<out>/probe/<label>/`. Records that are there
 * already are kept, and their targets are not probed again.
 * @param {object} settings
 * @param {() => void} settings.assertServer  Throws when the server is no longer the one the probe began with
 * @param {boolean} [settings.restartServer]  Start the language server afresh for each target
 * @param {(name: string, args: object) => Promise<string>} [settings.call]  Calls a tool, as a session does
 * @returns {Promise<object[]>} the records of the codebase
 */
export async function probeCodebase(codebase, { out, minFiles, perType, only, languageServer, assertServer, readJson, writeJson, restartServer = false, call = callTool }) {
  const { label } = codebase;
  const path = join(out, "probe", `${label}.json`);
  const patches = join(out, "probe", label);
  const settings = { languageServer, benchmark: benchmarkVersion(), minFiles, elmRoot: codebase.elmRoot, check: codebase.check, checkTimeoutMs: codebase.checkTimeoutMs, link: codebase.link };
  const earlier = existsSync(path) ? readJson(path) : null;
  if (earlier) holdTo(path, earlier, settings);
  // The records were made on this commit, and the ref may have moved since
  const atCommit = { ...codebase, ref: earlier?.commit ?? codebase.ref };
  const records = earlier?.records ?? [];
  const recorded = new Set(records.map((record) => recordKey(record.type, record.key)));
  mkdirSync(patches, { recursive: true });

  // Written whole each time, and not after every target, since a codebase can have thousands
  let commit = earlier?.commit;
  let written = Date.now();
  const save = (always = false) => {
    if (commit === undefined || (!always && Date.now() - written < 5000)) return;
    writeJson(path, { codebase: label, commit, ...settings, records });
    written = Date.now();
  };

  // No label has a dot in it, so no session's slot has this name, nor the plan's
  const slot = join(out, "work", `${label}.probe`);
  // The checkout, the survey of it, and the state of its files that each target starts from
  let checkout = null;
  const open = async () => {
    stopClients();
    const worktree = await openCheckout(atCommit, slot);
    const survey = await surveyCheckout(worktree, codebase);
    checkout = { worktree, survey, committed: await committedFiles(worktree), start: await stateOf(worktree, codebase) };
    commit = worktree.commit;
  };

  // Put the files of the project back as the target found them, and tell whether that worked:
  // whether nothing that the commit holds and no Elm file differs from the state the target started from
  const putBack = async () => {
    const { worktree, committed, start } = checkout;
    const counts = (file) => committed.has(file) || file.endsWith(".elm");
    const changed = (await changedFiles(worktree, codebase, start)).filter(counts);
    if (changed.length === 0) return true;
    const originals = await originalsOf(worktree, changed, start);
    // Only the text of Elm files and elm.json is known as it was. A tool writes no other file.
    if (changed.some((file) => !originals.has(file))) return false;
    for (const file of changed) {
      const place = join(realRootOf(worktree), file);
      const text = originals.get(file);
      if (text === null) rmSync(place, { force: true });
      else {
        mkdirSync(dirname(place), { recursive: true });
        writeFileSync(place, text);
      }
    }
    return (await changedFiles(worktree, codebase, start)).filter(counts).length === 0;
  };

  const probeTarget = async (taskType, target) => {
    const { worktree, survey } = checkout;
    const task = { type: taskType.id, ...taskType.build(target, shell(...codebase.check), { exposed: survey.exposed }) };
    const calls = callsFor(taskType.id, target, task, worktree.elmRoot);
    if (restartServer) stopClients();
    const before = await stateOf(worktree, codebase);
    const texts = [];
    let failure = null;
    const calling = Date.now();
    for (const [name, args] of calls) {
      try {
        texts.push(await call(name, args));
      } catch (error) {
        // An interrupt reaches the language server too, which then fails the call. That says nothing about the tool.
        if (isStopped() || error instanceof Interrupted) throw new Interrupted();
        failure = error;
        texts.push(error.message);
        break;
      }
    }
    const toolMs = Date.now() - calling;
    if (isStopped()) throw new Interrupted();
    const text = texts.join("\n\n");
    const base = { type: taskType.id, key: target.key, size: target.size, text, toolSeconds: seconds(toolMs) };

    let record;
    if (failure) {
      // A failed call is judged by what it says, and by what it left
      const changed = await changedFiles(worktree, codebase, before);
      const refused = changed.length === 0 && REFUSALS.test(failure.message);
      // A server that ran out of time, or went away, is started afresh for the next target
      if (!refused) stopClients();
      const patch = await patchOf(worktree, changed);
      if (changed.length > 0) writeFileSync(join(patches, patchName(taskType.id, target.key)), patch);
      record = { ...base, outcome: refused ? "tool-refused" : "tool-error", unmet: [], problems: [], diff: diffStat(patch, changed.length), checkSeconds: null };
    } else {
      const judged = await judge(worktree, codebase, task, before);
      if (isStopped()) throw new Interrupted();
      writeFileSync(join(patches, patchName(taskType.id, target.key)), judged.patch);
      const outcome = !judged.compiles ? "does-not-compile" : judged.problems.length === 0 ? "solved" : "wrong-result";
      record = { ...base, outcome, unmet: judged.unmet, problems: judged.problems, diff: diffStat(judged.patch, judged.changedFiles), checkSeconds: seconds(judged.checkMs) };
    }
    if (!(await putBack())) {
      // What cannot be put back file by file goes with its checkout. The next target gets a fresh one.
      await closeCheckout(codebase, slot);
      await open();
    }
    return record;
  };

  // A build that failed may have failed on the compiler's cache, which a move of a module can leave
  // at odds with the files. The checkout as it was put back has to compile. Where it does once the
  // cache is gone, the target is probed again with the cache built afresh.
  const compilesAgain = async () => {
    const { worktree } = checkout;
    if ((await runCheck(worktree, codebase)).ok) return true;
    rmSync(join(worktree.elmRoot, "elm-stuff"), { recursive: true, force: true });
    if ((await runCheck(worktree, codebase)).ok) return false;
    throw new Error(`${label}: the checkout no longer compiles once a target's change was put back, also with the compiler's cache built afresh.`);
  };

  // The targets of a task type that the probe takes. Where the task type has a trial, a target is
  // only taken once the build says what the trial asks, as in the plan. A target with a record was
  // taken before, and is not built again.
  const choose = async (taskType, targets) => {
    let pool = targets;
    const proven = new Set(targets.filter((target) => recorded.has(recordKey(taskType.id, target.key))).map((target) => target.key));
    for (;;) {
      const picked = spreadBySize(pool, perType, minFiles);
      const unproven = taskType.trial ? picked.filter((target) => !proven.has(target.key)) : [];
      if (unproven.length === 0) return picked;
      const failed = new Set();
      for (const target of unproven) {
        if (isStopped()) throw new Interrupted();
        if (await trialHolds(checkout.worktree, codebase, target, taskType.trial)) proven.add(target.key);
        else failed.add(target.key);
      }
      pool = pool.filter((target) => !failed.has(target.key));
    }
  };

  const began = Date.now();
  console.error(`${label}: checking out the codebase and building it`);
  try {
    await open();
    for (const taskType of TASK_TYPES.filter((type) => `${label}/${type.id}`.includes(only))) {
      const typeBegan = Date.now();
      const { targets } = targetsOf(checkout.survey, taskType, minFiles);
      const chosen = await choose(taskType, targets);
      const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
      for (const target of chosen) {
        if (isStopped()) throw new Interrupted();
        const key = recordKey(taskType.id, target.key);
        if (!recorded.has(key)) {
          assertServer();
          let record = await probeTarget(taskType, target);
          if (record.outcome === "does-not-compile" && !(await compilesAgain())) record = await probeTarget(taskType, target);
          records.push(record);
          recorded.add(key);
          save();
        }
        counts[records.find((record) => recordKey(record.type, record.key) === key).outcome]++;
      }
      const tally = OUTCOMES.filter((outcome) => counts[outcome] > 0).map((outcome) => `${counts[outcome]} ${outcome}`);
      console.error(
        `${label}: ${taskType.id}, ${chosen.length} of ${plural(targets.length, "target", "targets")}${tally.length > 0 ? `: ${tally.join(", ")}` : ""}, in ${duration(Date.now() - typeBegan)}`
      );
    }
    console.error(`${label}: probed in ${duration(Date.now() - began)}`);
  } finally {
    save(true);
    stopClients();
    await closeCheckout(codebase, slot);
  }
  return records;
}

// "1 min 5 s", "12 s"
function duration(ms) {
  const total = Math.round(ms / 1000);
  const [minutes, rest] = [Math.floor(total / 60), total % 60];
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}

// How many of `records` ended in each outcome
function countOutcomes(records) {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, records.filter((record) => record.outcome === outcome).length]));
}

/**
 * Counts of the records, which name nothing of a codebase: per codebase and
 * task type, how many targets were tried, how many ended in each outcome and
 * how often each kind of expectation was not met, and the same per band of size.
 * @param {{ label: string, records: object[] }[]} codebases
 */
export function summarizeProbe(codebases, settings) {
  return {
    ...settings,
    codebases: codebases.map(({ label, records }) => ({
      label,
      types: TASK_TYPES.map(({ id }) => records.filter((record) => record.type === id))
        .filter((typed) => typed.length > 0)
        .map((typed) => ({
          type: typed[0].type,
          tried: typed.length,
          outcomes: countOutcomes(typed),
          unmet: Object.fromEntries(
            [...new Set(typed.flatMap((record) => record.unmet))].sort().map((kind) => [kind, typed.filter((record) => record.unmet.includes(kind)).length])
          ),
          bands: SIZE_BANDS.map((band) => typed.filter((record) => bandOf(record.size) === band))
            .filter((banded) => banded.length > 0)
            .map((banded) => ({ sizes: bandName(bandOf(banded[0].size)), tried: banded.length, outcomes: countOutcomes(banded) })),
        })),
    })),
  };
}

const COLUMNS = [
  ["Codebase", (row) => row.label],
  ["Task type", (row) => row.type],
  ["Sizes", (row) => row.sizes],
  ["Tried", (row) => row.tried],
  ...OUTCOMES.map((outcome) => [outcome, (row) => row.outcomes[outcome]]),
];

/** The summary as a table of plain text, a row per codebase and task type, with a row per band of size below it */
export function renderProbeTable(summary) {
  const rows = summary.codebases.flatMap(({ label, types }) =>
    types.flatMap(({ type, tried, outcomes, bands }) => [{ label, type, sizes: "all", tried, outcomes }, ...bands.map((band) => ({ label, type, ...band }))])
  );
  const cells = [COLUMNS.map(([title]) => title), ...rows.map((row) => COLUMNS.map(([, cell]) => String(cell(row))))];
  const widths = COLUMNS.map((_, at) => Math.max(...cells.map((line) => line[at].length)));
  // Names to the left, counts to the right
  return cells.map((line) => line.map((cell, at) => (at < 3 ? cell.padEnd(widths[at]) : cell.padStart(widths[at]))).join("  ").trimEnd()).join("\n");
}

/**
 * Probe every codebase of the config that `only` leaves in, write the summary
 * of every record in the output directory to `<out>/probe.json`, and return it as a table.
 * @param {object} options
 * @param {() => string | null} options.unfitServer  Why the server cannot be probed as it is, or null
 */
export async function runProbe({ codebases, out, minFiles, perType, only, readJson, writeJson, unfitServer, restartServer, call }) {
  const chosen = codebases.filter(({ label }) => TASK_TYPES.some((type) => `${label}/${type.id}`.includes(only)));
  if (chosen.length === 0) {
    throw new Error(`No task type of the config's codebases has "${only}" in its id. Their ids are ${codebases[0].label}/${TASK_TYPES[0].id} and the like.`);
  }
  const unfit = unfitServer();
  if (unfit !== null) throw new Error(unfit);
  const { ok, report } = await runChecks();
  if (!ok) throw new Error(`The probe needs a language server that starts and answers, and the checks of "cli.mjs doctor" fail:\n${report}`);
  // The tools run the compiler and elm-format that each codebase pins, as the lsp arm's server does with --project-tools
  allowProjectTools();
  const languageServer = languageServerVersion();
  // The server runs from this checkout. A build or an edit here since the probe began would give the next targets another one.
  const assertServer = () => {
    const now = languageServerVersion();
    if (now !== languageServer) {
      throw new Error(`The language server was ${languageServer} when the probe began, and is now ${now}. Put this checkout back as it was, or use another --out.`);
    }
    const unfitNow = unfitServer();
    if (unfitNow !== null) throw new Error(unfitNow);
  };
  for (const codebase of chosen) {
    await probeCodebase(codebase, { out, minFiles, perType, only, languageServer, assertServer, readJson, writeJson, restartServer, call });
  }
  // Every codebase with records in the directory, also one that this probe passed over
  const probed = codebases
    .map(({ label }) => ({ label, path: join(out, "probe", `${label}.json`) }))
    .filter(({ path }) => existsSync(path))
    .map(({ label, path }) => ({ label, records: readJson(path).records }));
  const summary = summarizeProbe(probed, { languageServer, minFiles });
  writeJson(join(out, "probe.json"), summary);
  return renderProbeTable(summary);
}
