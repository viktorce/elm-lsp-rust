/**
 * The report: run records condensed into a summary, and the summary drawn as
 * one self-contained HTML page.
 *
 * The summary holds counts and measurements only. Prompts, file names and
 * symbols of the benchmarked codebases stay in the plan and the run records.
 */

import { ARMS } from "./arms.mjs";
import { harnessIdOf, harnessOf } from "./harnesses/index.mjs";
import { plural, TASK_TYPES } from "./tasks.mjs";

function median(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const totalToolCalls = (record) => Object.values(record.toolCalls).reduce((total, count) => total + count, 0);

// The ways a session can end, best first. A failed session is told apart by what stopped it:
// the limits are the operator's and say something about the arm, an error says little. A limit
// of money holds a harness that reports a cost, and one of tokens a harness that counts them as a
// session goes.
const ENDINGS = [
  { id: "passed", title: "Solved" },
  { id: "wrong-result", title: "Wrong result" },
  { id: "does-not-compile", title: "Does not compile" },
  { id: "time-limit", title: "Out of time" },
  { id: "budget-limit", title: "Out of budget", limit: "reportsCost" },
  { id: "token-limit", title: "Out of tokens", limit: "countsTokens" },
  { id: "error", title: "Session error" },
  { id: "server-failed", title: "Server did not start" },
];

// The endings that the sessions of a harness can come to: a limit only where the harness can be held to it
const endingsOf = (harness) => ENDINGS.filter(({ limit }) => limit === undefined || harness[limit]);

// The endings that a summary counts, as the harness of its sessions has them
const endingsIn = (summary) => ENDINGS.filter(({ id }) => id in summary.overall[summary.arms[0].id].endings);

// Tokens in place of a cost, for the sessions of a harness that reports none
const TOKENS = ["inputTokens", "cacheReadInputTokens", "outputTokens"];

const endingOf = (record) => (record.outcome === "agent-failed" ? record.failure : record.outcome);

// A record of a run made before plans had levels has none
const levelOf = (record) => record.level ?? null;

// The figures of a group of runs. Medians cover every session of the group that has the figure, solved or not.
function measure(records, harness) {
  const costReported = harness.reportsCost;
  return {
    sessions: records.length,
    solved: records.filter((record) => record.outcome === "passed").length,
    endings: Object.fromEntries(endingsOf(harness).map(({ id }) => [id, records.filter((record) => endingOf(record) === id).length])),
    // A session that was killed reports no cost
    withoutCost: records.filter((record) => record.costUsd === null).length,
    costUsd: median(records.map((record) => record.costUsd)),
    ...(costReported
      ? {}
      : {
          // Nor do tokens, where its harness counts them only at the end of a turn
          withoutTokens: records.filter((record) => (record.inputTokens ?? null) === null).length,
          ...Object.fromEntries(TOKENS.map((figure) => [figure, median(records.map((record) => record[figure] ?? null))])),
        }),
    wallMs: median(records.map((record) => record.wallMs)),
    turns: median(records.map((record) => record.turns)),
    toolCalls: median(records.map(totalToolCalls)),
  };
}

/**
 * @param {object} plan     What the plan command wrote
 * @param {object[]} records  One per session, as executeRun returns them
 * @param {string[]} [arms]   The arms that were asked for. Without it, the ones that have a record.
 */
export function summarize(plan, allRecords, arms) {
  // Sessions of two harnesses or two models would sit in the same rounds and be compared as one arm
  const ids = [...new Set(allRecords.map((record) => harnessIdOf(record.harness)))];
  const unknown = ids.filter((id) => harnessOf(id) === null);
  if (unknown.length > 0) throw new Error(`The records name a harness that this benchmark does not know: ${unknown.join(", ")}. Report them with the benchmark that ran them.`);
  if (ids.length > 1) {
    throw new Error(`The records are of sessions in ${ids.map((id) => harnessOf(id).name).join(" and ")}. A report shows one run: give each harness an --out of its own, and report each one.`);
  }
  const models = [...new Set(allRecords.map((record) => record.model))];
  if (models.length > 1) throw new Error(`The records are of sessions with ${models.join(" and ")}. A report shows one run: give each model an --out of its own, and report each one.`);
  // An arm that was asked for and has no session yet still has every round waiting for it
  const armIds = Object.keys(ARMS).filter((arm) => (arms ? arms.includes(arm) : allRecords.some((record) => record.arm === arm)));
  // The arms are compared on the same work: a round of a task counts once every arm has done it
  const round = (record) => `${record.task} #${record.repetition}`;
  const complete = (key) => armIds.every((arm) => allRecords.some((record) => record.arm === arm && round(record) === key));
  const records = allRecords.filter((record) => complete(round(record)));
  // A record of a run made before there was a choice of harness names none, and ran in Claude Code
  const harness = harnessOf(ids[0]);
  const costReported = harness.reportsCost;
  const perArm = (subset) =>
    Object.fromEntries(armIds.map((arm) => [arm, measure(subset.filter((record) => record.arm === arm), harness)]));
  // The files that the target of each codebase involves, in the order of the plan's codebases
  const targetsOf = (subset) =>
    plan.codebases
      .filter(({ label }) => subset.some((record) => record.codebase === label))
      .map(({ label }) => ({ codebase: label, files: subset.find((record) => record.codebase === label).files ?? null }));
  // One group per level that a task type has, smallest first
  const perLevel = (subset) =>
    [...new Set(subset.map(levelOf))]
      .sort((a, b) => a - b)
      .map((level) => {
        const atLevel = subset.filter((record) => levelOf(record) === level);
        return { level, targets: targetsOf(atLevel), ...perArm(atLevel) };
      });

  return {
    // A page shows one run, and so one harness. Two are two output directories.
    harness: harness.name,
    // The built-in tools that both arms had
    tools: harness.tools,
    // False where the sessions reported tokens and no cost, and the page shows those
    costReported,
    // Whether the harness reports these, which the page shows as missing otherwise
    turnsReported: harness.reportsTurns === true,
    retriesReported: harness.reportsRetries === true,
    model: models.join(", "),
    // Null for the sessions that ran at the effort their harness picks for the model
    efforts: [...new Set(allRecords.map((record) => record.effort ?? null))],
    // Sessions whose round of a task another arm has not done yet. They are in no figure.
    unpaired: allRecords.length - records.length,
    // Empty when the sessions never reported one, as a stand-in agent's do not
    agentVersions: [...new Set(allRecords.map((record) => record.agentVersion).filter(Boolean))].sort(),
    // Every record names the server its run was started with. Only this arm's sessions had it.
    languageServers: [...new Set(allRecords.filter((record) => record.arm === "lsp").map((record) => record.languageServer).filter(Boolean))].sort(),
    // The ones with a result. A run can be limited to one codebase of the plan with --only.
    codebases: plan.codebases
      .filter(({ label }) => records.some((record) => record.codebase === label))
      .map(({ label, modules, lines }) => ({ label, modules, lines })),
    arms: armIds.map((id) => ({ id, title: ARMS[id].title })),
    overall: perArm(records),
    taskTypes: TASK_TYPES.filter((type) => records.some((record) => record.type === type.id)).map((type) => {
      const ofType = records.filter((record) => record.type === type.id);
      return { id: type.id, title: type.title, ...perArm(ofType), levels: perLevel(ofType) };
    }),
    runs: records.map((record) => ({
      codebase: record.codebase,
      type: record.type,
      level: levelOf(record),
      files: record.files ?? null,
      arm: record.arm,
      repetition: record.repetition,
      outcome: record.outcome,
      ending: endingOf(record),
      wallMs: record.wallMs,
      costUsd: record.costUsd,
      ...(costReported ? {} : Object.fromEntries(TOKENS.map((figure) => [figure, record[figure] ?? null]))),
      turns: record.turns,
      toolCalls: totalToolCalls(record),
      lspCalls: record.lspCalls,
      changedFiles: record.changedFiles,
      apiRetries: record.apiRetries,
    })),
  };
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// Shown where a session produced no figure, for example no cost because it never started
const MISSING = "n/a";

// "1 session", "2 sessions"
const count = (number, noun) => plural(number, noun, `${noun}s`);

const FORMAT = {
  solved: (group) => `${group.solved} of ${group.sessions}`,
  cost: (usd) => (usd === null ? MISSING : `$${usd.toFixed(2)}`),
  time(ms) {
    if (ms === null) return MISSING;
    // Rounded to whole seconds first, so 119.6 s reads "2 min 0 s" and not "1 min 60 s"
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  },
  count: (value) => (value === null ? MISSING : String(Math.round(value))),
  tokens: (value) => (value === null || value === undefined ? MISSING : Math.round(value).toLocaleString("en-US")),
};

// What a session spent, as its harness reports it: a cost, or tokens where it reports none
const spent = (group, costReported) =>
  costReported ? FORMAT.cost(group.costUsd) : `${FORMAT.tokens(group.inputTokens)} in, ${FORMAT.tokens(group.cacheReadInputTokens)} cached, ${FORMAT.tokens(group.outputTokens)} out`;

// Row labels of the charts, which have less room than the table
const SHORT_TITLE = {
  "rename-function": "Rename function",
  "rename-shared-function": "Rename function, shared name",
  "rename-variant": "Rename variant",
  "rename-field": "Rename field, shared name",
  "rename-module": "Rename module",
  "add-variant": "Add variant",
  "rename-type": "Rename type",
  "move-function": "Move function",
  "remove-variant": "Remove variant",
  "remove-field": "Remove field",
};

const ENDING_TITLE = Object.fromEntries(ENDINGS.map(({ id, title }) => [id, title]));

// Colors and chrome follow the reference palette of the data-viz method: two
// categorical slots, text in ink tokens, hairline grid, one value axis per chart.
const STYLE = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --arm-baseline: #2a78d6; --arm-lsp: #eb6834;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --arm-baseline: #3987e5; --arm-lsp: #d95926;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --arm-baseline: #3987e5; --arm-lsp: #d95926;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px 48px; background: var(--page); color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; }
h1 { font-size: 24px; line-height: 1.2; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 0 0 2px; }
p { margin: 0; }
.lede, .note, figcaption { color: var(--ink-2); }
.legend { display: flex; flex-wrap: wrap; gap: 20px; margin: 18px 0 14px; color: var(--ink-2); }
.key { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 7px; vertical-align: -1px; }
.key.baseline { background: var(--arm-baseline); }
.key.lsp { background: var(--arm-lsp); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.tile .label { color: var(--ink-2); margin-bottom: 8px; }
.tile .row { display: flex; align-items: baseline; gap: 8px; }
.tile .value { font-size: 26px; font-weight: 600; line-height: 1.25; }
.tile .key { align-self: center; margin-right: 0; }
figure { margin: 12px 0 0; overflow-x: auto; }
figcaption { margin-bottom: 14px; }
svg { display: block; width: 100%; min-width: 860px; height: auto; }
svg text { fill: var(--ink-2); font-size: 12px; }
svg .category { fill: var(--ink); }
svg .panel { fill: var(--ink); font-weight: 600; }
svg .tick { fill: var(--muted); font-variant-numeric: tabular-nums; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--axis); stroke-width: 1; }
svg .bar.baseline { fill: var(--arm-baseline); }
svg .bar.lsp { fill: var(--arm-lsp); }
svg .hit { fill: transparent; }
svg .hit:hover + .bar, svg .hit:focus + .bar { opacity: 0.8; }
svg .hit:focus { outline: none; }
.table-card { margin-top: 12px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { color: var(--ink-2); font-weight: 500; }
td.number, th.number { text-align: right; padding-right: 0; padding-left: 12px; }
tr:last-child td { border-bottom: 0; }
.note { margin-top: 14px; max-width: 80ch; }
.levels { display: grid; gap: 12px; margin-top: 12px; }
.levels .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px 24px; margin: 12px 0 4px; }
.levels figure { margin: 0; }
.levels h3 { font-size: 13px; font-weight: 500; color: var(--ink-2); margin: 0 0 4px; }
svg.line { min-width: 0; max-width: 560px; }
svg .trend { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .trend.baseline { stroke: var(--arm-baseline); }
svg .trend.lsp { stroke: var(--arm-lsp); }
svg .dot { stroke: var(--surface); stroke-width: 2; }
svg .dot.baseline { fill: var(--arm-baseline); }
svg .dot.lsp { fill: var(--arm-lsp); }
svg .hit:hover + .dot, svg .hit:focus + .dot { opacity: 0.8; }
.levels td { border-bottom: 0; }
.levels tr.level td { border-top: 1px solid var(--grid); }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--surface); padding: 6px 9px;
  border-radius: 6px; font-size: 12px; white-space: nowrap; opacity: 0; transform: translate(-50%, -130%); }
`;

// The page follows the system's light or dark setting. "?theme=light" or
// "?theme=dark" in the address pins one, for screenshots. One tooltip serves
// every mark, on hover and on keyboard focus.
const SCRIPT = `
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
const tip = document.getElementById("tip");
function show(target, x, y) {
  tip.textContent = target.dataset.tip;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
  tip.style.opacity = 1;
}
for (const mark of document.querySelectorAll("[data-tip]")) {
  mark.addEventListener("pointermove", (event) => show(mark, event.clientX, event.clientY));
  mark.addEventListener("pointerleave", () => (tip.style.opacity = 0));
  mark.addEventListener("focus", () => {
    const box = mark.getBoundingClientRect();
    show(mark, box.right, box.top + box.height / 2);
  });
  mark.addEventListener("blur", () => (tip.style.opacity = 0));
}
`;

const legend = (arms) =>
  `<div class="legend">${arms.map((arm) => `<span><span class="key ${arm.id}"></span>${escapeHtml(arm.title)}</span>`).join("")}</div>`;

function tile(label, arms, groups, format) {
  const rows = arms
    .map((arm) => `<div class="row"><span class="key ${arm.id}"></span><span class="value">${escapeHtml(format(groups[arm.id]))}</span></div>`)
    .join("");
  return `<div class="card tile"><div class="label">${escapeHtml(label)}</div>${rows}</div>`;
}

// A round number at or above `max` that splits into four even steps.
function axisEnd(max) {
  const step = 10 ** Math.floor(Math.log10(max / 4 || 1));
  const nice = [1, 2, 2.5, 5, 10].map((factor) => factor * step).find((candidate) => candidate * 4 >= max);
  return nice * 4;
}

// The three measures drawn per task type. Each panel has its own value axis.
const PANELS = [
  {
    title: "Solved",
    value: (group) => group.solved,
    label: FORMAT.solved,
    tick: String,
    // The axis ends at the number of sessions, so a full bar means every session solved its task
    end: (groups) => Math.max(...groups.map((group) => group.sessions)),
    // Whole sessions only: at most four steps, each a whole number
    ticks: (end) => Array.from({ length: Math.floor(end / Math.ceil(end / 3)) + 1 }, (_, step) => step * Math.ceil(end / 3)),
  },
  {
    title: "Median cost",
    cost: true,
    value: (group) => group.costUsd,
    label: (group) => FORMAT.cost(group.costUsd),
    // Cents are too coarse for an axis that ends below ten of them
    tick: (amount, end) => `$${amount.toFixed(end <= 0.1 ? 3 : 2)}`,
  },
  {
    // In place of the cost, for a harness that reports none. The input dominates what a session spends.
    title: "Median input tokens",
    tokens: true,
    value: (group) => group.inputTokens ?? null,
    label: (group) => FORMAT.tokens(group.inputTokens),
    tick: (amount) => FORMAT.tokens(amount),
  },
  {
    title: "Median time",
    label: (group) => FORMAT.time(group.wallMs),
    // Seconds read well up to a couple of minutes. Beyond that the axis counts minutes, as the labels at the bars do.
    fitted(groups) {
      const [unit, name] = Math.max(...groups.map((group) => group.wallMs ?? 0)) >= 120000 ? [60000, "min"] : [1000, "s"];
      return {
        ...this,
        value: (group) => (group.wallMs === null ? null : group.wallMs / unit),
        tick: (amount) => `${Number(amount.toFixed(1))} ${name}`,
      };
    },
  },
];

// The panels of a run: the cost where its harness reports one, and the tokens where it does not
const panelsOf = (costReported) => PANELS.filter((panel) => (panel.cost ? costReported : panel.tokens ? !costReported : true));

// Layout of the task chart, in SVG user units, which are CSS pixels at full width
const CHART = { width: 1080, labels: 210, panelGap: 28, valueRoom: 76, header: 30, barHeight: 14, barGap: 2, groupGap: 16, footer: 22 };

/**
 * Horizontal bars per task type, one bar per arm, in one panel per measure.
 * The panels share the row labels, and every bar has its value printed at its tip.
 */
function taskChart(summary) {
  const { arms, taskTypes } = summary;
  const { width, labels, panelGap, valueRoom, header, barHeight, barGap, groupGap, footer } = CHART;
  const shown = panelsOf(summary.costReported);
  const panelWidth = (width - labels - panelGap * (shown.length - 1)) / shown.length;
  const plot = panelWidth - valueRoom;
  const groupHeight = arms.length * (barHeight + barGap) - barGap + groupGap;
  const bottom = header + taskTypes.length * groupHeight - groupGap;
  const rowY = (index) => header + index * groupHeight;

  const rowLabels = taskTypes
    .map((type, index) => {
      const middle = rowY(index) + (groupHeight - groupGap) / 2 + 4;
      return `<text class="category" x="${labels - 14}" y="${middle}" text-anchor="end">${escapeHtml(SHORT_TITLE[type.id] ?? type.title)}</text>`;
    })
    .join("");

  const panels = shown.map((unfitted, panelIndex) => {
    const left = labels + panelIndex * (panelWidth + panelGap);
    const groups = taskTypes.flatMap((type) => arms.map((arm) => type[arm.id]));
    const panel = unfitted.fitted?.(groups) ?? unfitted;
    const axis = panel.end?.(groups) ?? axisEnd(Math.max(...groups.map((group) => panel.value(group) ?? 0), Number.MIN_VALUE));
    const x = (amount) => (amount / axis) * plot;

    const ticks = panel.ticks?.(axis) ?? [0, 1, 2, 3, 4].map((step) => (axis * step) / 4);
    const grid = ticks
      .map(
        (amount) =>
          `<line class="${amount === 0 ? "axis" : "grid"}" x1="${left + x(amount)}" x2="${left + x(amount)}" y1="${header - 6}" y2="${bottom + 6}"/>` +
          `<text class="tick" x="${left + x(amount)}" y="${bottom + footer}" text-anchor="middle">${escapeHtml(panel.tick(amount, axis))}</text>`
      )
      .join("");

    const bars = taskTypes
      .map((type, index) =>
        arms
          .map((arm, position) => {
            const group = type[arm.id];
            const length = x(panel.value(group) ?? 0);
            const y = rowY(index) + position * (barHeight + barGap);
            const text = panel.label(group);
            // Square at the baseline, rounded at the data end
            const radius = Math.min(4, length);
            const shape = `M${left},${y} h${length - radius} a${radius},${radius} 0 0 1 ${radius},${radius} v${barHeight - 2 * radius} a${radius},${radius} 0 0 1 -${radius},${radius} h-${length - radius} z`;
            const tip = `${type.title} · ${arm.title} · ${panel.title}: ${text} (${count(group.sessions, "session")})`;
            return (
              `<rect class="hit" tabindex="0" x="${left}" y="${y - barGap / 2}" width="${panelWidth}" height="${barHeight + barGap}" data-tip="${escapeHtml(tip)}"/>` +
              `<path class="bar ${arm.id}" d="${shape}"/>` +
              `<text x="${left + length + 6}" y="${y + barHeight - 3}">${escapeHtml(text)}</text>`
            );
          })
          .join("")
      )
      .join("");

    return `<text class="panel" x="${left}" y="12">${escapeHtml(panel.title)}</text>${grid}${bars}`;
  }).join("");

  // A session that had to be killed reports no cost, and it is likely the arm's most expensive one
  const costless = arms
    .filter((arm) => summary.overall[arm.id].withoutCost > 0)
    .map((arm) => `${count(summary.overall[arm.id].withoutCost, "session")} ${arm.title.toLowerCase()}`);
  // And one that the harness counts only at the end of a turn has no tokens either, when it did not get there
  const tokenless = arms
    .filter((arm) => summary.overall[arm.id].withoutTokens > 0)
    .map((arm) => `${count(summary.overall[arm.id].withoutTokens, "session")} ${arm.title.toLowerCase()}`);
  const caption =
    "Each kind of task across all codebases. Medians include the sessions that did not solve their task." +
    (!summary.costReported
      ? ` ${summary.harness} reports no cost, so the page shows tokens in its place.` +
        (tokenless.length > 0 ? ` Ended before ${summary.harness} counted their tokens, and left out of the token medians: ${tokenless.join(", ")}.` : "")
      : costless.length > 0
        ? ` Ended without reporting a cost, and left out of the cost medians: ${costless.join(", ")}.`
        : "");
  return (
    `<figure class="card chart"><h2>By kind of task</h2><figcaption>${caption}</figcaption>` +
    `<svg viewBox="0 0 ${width} ${bottom + footer + 6}" role="img" aria-label="Tasks solved, ${shown[1].title.toLowerCase()} and median time per kind of task and arm. The table below has every session.">` +
    `${rowLabels}${panels}</svg></figure>`
  );
}

// Layout of a chart against level, in SVG user units
const LINE_CHART = { width: 560, height: 200, left: 64, right: 84, top: 14, bottom: 34 };

// How a level is named on the page. Records of a run made before plans had levels have none.
const levelName = (level) => (level === null ? MISSING : String(level));

/**
 * One measure of one task type against level, one line per arm. The levels
 * stand evenly apart, as the plan asks for them, and each point has a tooltip.
 * The last point of each line has its value beside it.
 */
function levelChart(type, arms, unfitted) {
  const { width, height, left, right, top, bottom } = LINE_CHART;
  const groups = type.levels.flatMap((level) => arms.map((arm) => level[arm.id]));
  const panel = unfitted.fitted?.(groups) ?? unfitted;
  const axis = axisEnd(Math.max(...groups.map((group) => panel.value(group) ?? 0), Number.MIN_VALUE));
  const plotWidth = width - left - right;
  const plotBottom = height - bottom;
  const x = (index) => left + (type.levels.length === 1 ? plotWidth / 2 : (index * plotWidth) / (type.levels.length - 1));
  const y = (amount) => plotBottom - (amount / axis) * (plotBottom - top);

  const grid = [0, 1, 2, 3, 4]
    .map((step) => (axis * step) / 4)
    .map(
      (amount) =>
        `<line class="${amount === 0 ? "axis" : "grid"}" x1="${left}" x2="${width - right}" y1="${y(amount)}" y2="${y(amount)}"/>` +
        `<text class="tick" x="${left - 8}" y="${y(amount) + 4}" text-anchor="end">${escapeHtml(panel.tick(amount, axis))}</text>`
    )
    .join("");
  const levelTicks = type.levels
    .map((level, index) => `<text class="tick" x="${x(index)}" y="${plotBottom + 18}" text-anchor="middle">${escapeHtml(levelName(level.level))}</text>`)
    .join("");
  const lines = arms
    .map((arm) => {
      const points = type.levels.map((level, index) => ({ level, index, amount: panel.value(level[arm.id]) })).filter(({ amount }) => amount !== null);
      const path = points.map(({ index, amount }, at) => `${at === 0 ? "M" : "L"}${x(index)},${y(amount)}`).join(" ");
      const dots = points
        .map(({ level, index, amount }) => {
          const group = level[arm.id];
          const tip = `${type.title} · level ${levelName(level.level)} · ${arm.title} · ${panel.title}: ${panel.label(group)} (${count(group.sessions, "session")})`;
          return (
            `<circle class="hit" tabindex="0" cx="${x(index)}" cy="${y(amount)}" r="10" data-tip="${escapeHtml(tip)}"/>` +
            `<circle class="dot ${arm.id}" cx="${x(index)}" cy="${y(amount)}" r="4"/>`
          );
        })
        .join("");
      const last = points.at(-1);
      const label = last ? `<text x="${x(last.index) + 10}" y="${y(last.amount) + 4}">${escapeHtml(panel.label(last.level[arm.id]))}</text>` : "";
      return `${points.length > 1 ? `<path class="trend ${arm.id}" d="${path}"/>` : ""}${dots}${label}`;
    })
    .join("");
  const description = `${panel.title} per level of ${type.title}, one line per arm. The table beside it has the figures.`;
  return (
    `<figure><h3>${escapeHtml(panel.title)} by level</h3>` +
    `<svg class="line" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(description)}">${grid}${levelTicks}${lines}</svg></figure>`
  );
}

// The cells of what sessions spent: one of cost, or three of tokens where the harness reports no cost
const spentCells = (group, costReported) =>
  costReported
    ? `<td class="number">${FORMAT.cost(group.costUsd)}</td>`
    : TOKENS.map((figure) => `<td class="number">${FORMAT.tokens(group[figure])}</td>`).join("");
const spentHeads = (costReported, prefix = "") =>
  (costReported ? ["Cost"] : ["Input tokens", "Cached input", "Output tokens"])
    .map((title) => `<th class="number">${prefix}${prefix === "" ? title : title.toLowerCase()}</th>`)
    .join("");

// The figures of a task type per level and arm, with the files that the target of each codebase involves
function levelTable(type, arms, costReported) {
  const rows = type.levels
    .map((level) =>
      arms
        .map((arm, position) => {
          const group = level[arm.id];
          const files = level.targets.map(({ codebase, files }) => `${codebase} ${FORMAT.count(files)}`).join(", ");
          const shared = position === 0 ? `<td rowspan="${arms.length}">${escapeHtml(levelName(level.level))}</td><td rowspan="${arms.length}">${escapeHtml(files)}</td>` : "";
          return (
            `<tr${position === 0 ? ' class="level"' : ""}>${shared}<td><span class="key ${arm.id}"></span>${escapeHtml(arm.title)}</td><td class="number">${FORMAT.solved(group)}</td>` +
            `${spentCells(group, costReported)}<td class="number">${FORMAT.time(group.wallMs)}</td><td class="number">${FORMAT.count(group.toolCalls)}</td></tr>`
          );
        })
        .join("")
    )
    .join("");
  return (
    `<div class="table-card"><table><thead><tr><th>Level</th><th>Files of each target</th><th>Arm</th><th class="number">Solved</th>` +
    `${spentHeads(costReported, "Median ")}<th class="number">Median time</th><th class="number">Median tool calls</th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

/**
 * Per task type, how each arm fares as the change touches more files: a
 * chart of cost and one of time against level, and the figures in a table.
 */
function levelSection(summary) {
  const [, spentPanel, time] = panelsOf(summary.costReported);
  const cards = summary.taskTypes
    .map(
      (type) =>
        `<section class="card"><h2>${escapeHtml(type.title)}</h2>` +
        `<p class="lede">A level is the number of files that the plan asked a target to involve. The table has the number that the target of each codebase involves.</p>` +
        `<div class="pair">${levelChart(type, summary.arms, spentPanel)}${levelChart(type, summary.arms, time)}</div>${levelTable(type, summary.arms, summary.costReported)}</section>`
    )
    .join("");
  return `<div class="levels">${cards}</div>`;
}

// The limits that a session of the run could reach, as the footnote names them
function limitsNote(summary) {
  const limits = endingsIn(summary)
    .filter(({ id }) => id.endsWith("-limit"))
    .map(({ title }) => `"${title}"`);
  return limits.length === 1 ? `${limits[0]} is the limit the benchmark was run with.` : `${limits.join(" and ")} are the limits the benchmark was run with.`;
}

// One row per arm, one column per way a session can end
function endingsTable(summary) {
  const ENDINGS = endingsIn(summary);
  const head = ENDINGS.map(({ title }) => `<th class="number">${escapeHtml(title)}</th>`).join("");
  const rows = summary.arms
    .map((arm) => {
      const cells = ENDINGS.map(({ id }) => `<td class="number">${summary.overall[arm.id].endings[id]}</td>`).join("");
      return `<tr><td><span class="key ${arm.id}"></span>${escapeHtml(arm.title)}</td>${cells}</tr>`;
    })
    .join("");
  return `<div class="card table-card"><h2>How the sessions ended</h2><table><thead><tr><th>Arm</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function runsTable(summary) {
  const armTitle = Object.fromEntries(summary.arms.map((arm) => [arm.id, arm.title]));
  const typeTitle = Object.fromEntries(summary.taskTypes.map((type) => [type.id, SHORT_TITLE[type.id] ?? type.title]));
  const rows = summary.runs
    .map(
      (run) =>
        `<tr><td>${escapeHtml(run.codebase)}</td><td>${escapeHtml(typeTitle[run.type])}</td>` +
        `<td><span class="key ${run.arm}"></span>${escapeHtml(armTitle[run.arm])}</td><td>${escapeHtml(ENDING_TITLE[run.ending])}</td>` +
        `<td class="number">${escapeHtml(levelName(run.level))}</td><td class="number">${FORMAT.count(run.files)}</td>` +
        `<td class="number">${FORMAT.time(run.wallMs)}</td>${spentCells(run, summary.costReported)}` +
        `<td class="number">${FORMAT.count(run.turns)}</td><td class="number">${run.toolCalls}</td>` +
        `<td class="number">${run.lspCalls}</td><td class="number">${FORMAT.count(run.changedFiles)}</td>` +
        `<td class="number">${FORMAT.count(run.apiRetries)}</td></tr>`
    )
    .join("");
  return (
    `<div class="card table-card"><h2>Every session</h2><table><thead><tr><th>Codebase</th><th>Task</th><th>Arm</th><th>Outcome</th>` +
    `<th class="number">Level</th><th class="number">Target files</th>` +
    `<th class="number">Time</th>${spentHeads(summary.costReported)}<th class="number">Turns</th><th class="number">Tool calls</th>` +
    `<th class="number">Server calls</th><th class="number">Files</th><th class="number">API retries</th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

/** @param {ReturnType<typeof summarize>} summary */
export function renderReport(summary) {
  const { arms, overall, codebases, runs } = summary;
  const sizes = codebases.map((codebase) => `${codebase.label} (${codebase.modules} modules, ${codebase.lines.toLocaleString("en-US")} lines)`);
  const effort = ` at ${summary.efforts.map((level) => (level === null ? `${summary.harness}'s default effort` : `effort ${level}`)).join(" and ")}`;
  const agent = ` in ${summary.harness}${summary.agentVersions.length > 0 ? ` ${summary.agentVersions.join(" and ")}` : ""}`;
  const server = summary.languageServers.length > 0 ? ` The language server is elm-lsp-rust ${summary.languageServers.join(" and ")}.` : "";
  const lede =
    `${summary.model}${effort}${agent} worked on ${count(summary.taskTypes.length, "kind")} of refactoring in ` +
    `${count(codebases.length, "Elm codebase")}${sizes.length > 0 ? `: ${sizes.join(", ")}` : ""}. ${count(runs.length, "session")} in total.${server} ` +
    `A task counts as solved when the project compiles and the change is the one that was asked for.` +
    (summary.unpaired > 0
      ? ` ${count(summary.unpaired, "more session")} left out: the other arm has not done the same round of the same task yet.`
      : "") +
    (arms.length === 1 ? " Only one arm was run, so this page compares nothing." : "");

  const tiles = [
    tile("Tasks solved", arms, overall, FORMAT.solved),
    tile(summary.costReported ? "Median cost per session" : "Median tokens per session", arms, overall, (group) => spent(group, summary.costReported)),
    tile("Median time per session", arms, overall, (group) => FORMAT.time(group.wallMs)),
    tile("Median tool calls per session", arms, overall, (group) => FORMAT.count(group.toolCalls)),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elm refactoring benchmark</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Elm refactoring with and without the language server</h1>
<p class="lede">${escapeHtml(lede)}</p>
${legend(arms)}
<div class="tiles">${tiles}</div>
${taskChart(summary)}
${levelSection(summary)}
${endingsTable(summary)}
${runsTable(summary)}
<p class="note">Both arms get the same prompt, the same model and the same built-in tools of ${escapeHtml(summary.harness)} (${escapeHtml(summary.tools.join(", "))}). The only difference is whether the session has the language server, with its tools and the notes on paths, lines and columns that it sends when a session connects. Each session starts from a fresh checkout with a warm compiler cache. ${limitsNote(summary)} "Session error" is a session that ended on an error of its own, such as a request that grew too long for the model. "Level" is the number of files that the plan asked a target to involve, and "Target files" the number that the session's target involves. ${summary.turnsReported ? `"Turns" is the number of turns that ${escapeHtml(summary.harness)} reports for the session` : `"Turns" is empty, since ${escapeHtml(summary.harness)} reports no turns of the agent`}, "Server calls" counts the calls to the language server, and "Files" the files the session changed. A module that moved counts twice there, for the file that went and the one that came. ${summary.retriesReported ? `"API retries" counts how often ${escapeHtml(summary.harness)} had to ask the API again, which tells a session that waited from one that worked slowly.` : `"API retries" is empty where ${escapeHtml(summary.harness)} does not say when it asks the API again.`}</p>
</main>
<div id="tip" role="tooltip"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
