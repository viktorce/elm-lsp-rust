/**
 * What the check of a session can find wrong, by kind, and every sentence
 * that says so. A record keeps the sentences as `problems`, and the kind of
 * each beside it as `problemKinds`. The sentences name files and symbols of
 * the codebase, so a report shows the kinds and never a sentence. A problem
 * can only be worded with a template that has a kind, and it gets its kind
 * as it is worded. A record written before there were kinds has only the
 * sentences, and the kind of each is read back from its words.
 */

// The kinds, in the order the report lists them. A title is what a reader of the report sees.
export const PROBLEM_KINDS = [
  { id: "does-not-compile", title: "Does not compile" },
  // A build that takes longer than its limit counts as one that fails, and the session's ending says so
  { id: "check-timed-out", title: "Does not compile within the time of the check command" },
  { id: "change-missing", title: "The change that was asked for is missing" },
  { id: "old-name-left", title: "Left the old name or the removed part in place" },
  { id: "namesake", title: "Renamed or removed a namesake the task did not name" },
  // The check compares tokens by their place, so it knows that the literal at a place differs and not what was done to it
  { id: "inside-string", title: "Changed a string literal" },
  { id: "code-beyond-task", title: "Changed code the task did not name" },
  { id: "imports", title: "Changed the imports or the module line beyond the task" },
  { id: "moved-function-changed", title: "Changed the function it moved" },
  { id: "removal-differs", title: "Left the code otherwise than the removal makes it" },
  { id: "branch-not-todo", title: "Wrote a branch that is not a Debug.todo" },
  { id: "todo-takes-line", title: "Wrote a Debug.todo branch that takes over the line below it" },
  { id: "beyond-branches", title: "Changed more than the variant and its branches" },
  { id: "no-branch", title: "Added no branch for the variant" },
  { id: "variant-twice", title: "Added the variant to more than one type" },
  { id: "variant-not-last", title: "Added the variant elsewhere than last" },
  { id: "file-added-or-deleted", title: "Created or deleted a file the task did not ask for" },
  { id: "wrote-over-file", title: "Moved a module onto a file that was there" },
  { id: "non-elm-file", title: "Changed a file that is no Elm source" },
  { id: "cannot-use-target", title: "Changed a file that cannot use the target" },
  { id: "elm-json", title: "Changed elm.json beyond the module's name" },
  { id: "commit", title: "Made a commit" },
  { id: "not-judged", title: "Could not be judged" },
  // A sentence of an older benchmark, worded in a way that no template here has
  { id: "unknown", title: "A problem of a kind this benchmark no longer words" },
  // A failed result whose record holds no sentence, which no check of this benchmark leaves
  { id: "unstated", title: "Failed in a way that its record does not say" },
];

// How one file differs from what it should be. Each stands at the end of a sentence below, whose kind can depend on it.
const DIFFERENCES = {
  "header-lost": 'the module line and the imports no longer have "{line}"',
  "header-gained": 'the module line and the imports gained "{line}"',
  // A string or a character literal in the place of another one
  "literal-became": "{literal} became {newLiteral}",
  "token-became": "{old} became {now}",
};

// A change beyond a rename or a move, by what changed
const BEYOND = { "header-lost": "imports", "header-gained": "imports", "literal-became": "inside-string", "token-became": "code-beyond-task" };

// Every sentence of a problem, with its kind. A `{difference}` is one of DIFFERENCES.
const SENTENCES = {
  "check-fails": ["does-not-compile", "the check command fails: {output}"],
  "check-timed-out": ["check-timed-out", "the check command ran out of time"],
  "lacks-function-declaration": ["change-missing", "{file} does not declare {name}"],
  "lacks-type-declaration": ["change-missing", "{file} does not declare the type {name}"],
  "lacks-module-declaration": ["change-missing", "{file} does not declare the module {module}"],
  "lacks-variant": ["change-missing", "{type} in {file} has no variant {variant}"],
  "lacks-field": ["change-missing", "{alias} in {file} has no field {field}"],
  "still-declares-function": ["old-name-left", "{file} still declares {name}"],
  "still-declares-type": ["old-name-left", "{file} still declares the type {name}"],
  "still-has-variant": ["old-name-left", "{type} in {file} still has the variant {variant}"],
  "still-has-field": ["old-name-left", "{alias} in {file} still has the field {field}"],
  "file-still-exists": ["old-name-left", "{file} still exists"],
  "still-imported": ["old-name-left", "{module} is still imported by {files}"],
  "elm-json-still-lists": ["old-name-left", "elm.json still lists {from} among the modules it exposes"],
  "function-namesake-lost": ["namesake", "{name} was also renamed or removed in {files}"],
  "type-namesake-lost": ["namesake", "the type {name} was also renamed or removed in {files}"],
  "variant-namesake-lost": ["namesake", "{variant} was also renamed or removed on {types}"],
  "field-namesake-lost": ["namesake", "{field} was also renamed or removed on {aliases}"],
  "renamed-beyond": [BEYOND, "{file} changed in more than the name: {difference}"],
  "moved-beyond": [BEYOND, "{file} changed in more than the move: {difference}"],
  "moved-function-differs": ["moved-function-changed", "{name} in {file} is not the function that was moved: {difference}"],
  "removal-differs": ["removal-differs", "{file} is not what the removal makes of it: {difference}"],
  "removal-unreadable": ["not-judged", "{file} cannot be read as the plan read it, so the removal cannot be judged"],
  "branch-not-todo": ["branch-not-todo", "a branch for {variant} is followed by something else than a Debug.todo with a message"],
  "branch-takes-line": ["todo-takes-line", "a branch for {variant} takes over the line below it, which is indented deeper than the branch's pattern"],
  "beyond-branches": ["beyond-branches", "changed more than the variant and its branches: {lines}"],
  "no-branch": ["no-branch", "no branch for {variant} was added"],
  "variant-twice": ["variant-twice", "{variant} was added {times} times, and one type was to get it"],
  "variant-not-last": ["variant-not-last", "{variant} is not the last variant of {type} in {file}"],
  "file-deleted": ["file-added-or-deleted", "{file} was deleted, which no {change} asks for"],
  "file-new": ["file-added-or-deleted", "{file} is a new file, which no {change} asks for"],
  "move-wrote-over": ["wrote-over-file", "the move of {from} wrote over {file}, a file of the starting commit"],
  "non-elm-files": ["non-elm-file", "changed files that are no Elm sources of the project: {files}"],
  "cannot-use-target": ["cannot-use-target", "changed files that cannot use the target: {files}"],
  "elm-json-beyond": ["elm-json", "elm.json changed in more than the name of {from} among the modules it exposes"],
  commit: ["commit", "the session created a commit, which the task told it not to"],
  "not-judged": ["not-judged", "the result could not be judged: {error}"],
};

const KNOWN = new Set(PROBLEM_KINDS.map(({ id }) => id));
for (const [id, [kind]] of Object.entries(SENTENCES)) {
  for (const each of typeof kind === "string" ? [kind] : Object.values(kind)) {
    if (!KNOWN.has(each)) throw new Error(`The problem "${id}" is of the kind "${each}", which PROBLEM_KINDS does not have`);
  }
}

// A whole string or character literal, with its quotes, as a token of Elm holds it. A read of an older record
// takes a difference for a changed literal only where both sides of "became" are one.
const LITERAL = String.raw`"""[^]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const SLOT = { literal: LITERAL, newLiteral: LITERAL };

const isSlot = (part) => /^\{\w+\}$/.test(part);

// A template as a pattern that takes a whole text apart into its slots, in their order, with the parts it is made of
function patternOf(template) {
  const parts = template.split(/(\{\w+\})/).filter((part) => part !== "");
  const names = parts.filter(isSlot).map((part) => part.slice(1, -1));
  const source = parts.map((part) => (isSlot(part) ? `(${SLOT[part.slice(1, -1)] ?? "[^]*?"})` : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return { names, parts, pattern: new RegExp(`^${source}$`) };
}

const read = (templates) => Object.entries(templates).map(([id, template]) => ({ id, ...patternOf(template) }));
const DIFFERENCE_PATTERNS = read(DIFFERENCES);
const SENTENCE_PATTERNS = read(Object.fromEntries(Object.entries(SENTENCES).map(([id, [, template]]) => [id, template])));

// For each fixed part of a template in a text it fits, how much of the text before it stands in slots that can hold
// anything, and then its length taken negative. Of two matches, the one whose list comes first in the order of arrays
// begins its words earlier, or with more of them. A literal's slot holds a literal and nothing else, so it counts as none.
function placesOf(parts, slots) {
  const places = [];
  let free = 0;
  let slot = 0;
  for (const part of parts) {
    if (!isSlot(part)) places.push(free, -part.length);
    else if (SLOT[part.slice(1, -1)] === undefined) free += slots[slot++].length;
    else slot++;
  }
  return places;
}

const comesFirst = (one, other) => {
  const differs = one.findIndex((value, at) => value !== other[at]);
  return differs !== -1 && (differs >= other.length || one[differs] < other[differs]);
};

/**
 * The id of the template that a text fits, with what stands in its slots, or
 * null. A slot can hold words that end in another template's words, as a
 * line of code or a string can, so that several templates fit. The outer
 * sentence is the one whose words begin earliest in the text, and of two
 * that begin at the same place, the one with more words there: "does not
 * declare the type" before "does not declare". Text in a literal's slot
 * does not count, so a literal that holds " became " stays one.
 */
function fit(patterns, text) {
  let best = null;
  for (const { id, names, parts, pattern } of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const found = { id, slots: Object.fromEntries(names.map((name, at) => [name, match[at + 1]])), places: placesOf(parts, match.slice(1)) };
    if (best === null || comesFirst(found.places, best.places)) best = found;
  }
  return best;
}

/**
 * A problem's sentence, or a difference to stand in one, from its template.
 * Throws on an id or a slot that no template has, which is a mistake in the
 * benchmark's code.
 */
export function word(id, values) {
  const template = DIFFERENCES[id] ?? SENTENCES[id]?.[1];
  if (template === undefined) throw new Error(`No problem is worded as "${id}"`);
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (values?.[name] === undefined) throw new Error(`The problem "${id}" needs a value for {${name}}`);
    return String(values[name]);
  });
}

/** A difference worded, with the id of its template, which decides the kind of the sentence it stands in. */
export const difference = (id, values) => ({ id, text: word(id, values) });

const isLiteral = (token) => /^["']/.test(token);

/** The difference that a file's tokens make, worded as the checks word it. A literal in the place of a literal changed. */
export const tokenDifference = (old, now) =>
  isLiteral(old) && isLiteral(now) ? difference("literal-became", { literal: old, newLiteral: now }) : difference("token-became", { old, now });

/**
 * A problem as a check finds it: its sentence, and its kind beside it. A
 * sentence about a difference takes the difference as `values.difference`.
 */
export function problem(id, values = {}) {
  const { difference: within, ...rest } = values;
  const text = word(id, within === undefined ? rest : { ...rest, difference: within.text });
  const [kind] = SENTENCES[id];
  return { text, kind: typeof kind === "string" ? kind : kind[within.id] };
}

/** The kind of a problem's sentence, one of PROBLEM_KINDS, read from its words, for a record that holds no kinds. */
export function problemKind(text) {
  const sentence = fit(SENTENCE_PATTERNS, text);
  if (sentence === null) return "unknown";
  const [kind] = SENTENCES[sentence.id];
  if (typeof kind === "string") return kind;
  return kind[fit(DIFFERENCE_PATTERNS, sentence.slots.difference)?.id] ?? "unknown";
}

/**
 * The kind of what the check of a session found wrong first: the kind that
 * the record holds beside the sentence, or else the one its words have. A
 * record without a sentence does not say.
 */
export const firstProblemKind = (record) => record.problemKinds?.[0] ?? (record.problems?.length > 0 ? problemKind(record.problems[0]) : "unstated");

// The templates as they are, for the tests that hold every one of them to its kind
export { DIFFERENCES as PROBLEM_DIFFERENCES, SENTENCES as PROBLEM_SENTENCES };
