/**
 * The move-function task: which moves of a function to another module need no
 * judgment from the agent, the move as the plan makes it to see that the
 * project compiles with it, and how the files a session left are compared
 * with the files as they were. tasks.mjs words the request and holds a
 * session to it.
 *
 * A move needs no judgment where the destination can take the function as it
 * is. Every name the function uses means the same there: through the import
 * of its module that the destination has, under the qualifier that this
 * import gives, or through a plain import of the module that the destination
 * gets. A call with a qualifier names the destination's qualifier afterwards,
 * through a plain import of the destination where its module had none. A
 * call without one stays as it is, and its module imports the function by
 * name from the destination. No import cycle comes of it, and nothing in the
 * destination shares a name with the function or with what it names bare.
 */

import {
  commentsAbove,
  compiledFiles,
  declarationLines,
  DEFAULT_MODULES,
  importersOf,
  mentions,
  modulesByQualifier,
  NAME_END,
  namesUsed,
  refersTo,
  rewriteNames,
  scanSource,
  withExposing,
  withImport,
  withImportExposing,
} from "./elm-source.mjs";

// Every name that a module declares at its top: values, ports, types and variants
const declaredBy = (source) => new Set([...source.values, ...source.typeNames, ...source.types.flatMap((type) => type.variants)]);

// The names that another module can take from it
const exposedBy = (source) => new Set([...source.exposedValues, ...source.exposedTypes, ...source.types.filter((type) => type.open).flatMap((type) => type.variants)]);

// True when the file's import of `module` can let it use `name` bare: by name, through (..), or
// for a variant through the (..) of a type. What a module exposes is not known here, and a name
// that it does not give fails the build.
const givesBare = (source, name, module) => {
  const imported = source.imported.get(module);
  return imported !== undefined && (imported.everything || imported.names.includes(name) || (/^\p{Lu}/u.test(name) && imported.constructorsOf.length > 0));
};

// The module that the function takes a bare name from, by the record of them. A name such as
// toString is no key of it, whatever an object of JavaScript holds.
const takenFrom = (taken, name) => (Object.hasOwn(taken, name) ? taken[name] : undefined);

// The one qualifier that stands for `module` alone in a file, or undefined where none does
const qualifierOf = (qualifiers, module) => [...qualifiers].find(([, modules]) => modules.length === 1 && modules[0] === module)?.[0];

// The one module that a qualifier stands for, or undefined
const moduleOf = (qualifiers, qualifier) => (qualifiers.get(qualifier)?.length === 1 ? qualifiers.get(qualifier)[0] : undefined);

/**
 * The lines of a function's annotation and definition, and of the comment
 * right above them, which documents it: the first line and the line below
 * the last one. Null where the text does not declare the function.
 */
function linesOf(text, name) {
  const ranges = declarationLines(text, name);
  if (ranges.length === 0) return null;
  return { from: commentsAbove(text, ranges[0].from), to: ranges.at(-1).to };
}

// The text of the function, with the comment above it, and the text without them
function cut(text, name) {
  const place = linesOf(text, name);
  if (place === null) return { moved: "", rest: text };
  const lines = text.split("\n");
  return { moved: lines.slice(place.from, place.to).join("\n"), rest: [...lines.slice(0, place.from), ...lines.slice(place.to)].join("\n") };
}

// Where a file's imports take a bare name from: the modules that expose it for certain, and the
// packages that may, since what a package exposes is known only from an import that lists it
function sourcesOf(source, name, byModule, exposures) {
  const sure = new Set();
  const maybe = new Set();
  for (const [module, imported] of source.imported) {
    const known = byModule.get(module);
    const exposes = known
      ? imported.everything
        ? exposures.get(module).has(name)
        : imported.constructorsOf.some((type) => known.types.find((own) => own.name === type)?.variants.includes(name))
      : false;
    if (imported.names.includes(name) || exposes) sure.add(module);
    else if (!known && (imported.everything || imported.constructorsOf.length > 0)) maybe.add(module);
  }
  return { sure, maybe };
}

/**
 * The functions that can be moved without judgment, each with its
 * destination. Of the modules that can take a function, the destination is
 * the one that the most of its users import already, then the one that needs
 * the fewest new imports itself, then the first by path. One that the check
 * command does not compile is none.
 * @param {string[]} entries  The files the check command names. Without any, every module counts as compiled.
 */
export function moveCandidates(project, entries, minNameLength) {
  const byModule = new Map(project.map((source) => [source.module, source]));
  const compiled = entries.length > 0 ? compiledFiles(project, entries) : null;
  const declared = new Map(project.map((source) => [source.module, declaredBy(source)]));
  const exposures = new Map(project.map((source) => [source.module, exposedBy(source)]));
  const qualifiers = new Map(project.map((source) => [source.module, modulesByQualifier(source)]));
  // The modules of the project that a module imports, directly or not
  const reached = new Map();
  const reach = (module) => {
    if (!reached.has(module)) {
      const seen = new Set();
      const pending = [module];
      while (pending.length > 0) {
        for (const next of byModule.get(pending.pop())?.imports ?? []) {
          if (seen.has(next) || !byModule.has(next)) continue;
          seen.add(next);
          pending.push(next);
        }
      }
      reached.set(module, seen);
    }
    return reached.get(module);
  };
  const destinations = project.filter((source) => compiled === null || compiled.has(source.file));

  const candidates = [];
  for (const source of project) {
    const ownQualifiers = qualifiers.get(source.module);
    for (const name of source.exposedFunctions) {
      if (name.length < minNameLength) continue;
      // Its module can call it elsewhere, and then imports it from the destination
      const place = declarationLines(source.text, name);
      const elsewhere = source.code
        .split("\n")
        .map((line, at) => (place.some(({ from, to }) => from <= at && at < to) ? "" : line))
        .join("\n")
        .replace(/^(?:(?:port|effect)\s+)?(?:module|import)\b[^\n]*(?:\n(?!\S)[^\n]*)*/gm, "");
      const calledAtHome = mentions(elsewhere, name);
      // The module has to expose something else, since a module line exposes at least one thing
      if (source.exposedValues.length + source.exposedTypes.length < 2) continue;

      // The modules the function takes names from: through a qualifier, and bare from its own module
      // or from an import that gives the name. The other bare names are its own variables, what every
      // module has, and what may come from a package that gives names without a list of them.
      const uses = namesUsed(cut(source.text, name).moved).filter((use) => !(use.qualifier === "" && use.name === name));
      const qualified = [...new Set(uses.filter((use) => use.qualifier !== "").map((use) => use.qualifier))];
      const usedModules = new Set(qualified.map((qualifier) => moduleOf(ownQualifiers, qualifier)));
      if (usedModules.has(undefined)) continue;
      const bare = [...new Set(uses.filter((use) => use.qualifier === "").map((use) => use.name))];
      const sources = new Map(bare.map((used) => [used, sourcesOf(source, used, byModule, exposures)]));
      const own = bare.filter((used) => declared.get(source.module).has(used));
      // Another module can take only what the module exposes. A type and a variant can share a name,
      // and a type exposed without its variants is no way to them.
      const reachable = (used) =>
        source.types.every((type) => !type.variants.includes(used) || type.open) &&
        (!source.typeNames.includes(used) || source.exposedTypes.includes(used)) &&
        (!source.values.includes(used) || source.exposedValues.includes(used));
      if (!own.every(reachable)) continue;
      // A type of its module and a variant or record of an import can share a name, which the tokens do not tell apart
      if (own.some((used) => sources.get(used).sure.size > 0 || sources.get(used).maybe.size > 0)) continue;
      if (bare.some((used) => !own.includes(used) && sources.get(used).sure.size > 1)) continue;
      const taken = Object.fromEntries([
        ...own.map((used) => [used, source.module]),
        ...bare.filter((used) => !own.includes(used) && sources.get(used).sure.size === 1).map((used) => [used, [...sources.get(used).sure][0]]),
      ]);
      const free = bare.filter((used) => takenFrom(taken, used) === undefined);

      // A module that lists it in its import changes too, whether it calls it or not
      const users = importersOf(project, source.module).filter((user) => refersTo(user, source.module, name) || user.imported.get(source.module).names.includes(name));
      if (users.length === 0) continue;

      let best = null;
      for (const destination of destinations) {
        if (destination === source || mentions(destination.code, name)) continue;
        const theirs = qualifiers.get(destination.module);
        const theirDeclared = declared.get(destination.module);
        // A name taken bare here comes from that module there, bare or through a qualifier, and no other module gives it there
        const takenThere = Object.entries(taken).filter(([, module]) => module !== destination.module);
        const clashes = takenThere.some(([used, module]) => {
          const there = sourcesOf(destination, used, byModule, exposures);
          return theirDeclared.has(used) || [...there.sure].some((other) => other !== module);
        });
        // Any other bare name means there what it means here: the destination declares none of them and
        // gives none of them through an import, and a package can give one there only where it can here
        const changes = free.some((used) => {
          const [here, there] = [sources.get(used), sourcesOf(destination, used, byModule, exposures)];
          return theirDeclared.has(used) || there.sure.size > 0 || (here.maybe.size > 0 && [...there.maybe].some((module) => !here.maybe.has(module)));
        });
        if (clashes || changes) continue;
        // Each module the function takes a name from is imported there under a qualifier of its own, or
        // is imported anew under its whole name, which no other import may have as its alias
        const needed = new Set([...usedModules, ...takenThere.map(([, module]) => module)]);
        needed.delete(destination.module);
        const imports = [...needed].filter((module) => !destination.imports.includes(module) && !DEFAULT_MODULES.has(module)).sort();
        if (imports.some((module) => theirs.has(module))) continue;
        if ([...needed].some((module) => !imports.includes(module) && qualifierOf(theirs, module) === undefined)) continue;
        // A user without an import of the destination gets one, under the destination's own name, and so
        // does the function's own module where it calls the function
        const lacking = [...users, ...(calledAtHome ? [source] : [])].filter((user) => !user.imports.includes(destination.module));
        if (lacking.some((user) => qualifiers.get(user.module).has(destination.module))) continue;
        if (users.some((user) => user.imports.includes(destination.module) && qualifierOf(qualifiers.get(user.module), destination.module) === undefined)) continue;
        // No new import closes a circle: the destination reaches neither itself nor a module that will import it
        const below = new Set(reach(destination.module));
        for (const module of imports.filter((module) => byModule.has(module))) for (const next of [module, ...reach(module)]) below.add(next);
        if (below.has(destination.module) || lacking.some((user) => below.has(user.module)) || (calledAtHome && below.has(source.module))) continue;

        // Fewer modules that get an import of it first, then fewer new imports of its own, then the first by path
        const order = best && (lacking.length - best.lacking.length || imports.length - best.imports.length || (destination.file < best.destination.file ? -1 : 1));
        if (best === null || order < 0) best = { destination, lacking, imports };
      }
      if (best === null) continue;
      const { destination, lacking, imports } = best;
      const userFiles = users.map((user) => user.file);
      const theirs = qualifiers.get(destination.module);
      candidates.push({
        key: `${source.file}:${name}`,
        size: users.length,
        file: source.file,
        module: source.module,
        name,
        destination: destination.module,
        destinationFile: destination.file,
        // A module that imports the destination with everything it exposes gets one more name there, which can clash with one of its own
        affected: [...new Set([destination.file, ...userFiles, ...importersOf(project, destination.module).map((importer) => importer.file)])],
        mayChange: [source.file, destination.file, ...userFiles],
        users: userFiles,
        // The users that call it bare, which then import it by name from the destination, and the
        // others that get a plain import of the destination
        bareUsers: users.filter((user) => callsBare(user, source.module, name)).map((user) => user.file),
        calledAtHome,
        newImports: lacking.filter((user) => user !== source && !callsBare(user, source.module, name)).map((user) => user.file),
        // What the function takes bare, by the module it comes from, and what the destination imports anew
        taken,
        imports,
        // The names that the function takes from a module through the destination's own import of it, by
        // another qualifier than here or no longer bare
        requalified:
          qualified.some((qualifier) => {
            const module = moduleOf(ownQualifiers, qualifier);
            return !imports.includes(module) && (module === destination.module || qualifierOf(theirs, module) !== qualifier);
          }) ||
          Object.entries(taken).some(([used, module]) => {
            const there = sourcesOf(destination, used, byModule, exposures);
            return module !== destination.module && !imports.includes(module) && !there.sure.has(module) && !there.maybe.has(module);
          }),
      });
    }
  }
  return candidates;
}

/**
 * The destination's text as the move leaves it, without the function: what
 * it exposes takes the function's name, and it imports anew each module that
 * the move names, under the module's whole name.
 */
const destinationWithout = (text, { name, imports }) =>
  withExposing(
    imports.reduce((written, module) => withImport(written, `import ${module}`), text),
    name,
    true
  );

// True when a module calls the function of `module` bare, or may: its import of the module exposes it
// by name, or exposes everything and the module names the function bare
function callsBare(user, module, name) {
  const imported = user.imported.get(module);
  return imported !== undefined && (imported.names.includes(name) || (imported.everything && new RegExp(`(?<![\\p{L}0-9_.])${name}${NAME_END}`, "u").test(user.codeWithoutImports)));
}

// The text with the moved function imported by name from the destination: in the exposing list of its
// import of the destination, or in a new import line where it has none
const importedByName = (text, destination, name) =>
  scanSource("", text)?.imports.includes(destination) ? withImportExposing(text, destination, name, true) : withImport(text, `import ${destination} exposing (${name})`);

// The function's module as the move leaves it: without the function and without exposing it, and
// importing it by name from the destination where it calls it elsewhere
function sourceAfterMove(text, { name, destination, calledAtHome }) {
  const rest = withExposing(cut(text, name).rest, name, false);
  return calledAtHome ? importedByName(rest, destination, name) : rest;
}

// A user's text as the move leaves it apart from the qualifiers of its calls. One that calls the function
// bare takes it out of its import of the function's module and imports it by name from the destination.
// One that calls it qualified alone gets a plain import of the destination where it had none.
function userAfterMove(text, { name, module, destination }) {
  const user = scanSource("", text);
  if (user !== null && callsBare(user, module, name)) return importedByName(withImportExposing(text, module, name, false), destination, name);
  return user?.imports.includes(destination) ? text : withImport(text, `import ${destination}`);
}

// Rewrites the calls of a user to the moved function as `to(qualifier)` gives them, where its qualifier stands for `module`
const callsRewritten = (text, name, module, to) => {
  const qualifiers = modulesByQualifier(scanSource("", text));
  return rewriteNames(text, (use) => (use.name === name && use.qualifier !== "" && qualifiers.get(use.qualifier)?.includes(module) ? to(use.qualifier) : undefined));
};

/**
 * The move as the plan makes it, to see that the project compiles with it:
 * each file that it changes, with the text it then has. The function goes to
 * the end of the destination, with each name that it takes from a module
 * written through the qualifier that the destination gives that module.
 * @param {(file: string) => string} read  The text of a file of the project
 * @returns {Record<string, string>}
 */
export function movedFiles(target, read) {
  const { file, name, module, destination, destinationFile, users } = target;
  const [source, destinationText] = [read(file), read(destinationFile)];
  const { moved } = cut(source, name);
  const ownQualifiers = modulesByQualifier(scanSource(file, source));
  const landing = destinationWithout(destinationText, target);
  const theirs = modulesByQualifier(scanSource(destinationFile, landing));
  const written = rewriteNames(moved, ({ qualifier, name: used }) => {
    if (qualifier !== "") {
      const usedModule = moduleOf(ownQualifiers, qualifier);
      return usedModule === destination ? used : `${qualifierOf(theirs, usedModule)}.${used}`;
    }
    // A name of its own module, and one that an import gives it, through the destination's import of that module
    const from = takenFrom(target.taken, used);
    return from === undefined || from === destination ? undefined : `${qualifierOf(theirs, from)}.${used}`;
  });
  const files = {
    [file]: sourceAfterMove(source, target),
    [destinationFile]: `${landing.trimEnd()}\n\n\n${written}\n`,
  };
  for (const user of users) {
    const text = userAfterMove(read(user), target);
    const qualifier = qualifierOf(modulesByQualifier(scanSource(user, text)), destination);
    files[user] = callsRewritten(text, name, module, () => `${qualifier}.${name}`);
  }
  return files;
}

/**
 * The function's annotation and definition as they read wherever they stand:
 * every qualified name with the whole name of its module, and every bare name
 * that stands for a name of a module with that module's name in front. `owner`
 * gives the module that a bare name stands for, or undefined.
 */
function canonical(text, name, owner) {
  const qualifiers = modulesByQualifier(scanSource("", text));
  const written = rewriteNames(text, ({ qualifier, name: used }) => {
    if (qualifier !== "") return `${moduleOf(qualifiers, qualifier) ?? qualifier}.${used}`;
    const module = used === name ? undefined : owner(used);
    return module === undefined ? undefined : `${module}.${used}`;
  });
  return cut(written, name).moved;
}

/**
 * The texts that a session's move is compared with, for one file that the
 * session changed: pairs of what the file should hold and what it holds,
 * which the comparison of tokens then reads. The function itself is compared
 * on its own, with its names read as `canonical` writes them, and its pair
 * has the part "function". The pairs of whole files have the part "file".
 * @param {{ name: string, module: string, destination: string, from: string, to: string, taken: Record<string, string>, imports: string[], calledAtHome: boolean }} move
 * @param {string} file  A file the session changed
 * @param {(file: string) => string | null} original  Its text when the session began
 * @param {(file: string) => string | null} now  Its text as the session left it
 * @returns {{ part: "file" | "function", expected: string, found: string }[]}
 */
export function movePairs(move, file, original, now) {
  const { name, module, destination, from, to, taken } = move;
  const [was, is] = [original(file), now(file)];
  if (file === from) return [{ part: "file", expected: sourceAfterMove(was, move), found: is }];
  if (file === to) {
    const there = scanSource(to, is);
    const theirDeclared = there ? declaredBy(there) : new Set();
    // In the destination a bare name can stand for one of the destination, for one that an import
    // there exposes by name, and for one that the function takes bare where the destination's
    // import of its module gives it bare
    const ownerThere = (used) => {
      if (theirDeclared.has(used)) return destination;
      const listing = [...(there?.imported ?? [])].find(([, imported]) => imported.names.includes(used));
      if (listing) return listing[0];
      const of = takenFrom(taken, used);
      return of !== undefined && of !== destination && there && givesBare(there, used, of) ? of : undefined;
    };
    const ownerHere = (used) => takenFrom(taken, used);
    return [
      { part: "file", expected: destinationWithout(was, move), found: cut(is, name).rest },
      { part: "function", expected: canonical(original(from), name, ownerHere), found: canonical(is, name, ownerThere) },
    ];
  }
  return [
    {
      part: "file",
      expected: callsRewritten(userAfterMove(was, move), name, module, () => `${destination}.${name}`),
      found: callsRewritten(is, name, destination, () => `${destination}.${name}`),
    },
  ];
}
