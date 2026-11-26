/**
 * The remove-variant and remove-field tasks: which variants and fields can be
 * removed with no choice left to the agent, the removal as the plan makes it,
 * and the text that each file should have once it is done. tasks.mjs words
 * the requests and holds a session to them.
 *
 * A removal leaves no choice where the request can say what becomes of each
 * place that names the target. A branch of a case whose pattern names the
 * variant can no longer match, and goes. Every other use of the variant, and
 * every read of the field, becomes Debug.todo. A record that is built or
 * updated with the field loses it. What a reading of the source text cannot
 * tell apart is left out: a variant of the same name on another type, a field
 * of the same name on another record type, a record pattern that binds the
 * field, whose variable would be left without a value, and an alias that
 * builds its record as a function, whose arguments would change.
 *
 * The plan builds two changes before it takes a target. The removal has to
 * compile, which it does not where a catch-all branch would then match
 * nothing that the branches above it do not. The target renamed in every
 * place where the reading finds a use of it has to compile as well. A use
 * that the reading missed would no longer find its name, and one that it
 * took for a use, the field of a record of a package for one, would find the
 * renamed one where it does not belong.
 */

import { countBy, filesOf, importersOf, isKeyword, mentions, namesIn, placedTokens, readersOf, refersTo, scanSource } from "./elm-source.mjs";

// The variants that every module can name without an import. A variant of the project that is
// called like one of them would be told from it by the imports alone.
const DEFAULT_VARIANTS = new Set(["True", "False", "Just", "Nothing", "Ok", "Err", "LT", "EQ", "GT"]);

// Two tokens with nothing between them, as the parts of `user.name`
const adjacent = (left, right) => left !== undefined && right !== undefined && left.end === right.at;

const isName = (token) => /^[\p{L}_]/u.test(token?.text ?? "") && !isKeyword(token.text);

const isCloser = (token) => [")", "]", "}"].includes(token?.text);

// The last token of a value that a name or a call can be applied to: a name, a number, a literal or a closing bracket
const endsAValue = (token) => isName(token) || /^["'0-9]/.test(token?.text ?? "") || isCloser(token);

/**
 * For each bracket among the tokens, the index of the one that pairs with it,
 * and -1 for every other token. `inside` has for each token the index of the
 * innermost bracket that it stands in, or -1. Null where the brackets do not
 * pair up.
 */
function bracketsOf(tokens) {
  const partner = new Array(tokens.length).fill(-1);
  const inside = new Array(tokens.length).fill(-1);
  const open = [];
  for (const [index, { text }] of tokens.entries()) {
    inside[index] = open.at(-1) ?? -1;
    if (["(", "[", "{"].includes(text)) open.push(index);
    else if (isCloser({ text })) {
      const opener = open.pop();
      if (opener === undefined || "([{"[")]}".indexOf(text)] !== tokens[opener].text) return null;
      [partner[index], partner[opener]] = [opener, index];
      inside[index] = open.at(-1) ?? -1;
    }
  }
  return open.length > 0 ? null : { partner, inside };
}

/**
 * The branches of every case expression among the tokens, each by the index
 * of its first token, of the arrow behind its pattern and of the first token
 * behind it. A branch begins where its line begins, in the column of the
 * first branch, as Elm's layout rule has it, and the case ends at a line that
 * begins further left. It also ends at a bracket that closes one opened in
 * front of the case, and at a comma between items around it. Null where a
 * case is laid out otherwise: with a branch on the line of `of`, or with a
 * bracket that is open when the next branch begins.
 * @returns {{ from: number, arrow: number, to: number }[] | null}
 */
function caseBranches(tokens) {
  const branches = [];
  for (const [index, token] of tokens.entries()) {
    if (token.text !== "of" || token.type) continue;
    const first = index + 1;
    if (first >= tokens.length || !tokens[first].first) return null;
    const { column } = tokens[first];
    let from = first;
    let arrow = -1;
    let depth = 0;
    let at = first;
    for (; at < tokens.length; at++) {
      const { text, first: begins, column: here } = tokens[at];
      if (at > first && begins && here <= column) {
        if (depth !== 0 || arrow === -1) return null;
        branches.push({ from, arrow, to: at });
        if (here < column) break;
        [from, arrow] = [at, -1];
      }
      if (["(", "[", "{"].includes(text)) depth++;
      else if (isCloser({ text }) && --depth < 0) break;
      else if (text === "," && depth === 0) break;
      else if (arrow === -1 && depth === 0 && text === "-" && tokens[at + 1]?.text === ">" && adjacent(tokens[at], tokens[at + 1])) arrow = at;
    }
    if (branches.at(-1)?.from !== from) {
      if (arrow === -1) return null;
      branches.push({ from, arrow, to: at });
    }
  }
  return branches;
}

// Where the line of a token begins in the text
const lineStart = (token) => token.at - token.column;

// Where a branch that goes on to the token `to` ends in the text: at the start of that token's line
// where it begins the line, and at the token itself where a bracket or a comma ended the case
const branchEnd = (text, tokens, to) => (to >= tokens.length ? text.length : tokens[to].first ? lineStart(tokens[to]) : tokens[to].at);

/**
 * The text with the edits made, each as [from, to, text]. An edit that lies
 * inside another is made with that one. Null where two of them overlap in part.
 */
function applied(text, edits) {
  const sorted = [...edits].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept = [];
  for (const edit of sorted) {
    const last = kept.at(-1);
    if (last && edit[0] < last[1]) {
      if (edit[1] > last[1]) return null;
      continue;
    }
    kept.push(edit);
  }
  return kept.reduceRight((written, [from, to, instead]) => written.slice(0, from) + instead + written.slice(to), text);
}

// The parts of the tokens from `from` to `to`, by the separator that stands right inside the bracket
// `opener`: each part's first token and the token behind its last one
function partsBetween(tokens, inside, from, to, separator, opener) {
  const parts = [];
  let start = from;
  for (let at = from; at < to; at++) {
    if (tokens[at].text === separator && inside[at] === opener) {
      parts.push({ from: start, to: at });
      start = at + 1;
    }
  }
  return [...parts, { from: start, to }];
}

// The edit that takes the part `index` of `parts` out together with one separator: the one behind it,
// and the one in front of it for the last part
const withoutPart = (tokens, parts, index) =>
  index < parts.length - 1
    ? [tokens[parts[index].from].at, tokens[parts[index + 1].from].at, ""]
    : [tokens[parts[index].from - 1].at, tokens[parts[index].to - 1].end, ""];

/**
 * The index of the last token of the argument that begins at `at`, or -1
 * where none begins there: a name, qualified or not, a number, a literal, a
 * bracket with all that it holds, any of these with fields read behind it,
 * an accessor such as `.name`, and a negation. Elm reads a minus sign with a
 * blank in front of it and none behind it as a negation, so `Point -1 2`
 * passes -1.
 */
function argumentEnd(tokens, partner, at) {
  const token = tokens[at];
  let end;
  if (token.text === "-" && !adjacent(tokens[at - 1], token) && adjacent(token, tokens[at + 1])) return argumentEnd(tokens, partner, at + 1);
  if (/^["'0-9]/.test(token.text)) return at;
  if (isName(token)) end = at;
  else if (["(", "[", "{"].includes(token.text)) end = partner[at];
  else if (token.text === "." && !adjacent(tokens[at - 1], token) && adjacent(token, tokens[at + 1]) && /^\p{Ll}/u.test(tokens[at + 1].text)) return at + 1;
  else return -1;
  while (tokens[end + 1]?.text === "." && adjacent(tokens[end], tokens[end + 1]) && adjacent(tokens[end + 1], tokens[end + 2]) && isName(tokens[end + 2])) end += 2;
  return end;
}

/**
 * The index of the last token of a construction that begins at `from` with
 * the variant at `name`: of the arguments that follow it directly, or of the
 * variant itself where none does, or where it is an argument of what stands
 * in front of it. An argument goes on to a later line where that line is
 * indented deeper than the line the construction begins on. Null before a
 * lambda, which can be the last argument without brackets around it.
 */
function constructionEnd(tokens, partner, from, name) {
  if (endsAValue(tokens[from - 1])) return name;
  let lineFirst = from;
  while (!tokens[lineFirst].first) lineFirst--;
  const indent = tokens[lineFirst].column;
  let last = name;
  for (let at = name + 1; at < tokens.length && !(tokens[at].first && tokens[at].column <= indent); ) {
    const end = argumentEnd(tokens, partner, at);
    if (end === -1) break;
    [last, at] = [end, end + 1];
  }
  const next = tokens[last + 1];
  const goesOn = next !== undefined && !(next.first && next.column <= indent);
  if (goesOn && next.text === "\\") return null;
  return last;
}

// The message of each Debug.todo that the plan writes. The session's own is as good.
const todo = (what) => `(Debug.todo "${what} was removed")`;

/**
 * The text of one file with the variant removed, or with it renamed to
 * `renamed` in every place where the reading finds a use of it. Null where
 * the reading cannot make the change.
 * @param {{ type: string, variant: string, home: boolean, bare: boolean, qualifier: string | null }} view
 *   What the file is to the variant: whether it declares the type, whether it can name the
 *   variant without a qualifier, and the qualifier it names it by with one
 */
function variantChanged(text, { type, variant, home, bare, qualifier }, renamed) {
  const tokens = placedTokens(text);
  const brackets = bracketsOf(tokens);
  if (brackets === null) return null;
  const { partner, inside } = brackets;

  // Each use, by the index of its first token, its qualifier's or its own, and of the variant's name
  const uses = [];
  for (const [index, token] of tokens.entries()) {
    if (token.text !== variant || token.type) continue;
    // Followed by a dot, it is a part of a module's name
    if (tokens[index + 1]?.text === "." && adjacent(token, tokens[index + 1])) continue;
    let from = index;
    while (tokens[from - 1]?.text === "." && adjacent(tokens[from - 1], tokens[from]) && adjacent(tokens[from - 2], tokens[from - 1]) && /^\p{Lu}/u.test(tokens[from - 2].text)) from -= 2;
    const written = tokens.slice(from, index).filter((_, at) => at % 2 === 0).map((part) => part.text).join(".");
    if (written === "" ? bare && !(tokens[index - 1]?.text === "." && adjacent(tokens[index - 1], token)) : written === qualifier) uses.push({ from, name: index });
  }

  const edits = [];
  if (home) {
    const declared = variantInDeclaration(tokens, inside, type, variant);
    if (declared === null) return null;
    edits.push(renamed === null ? declared.removal : [tokens[declared.name].at, tokens[declared.name].end, renamed]);
  }
  if (renamed !== null) {
    for (const { name } of uses) edits.push([tokens[name].at, tokens[name].end, renamed]);
    return applied(text, edits);
  }
  if (uses.length === 0) return applied(text, edits);

  const branches = caseBranches(tokens);
  if (branches === null) return null;
  // A pattern holds no case, so a use lies in the pattern of one branch at most
  const removed = branches.filter((branch) => uses.some(({ from, name }) => branch.from <= from && name < branch.arrow));
  for (const branch of removed) edits.push([lineStart(tokens[branch.from]), branchEnd(text, tokens, branch.to), ""]);
  for (const { from, name } of uses) {
    if (removed.some((branch) => branch.from <= from && from < branch.to)) continue;
    const last = constructionEnd(tokens, partner, from, name);
    if (last === null) return null;
    edits.push([tokens[from].at, tokens[last].end, todo(variant)]);
  }
  return applied(text, edits);
}

/**
 * Where the declaration of a custom type has the variant: the token of its
 * name, and the edit that takes it out with one bar, the one behind it where
 * it is the first variant. Null where the text does not declare it so.
 */
function variantInDeclaration(tokens, inside, type, variant) {
  const start = tokens.findIndex((token, at) => token.text === "type" && token.column === 0 && tokens[at + 1]?.text === type);
  if (start === -1) return null;
  let end = start + 1;
  while (end < tokens.length && tokens[end].column !== 0) end++;
  const equals = tokens.findIndex((token, at) => at > start && at < end && token.text === "=");
  if (equals === -1) return null;
  const parts = partsBetween(tokens, inside, equals + 1, end, "|", inside[start]);
  const index = parts.findIndex((part) => tokens[part.from]?.text === variant);
  if (index === -1 || parts.length < 2) return null;
  return { name: parts[index].from, removal: withoutPart(tokens, parts, index) };
}

/**
 * The places where the tokens name the field: each read, by its first and
 * its last token and whether it is an accessor such as `.name`, each record
 * that is built or updated with it, and each record pattern that names it.
 * A name with a dot in front that belongs to a module, as in `Config.name`,
 * is no read.
 */
function fieldPlaces(tokens, brackets, field) {
  const { partner, inside } = brackets;
  const reads = [];
  const patterns = [];
  for (const [index, token] of tokens.entries()) {
    if (token.text !== field || token.type) continue;
    const [dot, before] = [tokens[index - 1], tokens[index - 2]];
    if (dot?.text === "." && adjacent(dot, token)) {
      if (!adjacent(before, dot) || !endsAValue(before)) {
        reads.push({ from: index - 1, to: index, accessor: true });
        continue;
      }
      // Back over what the field is read from: names, brackets and the fields read from those
      let from = index - 2;
      for (;;) {
        if (isCloser(tokens[from])) from = partner[from];
        if (tokens[from - 1]?.text === "." && adjacent(tokens[from - 1], tokens[from]) && adjacent(tokens[from - 2], tokens[from - 1]) && endsAValue(tokens[from - 2])) from -= 2;
        else break;
      }
      // Names that all begin with a capital letter are the parts of a module's name
      const chain = tokens.slice(from, index - 1);
      if (chain.every((part) => /^\p{Lu}/u.test(part.text) || part.text === ".")) continue;
      reads.push({ from, to: index, accessor: false });
    } else if (tokens[inside[index]]?.text === "{" && ["{", ","].includes(tokens[index - 1]?.text) && [",", "}"].includes(tokens[index + 1]?.text)) {
      patterns.push(index);
    }
  }

  // A record built with the field, `{ name = ... }`, and one updated with it, `{ user | name = ... }`
  const records = [];
  for (const [opener, token] of tokens.entries()) {
    if (token.text !== "{" || token.type || !isName(tokens[opener + 1])) continue;
    const update = tokens[opener + 2]?.text === "|";
    const literal = tokens[opener + 2]?.text === "=" && !(tokens[opener + 3]?.text === "=" && adjacent(tokens[opener + 2], tokens[opener + 3]));
    if (!update && !literal) continue;
    const parts = partsBetween(tokens, inside, opener + (update ? 3 : 1), partner[opener], ",", opener);
    const index = parts.findIndex((part) => tokens[part.from]?.text === field);
    if (index !== -1) records.push({ opener, update, parts, index, labels: parts.map((part) => tokens[part.from]?.text) });
  }
  return { reads, records, patterns };
}

/**
 * The text of one file with the field removed, or renamed to `renamed` in
 * every place where the reading finds it. Null where the reading cannot make
 * the change: where a record pattern names the field, and where a record
 * built with it has other fields than the alias.
 * @param {{ alias: string, field: string, fields: string[], home: boolean }} view
 */
function fieldChanged(text, { alias, field, fields, home }, renamed) {
  const tokens = placedTokens(text);
  const brackets = bracketsOf(tokens);
  if (brackets === null) return null;
  const { reads, records, patterns } = fieldPlaces(tokens, brackets, field);
  if (patterns.length > 0) return null;

  const edits = [];
  const label = (index) => [tokens[index].at, tokens[index].end, renamed];
  if (home) {
    const declared = fieldInDeclaration(tokens, brackets, alias, field);
    if (declared === null) return null;
    edits.push(renamed === null ? declared.removal : label(declared.name));
  }
  for (const { opener, update, parts, index, labels } of records) {
    // A record of another type, or the alias's own written with fields that it does not have
    if (!update && (labels.length !== fields.length || !fields.every((name) => labels.includes(name)))) return null;
    if (renamed !== null) edits.push(label(parts[index].from));
    else if (update && parts.length === 1) edits.push([tokens[opener].at, tokens[brackets.partner[opener]].end, tokens[opener + 1].text]);
    else edits.push(withoutPart(tokens, parts, index));
  }
  for (const { from, to, accessor } of reads) {
    if (renamed !== null) edits.push(label(to));
    else edits.push([tokens[from].at, tokens[to].end, accessor ? `(\\_ -> ${todo(field).slice(1, -1)})` : todo(field)]);
  }
  return applied(text, edits);
}

/**
 * Where the declaration of a record alias has the field: the token of its
 * label, and the edit that takes it out with its type and one comma. Null
 * where the text does not declare it so.
 */
function fieldInDeclaration(tokens, { partner, inside }, alias, field) {
  const start = tokens.findIndex((token, at) => token.text === "type" && token.column === 0 && tokens[at + 1]?.text === "alias" && tokens[at + 2]?.text === alias);
  const brace = tokens.findIndex((token, at) => at > start + 3 && token.text === "{");
  if (start === -1 || brace === -1 || tokens[brace - 1].text !== "=") return null;
  const parts = partsBetween(tokens, inside, brace + 1, partner[brace], ",", brace);
  const index = parts.findIndex((part) => tokens[part.from]?.text === field && tokens[part.from + 1]?.text === ":");
  return index === -1 ? null : { name: parts[index].from, removal: withoutPart(tokens, parts, index) };
}

/**
 * What a file is to the target of a removal, from its own text: what it
 * declares, and how it can name the variant. Null for a variant where the
 * file cannot name it at all.
 */
function viewOf(removal, file, text) {
  const home = file === removal.file;
  if (removal.of === "field") return { ...removal, home };
  if (home) return { ...removal, home, bare: true, qualifier: null };
  const imported = scanSource(file, text)?.imported.get(removal.module);
  return imported === undefined ? null : { ...removal, home, bare: imported.everything || imported.constructorsOf.includes(removal.type), qualifier: imported.qualifier };
}

/**
 * The text of one file as the removal leaves it, or with the target renamed
 * to `renamed` in every place where the reading finds it. The text as it is
 * where the file has no use of the target. Null where the reading cannot make
 * the change.
 * @param {{ of: "variant" | "field", file: string, module: string }} removal  The target, as the task's expectation holds it
 */
export function removedFrom(removal, file, text, renamed = null) {
  const view = viewOf(removal, file, text);
  if (view === null) return text;
  return removal.of === "variant" ? variantChanged(text, view, renamed) : fieldChanged(text, view, renamed);
}

/**
 * The two changes that the plan builds for a target, each as the files it
 * changes with their new texts: the target renamed to `renamed` wherever the
 * reading finds a use of it, and the removal. Null where the reading cannot
 * make them.
 * @param {(file: string) => string} read
 */
export function removalTrial(removal, read, renamed) {
  const changes = [renamed, null].map((name) => Object.fromEntries(removal.users.map((file) => [file, removedFrom(removal, file, read(file), name)])));
  return changes.every((change) => Object.values(change).every((text) => text !== null)) ? changes : null;
}

/**
 * The variants that can be removed with no choice left: of a custom type
 * with another variant to keep, on no other type of the project, and called
 * like no variant that every module has. `users` has the files that name it,
 * the one that declares it among them, and the size counts them.
 */
export function variantCandidates(project, { minNameLength, suffix }) {
  const owners = countBy(project.flatMap((source) => source.types.flatMap((type) => type.variants)));
  const taken = namesIn(project);
  const candidates = [];
  for (const source of project) {
    for (const type of source.types.filter((each) => each.variants.length >= 2)) {
      for (const variant of type.variants) {
        if (variant.length < minNameLength || owners.get(variant) > 1 || DEFAULT_VARIANTS.has(variant) || taken.has(variant + suffix)) continue;
        const importers = importersOf(project, source.module);
        // No other module can name a variant that its own module keeps to itself
        const users = [source, ...(type.open ? importers.filter((importer) => refersTo(importer, source.module, variant, type.name)) : [])];
        candidates.push({
          key: `${source.file}:${type.name}.${variant}`,
          size: users.length,
          file: source.file,
          module: source.module,
          affected: filesOf(importers),
          type: type.name,
          variant,
          users: filesOf(users),
        });
      }
    }
  }
  return candidates;
}

// A record pattern, `{ name, email }`, with the names it binds
const RECORD_PATTERN = /\{\s*(\p{Ll}[\p{L}0-9_]*(?:\s*,\s*\p{Ll}[\p{L}0-9_]*)*)\s*\}/gu;

// A field's label in a record type, `{ name : String }` or `{ a | name : String }`
const TYPE_LABEL = /(?<=[{,|]\s*)(\p{Ll}[\p{L}0-9_]*)\s*:(?!:)/gu;

/**
 * The fields that can be removed with no choice left: of a record alias with
 * another field to keep, on no other record type of the project, named by no
 * record pattern, and of an alias that no code calls as a function. `users`
 * has the files that read the field or build a record with it, the one that
 * declares it among them, and the size counts them.
 */
export function fieldCandidates(project, { minNameLength, suffix }) {
  const taken = namesIn(project);
  const labels = countBy(project.flatMap((source) => [...source.code.matchAll(TYPE_LABEL)].map((match) => match[1])));
  const bound = new Set(project.flatMap((source) => [...source.code.matchAll(RECORD_PATTERN)].flatMap((match) => match[1].split(",").map((name) => name.trim()))));
  const tokens = new Map(project.map((source) => [source.file, placedTokens(source.text)]));
  // The names that begin with a capital letter and stand for a value: a variant, or an alias that builds its record
  const values = new Set(
    [...tokens.values()].flatMap((placed) =>
      placed.filter((token, at) => !token.type && /^\p{Lu}/u.test(token.text) && !(placed[at + 1]?.text === "." && adjacent(token, placed[at + 1]))).map((token) => token.text)
    )
  );
  const brackets = new Map();
  const bracketsIn = (file) => {
    if (!brackets.has(file)) brackets.set(file, bracketsOf(tokens.get(file)));
    return brackets.get(file);
  };
  const candidates = [];
  for (const source of project) {
    for (const alias of source.aliases.filter((each) => each.fields.length >= 2 && !values.has(each.name))) {
      for (const field of alias.fields) {
        if (field.length < minNameLength || labels.get(field) !== 1 || bound.has(field) || taken.has(field + suffix)) continue;
        const users = project.filter((user) => {
          if (user === source) return true;
          if (!mentions(user.code, field)) return false;
          const placed = bracketsIn(user.file);
          const { reads, records } = placed === null ? { reads: [], records: [] } : fieldPlaces(tokens.get(user.file), placed, field);
          return placed === null || reads.length + records.length > 0;
        });
        candidates.push({
          key: `${source.file}:${alias.name}.${field}`,
          size: users.length,
          file: source.file,
          module: source.module,
          affected: readersOf(project, source, field),
          alias: alias.name,
          field,
          fields: alias.fields,
          users: filesOf(users),
        });
      }
    }
  }
  return candidates;
}

// The tokens of Debug.todo with a message, as one, whatever the message
const TODO = "Debug.todo";

// The same, as the body of a function that takes an argument and ignores it
const TODO_FUNCTION = "\\ -> Debug.todo";

/**
 * The tokens with each call of Debug.todo on a string literal as one token,
 * whatever the message, and each function that ignores its argument and
 * makes such a call as another. Brackets around either are left out. The
 * message is the session's choice, and so are the brackets that a place
 * needs or does not.
 * @param {string[]} tokens
 */
export function withoutTodoMessages(tokens) {
  const read = [];
  // Each token that comes is read with the ones before it, which a bracket or a lambda can close around
  const push = (token) => {
    read.push(token);
    for (;;) {
      const [open, inner, close] = read.slice(-3);
      const lambda = read.slice(-5);
      if (read.length >= 3 && open === "(" && [TODO, TODO_FUNCTION].includes(inner) && close === ")") read.splice(-3, 3, inner);
      else if (lambda.length === 5 && lambda[0] === "\\" && /^[\p{Ll}_][\p{L}0-9_]*$/u.test(lambda[1]) && lambda[2] === "-" && lambda[3] === ">" && lambda[4] === TODO) {
        read.splice(-5, 5, TODO_FUNCTION);
      } else return;
    }
  };
  for (let at = 0; at < tokens.length; at++) {
    if (tokens[at] === "Debug" && tokens[at + 1] === "." && tokens[at + 2] === "todo") {
      let next = at + 3;
      if (tokens[next] === "<" && tokens[next + 1] === "|") next += 2;
      let brackets = 0;
      while (tokens[next + brackets] === "(") brackets++;
      const message = tokens[next + brackets];
      if (message?.startsWith('"') && tokens.slice(next + brackets + 1, next + 2 * brackets + 1).every((token) => token === ")")) {
        push(TODO);
        at = next + 2 * brackets;
        continue;
      }
    }
    push(tokens[at]);
  }
  return read;
}
