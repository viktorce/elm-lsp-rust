/**
 * Widening a check command. A target only counts where the check command
 * compiles every file that the change can break, so each module that the
 * command leaves out holds back every target that involves it. A module that
 * no other module imports is compiled only where the command names it. This
 * finds those modules that compile on their own, for the operator to add.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { shell } from "../../mcp-wrapper/harnesses.mjs";
import { compiledFiles, projectDirectories, scanProject } from "./elm-source.mjs";
import { entryFiles, namedPaths } from "./plan.mjs";
import { closeCheckout, openCheckout, runCheck } from "./sandbox.mjs";
import { plural } from "./tasks.mjs";

/**
 * The check command with `files` in place of the words that name its entry
 * files, where the first of those words stood.
 * @param {string[]} check
 * @param {boolean[]} isEntry  For each word, whether it names an entry file
 */
function withFiles(check, isEntry, files) {
  const first = isEntry.indexOf(true);
  return check.flatMap((word, index) => (index === first ? files : isEntry[index] ? [] : [word]));
}

/**
 * Find the modules of one codebase that its check command does not compile
 * and that no module imports, in a checkout of its own that `workDir` keeps
 * track of, as a plan's. Each one is built alone with the check command, in
 * place of its entry files, and the ones that compile are built once more
 * together with the entry files. `say` gets what the operator reads: the
 * counts, the verdict of that last build and the `check` to put in the config.
 * A module of the test directory is left out, since elm make cannot build it.
 * So is every module of a codebase whose check command names no module as a
 * word of its own: there is no word to put the modules beside.
 */
export async function widenCheck(codebase, { workDir, say }) {
  const { label, check } = codebase;
  // One per codebase, so that a run which is killed leaves each of its checkouts to be found again.
  // No label has a dot in it, so no session's or plan's slot has this name.
  const slot = join(workDir, `${label}.entries`);
  const worktree = await openCheckout(codebase, slot);
  try {
    const project = scanProject(worktree.elmRoot);
    const entries = entryFiles(worktree, codebase, project);
    if (entries.length === 0) {
      say(
        `${label}: "${shell(...check)}" names no module of the project as a word of its own, so its modules cannot be put beside it. ` +
          `Widen it by hand, or name each file it compiles as a word of the command, as in "elm make src/Main.elm", and run this again.`
      );
      return;
    }
    // The build before any change fills the compiler's cache, so each module after it builds quickly
    const start = await runCheck(worktree, codebase);
    if (!start.ok) {
      throw new Error(`${label}: on ${codebase.ref}, before any change, ${start.problem}`);
    }

    const compiled = compiledFiles(project, entries);
    // The test directory is the last of the project's directories. A module there that no source
    // directory holds as well is built by a test runner and not by elm make.
    const directories = projectDirectories(JSON.parse(readFileSync(join(worktree.elmRoot, "elm.json"), "utf-8")), worktree.elmRoot);
    // A directory of "." is the Elm root, which the path from the root to itself spells as ""
    const within = (file, directory) => directory === "" || file.startsWith(`${directory}/`);
    const isTest = (file) => within(file, directories.at(-1)) && !directories.slice(0, -1).some((directory) => within(file, directory));
    // A module that only tests import is no part of what elm make builds either
    const imported = new Set(project.filter((source) => !isTest(source.file)).flatMap((source) => source.imports));
    const unreached = project.filter((source) => !compiled.has(source.file) && !imported.has(source.module)).map((source) => source.file);
    const tests = unreached.filter(isTest);
    const candidates = unreached.filter((file) => !isTest(file));
    const testsLeftOut =
      tests.length > 0
        ? ` ${plural(tests.length, "module", "modules")} of ${directories.at(-1)} that nothing imports ${tests.length === 1 ? "is" : "are"} left out, since elm make does not build ${tests.length === 1 ? "it" : "them"}. ` +
          `A check command can build those with a test runner, as in "elm-test", beside elm make.`
        : "";
    const before = `${label}: the check command compiles ${compiled.size} of the ${plural(project.length, "module", "modules")}.`;
    if (candidates.length === 0) {
      say(`${before} Each module that it leaves out is imported by another one or lies in the test directory, so there is nothing to add.${testsLeftOut}`);
      return;
    }
    say(`${before} Building the ${plural(candidates.length, "module", "modules")} that nothing imports one at a time.`);

    const isEntry = namedPaths(worktree, codebase).map((path) => entries.includes(path));
    const kept = [];
    let timedOut = 0;
    for (const file of candidates) {
      const alone = await runCheck(worktree, { ...codebase, check: withFiles(check, isEntry, [file]) });
      if (alone.ok) kept.push(file);
      else if (alone.timedOut) timedOut++;
    }
    const failed = candidates.length - kept.length;
    const outOfTime = timedOut > 0 ? `, ${timedOut} of them because the build ran out of time` : "";
    const after = compiledFiles(project, [...entries, ...kept]).size;
    if (kept.length === 0) {
      say(`${label}: none of them compiles on its own${outOfTime}, so there is nothing to add.${testsLeftOut}`);
      return;
    }
    const failures = failed === 0 ? "Each of them compiles on its own" : `${failed} of them ${failed === 1 ? "does not compile on its own" : "do not compile on their own"}${outOfTime}`;
    say(
      `${label}: ${failures}. With ${failed === 0 ? "all of them" : `the other ${plural(kept.length, "module", "modules")}`} named, ` +
        `the check command compiles ${after} modules instead of ${compiled.size}.${testsLeftOut}`
    );

    // The files go beside the entry files, after the last word that names one
    const last = isEntry.lastIndexOf(true);
    const widened = [...check.slice(0, last + 1), ...kept, ...check.slice(last + 1)];
    const together = await runCheck(worktree, { ...codebase, check: widened });
    say(
      together.ok
        ? `${label}: the widened check command passes. Put it in the config in place of the one there: "check": ${JSON.stringify(widened)}`
        : `${label}: each of those modules compiles on its own, and named together ${together.problem.trimEnd()}\n` +
            `${label}: so the widened check command is not fit for the config. Name fewer of the modules. It was "check": ${JSON.stringify(widened)}`
    );
  } finally {
    await closeCheckout(codebase, slot);
  }
}
