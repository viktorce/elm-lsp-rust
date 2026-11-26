/**
 * Tests of benchmarks/lib/problems.mjs, which words what the check of a
 * session finds wrong, with its kind, and reads the kind of an older
 * record's problem back from the words.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { difference, firstProblemKind, PROBLEM_DIFFERENCES, PROBLEM_KINDS, PROBLEM_SENTENCES, problem, problemKind, tokenDifference, word } from "../benchmarks/lib/problems.mjs";

const slotsOf = (template) => [...template.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);

// A value for every slot, with words in it that other templates use, as names of a codebase can have
const plain = (template) => Object.fromEntries(slotsOf(template).map((name) => [name, `src/Still has ${name}.elm`]));

// Every sentence that the checks can word, with plain values, to end a slot with
const SENTENCES = Object.entries(PROBLEM_SENTENCES).map(([id, [, template]]) => word(id, { ...plain(template), difference: "label became title" }));

// The value of a template's last slot where the template ends in it, which can hold anything, a line of code or the
// output of a build: one that ends in each other sentence. The other slots are names and paths.
function* hostile(template) {
  const last = slotsOf(template).at(-1);
  if (last === undefined || !template.endsWith(`{${last}}`)) return yield plain(template);
  for (const tail of SENTENCES) yield { ...plain(template), [last]: `${plain(template)[last]} ${tail}` };
}

// Each difference with a last slot that ends in every sentence, and a literal that holds the words between its slots
function* differences() {
  for (const tail of SENTENCES) {
    yield difference("header-lost", { line: `import Html exposing (div) ${tail}` });
    yield difference("header-gained", { line: `import Set ${tail}` });
    yield difference("token-became", { old: "label", now: `title ${tail}` });
  }
  yield tokenDifference('"a label became"', '"a title"');
  yield tokenDifference("'a'", '"a \\" became \'b"');
}

test("every sentence that a check can word gets its kind, and an older record's words read back as the same kind", () => {
  for (const [id, [kind, template]] of Object.entries(PROBLEM_SENTENCES)) {
    const aboutDifference = template.includes("{difference}");
    for (const values of hostile(template)) {
      for (const within of aboutDifference ? differences() : [undefined]) {
        const found = problem(id, within === undefined ? values : { ...values, difference: within });
        const expected = typeof kind === "string" ? kind : kind[within.id];
        assert.equal(found.kind, expected, `${id}: ${found.text}`);
        assert.equal(problemKind(found.text), expected, `${id} read back: ${found.text}`);
      }
    }
  }
  // Every kind that a sentence can have is on the list, and each one has a title for the page
  const listed = new Set(PROBLEM_KINDS.map(({ id }) => id));
  for (const [kind] of Object.values(PROBLEM_SENTENCES)) {
    for (const each of typeof kind === "string" ? [kind] : Object.values(kind)) assert.ok(listed.has(each), each);
  }
  assert.ok(PROBLEM_KINDS.every(({ title }) => /^[A-Z]/.test(title) && !title.endsWith(".")));
  assert.deepEqual(Object.keys(PROBLEM_DIFFERENCES), ["header-lost", "header-gained", "literal-became", "token-became"]);
});

test("a changed literal is one that stands where a literal stood", () => {
  assert.deepEqual(tokenDifference('"label"', '"title"'), { id: "literal-became", text: '"label" became "title"' });
  assert.deepEqual(tokenDifference("'a'", "'b'"), { id: "literal-became", text: "'a' became 'b'" });
  // Code inserted before a string compares the string with what came in its place, which is no change of a literal
  assert.deepEqual(tokenDifference('"label"', "view"), { id: "token-became", text: '"label" became view' });
  assert.deepEqual(tokenDifference("view", '"label"'), { id: "token-became", text: 'view became "label"' });
  assert.equal(problem("renamed-beyond", { file: "src/Lib.elm", difference: tokenDifference('"label"', "view") }).kind, "code-beyond-task");
  assert.equal(problem("moved-beyond", { file: "src/Lib.elm", difference: tokenDifference('"a"', '"b"') }).kind, "inside-string");
});

test("the sentences of records written before there were kinds get their kinds", () => {
  const kinds = [
    ['src/Lib.elm changed in more than the name: "label" became "title"', "inside-string"],
    ["src/Lib.elm changed in more than the name: record became title", "code-beyond-task"],
    ["src/Lib.elm changed in more than the name: the end of the file became title", "code-beyond-task"],
    ['src/Lib.elm changed in more than the name: the module line and the imports no longer have "import Dict"', "imports"],
    ['src/View.elm changed in more than the move: the module line and the imports gained "import Set"', "imports"],
    ["src/View.elm changed in more than the move: 'a' became 'b'", "inside-string"],
    // A literal in the place of code, or code in the place of a literal, is no changed literal
    ['src/Lib.elm changed in more than the name: "label" became title', "code-beyond-task"],
    ['src/View.elm changed in more than the move: view became "label"', "code-beyond-task"],
    // The words of another sentence at the end of a slot leave the outer sentence its kind
    ['src/Lib.elm changed in more than the name: "This does not declare example" became "x"', "inside-string"],
    ["changed more than the variant and its branches: -- the old record still exists", "beyond-branches"],
    ["the check command fails: -- src/Main.elm still declares view", "does-not-compile"],
    ["the result could not be judged: src/Lib.elm still exists", "not-judged"],
    ["view in src/Page.elm is not the function that was moved: div became span", "moved-function-changed"],
    // A removal is judged against the text it should leave, so a literal that differs is no rename inside a string
    ['src/Page/Home.elm is not what the removal makes of it: "walk" became "wait"', "removal-differs"],
    ["src/Page/Home.elm is not what the removal makes of it: Wait became _", "removal-differs"],
    ["the check command fails: -- NAMING ERROR ------ src/Main.elm", "does-not-compile"],
    ["the check command ran out of time", "check-timed-out"],
    ["src/Lib.elm does not declare titleOf", "change-missing"],
    ["src/Lib.elm still declares labelOf", "old-name-left"],
    ["src/Shop.elm does not declare the type Item", "change-missing"],
    ["labelOf was also renamed or removed in src/Other.elm, src/More.elm", "namesake"],
    ["label was also renamed or removed on Item (src/Shop.elm)", "namesake"],
    ["changed files that are no Elm sources of the project: ../README.md, package.json", "non-elm-file"],
    ["changed files that cannot use the target: src/Other.elm", "cannot-use-target"],
    ["a branch for Dot is followed by something else than a Debug.todo with a message", "branch-not-todo"],
    ["a branch for Dot takes over the line below it, which is indented deeper than the branch's pattern", "todo-takes-line"],
    ["changed more than the variant and its branches: -a / +b", "beyond-branches"],
    ["src/Old.elm was deleted, which no rename asks for", "file-added-or-deleted"],
    ["the move of src/Old.elm wrote over src/New.elm, a file of the starting commit", "wrote-over-file"],
    ["the session created a commit, which the task told it not to", "commit"],
    ["the result could not be judged: fatal: not a git repository", "not-judged"],
    ["something that no template words", "unknown"],
  ];
  assert.deepEqual(kinds.map(([text]) => [text, problemKind(text)]), kinds);
});

test("a record's kinds come from beside its sentences, and from the words where it has none", () => {
  const text = 'src/Lib.elm changed in more than the name: "label" became "title"';
  assert.equal(firstProblemKind({ problems: [text], problemKinds: ["code-beyond-task"] }), "code-beyond-task");
  assert.equal(firstProblemKind({ problems: [text] }), "inside-string");
  // A failed result whose record holds no sentence does not say what failed
  assert.equal(firstProblemKind({ problems: [] }), "unstated");
  assert.equal(firstProblemKind({}), "unstated");
});

test("a problem is worded only from a template, with every slot filled", () => {
  assert.equal(word("file-new", { file: "src/New.elm", change: "move" }), "src/New.elm is a new file, which no move asks for");
  assert.equal(word("check-timed-out"), "the check command ran out of time");
  assert.deepEqual(problem("file-new", { file: "src/New.elm", change: "move" }), { text: "src/New.elm is a new file, which no move asks for", kind: "file-added-or-deleted" });
  assert.throws(() => word("no-such-problem", {}), /No problem is worded as "no-such-problem"/);
  assert.throws(() => word("file-new", { file: "src/New.elm" }), /The problem "file-new" needs a value for \{change\}/);
});
