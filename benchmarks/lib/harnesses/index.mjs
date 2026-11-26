/**
 * The harnesses that `run --harness` can start a session in, by their ids.
 * Claude Code is the one a run takes when it names none, and the one that
 * the records of a run made before there was a choice were made in.
 */

import { antigravity } from "./antigravity.mjs";
import { claudeCode } from "./claude-code.mjs";
import { codex } from "./codex.mjs";

export const HARNESSES = Object.fromEntries([claudeCode, codex, antigravity].map((harness) => [harness.id, harness]));

export const DEFAULT_HARNESS = claudeCode;

// The id of the harness of a record or a run.json, which names none where it was made before there was a choice
export const harnessIdOf = (id) => id ?? DEFAULT_HARNESS.id;

// The harness of a record or a run.json, or null where its id is none that this benchmark knows
export const harnessOf = (id) => HARNESSES[harnessIdOf(id)] ?? null;
