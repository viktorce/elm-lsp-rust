/**
 * Tests of benchmarks/lib/levels.mjs, which picks one target per level of a
 * task type, and of what plan prints of the levels a task type did not get.
 * The targets are made up, with sizes as three real codebases have them. They
 * start no process and read no clock.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LEVELS, pickLevels } from "../benchmarks/lib/levels.mjs";
import { shortfallLines } from "../benchmarks/lib/plan.mjs";

// Targets of these sizes, keyed in the order given
const targets = (sizes) => sizes.map((size, index) => ({ key: `t${String(index).padStart(3, "0")}`, size }));

// Every size from `from` down to `to`
const down = (from, to) => Array.from({ length: from - to + 1 }, (_, index) => from - index);

// The level and the size of each pick
const picks = async (sizes, levels = DEFAULT_LEVELS, options) =>
  (await pickLevels(targets(sizes), levels, options)).picked.map(({ level, target }) => [level, target.size]);

test("each level gets a target, smaller than the one above it", async () => {
  // A few large targets far above the rest: the top level takes the smallest that reaches it
  assert.deepEqual(await picks([220, 213, 211, 209, 209, 209, 57, 45, 39, 38, ...down(37, 10)]), [
    [10, 10],
    [50, 45],
    [100, 209],
  ]);
  // None reaches the top level, which takes the largest
  assert.deepEqual(await picks([90, 67, 51, 47, 40, 37, ...down(36, 10)]), [
    [10, 10],
    [50, 51],
    [100, 90],
  ]);
  assert.deepEqual(await picks([110, 34, 26, 22, 19, 18, 16, 14, 12, 10]), [
    [10, 10],
    [50, 34],
    [100, 110],
  ]);
  // The middle level's number is above the largest target, so it aims halfway between bottom and top by ratio
  assert.deepEqual(await picks([22, 21, 18, 15, 14, 12, 11, 11, 11, 10]), [
    [10, 10],
    [50, 15],
    [100, 22],
  ]);
  // Two sizes alone make two levels, whatever the plan asked for
  assert.deepEqual(await picks([7, 5, 5, 5, 5, 5]), [
    [10, 5],
    [100, 7],
  ]);
});

test("a level that would tell nothing beside its neighbour is left without a target", async () => {
  // 12 files lie much nearer to the bottom's 10 than to 50
  const near = await pickLevels(targets([10, 11, 12, 300]), DEFAULT_LEVELS);
  assert.deepEqual(near.picked.map(({ level, target }) => [level, target.size]), [
    [10, 10],
    [100, 300],
  ]);
  assert.deepEqual(near.missing, [{ level: 50, unbroken: 0 }]);
  // 95 files lie much nearer to the top's 101 than to 50
  assert.deepEqual(await picks([10, 95, 101]), [
    [10, 10],
    [100, 101],
  ]);
  // Targets that all lie above the top level leave room for that one alone
  assert.deepEqual(await picks([300, 200, 150, 120]), [[100, 120]]);
});

test("targets of the same size are taken in the order of their keys", async () => {
  const tied = [
    { key: "src/B.elm", size: 10 },
    { key: "src/A.elm", size: 10 },
    { key: "src/D.elm", size: 100 },
    { key: "src/C.elm", size: 100 },
    // As far from 50 as 45 is, and its key comes later
    { key: "src/F.elm", size: 55 },
    { key: "src/E.elm", size: 45 },
  ];
  const { picked } = await pickLevels(tied, DEFAULT_LEVELS);
  assert.deepEqual(
    picked.map(({ target }) => target.key),
    ["src/A.elm", "src/E.elm", "src/C.elm"]
  );
  // However the targets came in
  const again = await pickLevels([...tied].reverse(), DEFAULT_LEVELS);
  assert.deepEqual(again.picked, picked);
});

test("one level alone is the top level, and nothing at all leaves every level missing", async () => {
  assert.deepEqual(await picks([8, 30, 70, 400], [50]), [[50, 70]]);
  assert.deepEqual(await picks([8, 30], [50]), [[50, 30]]);
  const none = await pickLevels([], DEFAULT_LEVELS);
  assert.deepEqual(none, { picked: [], missing: DEFAULT_LEVELS.map((level) => ({ level, unbroken: 0 })), unbroken: 0, untried: 0 });
});

test("a target that has to prove itself is tried once, and each level goes on to the next one that fits", async () => {
  const tried = [];
  // The targets of 209 and 45 files break nothing, and the one of 12 cannot be tried
  const attempt = async (target) => {
    tried.push(target.size);
    return target.size === 209 || target.size === 45 ? false : target.size === 12 ? null : true;
  };
  const result = await pickLevels(targets([220, 209, 57, 45, 12, 10]), DEFAULT_LEVELS, { attempt, maxAttempts: 5 });
  assert.deepEqual(
    result.picked.map(({ level, target }) => [level, target.size]),
    [
      [10, 10],
      [50, 57],
      [100, 220],
    ]
  );
  assert.deepEqual(tried, [209, 220, 10, 45, 57]);
  assert.deepEqual([result.unbroken, result.untried], [2, 0]);

  // A level gives up after so many targets that break nothing. The top one here tries 209 and 220 in vain.
  const stubborn = await pickLevels(targets([220, 209, 57, 12, 10]), DEFAULT_LEVELS, {
    attempt: async (target) => (target.size > 100 ? false : target.size === 12 ? null : true),
    maxAttempts: 2,
  });
  assert.deepEqual(stubborn.missing, [{ level: 100, unbroken: 2 }]);
  // With no top target, the bottom one is the nearest to its number, and the middle one aims at its own
  assert.deepEqual(
    stubborn.picked.map(({ level, target }) => [level, target.size]),
    [
      [10, 10],
      [50, 57],
    ]
  );
  assert.deepEqual([stubborn.unbroken, stubborn.untried], [2, 0]);
});

test("plan says which levels a task type did not get, and what holds larger targets back", () => {
  const [held, unbroken] = shortfallLines("A", [
    {
      type: "rename-field",
      got: [
        { level: 10, files: 7 },
        { level: 100, files: 8 },
      ],
      missing: [{ level: 50, unbroken: 0 }],
      largest: 8,
      heldBack: { file: "src/Admin.elm", candidates: 2, files: 4 },
    },
    {
      type: "add-variant",
      got: [{ level: 10, files: 1 }],
      missing: [
        { level: 50, unbroken: 1 },
        { level: 100, unbroken: 5 },
      ],
      largest: 3,
      heldBack: null,
    },
  ]);
  assert.equal(
    held,
    "A: rename-field has targets for the levels 10 and 100, of 7 and 8 files, and none for the level 50. Its largest target involves 8 files. " +
      "2 larger candidates involve src/Admin.elm, which the check command does not compile, and 3 other such files hold larger candidates back too. " +
      "The entries command finds the modules that the check command can compile besides."
  );
  assert.equal(
    unbroken,
    "A: add-variant has a target for the level 10, of 1 file, and none for the levels 50 and 100. Its largest target involves 3 files. " +
      "For the level 50, the project still compiled with the change made to the one target that was tried, so there was no work to ask for. " +
      "For the level 100, the project still compiled with the change made to each of the 5 targets that were tried, so there was no work to ask for."
  );
});
