/**
 * Tests of benchmarks/lib/probe.mjs that start no process and read no clock:
 * which targets the probe takes, which tool calls it makes for them, and what
 * its summary counts. The tests that run a probe are in benchmark.test.mjs.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { callsFor, renderProbeTable, spreadBySize, summarizeProbe } from "../benchmarks/lib/probe.mjs";
import { TASK_TYPES } from "../benchmarks/lib/tasks.mjs";
import { SHAPES } from "./benchmark-support.mjs";
import { tempDir } from "./support.mjs";

const sized = (sizes) => sizes.map((size, at) => ({ key: `src/M${String(at).padStart(3, "0")}.elm`, size }));

test("the probe takes its targets spread over their sizes, the largest among them, the same way each time", () => {
  // Most targets are small, as in a real project, and a few are large
  const targets = sized([...Array(60).fill(5), ...Array(30).fill(8), 12, 20, 33, 40, 41, 75]);
  const picked = spreadBySize(targets, 6, 5);
  // The steps are at 75, 61, 47, 33, 19 and 5. Of 40 and 41, the step at 61 takes 41, and the one at 47 the other.
  assert.deepEqual(picked.map((target) => target.size), [5, 20, 33, 40, 41, 75]);
  // Of equal sizes, the first by key
  assert.equal(picked[0].key, "src/M000.elm");
  // The order the targets come in makes no difference
  assert.deepEqual(spreadBySize([...targets].reverse(), 6, 5), picked);
  // No more than there are, in the order of their sizes
  assert.deepEqual(spreadBySize(sized([9, 5, 7]), 30, 5).map((target) => target.size), [5, 7, 9]);
  // One target is the largest one
  assert.deepEqual(spreadBySize(sized([9, 5, 70, 7]), 1, 5).map((target) => target.size), [70]);
  // Where the large sizes are few, the rest come from the nearest sizes, and no target is taken twice
  const crowded = spreadBySize(sized([...Array(20).fill(5), 100]), 5, 5);
  assert.deepEqual(crowded.map((target) => target.size), [5, 5, 5, 5, 100]);
  assert.equal(new Set(crowded.map((target) => target.key)).size, 5);
});

test("each task type is done with the tools that a session of the lsp arm calls, pointed at the target's declaration", (t) => {
  const elmRoot = tempDir(t);
  mkdirSync(join(elmRoot, "src"));
  // A comment that holds a letter outside ASCII moves the column in bytes away from the index in characters
  writeFileSync(join(elmRoot, "src/Shapes.elm"), SHAPES.replace("    | Dot", "    | {- é -} Dot"));
  const callsOf = (type, target) => {
    const taskType = TASK_TYPES.find((candidate) => candidate.id === type);
    const task = taskType.build({ file: "src/Shapes.elm", module: "Shapes", size: 1, mayChange: [], namesakes: [], fields: [], types: [], functions: [], variants: [], ...target }, "elm make");
    return callsFor(type, { file: "src/Shapes.elm", ...target }, task, elmRoot);
  };
  const file_path = join(elmRoot, "src/Shapes.elm");
  assert.deepEqual(callsOf("rename-function", { name: "area" }), [
    ["elm_rename_function", { file_path, line: 29, character: 0, old_name: "area", newName: "areaRenamed" }],
  ]);
  assert.deepEqual(callsOf("rename-shared-function", { name: "area" })[0][0], "elm_rename_function");
  assert.deepEqual(callsOf("rename-variant", { type: "Shape", variant: "Dot" }), [
    ["elm_rename_variant", { file_path, line: 12, character: 15, old_name: "Dot", newName: "DotRenamed" }],
  ]);
  assert.deepEqual(callsOf("rename-field", { alias: "Point", field: "y" }), [
    ["elm_rename_field", { file_path, line: 17, character: 6, old_name: "y", newName: "yRenamed" }],
  ]);
  assert.deepEqual(callsOf("rename-type", { name: "Point" }), [
    ["elm_rename_type", { file_path, line: 15, character: 11, old_name: "Point", newName: "PointRenamed" }],
  ]);
  // The new file lies beside the old one, so the module is renamed and not moved
  assert.deepEqual(callsOf("rename-module", { newFile: "src/ShapesRenamed.elm" }), [["elm_rename_file", { file_path, new_name: "ShapesRenamed.elm" }]]);
  assert.deepEqual(callsOf("add-variant", { type: "Shape" }), [
    ["elm_prepare_add_variant", { file_path, type_name: "Shape", new_variant_name: "AddedByBenchmark" }],
    ["elm_add_variant", { file_path, type_name: "Shape", new_variant_name: "AddedByBenchmark" }],
  ]);
  // A removal is previewed, then made, each pointed at the variant or the field
  const dot = { file_path, line: 12, character: 15, variant_name: "Dot" };
  assert.deepEqual(callsOf("remove-variant", { type: "Shape", variant: "Dot" }), [
    ["elm_prepare_remove_variant", dot],
    ["elm_remove_variant", dot],
  ]);
  const y = { file_path, line: 17, character: 6, field_name: "y" };
  assert.deepEqual(callsOf("remove-field", { alias: "Point", field: "y" }), [
    ["elm_prepare_remove_field", y],
    ["elm_remove_field", y],
  ]);
  // A target that the file does not declare is a mistake of the probe, and no call is made for it
  assert.throws(() => callsOf("rename-variant", { type: "Shape", variant: "Square" }), /The probe found no declaration of \{"type":"Shape","variant":"Square"\}/);
});

test("the summary counts the outcomes per codebase, task type and band of size, and names nothing of a codebase", () => {
  const record = (type, size, outcome, unmet = []) => ({ type, key: "src/Private/Name.elm:secret", size, outcome, unmet, text: "src/Private/Name.elm", problems: ["secret"] });
  const summary = summarizeProbe(
    [
      {
        label: "A",
        records: [
          record("rename-field", 5, "solved"),
          record("rename-field", 7, "wrong-result", ["fields-kept"]),
          record("rename-field", 30, "wrong-result", ["fields-kept", "renames-only"]),
          record("rename-field", 250, "does-not-compile"),
          record("rename-function", 12, "tool-error"),
        ],
      },
      { label: "B", records: [record("add-variant", 3, "tool-refused")] },
    ],
    { languageServer: "0.3.39 (abcdef0)", minFiles: 5 }
  );
  const zero = { solved: 0, "wrong-result": 0, "does-not-compile": 0, "tool-error": 0, "tool-refused": 0 };
  assert.deepEqual(summary.codebases[0].types[1], {
    type: "rename-field",
    tried: 4,
    outcomes: { ...zero, solved: 1, "wrong-result": 2, "does-not-compile": 1 },
    unmet: { "fields-kept": 2, "renames-only": 1 },
    bands: [
      { sizes: "5-9", tried: 2, outcomes: { ...zero, solved: 1, "wrong-result": 1 } },
      { sizes: "20-49", tried: 1, outcomes: { ...zero, "wrong-result": 1 } },
      { sizes: "200+", tried: 1, outcomes: { ...zero, "does-not-compile": 1 } },
    ],
  });
  // The task types come in their own order, and only those with records
  assert.deepEqual(summary.codebases[0].types.map((type) => type.type), ["rename-function", "rename-field"]);
  assert.equal(summary.codebases[1].types[0].bands[0].sizes, "1-4");
  assert.equal(summary.minFiles, 5);
  const table = renderProbeTable(summary);
  assert.doesNotMatch(JSON.stringify(summary) + table, /Private|secret/);
  assert.match(table, /^Codebase +Task type +Sizes +Tried +solved +wrong-result +does-not-compile +tool-error +tool-refused$/m);
  assert.match(table, /^A +rename-field +all +4 +1 +2 +1 +0 +0$/m);
  assert.match(table, /^A +rename-field +200\+ +1 +0 +0 +1 +0 +0$/m);
  assert.match(table, /^B +add-variant +1-4 +1 +0 +0 +0 +0 +1$/m);
});
