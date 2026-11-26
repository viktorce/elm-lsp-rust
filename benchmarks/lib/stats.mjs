/**
 * The statistics of the report: how much less one arm took than the other,
 * an interval around that from tasks drawn again, and the exact sign test of
 * whether one side solved tasks more often than chance would make it. Both
 * take the task as their unit, since the repetitions of a task are not
 * independent of each other. Nothing here reads a clock or Math.random, so
 * the same records always give the same page.
 */

// How many times the tasks are drawn again for an interval
export const DRAWS = 4000;

// Any fixed number will do. Another one gives other bounds, close to these.
export const SEED = 1;

// Below this many tasks, a draw of them again shows little of how a saving can vary: one task gives the same
// share in every draw, and a few give a handful of shares. Such a saving gets no interval.
export const MIN_TASKS = 10;

/**
 * Numbers in [0, 1) from a seed, the same ones on every machine. This is
 * mulberry32, which is short and passes the usual tests of such generators.
 */
export function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** The value below which a share `p` of the sorted values lie, read between the two nearest of them. */
export function quantile(sorted, p) {
  const at = (sorted.length - 1) * p;
  const below = Math.floor(at);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below);
}

/** How much less `withIt` is than `without`, in percent of `without`. Null where there is nothing to take a share of. */
export const savedPercent = (without, withIt) => (without === 0 ? null : (100 * (without - withIt)) / without);

/**
 * The 2.5th and the 97.5th percentile of the saving, over draws of as many
 * tasks as there are, with replacement. Each task is the sum of its sessions
 * in each arm, so the sessions of a task stay together, as they are not
 * independent of each other. Null for fewer than MIN_TASKS tasks, and where
 * a draw has nothing to take a share of, since its baseline took none: the
 * percentiles of the other draws would hide that draw.
 * @param {[number, number][]} tasks  Per task, the sum of the baseline's sessions and that of the lsp arm's
 */
export function savedInterval(tasks, { draws = DRAWS, seed = SEED } = {}) {
  if (tasks.length < MIN_TASKS) return null;
  const random = generator(seed);
  const shares = [];
  for (let draw = 0; draw < draws; draw++) {
    let [without, withIt] = [0, 0];
    for (let pick = 0; pick < tasks.length; pick++) {
      const [baseline, lsp] = tasks[Math.floor(random() * tasks.length)];
      without += baseline;
      withIt += lsp;
    }
    const share = savedPercent(without, withIt);
    if (share === null) return null;
    shares.push(share);
  }
  shares.sort((a, b) => a - b);
  return [quantile(shares, 0.025), quantile(shares, 0.975)];
}

// The logarithms of n! from 0 on, as far as a test has needed them
const logFactorials = [0];
function logFactorial(n) {
  for (let next = logFactorials.length; next <= n; next++) logFactorials.push(logFactorials[next - 1] + Math.log(next));
  return logFactorials[n];
}

const logChoose = (n, k) => logFactorial(n) - logFactorial(k) - logFactorial(n - k);

/**
 * The two-sided p-value of the exact sign test: how likely a split of
 * `first` and `second` or a more uneven one is, where each of those went to
 * either side by the toss of a fair coin.
 */
export function signP(first, second) {
  const n = first + second;
  let tail = 0;
  for (let k = 0; k <= Math.min(first, second); k++) tail += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/**
 * Which of two sides solved each task more often, and the sign test on that.
 * A task counts for the side that solved more of its rounds, and for neither
 * where both solved as many. The test does not depend on which repetition of
 * a task is set beside which, as a pairing of sessions would. Null for p
 * without tasks.
 * @param {[number, number][]} tasks  Per task, the rounds that each side solved of those that both did
 */
export function signTest(tasks) {
  const firstMore = tasks.filter(([first, second]) => first > second).length;
  const secondMore = tasks.filter(([first, second]) => first < second).length;
  return { firstMore, secondMore, tied: tasks.length - firstMore - secondMore, signP: tasks.length === 0 ? null : signP(firstMore, secondMore) };
}
