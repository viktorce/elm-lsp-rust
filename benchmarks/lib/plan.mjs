/**
 * Planning: pick one target per task type and level in each codebase and
 * write down the request and the expected outcome. The plan is the same for
 * every arm.
 */

import { existsSync, lstatSync, readFileSync, writeFileSync } from "fs";
import { join, normalize, relative, resolve } from "path";
import { shell } from "../../mcp-wrapper/harnesses.mjs";
import { asSpelledOnDisk } from "../../mcp-wrapper/workspace.mjs";
import { compiledFiles, scanOutsiders, scanProject } from "./elm-source.mjs";
import {
  changedFiles,
  closeCheckout,
  committedFiles,
  filesOutside,
  filesThroughLinks,
  openCheckout,
  realRootOf,
  runCheck,
  stateOf,
} from "./sandbox.mjs";
import { pickLevels } from "./levels.mjs";
import { heldBack, listed, plural, suitableTargets, TASK_TYPES, triedTargets, usedOutside } from "./tasks.mjs";

// How many targets each level tries in vain for a task type that must break the build first
const MAX_ATTEMPTS = 5;

// The modules that the project's elm.json lists as exposed, in one list or in groups with a title
// each. A package has them, and an application none.
function exposedModules(elmRoot) {
  const { "exposed-modules": exposed = [] } = JSON.parse(readFileSync(join(elmRoot, "elm.json"), "utf-8"));
  return Object.values(exposed).flat();
}

// The modules Lamdera looks for by name, and the types it looks for in the module Types. A project
// that uses it cannot rename them.
const NAMED_BY_LAMDERA = ["Env", "Types", "Frontend", "Backend"];
const TYPES_NAMED_BY_LAMDERA = ["FrontendModel", "BackendModel", "FrontendMsg", "BackendMsg", "ToBackend", "ToFrontend"];

// True when the project's elm.json depends on a Lamdera package.
function usesLamdera(elmRoot) {
  const { dependencies = {} } = JSON.parse(readFileSync(join(elmRoot, "elm.json"), "utf-8"));
  return Object.keys({ ...dependencies.direct, ...dependencies.indirect }).some((name) => name.startsWith("lamdera/"));
}

// What the disk says of when each file was last written, by path. A build that writes a file
// the bytes it had has still written it.
function writtenAt(worktree, files) {
  const root = realRootOf(worktree);
  return new Map(
    [...files].map((file) => {
      const entry = lstatSync(join(root, file), { bigint: true, throwIfNoEntry: false });
      return [file, entry ? `${entry.ino} ${entry.size} ${entry.mtimeNs}` : null];
    })
  );
}

// True when the project compiles, or fails to, as the trial of the task type asks once each of its
// changes is made in the checkout, one after the other. Null when the changes cannot be made, and no
// build was run to find out.
export async function trialHolds(worktree, codebase, target, trial) {
  const read = (file) => readFileSync(join(worktree.elmRoot, file), "utf-8");
  const changes = trial.edits(target, read);
  if (changes === null) return null;
  for (const [index, edits] of changes.entries()) {
    const originals = Object.keys(edits).map((file) => [file, read(file)]);
    let check;
    try {
      for (const [file, text] of Object.entries(edits)) writeFileSync(join(worktree.elmRoot, file), text);
      check = await runCheck(worktree, codebase);
    } finally {
      for (const [file, text] of originals) writeFileSync(join(worktree.elmRoot, file), text);
    }
    // A build that was cut short said nothing about the change. Taken for a broken one, it would make
    // a task of a variant that needs no work, or leave out a move that compiles.
    if (check.timedOut) {
      throw new Error(
        `${codebase.label}: ${trial.what(target, index)}, ${check.problem}. ` +
          `Its limit is ${codebase.checkTimeoutMs} ms, and ${trial.question} is not known. Raise checkTimeoutMs in the config.`
      );
    }
    if (check.ok !== trial.compiles) return false;
  }
  return true;
}

/**
 * What each word of the check command names, as a path from the Elm root. A
 * word that names a file is read as the disk spells that file, as the source
 * directories are, whatever letter case it is written in. Any other word is
 * taken as it is.
 */
export function namedPaths(worktree, codebase) {
  const root = asSpelledOnDisk(worktree.elmRoot);
  return codebase.check.map((word) =>
    existsSync(resolve(worktree.elmRoot, word)) ? relative(root, asSpelledOnDisk(resolve(worktree.elmRoot, word))) : normalize(word)
  );
}

/** The modules of the project that the check command names as words of their own */
export function entryFiles(worktree, codebase, project) {
  const named = namedPaths(worktree, codebase);
  return project.map((source) => source.file).filter((file) => named.includes(file));
}

/**
 * Check that a fresh checkout of a codebase can be judged, and read what its
 * targets are taken from: the project, what the check command compiles, the
 * Elm files beside the project and which files are reached through a link.
 * The plan and the probe take their targets from what this returns.
 */
export async function surveyCheckout(worktree, codebase) {
  // A file that git ignores, generated code for one, can be changed by a build as well as by a session
  const committed = await committedFiles(worktree);
  const fresh = await stateOf(worktree, codebase);
  const before = writtenAt(worktree, committed);
  const start = await runCheck(worktree, codebase);
  if (!start.ok) {
    throw new Error(`${codebase.label}: on ${codebase.ref}, before any change, ${start.problem}`);
  }
  // What the check command writes into a file of the commit, a bundle that is checked in for
  // one, would count against a session that runs the command and not against one that does
  // not. Here, before any change, it may write the bytes that are there. After a session's
  // changes it writes others.
  const after = writtenAt(worktree, committed);
  const changed = new Set(await changedFiles(worktree, codebase, fresh));
  const rewritten = [...committed].filter((path) => changed.has(path) || after.get(path) !== before.get(path)).sort();
  if (rewritten.length > 0) {
    throw new Error(
      `${codebase.label}: "${shell(...codebase.check)}" writes ${plural(rewritten.length, "file", "files")} that the commit holds, ` +
        `${rewritten[0]}${rewritten.length > 1 ? " for one" : ""}. A session that ran it would be judged by what it wrote there, and one that did not would not. ` +
        // The compiler's cache has no other place, so a commit that holds it cannot be built without a change
        (rewritten.every((path) => path.split("/").includes("elm-stuff"))
          ? `The commit holds the compiler's cache. Benchmark a commit without elm-stuff.`
          : `Have it write where the repository holds nothing, as with --output=/dev/null.`)
    );
  }
  // An Elm source that the commit does not hold counts against a session as well, whatever it holds.
  // A generated module can hold a digest of another module, or what "git describe --dirty" prints,
  // and then a session's edits change it and nothing else does. A fresh checkout has no such file, so
  // the first build shows that it writes one. The changed files that the commit holds stopped the plan above.
  const generated = [...changed].filter((path) => path.endsWith(".elm"));
  if (generated.length > 0) {
    throw new Error(
      `${codebase.label}: "${shell(...codebase.check)}" writes ${plural(generated.length, "Elm file", "Elm files")} that the commit does not hold, ` +
        `${generated[0]}${generated.length > 1 ? " for one" : ""}. A session that ran it would be judged by what it wrote there, and one that did not would not. ` +
        `Commit what it generates, and leave the generator out of the check command.`
    );
  }
  // A session's builds come after the one that its checkout has before the session. A build can write
  // an Elm file on its second run alone, where the first one left something behind for it. Built a
  // second time, the unchanged project shows that, and quickly.
  const builtOnce = await stateOf(worktree, codebase);
  const again = await runCheck(worktree, codebase);
  if (!again.ok) {
    throw new Error(`${codebase.label}: on ${codebase.ref}, built a second time without a change, ${again.problem}`);
  }
  const regenerated = (await changedFiles(worktree, codebase, builtOnce)).filter((path) => path.endsWith(".elm"));
  if (regenerated.length > 0) {
    throw new Error(
      `${codebase.label}: "${shell(...codebase.check)}" writes ${plural(regenerated.length, "Elm file", "Elm files")} when it runs a second time without a change, ` +
        `${regenerated[0]}${regenerated.length > 1 ? " for one" : ""}. A session that ran it would be judged by what it wrote there, and one that did not would not. ` +
        `Have it write the same files each time.`
    );
  }

  const project = scanProject(worktree.elmRoot);
  const outside = filesOutside(worktree, project.map((source) => source.file));
  if (outside.length > 0) {
    throw new Error(
      `${codebase.label}: ${plural(outside.length, "source file lies", "source files lie")} outside the Elm project root, ${outside[0]}${outside.length > 1 ? " for one" : ""}: ` +
        `behind a link that leads out of it, or in a source directory that the commit's elm.json lists there. ` +
        `A session's edits there would count as changes beside the project, and outside the checkout they would be edits of your own files.`
    );
  }
  // What the check command builds decides what its verdict covers
  const entries = entryFiles(worktree, codebase, project);
  if (entries.length === 0) {
    throw new Error(
      `${codebase.label}: "${shell(...codebase.check)}" names no module of the project as a word of its own. ` +
        `Name each file it compiles as a word of the command, as in "elm make src/Main.elm", so the benchmark knows which modules the compiler reads. ` +
        `A file named inside a longer word, the script of "sh -c" for one, does not count.`
    );
  }
  const built = { entries, compiled: compiledFiles(project, entries) };
  const outsiders = scanOutsiders(worktree.elmRoot, project);
  // A source file can be a link to another place in the project. git names a change to it by
  // that place, where the verdict does not expect it.
  const behindLinks = new Set(filesThroughLinks(worktree, project.map((source) => source.file)));
  const isPlain = (target) => [target.file, ...target.affected].every((file) => !behindLinks.has(file));
  const keepsItsName = usesLamdera(worktree.elmRoot)
    ? (taskType, target) =>
        (taskType.id === "rename-module" && NAMED_BY_LAMDERA.includes(target.module)) ||
        (taskType.id === "rename-type" && target.module === "Types" && TYPES_NAMED_BY_LAMDERA.includes(target.name))
    : () => false;
  // A module that moves onto a file of the checkout writes over it. The scan passes over a file without
  // a module line, so the disk is asked. lstat finds a link whose end is gone as well, and where the
  // disk ignores letter case, a name that differs in case alone.
  const isFree = (target) => target.newFile === undefined || !lstatSync(join(worktree.elmRoot, target.newFile), { throwIfNoEntry: false });
  return {
    project,
    built,
    outsiders,
    isPlain,
    keepsItsName,
    isFree,
    // The modules that elm.json exposes, which a request to rename one of them names
    exposed: exposedModules(worktree.elmRoot),
  };
}

/**
 * The targets of a task type that pass every filter, most suitable first, with
 * what each filter left: the candidates, those that suit by size and build, those
 * that no Elm file outside the project can use, those that involve no file behind
 * a link, and those whose new path is free. The last list is the targets.
 */
export function targetsOf({ project, built, outsiders, isPlain, keepsItsName, isFree }, taskType, minFiles) {
  // Found once for the three uses below, since a large project takes seconds to search
  const candidates = taskType.candidates(project, built.entries);
  const suitable = suitableTargets(taskType, project, built, minFiles, candidates);
  const inSight = suitable.filter((target) => !usedOutside(target, outsiders));
  const plain = inSight.filter(isPlain);
  const free = plain.filter(isFree);
  const targets = free.filter((target) => !keepsItsName(taskType, target));
  return { candidates, suitable, inSight, plain, free, targets };
}

/**
 * Plan the tasks for one codebase in a checkout of its own, which `workDir` keeps track of.
 * Each task type gets one task per level that it finds a target for, see levels.mjs.
 * A task type without a suitable target in this codebase is left out and named in `skipped`,
 * with the file the check command does not compile that held back the most candidates, if any.
 * One that got some of the levels and not all is named in `short`.
 * @param {number[]} levels  Distinct, smallest first
 */
export async function planCodebase(codebase, { workDir, minFiles, levels }) {
  // One per codebase, so that a plan which is killed leaves each of its checkouts to be found again.
  // No label has a dot in it, so no session's slot has this name.
  const slot = join(workDir, `${codebase.label}.plan`);
  const worktree = await openCheckout(codebase, slot);
  try {
    const survey = await surveyCheckout(worktree, codebase);
    const { project, built, outsiders } = survey;
    const tasks = [];
    const skipped = [];
    const short = [];
    let usedByOutsiders = 0;
    let linked = 0;
    for (const taskType of TASK_TYPES) {
      const { candidates, suitable, inSight, plain, free, targets } = targetsOf(survey, taskType, minFiles);
      usedByOutsiders += suitable.length - inSight.length;
      linked += inSight.length - plain.length;
      // A target with a trial is built once, whichever level tries it
      const attempt = taskType.trial && ((target) => trialHolds(worktree, codebase, target, taskType.trial));
      const { picked, missing, unbroken, untried } = await pickLevels(targets, levels, { attempt, maxAttempts: MAX_ATTEMPTS });
      if (picked.length === 0) {
        // The most files that any candidate involves, or null without a candidate. With fewer than
        // --min-files asks for, that alone explains the gap.
        const largest = candidates.reduce((most, candidate) => Math.max(most ?? 0, candidate.size), null);
        // What each filter above took out of the candidates that would have suited
        const leftOut = {
          outside: suitable.length - inSight.length,
          linked: inSight.length - plain.length,
          occupied: plain.length - free.length,
          named: free.length - targets.length,
        };
        skipped.push({ type: taskType.id, heldBack: heldBack(taskType, project, built, minFiles, candidates), largest, unbroken, untried, leftOut });
        continue;
      }
      for (const { level, target } of picked) {
        tasks.push({
          id: `${codebase.label}/${taskType.id}/${level}`,
          codebase: codebase.label,
          type: taskType.id,
          // The number of files asked for, and the number the target involves
          level,
          files: target.size,
          // As a shell takes it, since the session runs it in one: an argument with a space keeps its quotes
          ...taskType.build(target, shell(...codebase.check), { exposed: survey.exposed }),
        });
      }
      if (missing.length > 0) {
        const largest = Math.max(...targets.map((target) => target.size));
        short.push({
          type: taskType.id,
          got: picked.map(({ level, target }) => ({ level, files: target.size })),
          missing,
          largest,
          // What keeps the larger candidates out of the plan, where it is the check command
          heldBack: heldBack(taskType, project, built, largest + 1, candidates),
        });
      }
    }

    return {
      codebase: {
        label: codebase.label,
        commit: worktree.commit,
        modules: project.length,
        compiled: built.compiled.size,
        // Elm files under the project root that are no part of the project, and the targets left out for their sake
        outsiders: outsiders.length,
        usedByOutsiders,
        // Targets left out because a file they involve is reached through a link
        linked,
        // What a run has to find unchanged in its config: the prompts name the check command,
        // and a build that takes longer than its limit counts as one that fails
        elmRoot: codebase.elmRoot,
        check: codebase.check,
        checkTimeoutMs: codebase.checkTimeoutMs,
        link: codebase.link,
        // The line breaks, which is what `wc -l` counts. A file that ends with one has no line behind it.
        lines: project.reduce((total, source) => total + source.text.split("\n").length - 1, 0),
      },
      tasks,
      skipped,
      short,
    };
  } finally {
    await closeCheckout(codebase, slot);
  }
}

/**
 * What plan prints of the task types of a codebase that got some of the
 * levels and not all: the levels each one got, with the files of their
 * targets, the levels it did not get, its largest target, and what keeps
 * larger candidates out where that is the check command.
 * @param {object[]} short  What planCodebase returns as `short`
 * @returns {string[]}
 */
export function shortfallLines(label, short) {
  return short.map(({ type, got, missing, largest, heldBack }) => {
    const levels = (count) => (count === 1 ? "the level" : "the levels");
    const gotten =
      `${got.length === 1 ? "a target" : "targets"} for ${levels(got.length)} ${listed(got.map(({ level }) => level))}, ` +
      `of ${listed(got.map(({ files }) => files))} ${got.length === 1 && got[0].files === 1 ? "file" : "files"}`;
    const notGotten = `none for ${levels(missing.length)} ${listed(missing.map(({ level }) => level))}`;
    const larger = heldBack
      ? ` ${plural(heldBack.candidates, "larger candidate involves", "larger candidates involve")} ${heldBack.file}, which the check command does not compile` +
        (heldBack.files > 1 ? `, and ${plural(heldBack.files - 1, "other such file holds", "other such files hold")} larger candidates back too` : "") +
        `. The entries command finds the modules that the check command can compile besides.`
      : "";
    // What the builds of the task type's trial said of the targets that a level tried in vain
    const { trial } = TASK_TYPES.find((taskType) => taskType.id === type);
    const unbroken = missing
      .filter((level) => level.unbroken > 0)
      .map(({ level, unbroken }) => ` For the level ${level}, ${trial.vain(triedTargets(unbroken))}.`)
      .join("");
    return `${label}: ${type} has ${gotten}, and ${notGotten}. Its largest target involves ${plural(largest, "file", "files")}.${larger}${unbroken}`;
  });
}
