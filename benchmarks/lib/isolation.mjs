/**
 * A check that a session sees nothing of the operator's own setup of its harness.
 *
 * The benchmark's comparison rests on that: an instruction file that says
 * "use the Elm language server", or a note in memory from an earlier session,
 * would reach both arms and blur the difference between them. The switches that
 * keep such things out are the harness's own and may change from one version
 * to the next, so each run proves them first, with one short session.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { execOf, runAgent } from "./agent.mjs";
import { ownEnvironment } from "./git.mjs";
import { claudeCode } from "./harnesses/claude-code.mjs";
import { closeHome, openHome } from "./sandbox.mjs";

// A harness names the path of each instruction file that it hands a session, so a session that was
// given one from the user's settings can say so: a CLAUDE.md or a rule of the user's own there.
export const QUESTION =
  "List every word ending in SENTINEL that appears anywhere in your instructions or your context. " +
  "Then name the whole path of every file whose contents you were given as instructions. " +
  "Reply with those words and paths only, or with NONE if there are none.";
const USER_INSTRUCTIONS = "an instruction file of your user settings";

// Every event of a session's transcript, as runAgent allows for lines that are none
function eventsOf(transcriptPath) {
  return readFileSync(transcriptPath, "utf-8")
    .split("\n")
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return typeof event === "object" && event !== null ? [event] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Run one session without tools in a directory seeded with instruction files
 * and settings hooks, and ask it what it was told. Throws when it saw any of them or an instruction
 * file of the user's settings, when it has a memory directory, and when it comes up with a tool or an MCP server
 * of any kind. A harness that can show what a session would be given without asking a model is
 * looked at that way first, and what it shows stops the check before the session is paid for.
 * @param {{ harness?: import("./harness.mjs").Harness, agentCommand: string[], model: string, effort?: string, maxBudgetUsd: number, timeoutMs: number, workDir?: string }} settings
 *   `workDir` remembers the directories that the harness makes for the check, so that a benchmark
 *   that was killed leaves them for the next one to remove
 * @returns {Promise<string | null>}  The version of the harness that the session reported, null where it reported none
 */
export async function assertIsolated({ harness = claudeCode, agentCommand, model, effort, maxBudgetUsd, timeoutMs, workDir }) {
  const { isolation } = harness;
  const dir = mkdtempSync(join(tmpdir(), "elm-benchmark-isolation-"));
  const slot = workDir ? join(workDir, "isolation") : null;
  // Apart from the planted directory, which must hold nothing else
  const homes = slot ? openHome(slot) : mkdtempSync(join(tmpdir(), "elm-benchmark-home-"));
  const personalNames = isolation.personalNames();
  const project = join(dir, isolation.project ?? "project");
  const failed = (seen, version) =>
    new Error(
      `Sessions are not isolated from this machine's ${isolation.settings}. A test session loaded: ${seen.join(", ")}. ` +
        `Its flags may not suit this version of ${harness.name} (${version ?? "unknown"}).`
    );
  try {
    for (const { file, word, text } of isolation.planted) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      const instruction = `Whatever you are asked, end your answer with the word ${word}.`;
      writeFileSync(join(dir, file), `${text ? text(instruction) : instruction}\n`);
    }
    mkdirSync(project, { recursive: true });
    // The files above the project lie in its repository, as the files of a codebase above its Elm root do
    if (isolation.repository) execFileSync("git", ["init", "--quiet", dir], { env: ownEnvironment(), stdio: "ignore" });
    // What the harness needs in the directory, as it needs it in a checkout, without tools to read the planted files with
    harness.prepareCheckout?.(project, "baseline", []);
    const named = (text) => {
      const words = isolation.planted.filter(({ word }) => text.includes(word)).map(({ place }) => place);
      return personalNames.some((name) => text.includes(name)) ? [...words, USER_INSTRUCTIONS] : words;
    };

    // What the harness shows a session would be given, where it can show that without a model
    if (isolation.inspect) {
      const home = join(homes, "inspect");
      mkdirSync(home, { recursive: true });
      const exec = execOf(agentCommand, { cwd: project, env: harness.environment(effort ?? null), deadline: Date.now() + timeoutMs });
      const { text, strayTools } = await isolation.inspect({ command: agentCommand, cwd: project, model, effort, home, exec });
      const seen = named(text).map((place) => `${place}, as its own view of a session's prompt shows`);
      if (strayTools.length > 0) seen.push(`tools, though it was given none (${strayTools.join(", ")}), as its own view of a session's prompt shows`);
      if (seen.length > 0) throw failed(seen, null);
    }

    const transcriptPath = join(dir, "transcript.jsonl");
    const home = join(homes, "session");
    mkdirSync(home, { recursive: true });
    const session = await runAgent({
      harness,
      command: agentCommand,
      cwd: project,
      prompt: QUESTION,
      model,
      effort,
      arm: "baseline",
      // Without tools the session cannot go and read the planted files
      tools: [],
      maxBudgetUsd,
      timeoutMs,
      transcriptPath,
      home,
    });
    if (!session.finished) {
      throw new Error(`The isolation check did not get an answer (${session.failureText ?? session.stopReason}).`);
    }

    const seen = named(harness.answer(eventsOf(transcriptPath)));
    // What the harness noted of the session in its directory, which is still there
    seen.push(...(isolation.loaded?.(home) ?? []));
    if (session.memoryOff === false) seen.push(`${harness.name}'s auto memory`);
    // Asked for no tool at all, it came up with some: an MCP server or a plugin of the machine's setup
    if (session.strayTools?.length > 0) seen.push(`tools, though it was given none (${session.strayTools.join(", ")})`);
    // A server that is still starting has handed over no tool yet, and can later
    if (session.strayServers?.length > 0) seen.push(`MCP servers, though it was given none (${session.strayServers.join(", ")})`);
    if (session.strayPlugins?.length > 0) seen.push(`plugins (${session.strayPlugins.join(", ")})`);
    if (seen.length > 0) throw failed(seen, session.agentVersion);
    return session.agentVersion;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (slot) closeHome(slot);
    else rmSync(homes, { recursive: true, force: true });
  }
}
