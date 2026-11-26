/**
 * What the stand-ins for the Codex CLI and the Antigravity CLI share: the
 * work a session does in its checkout, the answer of the isolation check, the
 * version the executable names and the notes a test reads.
 *
 *   FAKE_AGENT                the mode, as each stand-in lists them
 *   FAKE_AGENT_VERSION        the version that `--version` names, none where it is unset
 *   FAKE_AGENT_VERSION_LATER  the version that every `--version` after the first names
 *   FAKE_AGENT_COUNT          a file where each `--version` notes itself, so that the first can be told
 *   FAKE_AGENT_VERSION_FAILS  makes every `--version` after the first fail, as an executable that broke in the middle of a run
 *   FAKE_AGENT_STARTED        a file where each session notes its arguments and its environment
 *   FAKE_AGENT_NAMED          a path that the isolation check's session names in the mode "named"
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export const mode = process.env.FAKE_AGENT;

// No test lets a session work this long
export const selfDestruct = () => setTimeout(() => process.exit(1), 120000).unref();

// How many times `--version` was asked before, where a test counts them
function earlier() {
  if (!process.env.FAKE_AGENT_COUNT) return 0;
  const times = existsSync(process.env.FAKE_AGENT_COUNT) ? readFileSync(process.env.FAKE_AGENT_COUNT, "utf-8").length : 0;
  appendFileSync(process.env.FAKE_AGENT_COUNT, "x");
  return times;
}

/**
 * Answer `--version` with `line` around the version that the test names, the later one from the
 * second time on, or fail from the second time on where the test says so
 */
export function answerVersion(line) {
  const later = earlier() > 0;
  if (later && process.env.FAKE_AGENT_VERSION_FAILS) {
    console.error("dyld: Library not loaded");
    process.exit(134);
  }
  console.log(line((later && process.env.FAKE_AGENT_VERSION_LATER) || process.env.FAKE_AGENT_VERSION || null));
  process.exit(0);
}

export function note(fields) {
  if (process.env.FAKE_AGENT_STARTED) appendFileSync(process.env.FAKE_AGENT_STARTED, `${JSON.stringify({ ...fields, variables: Object.keys(process.env).sort() })}\n`);
}

function elmFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? elmFiles(join(dir, entry.name)) : entry.name.endsWith(".elm") ? [join(dir, entry.name)] : []
  );
}

// The isolation check asks which planted words the session can see
export const isIsolationCheck = (prompt) => prompt.includes("SENTINEL");

/**
 * Do in the working directory what the mode says, or `how` where a stand-in's mode solves in a way of
 * its own: "solve" carries out a "Rename the function `a` ... to `b`" prompt with a text replace,
 * "break" leaves a file the stand-in compiler rejects.
 */
export function work(prompt, how = mode) {
  if (how === "solve") {
    const [, from, to] = /Rename the function `(\w+)`[^]*? to `(\w+)`/.exec(prompt);
    for (const file of elmFiles("src")) writeFileSync(file, readFileSync(file, "utf-8").replaceAll(new RegExp(`\\b${from}\\b`, "g"), to));
  } else if (how === "break") {
    writeFileSync("src/Main.elm", `${readFileSync("src/Main.elm", "utf-8")}\n-- BROKEN\n`);
  }
}

// What a session that loaded every file of instructions from its directory up to the root of its
// repository would have been told, and the words of the files that the harness made for it besides
function planted(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === ".git" ? [] : planted(path);
    return statSync(path).size < 100000 ? (readFileSync(path, "utf-8").match(/\w+SENTINEL/g) ?? []) : [];
  });
}
export function plantedAbove(dir = process.cwd()) {
  const top = (from) => (existsSync(join(from, ".git")) || dirname(from) === from ? from : top(dirname(from)));
  return planted(top(dir));
}

// The answer of the isolation check's session, by the mode: what it saw, or NONE
export function isolationAnswer(prompt, personal) {
  const askedForPaths = prompt.includes("path");
  return (
    {
      nosy: () => plantedAbove().join(" "),
      personal: () => (askedForPaths ? personal : "NONE"),
      named: () => (askedForPaths ? process.env.FAKE_AGENT_NAMED : "NONE"),
    }[mode]?.() ?? "NONE"
  );
}

// Waits for the signal that Ctrl-C sends, as a harness that works on until told to stop
export const interrupted = () =>
  new Promise((resolve) => {
    const busy = setInterval(() => {}, 1000);
    process.once("SIGINT", () => {
      clearInterval(busy);
      resolve();
    });
  });
