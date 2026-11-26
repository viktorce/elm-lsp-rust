/**
 * The task types. Each one finds targets in a scanned project, words the
 * request for the agent, and lists what must hold once the agent is done.
 *
 * Targets are found and outcomes are checked with elm-source.mjs and the
 * project's own compiler. The language server takes no part in either.
 */

import { existsSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { isDeepStrictEqual } from "util";
import {
  codeOnly,
  countBy,
  filesOf,
  layoutOf,
  literalLineStarts,
  headerLine,
  importersOf,
  mentions,
  NAME_END,
  namesIn,
  namesType,
  readersOf,
  refersTo,
  scanProject,
  scanSource,
  tokensOf,
  UPPER_NAME,
  withVariant,
} from "./elm-source.mjs";
import { moveCandidates, movedFiles, movePairs } from "./move.mjs";
import { difference, problem, tokenDifference } from "./problems.mjs";
import { fieldCandidates, removalTrial, removedFrom, variantCandidates, withoutTodoMessages } from "./remove.mjs";

// Suffix of every new name. A target whose new name stands in the project's code already is left
// out. A function without an annotation, a record alias or a variable of that name would clash
// with the renamed target.
const SUFFIX = "Renamed";

// Variant that the add-variant task introduces
const NEW_VARIANT = "AddedByBenchmark";

// A name this short is too likely to appear inside unrelated words and strings
const MIN_NAME_LENGTH = 4;

// What a removal finds its candidates by: the shortest name it takes, and the new name of the
// trial's rename, which must not stand in the code already
const REMOVABLE = { minNameLength: MIN_NAME_LENGTH, suffix: SUFFIX };

// A removal leaves what it removes unused, and the request says what becomes of that
const LEAVE_THE_REST = "Leave every other function, variable and import as it is, also one that the removal leaves unused.";

/**
 * @typedef {object} Target
 * @property {string} key    Stable identity, used to order equal candidates
 * @property {number} size   How many files the change is expected to touch
 * @property {string} file   The file that declares the target
 * @property {string} module  The module in that file
 * @property {string[]} affected  Other files that the change can break
 *
 * @typedef {object} TaskType
 * @property {string} id
 * @property {string} title
 * @property {(project: import("./elm-source.mjs").ElmFile[], entries: string[]) => Target[]} candidates
 * @property {(target: Target, check: string, project?: { exposed?: string[] }) => { prompt: string, expect: object[], facts: object }} build
 *   `project.exposed` has the modules that elm.json lists as exposed, where the project is a package
 * @property {Trial} [trial]
 *
 * @typedef {object} Trial  Changes that the planner makes in a checkout and builds, one after the
 *   other, before it takes a target. It keeps the target only where the compiler says what the
 *   trial asks of each: that there is work to do, or that the change compiles.
 * @property {(target: Target, read: (file: string) => string) => Record<string, string>[] | null} edits
 *   The changes, each as the files it makes with their new texts. Null where they cannot be made.
 * @property {boolean} compiles  Whether the project has to compile with each change, or to fail
 * @property {(target: Target, index: number) => string} what  The change of that index, as "with the variant X added to the type T in F"
 * @property {string} question  What a build that ran out of time leaves unknown
 * @property {(tried: string) => string} vain  What the builds said of the targets that were tried in vain, `tried` being which ones
 * @property {(count: number) => string} unmade  Why `count` targets could not be tried
 */

/** "the one target that was tried", "each of the 3 targets that were tried" */
export const triedTargets = (count) => (count === 1 ? "the one target that was tried" : `each of the ${count} targets that were tried`);

/** "10", "10 and 50", "10, 50 and 100" */
export const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** "1 session", "2 sessions": a number with the word for one of the thing, or for several */
export const plural = (number, one, many) => `${number} ${number === 1 ? one : many}`;

// Every prompt ends the same way. The verdict holds a session to "nothing else", so the request says it.
const closing = (check) =>
  `Change nothing else. The project compiles with \`${check}\`, run from the current directory. ` +
  `It must still compile when you are done. Do not create commits.`;

// Functions to rename. `shared` asks for a name that other modules declare too.
function functionCandidates(project, shared) {
  const declarations = countBy(project.flatMap((source) => source.functions));
  const taken = namesIn(project);
  const aliases = project.flatMap((source) => source.aliases.map((alias) => ({ file: source.file, alias })));
  const candidates = [];
  for (const source of project) {
    for (const name of source.functions) {
      const elsewhere = declarations.get(name) - 1;
      if (name.length < MIN_NAME_LENGTH || taken.has(name + SUFFIX)) continue;
      if (shared ? elsewhere < 3 : elsewhere !== 0) continue;

      const importers = importersOf(project, source.module);
      candidates.push({
        key: `${source.file}:${name}`,
        // No other module can name a function that its own module keeps to itself
        size: source.exposedFunctions.includes(name) ? importers.filter((importer) => refersTo(importer, source.module, name)).length : 0,
        file: source.file,
        affected: filesOf(importers),
        module: source.module,
        name,
        mayChange: [source.file, ...filesOf(importers)],
        namesakes: filesOf(project.filter((other) => other !== source && other.functions.includes(name))),
        // Records with a field of the function's name. A text replace renames that too.
        fields: aliases.filter(({ alias }) => alias.fields.includes(name)).map(({ file, alias }) => ({ file, alias: alias.name })),
      });
    }
  }
  return candidates;
}

function buildFunctionRename({ file, module, name, mayChange, namesakes, fields, size }, check) {
  const newName = name + SUFFIX;
  const asides = [
    "",
    ` 1 other module declares a \`${name}\` of its own. That is a different function and keeps its name.`,
    ` ${namesakes.length} other modules declare a \`${name}\` of their own. Those are different functions and keep their name.`,
  ];
  const aside = asides[Math.min(namesakes.length, 2)];
  return {
    prompt:
      `Rename the function \`${name}\` of the module \`${module}\` (\`${file}\`) to \`${newName}\`, ` +
      `and update every use of it in the project.${aside}\n\n${closing(check)}`,
    expect: [
      { kind: "declares-function", file, name: newName },
      { kind: "lacks-function", file, name },
      ...(namesakes.length > 0 ? [{ kind: "functions-kept", name, files: namesakes }] : []),
      ...(fields.length > 0 ? [{ kind: "fields-kept", field: name, aliases: fields }] : []),
      { kind: "renames-only", of: "function", from: name, to: newName },
      { kind: "changes-only-in", files: mayChange },
      { kind: "only-elm-files" },
    ],
    facts: { filesUsingIt: size, namesakes: namesakes.length },
  };
}

/** @type {TaskType[]} */
export const TASK_TYPES = [
  {
    id: "rename-function",
    title: "Rename a function with a unique name",
    candidates: (project) => functionCandidates(project, false),
    build: buildFunctionRename,
  },

  {
    id: "rename-shared-function",
    title: "Rename a function whose name other modules also use",
    candidates: (project) => functionCandidates(project, true),
    build: buildFunctionRename,
  },

  {
    id: "rename-variant",
    title: "Rename a variant of a custom type",
    candidates(project) {
      const types = project.flatMap((source) => source.types.map((type) => ({ file: source.file, type })));
      const taken = namesIn(project);
      const candidates = [];
      for (const source of project) {
        for (const type of source.types) {
          for (const variant of type.variants) {
            // In `type Email = Email String` the tokens of a use do not tell the type from its variant
            if (variant.length < MIN_NAME_LENGTH || taken.has(variant + SUFFIX) || variant === type.name) continue;
            const importers = importersOf(project, source.module);
            candidates.push({
              key: `${source.file}:${type.name}.${variant}`,
              // No other module can name a variant that its own module keeps to itself
              size: type.open ? importers.filter((importer) => refersTo(importer, source.module, variant, type.name)).length : 0,
              file: source.file,
              module: source.module,
              affected: filesOf(importers),
              type: type.name,
              variant,
              mayChange: [source.file, ...filesOf(importers)],
              // Other types with a variant of the same name. A text replace renames those too.
              namesakes: types
                .filter((other) => other.type !== type && other.type.variants.includes(variant))
                .map((other) => ({ file: other.file, type: other.type.name })),
              // Types of the variant's own name, as in `type Page = Settings Settings`
              types: filesOf(project.filter((other) => other.typeNames.includes(variant))),
            });
          }
        }
      }
      return candidates;
    },
    build({ file, type, variant, mayChange, namesakes, types, size }, check) {
      const newVariant = variant + SUFFIX;
      const aside =
        namesakes.length > 0
          ? ` ${plural(namesakes.length, "other custom type has", "other custom types have")} a variant called \`${variant}\` too. It keeps that name there.`
          : "";
      return {
        prompt:
          `Rename the variant \`${variant}\` of the custom type \`${type}\` in \`${file}\` to \`${newVariant}\`, ` +
          `and update every place that constructs it or matches on it.${aside}\n\n${closing(check)}`,
        expect: [
          { kind: "type-has-variant", file, type, variant: newVariant },
          { kind: "type-lacks-variant", file, type, variant },
          ...(namesakes.length > 0 ? [{ kind: "variants-kept", variant, types: namesakes }] : []),
          ...(types.length > 0 ? [{ kind: "types-kept", name: variant, files: types }] : []),
          { kind: "renames-only", of: "variant", from: variant, to: newVariant },
          { kind: "changes-only-in", files: mayChange },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size, namesakes: namesakes.length },
      };
    },
  },

  {
    id: "rename-field",
    title: "Rename a record field whose name other records also use",
    candidates(project) {
      const aliases = project.flatMap((source) => source.aliases.map((alias) => ({ file: source.file, alias })));
      const owners = countBy(aliases.flatMap(({ alias }) => alias.fields));
      // A function over { a | name : String } takes every record that has the field. With the field
      // renamed on one of them alone, a call that passes that record for it no longer compiles.
      const open = new Set(project.flatMap((source) => source.openFields));
      const taken = namesIn(project);
      const candidates = [];
      for (const source of project) {
        for (const alias of source.aliases) {
          for (const field of alias.fields) {
            // The task is about telling records apart, so the name must be on at least two other records
            if (field.length < MIN_NAME_LENGTH || owners.get(field) < 3 || taken.has(field + SUFFIX) || open.has(field)) continue;
            const users = importersOf(project, source.module).filter(
              (importer) => mentions(importer.code, alias.name) && mentions(importer.code, field)
            );
            candidates.push({
              key: `${source.file}:${alias.name}.${field}`,
              size: users.length,
              file: source.file,
              module: source.module,
              affected: readersOf(project, source, field),
              alias: alias.name,
              field,
              namesakes: aliases
                .filter((other) => other.alias !== alias && other.alias.fields.includes(field))
                .map((other) => ({ file: other.file, alias: other.alias.name })),
              // Functions of the field's name
              functions: filesOf(project.filter((other) => other.functions.includes(field))),
            });
          }
        }
      }
      return candidates;
    },
    build({ file, alias, field, namesakes, functions, size }, check) {
      const newField = field + SUFFIX;
      return {
        prompt:
          `Rename the field \`${field}\` of the record type alias \`${alias}\` in \`${file}\` to \`${newField}\`. ` +
          `Update every place that reads, sets or pattern-matches that field on a value of type \`${alias}\`. ` +
          `Where a record pattern binds the field to a variable, the variable takes the new name as well. ` +
          `${plural(namesakes.length, "other record type has", "other record types have")} a field called \`${field}\` too. It keeps that name there.\n\n${closing(check)}`,
        expect: [
          { kind: "alias-has-field", file, alias, field: newField },
          { kind: "alias-lacks-field", file, alias, field },
          { kind: "fields-kept", field, aliases: namesakes },
          ...(functions.length > 0 ? [{ kind: "functions-kept", name: field, files: functions }] : []),
          { kind: "renames-only", of: "field", from: field, to: newField },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size, namesakes: namesakes.length },
      };
    },
  },

  {
    id: "rename-module",
    title: "Rename a module",
    candidates(project, entries) {
      const taken = namesIn(project);
      return project
        // The check command names its entry files by path, so those stay where they are.
        // A module's name is taken where its last part is, in a module line or as an alias.
        .filter((source) => !entries.includes(source.file) && !taken.has(source.module.split(".").at(-1) + SUFFIX))
        .map((source) => {
          const importers = importersOf(project, source.module);
          const newFile = source.file.replace(/\.elm$/, `${SUFFIX}.elm`);
          return {
            key: source.file,
            size: importers.length,
            file: source.file,
            affected: filesOf(importers),
            module: source.module,
            newFile,
            mayChange: [source.file, newFile, ...filesOf(importers)],
          };
        });
    },
    build({ file, module, newFile, mayChange, size }, check, { exposed = [] } = {}) {
      const newModule = module + SUFFIX;
      // No import leads to the list of modules in a package's elm.json, and a build of one file does not read it
      const listed = exposed.includes(module) ? " The package exposes the module, so change its name in the `exposed-modules` of `elm.json` as well." : "";
      // A module is named in parts, and the last part is the one that changes
      const lastPart = module.split(".").at(-1);
      return {
        prompt:
          `Rename the module \`${module}\` to \`${newModule}\`. Move \`${file}\` to \`${newFile}\`, ` +
          `and update every import of the module and every qualified reference to it.${listed}\n\n${closing(check)}`,
        expect: [
          { kind: "file-missing", file },
          { kind: "declares-module", file: newFile, module: newModule },
          { kind: "no-import-of", module },
          { kind: "renames-only", of: "module", from: lastPart, to: lastPart + SUFFIX, moved: [file, newFile] },
          { kind: "changes-only-in", files: mayChange },
          // A package lists the modules it exposes in elm.json, where this one has to change its name too
          { kind: "only-elm-files", except: ["elm.json"] },
          { kind: "elm-json-renames-only", from: module, to: newModule },
        ],
        facts: { filesImportingIt: size },
      };
    },
  },

  {
    id: "add-variant",
    title: "Add a variant and handle it in every case expression",
    trial: {
      edits({ file, type }, read) {
        const text = withVariant(read(file), type, NEW_VARIANT);
        return text === null ? null : [{ [file]: text }];
      },
      compiles: false,
      what: ({ file, type }) => `with the variant ${NEW_VARIANT} added to the type ${type} in ${file}`,
      question: "whether the variant breaks the build",
      vain: (tried) => `the project still compiled with the change made to ${tried}, so there was no work to ask for`,
      unmade: (count) => `the plan adds a variant on a line of its own, as elm-format lays a type out, and ${count === 1 ? "the one target is" : `none of the ${count} targets is`} written that way`,
    },
    candidates(project) {
      if (namesIn(project).has(NEW_VARIANT)) return [];
      const candidates = [];
      for (const source of project) {
        for (const type of source.types.filter((type) => type.variants.length >= 3)) {
          // A line such as "        Loading ->" or "        Page.Loading _ ->"
          const branch = new RegExp(`^ +(?:${UPPER_NAME}\\.)*(?:${type.variants.join("|")})${NAME_END}[^=\\n]*->`, "mu");
          const importers = importersOf(project, source.module);
          candidates.push({
            key: `${source.file}:${type.name}`,
            // Files with a branch on one of this type's variants, not on a namesake of another module's type.
            // Where the module keeps the variants to itself, its own file is the only one.
            size: [source, ...(type.open ? importers : [])].filter(
              (user) => branch.test(user.code) && type.variants.some((variant) => refersTo(user, source.module, variant, type.name))
            ).length,
            file: source.file,
            module: source.module,
            affected: filesOf(importers),
            type: type.name,
            mayChange: [source.file, ...filesOf(importers)],
          });
        }
      }
      return candidates;
    },
    build({ file, type, mayChange, size }, check) {
      return {
        prompt:
          `Add a variant \`${NEW_VARIANT}\`, without arguments, as the last variant of the custom type \`${type}\` in \`${file}\`. ` +
          `Wherever the compiler then reports a missing case, add a branch for \`${NEW_VARIANT}\` ` +
          `whose body is \`Debug.todo\` with a string literal of your choice for its message.\n\n${closing(check)}`,
        expect: [
          { kind: "type-has-variant", file, type, variant: NEW_VARIANT, last: true },
          { kind: "adds-variant-and-branches", variant: NEW_VARIANT },
          { kind: "changes-only-in", files: mayChange },
          { kind: "only-elm-files" },
        ],
        facts: { filesMatchingOnIt: size },
      };
    },
  },

  {
    id: "rename-type",
    title: "Rename a custom type or a type alias",
    candidates(project) {
      const taken = namesIn(project);
      const variants = project.flatMap((source) => source.types.flatMap((type) => type.variants.map((variant) => ({ file: source.file, type: type.name, variant }))));
      const candidates = [];
      for (const source of project) {
        for (const name of source.typeNames) {
          if (name.length < MIN_NAME_LENGTH || taken.has(name + SUFFIX)) continue;
          const importers = importersOf(project, source.module);
          candidates.push({
            key: `${source.file}:${name}`,
            // No other module can name a type that its own module keeps to itself
            size: source.exposedTypes.includes(name) ? importers.filter((importer) => namesType(importer, source.module, name)).length : 0,
            file: source.file,
            module: source.module,
            affected: filesOf(importers),
            name,
            kind: source.types.some((type) => type.name === name) ? "custom type" : "type alias",
            mayChange: [source.file, ...filesOf(importers)],
            // Types of the same name in other modules
            namesakes: filesOf(project.filter((other) => other !== source && other.typeNames.includes(name))),
            // Variants of the type's name, as in `type Email = Email String`, and on other types. A text replace renames those too.
            variants: variants.filter(({ variant }) => variant === name).map(({ file, type }) => ({ file, type })),
          });
        }
      }
      return candidates;
    },
    build({ file, name, kind, mayChange, namesakes, variants, size }, check) {
      const newName = name + SUFFIX;
      const own = variants.some((variant) => variant.file === file && variant.type === name);
      const others = variants.length - (own ? 1 : 0);
      const asides = [
        own ? ` Its variant \`${name}\` keeps its name.` : "",
        others > 0 ? ` ${plural(others, "other custom type has", "other custom types have")} a variant called \`${name}\`. It keeps that name there.` : "",
        namesakes.length > 0 ? ` ${plural(namesakes.length, "other module declares", "other modules declare")} a type \`${name}\` of ${namesakes.length === 1 ? "its" : "their"} own. That keeps its name.` : "",
      ].join("");
      return {
        prompt:
          `Rename the ${kind} \`${name}\` in \`${file}\` to \`${newName}\`, ` +
          `and update every place that names it in the project.${asides}\n\n${closing(check)}`,
        expect: [
          { kind: "declares-type", file, name: newName },
          { kind: "lacks-type", file, name },
          ...(namesakes.length > 0 ? [{ kind: "types-kept", name, files: namesakes }] : []),
          // The type's own variant stays with the type under its new name
          ...(variants.length > 0
            ? [{ kind: "variants-kept", variant: name, types: variants.map((variant) => (variant.file === file && variant.type === name ? { file, type: newName } : variant)) }]
            : []),
          { kind: "renames-only", of: "type", from: name, to: newName },
          { kind: "changes-only-in", files: mayChange },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size, namesakes: namesakes.length },
      };
    },
  },

  {
    id: "move-function",
    title: "Move a function to another module",
    candidates: (project, entries = []) => moveCandidates(project, entries, MIN_NAME_LENGTH),
    trial: {
      edits: (target, read) => [movedFiles(target, read)],
      compiles: true,
      what: ({ name, file, destinationFile }) => `with the function ${name} moved from ${file} to ${destinationFile}`,
      question: "whether the project compiles with the move",
      vain: (tried) => `the project did not compile once the plan had moved the function of ${tried}`,
      unmade: (count) => `the plan could not move the function of ${count === 1 ? "the one target" : `any of the ${count} targets`}`,
    },
    build({ file, module, name, destination, destinationFile, users, bareUsers, calledAtHome, newImports, taken, imports, requalified, mayChange, size }, check) {
      const quoted = (names) => listed(names.map((each) => `\`${each}\``));
      const asides = [
        bareUsers.length > 0 || calledAtHome
          ? ` A call of it without a qualifier stays as it is. A module that calls it so, or that lists it in its import of \`${module}\`, imports \`${name}\` by name from \`${destination}\` instead: ` +
            `add it to the exposing list of the module's import of \`${destination}\`, or add the line \`import ${destination} exposing (${name})\` where there is none, ` +
            `and take it out of the exposing list of the import of \`${module}\`, together with the word \`exposing\` where nothing else stays in that list.`
          : "",
        newImports.length > 0
          ? ` ${plural(newImports.length, "module that calls it with a qualifier does", "modules that call it with a qualifier do")} not import \`${destination}\` yet. Add the line \`import ${destination}\` to ${newImports.length === 1 ? "it" : "each of them"}.`
          : "",
        imports.length > 0
          ? ` The function takes names from ${quoted(imports)}, which \`${destination}\` does not import. Add the line ${quoted(imports.map((each) => `import ${each}`))} to \`${destination}\`, ` +
            `and write each name that the function takes from ${imports.length === 1 ? "that module" : "them"} with the whole name of its module in front.`
          : "",
        requalified
          ? ` The function takes every other name of another module through the import of that module that \`${destination}\` has. ` +
            `A name that the function writes with a qualifier gets the qualifier of that import. A name that it writes bare stays bare where that import exposes it, and gets that qualifier where it does not.`
          : "",
      ].join("");
      return {
        prompt:
          `Move the function \`${name}\`, with its type annotation, from the module \`${module}\` in \`${file}\` to the module \`${destination}\` in \`${destinationFile}\`. ` +
          `\`${destination}\` exposes it from then on, and \`${module}\` no longer does. ` +
          `A call of it with a qualifier names it through the module's import of \`${destination}\` from then on, with the qualifier that this import gives.${asides} ` +
          `Leave every other import as it is, also one that the move leaves unused.\n\n${closing(check)}`,
        expect: [
          { kind: "declares-function", file: destinationFile, name },
          { kind: "lacks-function", file, name },
          { kind: "moves-function", name, module, destination, from: file, to: destinationFile, users, taken, imports, calledAtHome },
          { kind: "changes-only-in", files: mayChange },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size, newImports: newImports.length },
      };
    },
  },

  {
    id: "remove-variant",
    title: "Remove a variant and every branch that matches on it",
    candidates: (project) => variantCandidates(project, REMOVABLE),
    trial: {
      edits: ({ file, module, type, variant, users }, read) => removalTrial({ of: "variant", file, module, type, variant, users }, read, variant + SUFFIX),
      compiles: true,
      what: ({ file, type, variant }, index) =>
        index === 0 ? `with the variant ${variant} of the type ${type} in ${file} renamed wherever the plan reads a use of it` : `with the variant ${variant} removed from the type ${type} in ${file}`,
      question: "whether the project compiles with the change",
      vain: (tried) => `the project did not compile once the plan had removed the variant of ${tried}, or renamed it wherever the plan reads a use of it`,
      unmade: (count) => `the plan could not make the removal of ${count === 1 ? "the one target" : `any of the ${count} targets`}`,
    },
    build({ file, module, type, variant, users, size }, check) {
      return {
        prompt:
          `Remove the variant \`${variant}\` from the custom type \`${type}\` in \`${file}\`. ` +
          `Remove every branch of a \`case\` whose pattern names \`${variant}\`, also where it stands inside a tuple or inside the pattern of another variant, as in \`( ${variant}, _ )\` or \`Just ${variant}\`, since such a branch can no longer match. ` +
          `A \`case\` that is left with one branch stays a \`case\`. ` +
          `Replace every other use of \`${variant}\`, also one written with a qualifier, with \`Debug.todo\` and a string literal of your choice for its message. ` +
          `Where arguments follow \`${variant}\` directly, as in \`${variant} a b\`, the whole application with its arguments is replaced. ` +
          `Elsewhere, as in \`List.map ${variant} items\` or \`${variant} <| a\`, only the name is. ${LEAVE_THE_REST}\n\n${closing(check)}`,
        expect: [
          { kind: "type-lacks-variant", file, type, variant },
          { kind: "removes-only", removal: { of: "variant", file, module, type, variant, users } },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size },
      };
    },
  },

  {
    id: "remove-field",
    title: "Remove a record field and replace every read of it",
    candidates: (project) => fieldCandidates(project, REMOVABLE),
    trial: {
      edits: ({ file, module, alias, field, fields, users }, read) => removalTrial({ of: "field", file, module, alias, field, fields, users }, read, field + SUFFIX),
      compiles: true,
      what: ({ file, alias, field }, index) =>
        index === 0 ? `with the field ${field} of the alias ${alias} in ${file} renamed wherever the plan reads a use of it` : `with the field ${field} removed from the alias ${alias} in ${file}`,
      question: "whether the project compiles with the change",
      vain: (tried) => `the project did not compile once the plan had removed the field of ${tried}, or renamed it wherever the plan reads a use of it`,
      unmade: (count) => `the plan could not make the removal of ${count === 1 ? "the one target" : `any of the ${count} targets`}`,
    },
    build({ file, module, alias, field, fields, users, size }, check) {
      return {
        prompt:
          `Remove the field \`${field}\` from the record type alias \`${alias}\` in \`${file}\`. ` +
          `Take it out of every record that is built with it, as in \`{ ${field} = ..., ... }\`, together with its value, and out of every record update that sets it, as in \`{ r | ${field} = ... }\`. ` +
          `An update that sets no other field becomes the record alone, \`r\`. ` +
          `Replace every read of the field with \`Debug.todo\` and a string literal of your choice for its message. ` +
          `A read with a dot, as in \`user.${field}\` or \`(get id).${field}\`, is replaced together with the record in front of the dot, and a field read behind it stays, as in \`(Debug.todo "...").next\` for \`user.${field}.next\`. ` +
          `An accessor function, \`.${field}\`, also in a pipeline as in \`user |> .${field}\`, becomes a function that ignores its argument, \`\\_ -> Debug.todo "..."\`. ` +
          `No other record type of the project has a field \`${field}\`, no record pattern names it, and no code calls \`${alias}\` as a function. ${LEAVE_THE_REST}\n\n${closing(check)}`,
        expect: [
          { kind: "alias-lacks-field", file, alias, field },
          { kind: "removes-only", removal: { of: "field", file, module, alias, field, fields, users } },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size },
      };
    },
  },
];

/**
 * The targets of one task type in a project that involve at least `minFiles`
 * files, in the order of the candidates. levels.mjs picks among them.
 *
 * The check command must compile the target's file and every file the change
 * can break. The compiler's verdict says nothing about a module it never
 * reads, such as a test module, so a reference left behind there would pass.
 *
 * @param {string[]} entries     The files the check command names
 * @param {Set<string>} compiled  The files it compiles from them
 * @param {Target[]} [candidates]  The candidates of the task type, where the caller found them already
 */
export function suitableTargets(taskType, project, { entries, compiled }, minFiles, candidates = taskType.candidates(project, entries)) {
  return candidates.filter((target) => target.size >= minFiles && [target.file, ...target.affected].every((file) => compiled.has(file)));
}

/**
 * True when an Elm file outside the project can use the target: it imports
 * the target's module, or names the field, which needs no import. The check
 * command never compiles such a file. A change that left it behind would
 * pass, and one that followed it there would count as changing a file that
 * cannot use the target. A function that moves gives its destination one
 * more name, which can clash with one of such a file that imports it.
 * @param {import("./elm-source.mjs").ElmFile[]} outsiders
 */
export function usedOutside(target, outsiders) {
  return outsiders.some(
    (outsider) =>
      [target.module, target.destination].some((module) => module !== undefined && outsider.imports.includes(module)) ||
      (target.field !== undefined && mentions(outsider.code, target.field))
  );
}

/**
 * The file outside the check command's build that holds back the most
 * candidates of a task type, with how many, and how many such files there
 * are, or null when no candidate is held back for that reason. A plan that
 * finds no target can then say what to add to the check command.
 * @param {Target[]} [candidates]  The candidates of the task type, where the caller found them already
 * @returns {{ file: string, candidates: number, files: number } | null}
 */
export function heldBack(taskType, project, { entries, compiled }, minFiles, candidates = taskType.candidates(project, entries)) {
  const counts = new Map();
  for (const target of candidates.filter((target) => target.size >= minFiles)) {
    for (const file of new Set([target.file, ...target.affected])) {
      if (!compiled.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const [worst] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return worst ? { file: worst[0], candidates: worst[1], files: counts.size } : null;
}

const read = (elmRoot, file) => (existsSync(join(elmRoot, file)) ? readFileSync(join(elmRoot, file), "utf-8") : null);

const scan = (elmRoot, file) => {
  const text = read(elmRoot, file);
  return text === null ? null : scanSource(file, text);
};

// A definition starts in column 0, however the rest of it is laid out
const declares = (elmRoot, file, name) => new RegExp(`^${name}${NAME_END}`, "mu").test(codeOnly(read(elmRoot, file) ?? ""));

const variantsOf = (elmRoot, file, type) => scan(elmRoot, file)?.types.find((t) => t.name === type)?.variants ?? [];

const fieldsOf = (elmRoot, file, alias) => scan(elmRoot, file)?.aliases.find((a) => a.name === alias)?.fields ?? [];

// What a pattern is made of, once strings and comments are taken out: names, the dots of a
// qualified one, digits with the minus sign of a negative number, brackets, commas, the colons
// of a list and blanks
const PATTERN_PARTS = /^[\p{L}0-9_.\s()[\]{},:-]*$/u;

// How many brackets a text leaves open, or -1 where it closes one that it never opened
function openBrackets(code) {
  let depth = 0;
  for (const character of code) {
    if ("([{".includes(character)) depth++;
    else if (")]}".includes(character) && --depth < 0) return -1;
  }
  return depth;
}

// One part of the body of an added branch, with the space in front of it: a bracket, the call,
// the "<|" behind it, or its message as a string literal in three quotes or in one. A literal in
// three quotes can go on over several lines, and one that the text does not end is told by its
// missing end.
const BODY_PART = /\s*(?:([()])|(Debug\.todo)(?![\p{L}0-9_.])|(<\|)|("""(?:[^"\\]|\\[^]|"(?!""))*(?:(""")|$))|"(?:[^"\\]|\\.)*")/uy;

// Where a module line or an import can name a thing of each kind, by the place of a token in
// it and the place of "exposing": a module in front of that word, a function behind it
const NAMED_IN_HEADER = {
  module: (at, exposing) => at < exposing,
  function: (at, exposing) => at > exposing,
  type: (at, exposing) => at > exposing,
  variant: () => false,
  field: () => false,
};

/**
 * What a text holds beyond the rename of `from` to `to`, compared with what
 * it was: null when every token is the one that was there, or `to` in the
 * place of `from`. Layout and comments are free. Anything else, a changed
 * string literal for one, comes back as a few words on the first difference,
 * with the id of the words, which decides the kind of the problem.
 * A text replace that also reached into a string would otherwise pass, as
 * long as the project still compiles.
 *
 * `of` is the kind of thing that is renamed, which decides where its name can
 * stand. A module's name changes in front of a dot, and in a module line or
 * an import outside of what that exposes: a module often declares a type of
 * its own name, `module User exposing (User)`, and that type keeps its name.
 * A function's name and a type's change in what such a line exposes and
 * nowhere else in it. A module's name stands in front of a dot and a type's
 * never does, so in `Email.Email` only the second is the type. A variant and
 * a field are named in none of them, so an import alias of the variant's
 * name, `import Page.Settings as Settings`, keeps its name too.
 * @param {{ of: "function" | "type" | "variant" | "field" | "module", from: string, to: string }} rename
 * @param {(tokens: string[]) => string[]} [normal]  What the tokens of the code below the imports are read as, on both sides
 */
function beyondRename(before, after, { of, from, to }, normal = (tokens) => tokens) {
  const [was, is] = [tokensOf(before), tokensOf(after)];
  const [wasBody, isBody] = [normal(was.body), normal(is.body)];
  for (let at = 0; at < Math.max(wasBody.length, isBody.length); at++) {
    const [old, now] = [wasBody[at], isBody[at]];
    const renamed = old === from && now === to && (of === "module" ? isBody[at + 1] === "." : of !== "type" || isBody[at + 1] !== ".");
    if (old !== now && !renamed) {
      return tokenDifference(old ?? "the end of the file", now ?? "the end of the file");
    }
  }
  // The module line and the imports may come in another order, and so may what each of them
  // exposes. Line by line they are the same, with `to` read as `from`: an alias that went to
  // another import, or an exposed name that did, changes what the code below means.
  const lines = (header) =>
    header.map((statement) => {
      const exposing = statement.includes("exposing") ? statement.indexOf("exposing") : statement.length;
      return headerLine(statement.map((token, at) => (token === to && NAMED_IN_HEADER[of](at, exposing) ? from : token)));
    });
  // The first line of `some` that `others` do not have as often
  const missing = (some, others) => {
    const left = [...others];
    return some.find((line) => {
      const at = left.indexOf(line);
      if (at !== -1) left.splice(at, 1);
      return at === -1;
    });
  };
  const [had, has] = [lines(was.header), lines(is.header)];
  const [lost, gained] = [missing(had, has), missing(has, had)];
  if (lost !== undefined) return difference("header-lost", { line: lost });
  return gained === undefined ? null : difference("header-gained", { line: gained });
}

// Each check returns null when the expectation holds, or a problem: a sentence that says what is wrong, with its kind.
const CHECKS = {
  "declares-function": ({ file, name }, { elmRoot }) => (declares(elmRoot, file, name) ? null : problem("lacks-function-declaration", { file, name })),

  "lacks-function": ({ file, name }, { elmRoot }) => (declares(elmRoot, file, name) ? problem("still-declares-function", { file, name }) : null),

  "functions-kept": ({ name, files }, { elmRoot }) => {
    const lost = files.filter((file) => !declares(elmRoot, file, name));
    return lost.length > 0 ? problem("function-namesake-lost", { name, files: lost.join(", ") }) : null;
  },

  // With `last`, the variant also has to be the last one of its type
  "type-has-variant": ({ file, type, variant, last }, { elmRoot }) => {
    const variants = variantsOf(elmRoot, file, type);
    if (!variants.includes(variant)) return problem("lacks-variant", { type, file, variant });
    return last && variants.at(-1) !== variant ? problem("variant-not-last", { variant, type, file }) : null;
  },

  "type-lacks-variant": ({ file, type, variant }, { elmRoot }) =>
    variantsOf(elmRoot, file, type).includes(variant) ? problem("still-has-variant", { type, file, variant }) : null,

  "variants-kept": ({ variant, types }, { elmRoot }) => {
    const lost = types.filter(({ file, type }) => !variantsOf(elmRoot, file, type).includes(variant));
    return lost.length > 0 ? problem("variant-namesake-lost", { variant, types: lost.map((l) => `${l.type} (${l.file})`).join(", ") }) : null;
  },

  "declares-type": ({ file, name }, { elmRoot }) => (scan(elmRoot, file)?.typeNames.includes(name) ? null : problem("lacks-type-declaration", { file, name })),

  "lacks-type": ({ file, name }, { elmRoot }) => (scan(elmRoot, file)?.typeNames.includes(name) ? problem("still-declares-type", { file, name }) : null),

  // A type or a type alias of another module, or one called like a variant, is another thing and keeps its name
  "types-kept": ({ name, files }, { elmRoot }) => {
    const lost = files.filter((file) => !scan(elmRoot, file)?.typeNames.includes(name));
    return lost.length > 0 ? problem("type-namesake-lost", { name, files: lost.join(", ") }) : null;
  },

  "alias-has-field": ({ file, alias, field }, { elmRoot }) =>
    fieldsOf(elmRoot, file, alias).includes(field) ? null : problem("lacks-field", { alias, file, field }),

  "alias-lacks-field": ({ file, alias, field }, { elmRoot }) =>
    fieldsOf(elmRoot, file, alias).includes(field) ? problem("still-has-field", { alias, file, field }) : null,

  "fields-kept": ({ field, aliases }, { elmRoot }) => {
    const lost = aliases.filter(({ file, alias }) => !fieldsOf(elmRoot, file, alias).includes(field));
    return lost.length > 0 ? problem("field-namesake-lost", { field, aliases: lost.map((l) => `${l.alias} (${l.file})`).join(", ") }) : null;
  },

  // In every file that changed, nothing changed but the name. `moved` names a file that went to another
  // place, which is the one file a rename may delete and the one it may create. It may not land on a
  // file of the starting commit, whose text the comparison with the old place would pass over.
  "renames-only": ({ moved = [], ...rename }, { elmRoot, changed, originals, committed }) => {
    const [movedFrom, movedTo] = moved;
    for (const file of changed.filter((path) => path.endsWith(".elm") && path !== movedFrom)) {
      const before = originals.get(file === movedTo ? movedFrom : file) ?? null;
      const after = read(elmRoot, file);
      if (after === null) return problem("file-deleted", { file, change: "rename" });
      if (file === movedTo && committed.has(file)) return problem("move-wrote-over", { from: movedFrom, file });
      // The module that moved is compared with what it was at its old place. With the old
      // file still there and untouched, another expectation says so.
      if (before === null && file === movedTo) continue;
      if (before === null) return problem("file-new", { file, change: "rename" });
      const beyond = beyondRename(before, after, rename);
      if (beyond) return problem("renamed-beyond", { file, difference: beyond });
    }
    return null;
  },

  // The destination holds the function with the tokens it had, apart from the qualifiers its imports
  // ask for. Its old module lost it and nothing else, and each user calls it through the destination.
  "moves-function": (move, { elmRoot, changed, originals }) => {
    const original = (file) => (originals.has(file) ? originals.get(file) : read(elmRoot, file));
    for (const file of changed.filter((path) => [move.from, move.to, ...move.users].includes(path))) {
      if (read(elmRoot, file) === null) return problem("file-deleted", { file, change: "move" });
      if (original(file) === null) return problem("file-new", { file, change: "move" });
      for (const { expected, found, part } of movePairs(move, file, original, (path) => read(elmRoot, path))) {
        const beyond = beyondRename(expected, found, { of: "function" });
        if (beyond) return part === "function" ? problem("moved-function-differs", { name: move.name, file, difference: beyond }) : problem("moved-beyond", { file, difference: beyond });
      }
    }
    return null;
  },

  // Each file that the removal changes holds what the plan makes of it, and every other file its old
  // code. The message of a Debug.todo is the session's choice, and so are the brackets around one.
  "removes-only": ({ removal }, { elmRoot, changed, originals }) => {
    const original = (file) => (originals.has(file) ? originals.get(file) : read(elmRoot, file));
    for (const file of new Set([...removal.users, ...changed.filter((path) => path.endsWith(".elm"))])) {
      const [was, is] = [original(file), read(elmRoot, file)];
      if (is === null) return problem("file-deleted", { file, change: "removal" });
      if (was === null) return problem("file-new", { file, change: "removal" });
      // The plan read the same text when it built the removal, so this reading cannot fail unless the starting commit changed
      const expected = removal.users.includes(file) ? removedFrom(removal, file, was) : was;
      if (expected === null) return problem("removal-unreadable", { file });
      const beyond = beyondRename(expected, is, { of: removal.of }, withoutTodoMessages);
      if (beyond) return problem("removal-differs", { file, difference: beyond });
    }
    return null;
  },

  "file-missing": ({ file }, { elmRoot }) => (existsSync(join(elmRoot, file)) ? problem("file-still-exists", { file }) : null),

  "declares-module": ({ file, module }, { elmRoot }) =>
    scan(elmRoot, file)?.module === module ? null : problem("lacks-module-declaration", { file, module }),

  "no-import-of": ({ module }, { elmRoot }) => {
    const importers = filesOf(importersOf(scanProject(elmRoot), module));
    return importers.length > 0 ? problem("still-imported", { module, files: importers.join(", ") }) : null;
  },

  // The request was to add the variant, a branch for it wherever the compiler asks, and nothing else.
  // With the project compiling, lines of these three shapes and no others prove just that: a
  // catch-all branch, a rewritten branch or a comment would each show up as another kind of line.
  "adds-variant-and-branches": ({ variant }, { elmRoot, patch, patchRoot = elmRoot, originals }) => {
    const { runs, removed } = changedLines(patch, elmRoot, patchRoot, originals);
    const added = runs.flat().map(({ text }) => text);
    // How far a text is the body of a branch: "whole", "begun" while the lines below it can still
    // complete it, or null for anything else. A body is Debug.todo and one string literal, and
    // any message will do. The language server's own tool writes "Handle <variant>", and what the
    // task is about is the branch, not the wording of a placeholder. Nor is it about brackets,
    // around the call, the function or the message, about the quotes of the message, one or three,
    // about a "<|" that hands the message over, or about the lines the call is laid out on. With
    // nothing but those in it, a text that the compiler takes is that call.
    const bodyState = (text) => {
      const words = [];
      let depth = 0;
      for (let at = 0; at < text.trimEnd().length; at = BODY_PART.lastIndex) {
        BODY_PART.lastIndex = at;
        const part = BODY_PART.exec(text);
        if (!part) return null;
        const [, bracket, call, handsOver, tripleQuoted, itsEnd] = part;
        if (bracket === "(") depth++;
        else if (bracket === ")" && --depth < 0) return null;
        else if (handsOver && words.at(-1) !== "call") return null;
        else if (!bracket && !handsOver) words.push(call ? "call" : tripleQuoted !== undefined && itsEnd === undefined ? "message without an end" : "message");
      }
      const [first, second, ...more] = words;
      if ((first ?? "call") !== "call" || more.length > 0) return null;
      return second === "message" && depth === 0 ? "whole" : "begun";
    };
    const noBody = problem("branch-not-todo", { variant });
    // The line that adds the variant to its type: a bar, any blanks and the variant, as in "| Dot" or "|Dot"
    const addsVariant = (line) => line.startsWith("|") && line.slice(1).trim() === variant;
    // What stands behind the arrow of a branch for the variant, or null for any other line. The
    // pattern has to name the variant in code: a catch-all with the name in a comment is no
    // branch for it. Neither is a line with something else than a body behind its arrow.
    // `before` is the code of the lines above that the pattern began on, where it takes several.
    // Such a pattern is a pattern and nothing else, with every bracket closed at its arrow.
    const behindBranch = (line, code, before = "") => {
      const arrow = code.indexOf("->");
      const pattern = `${before} ${code.slice(0, arrow)}`;
      if (arrow === -1 || !mentions(pattern, variant)) return null;
      if (before !== "" && !(PATTERN_PARTS.test(pattern) && openBrackets(pattern) === 0)) return null;
      const behind = line.slice(arrow + 2).trim();
      return bodyState(behind) === null ? null : behind;
    };

    const stray = [];
    let branches = 0;
    let unfinished = false;
    for (const run of runs) {
      // The body of the branch that is being read, as far as its lines went. Null between branches.
      let body = null;
      // How deep the pattern of that branch is indented
      let indent = 0;
      // The lines of a pattern that has not come to its arrow. A pattern goes on in the next line
      // while one of its brackets is open, as a tuple with an item to a line does. Its arrow has
      // to stand on the line where it ends: one on a line of its own ends no pattern here.
      let pattern = [];
      for (const { text: line, code, indent: lineIndent, below } of run) {
        if (body === null) {
          const before = pattern.map(({ code }) => code).join(" ");
          if (code.trim() !== "" && PATTERN_PARTS.test(code) && openBrackets(`${before} ${code}`) > 0) {
            pattern.push({ text: line, code, indent: lineIndent });
            continue;
          }
          body = behindBranch(line, code, before);
          if (body === null) {
            stray.push(...pattern.map(({ text }) => text), ...(addsVariant(line) && code.trim() === line ? [] : [line]));
            pattern = [];
            continue;
          }
          indent = pattern[0]?.indent ?? lineIndent;
          pattern = [];
          branches++;
        } else {
          body = `${body} ${line}`.trim();
        }
        const state = bodyState(body);
        if (state === null) return noBody;
        // A line indented deeper than the pattern goes on with the body, by Elm's layout rule. The first
        // line of code below a body has to begin a branch of its own or end the case, or the branch took
        // that line over from the one above, which loses it.
        if (state === "whole" && below > indent) {
          return problem("branch-takes-line", { variant });
        }
        if (state === "whole") body = null;
      }
      // A pattern that never came to its arrow is no branch
      stray.push(...pattern.map(({ text }) => text));
      // A body goes on in the lines right below its branch, and in no others
      unfinished ||= body !== null;
    }
    if (removed.length > 0 || stray.length > 0) {
      const lines = [...removed.map((line) => `-${line}`), ...stray.map((line) => `+${line || "<blank line in a literal>"}`)];
      return problem("beyond-branches", { lines: lines.slice(0, 5).join(" / ") });
    }
    // Another expectation finds the variant on the type that was named. A second one went onto
    // another type, a namesake in another module for one, where it compiles just as well.
    const variants = added.filter(addsVariant).length;
    if (variants > 1) return problem("variant-twice", { variant, times: variants });
    if (unfinished) return noBody;
    return branches > 0 ? null : problem("no-branch", { variant });
  },

  // A refactoring of Elm code changes Elm files of the project. Of what the commit holds, a data
  // file, a script or the build's own configuration that changed along is no part of it, whatever
  // the compiler says, and neither is any file beside the Elm project root, where no source of
  // the project lies. A file the commit does not hold is what some build wrote, or a note, and
  // no change.
  "only-elm-files": ({ except = [] }, { changed, committed }) => {
    const isBeside = (file) => file === ".." || file.startsWith("../");
    const stray = changed.filter((file) => committed.has(file) && (isBeside(file) || !file.endsWith(".elm")) && !except.includes(file));
    return stray.length > 0 ? problem("non-elm-files", { files: stray.join(", ") }) : null;
  },

  // A package lists the modules it exposes in elm.json, where the renamed one takes its new
  // name. The compiler reads that list when it builds the package whole. A build of one file
  // passes with the old name in it, so the list is read here. Nothing else in that file is the
  // task's to change.
  "elm-json-renames-only": ({ from, to }, { elmRoot, changed, originals }) => {
    const renamed = (value) => {
      if (Array.isArray(value)) return value.map(renamed);
      if (value === null || typeof value !== "object") return value === from ? to : value;
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renamed(inner)]));
    };
    try {
      const now = JSON.parse(read(elmRoot, "elm.json"));
      const was = changed.includes("elm.json") ? JSON.parse(originals.get("elm.json")) : now;
      const expected = "exposed-modules" in was ? { ...was, "exposed-modules": renamed(was["exposed-modules"]) } : was;
      if (isDeepStrictEqual(now, expected)) return null;
      if (isDeepStrictEqual(now, was)) return problem("elm-json-still-lists", { from });
    } catch {
      // Gone, or no JSON any more
    }
    return problem("elm-json-beyond", { from });
  },

  // A file that cannot use the target can still name it in a comment, which a search and replace
  // corrects along. Where its tokens are the ones it had, with no name to change, its code is the same.
  "changes-only-in": ({ files }, { elmRoot, changed, originals }) => {
    const allowed = new Set(files);
    const sameCode = (file) => {
      const [before, after] = [originals.get(file) ?? null, read(elmRoot, file)];
      return before !== null && after !== null && beyondRename(before, after, { of: "function" }) === null;
    };
    const stray = changed.filter((file) => file.endsWith(".elm") && !allowed.has(file) && !sameCode(file));
    return stray.length > 0 ? problem("cannot-use-target", { files: stray.join(", ") }) : null;
  },
};

// How deep the first line from `from` on that holds code or a literal is indented, read in the
// lines of layoutOf. The end of the file ends every declaration, as a line in column 0 does. So
// does a line that begins with a closing bracket or a comma, whatever its indent: the brackets of
// a body are closed where it ends, and such a line ends an expression around its case.
function indentBelow(layout, from) {
  for (let at = from; at < (layout?.length ?? 0); at++) {
    const line = layout[at].trimStart();
    if (line !== "") return /^[)\]},]/.test(line) ? 0 : layout[at].length - line.length;
  }
  return 0;
}

/**
 * The lines a patch adds to Elm files and the lines it removes from them,
 * trimmed, without blank ones. A changed line counts as one of each. The
 * added lines come in runs: the lines of one run stand one below the other
 * in their file, with nothing but blank lines between them. An added line
 * also says how deep it is indented, and how deep the next line of its file
 * that holds code or a literal is: 0 where no line below holds either, where
 * that line ends an expression around the case, and where the file cannot be
 * read.
 * @returns {{ runs: { text: string, code: string, indent: number, below: number }[][], removed: string[] }}
 */
function changedLines(patch, elmRoot, patchRoot, originals) {
  const runs = [];
  const removed = [];
  // The run that the next added line joins. Null once another line came, or another hunk.
  let run = null;
  const lines = patch.split("\n");
  // git says on the next line when a line is the last of its file and ends in no line break
  const isUnended = (at) => lines[at + 1]?.startsWith("\\ No newline") === true;
  let inElmFile = false;
  let code = null;
  let layout = null;
  let newLine = 0;
  let oldLine = 0;
  let newLiterals = new Set();
  let oldLiterals = new Set();
  let inHunk = false;
  // A last line that gains or loses its line break is shown as removed and added again, and it
  // did not change unless the added one reads differently. `unended` is such a line of the file
  // as it was, until the added lines tell. `lastRemoved` is the line removed last with nothing
  // but added lines since, which an unended line of the file as it is now may repeat.
  let unended = null;
  let lastRemoved = null;
  const settle = (next) => {
    const same = unended !== null && unended === next;
    if (unended !== null && !same) {
      removed.push(unended.trim());
      lastRemoved = null;
    }
    unended = null;
    return same;
  };
  for (const [at, line] of lines.entries()) {
    // A run goes on with the next added line. Any other line ends it, and so does an added line
    // that did not change. A blank line of the file between two added lines does not, and
    // neither does git's note on a missing line break.
    const before = run;
    if (!line.startsWith("\\") && line.trim() !== "") run = null;
    if (line.startsWith("diff --git ")) {
      settle();
      lastRemoved = null;
      inElmFile = line.endsWith(".elm");
      inHunk = false;
      code = null;
      layout = null;
      newLiterals = new Set();
      oldLiterals = new Set();
    } else if (!inHunk && line.startsWith("+++ b/")) {
      const file = relative(elmRoot, resolve(patchRoot, line.slice(6).replace(/\t$/, "")));
      const text = read(elmRoot, file);
      code = text === null ? null : codeOnly(text).split("\n");
      layout = text === null ? null : layoutOf(text).split("\n");
      newLiterals = literalLineStarts(text ?? "");
      oldLiterals = literalLineStarts(originals?.get(file) ?? "");
    } else if (line.startsWith("@@")) {
      newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 1) - 1;
      oldLine = Number(/-(\d+)/.exec(line)?.[1] ?? 1) - 1;
      lastRemoved = null;
      inHunk = inElmFile;
    } else if (!inHunk) continue;
    else if (line.startsWith("-")) {
      const text = line.slice(1);
      if (isUnended(at)) unended = text;
      else {
        removed.push(text.trim() || (oldLiterals.has(oldLine) ? "<blank line in a literal>" : ""));
        lastRemoved = text;
      }
      oldLine++;
    } else if (line.startsWith("+")) {
      const text = line.slice(1);
      // Read the line in its whole file. A string or comment can begin above the hunk.
      const lexical = code?.[newLine] ?? codeOnly(text);
      const inLiteral = newLiterals.has(newLine++);
      if (settle(line.slice(1))) continue;
      if (isUnended(at) && lastRemoved === line.slice(1)) {
        removed.pop();
        continue;
      }
      run = before ?? [];
      if (before === null) runs.push(run);
      const indent = text.length - text.trimStart().length;
      if (text.trim() !== "" || inLiteral) run.push({ text: text.trim(), code: lexical.slice(indent), indent, below: indentBelow(layout, newLine) });
    } else if (!line.startsWith("\\")) {
      newLine++;
      oldLine++;
      lastRemoved = null;
    }
  }
  settle();
  return { runs: runs.filter((lines) => lines.length > 0), removed: removed.filter(Boolean) };
}

/**
 * Check what a task expects against the project as the agent left it.
 * @param {string} elmRoot
 * @param {object[]} expect  The task's expectations
 * @param {object} left      What the session left behind
 * @param {string[]} left.changed  The files it changed, relative to the Elm root
 * @param {string} left.patch      The same changes as a unified diff
 * @param {string} [left.patchRoot=elmRoot]  The directory that the patch names its paths from
 * @param {Map<string, string | null>} left.originals  The text of each changed Elm file and of elm.json when the session began, null for a new one
 * @param {Set<string>} left.committed  The files that the starting commit holds
 * @returns {string[]} one sentence per expectation that does not hold
 */
export function unmetExpectations(elmRoot, expect, left) {
  return unmetProblems(elmRoot, expect, left).map(({ text }) => text);
}

/** The same as unmetExpectations, with the kind of each problem beside its sentence, as a record keeps them. */
export function unmetProblems(elmRoot, expect, left) {
  return expect.map((expectation) => CHECKS[expectation.kind](expectation, { elmRoot, ...left })).filter(Boolean);
}
