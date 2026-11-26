/**
 * Levels: how many files the target of a task involves. A plan asks for a few
 * of them, and each task type gets one target per level in each codebase, so
 * a run shows how each arm fares as a change touches more files.
 */

/** The levels of a plan that is given no --levels */
export const DEFAULT_LEVELS = [10, 50, 100];

// How far apart two sizes lie by their ratio, so 10 files and 20 lie as far apart as 50 and 100
const apart = (a, b) => Math.abs(Math.log(a / b));

// Compared by code unit, so the plan does not depend on the machine's locale
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const nearestTo = (aim) => (a, b) => Math.abs(a.size - aim) - Math.abs(b.size - aim) || byKey(a, b);

// The top level's order: the targets that reach the level, smallest first, then the others, largest first
const forTop = (level) => (a, b) => {
  const [aReaches, bReaches] = [a.size >= level, b.size >= level];
  if (aReaches !== bReaches) return aReaches ? -1 : 1;
  return (aReaches ? a.size - b.size : b.size - a.size) || byKey(a, b);
};

/**
 * Pick one target per level. Each level's target involves fewer files than
 * the target of the level above it and more than the one of the level below,
 * and a level that cannot get such a target is left without one.
 *
 * The top level takes the smallest target that reaches it, or the largest
 * one where none does. The bottom level takes the target nearest to it. A
 * level between them aims at its own number where that is below the top
 * target's size. Where it is not, the aim is spaced by ratio between the
 * sizes of the bottom target and the top one, by the level's place among the
 * levels. A level between them also takes no target that lies nearer, by
 * ratio, to a neighbour's target than to its own aim: a level of 12 files
 * beside one of 10 tells nothing that the one of 10 does not.
 *
 * The top level is settled first, then the bottom one, whose size the spaced
 * aims need, then the levels between them from the top down.
 *
 * @template {{ key: string, size: number }} T
 * @param {T[]} targets  The targets that suit, in any order
 * @param {number[]} levels  Distinct, smallest first. With one alone, that one is the top level.
 * @param {object} [options]
 * @param {(target: T) => Promise<boolean | null>} [options.attempt]  Whether a target counts:
 *   true when it does, false when it was tried in vain, null when it cannot be tried. Each target
 *   is tried once, whichever level asks.
 * @param {number} [options.maxAttempts]  How many targets a level tries in vain before it gives up
 * @returns {Promise<{ picked: { level: number, target: T }[], missing: { level: number, unbroken: number }[], unbroken: number, untried: number }>}
 *   `picked` and `missing` smallest level first. `unbroken` and `untried` count the targets that were
 *   tried in vain and that could not be tried, over every level.
 */
export async function pickLevels(targets, levels, { attempt = async () => true, maxAttempts = Infinity } = {}) {
  const tried = new Map();
  const counts = async (target) => {
    if (!tried.has(target.key)) tried.set(target.key, await attempt(target));
    return tried.get(target.key);
  };
  const settled = new Map();
  const missing = new Map();
  // The first target in that order which fits and counts, where a level gets one
  const settle = async (level, order, fits) => {
    let unbroken = 0;
    for (const target of [...targets].sort(order).filter(fits)) {
      const result = await counts(target);
      if (result) {
        settled.set(level, target);
        return;
      }
      if (result === false && ++unbroken === maxAttempts) break;
    }
    missing.set(level, unbroken);
  };

  const [bottom, top] = [levels[0], levels.at(-1)];
  await settle(top, forTop(top), () => true);
  const topTarget = settled.get(top);
  if (levels.length > 1) {
    await settle(bottom, nearestTo(bottom), (target) => !topTarget || target.size < topTarget.size);
  }
  const bottomTarget = levels.length > 1 ? settled.get(bottom) : undefined;
  for (let index = levels.length - 2; index > 0; index--) {
    const level = levels[index];
    // The nearest level above that got a target
    const above = levels.slice(index + 1).map((other) => settled.get(other)).find(Boolean);
    // A bottom level that got no target leaves its number to space the aims from
    const low = bottomTarget?.size ?? bottom;
    const aim =
      topTarget && level >= topTarget.size ? low * (topTarget.size / low) ** (index / (levels.length - 1)) : level;
    await settle(level, nearestTo(aim), (target) => {
      const nearer = (neighbour) => !neighbour || apart(target.size, aim) < apart(target.size, neighbour.size);
      return (!above || target.size < above.size) && (!bottomTarget || target.size > bottomTarget.size) && nearer(above) && nearer(bottomTarget);
    });
  }

  const values = [...tried.values()];
  return {
    picked: levels.filter((level) => settled.has(level)).map((level) => ({ level, target: settled.get(level) })),
    missing: levels.filter((level) => missing.has(level)).map((level) => ({ level, unbroken: missing.get(level) })),
    unbroken: values.filter((result) => result === false).length,
    untried: values.filter((result) => result === null).length,
  };
}
