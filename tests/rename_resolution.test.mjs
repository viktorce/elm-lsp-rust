/**
 * The renames resolve a name to its declaration as the compiler does, so a
 * namesake keeps its name: another module's function, a parameter, another
 * type's variant, a type called like the variant. And they reach the test
 * modules under tests/, which elm-test compiles beside the source directories.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { callTool, connect, REPO, tempDir } from "./support.mjs";

const ELM_JSON = readFileSync(join(REPO, "tests/fixture/elm.json"), "utf-8");

// A project of its own with these files, keyed by their paths below its root.
function projectWith(t, files) {
  const project = tempDir(t);
  writeFileSync(join(project, "elm.json"), ELM_JSON);
  writeSources(project, files);
  return project;
}

function writeSources(project, files) {
  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), lines.join("\n") + "\n");
  }
}

// The text of each of the files, keyed as `projectWith` takes them
function textsOf(project, files) {
  return Object.fromEntries(Object.keys(files).map((path) => [path, readFileSync(join(project, path), "utf-8")]));
}

function asTexts(files) {
  return Object.fromEntries(Object.entries(files).map(([path, lines]) => [path, lines.join("\n") + "\n"]));
}

async function assertCompiles(client, project, path) {
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: join(project, path) }), { text: "No errors or warnings", isError: false });
}

async function rename(client, project, kind, path, line, character, oldName, newName) {
  return callTool(client, `elm_rename_${kind}`, { file_path: join(project, path), line, character, old_name: oldName, newName });
}

const SHELF = {
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Bag",
    "import Html exposing (Html, text)",
    "import Shelf",
    "import Tray as B",
    "",
    "",
    "main : Html msg",
    "main =",
    "    if Shelf.isEmpty { bag = [] } && Bag.isEmpty [] && B.isEmpty 0 then",
    '        text "empty"',
    "",
    "    else",
    '        text "full"',
  ],
  "src/Bag.elm": ["module Bag exposing (Bag, isEmpty)", "", "", "type alias Bag =", "    List String", "", "", "isEmpty : Bag -> Bool", "isEmpty bag =", "    List.isEmpty bag"],
  "src/Shelf.elm": [
    "module Shelf exposing (Shelf, isEmpty)",
    "",
    "import Bag exposing (Bag)",
    "",
    "",
    "type alias Shelf =",
    "    { bag : Bag",
    "    }",
    "",
    "",
    "isEmpty : Shelf -> Bool",
    "isEmpty shelf =",
    "    Bag.isEmpty shelf.bag",
  ],
  // Its alias B is no module's name, and Main names the module through it alone
  "src/Tray.elm": ["module Tray exposing (isEmpty)", "", "", "isEmpty : Int -> Bool", "isEmpty count =", "    count == 0"],
};

test("a function rename leaves another module's function of the same name as it is", async (t) => {
  const project = projectWith(t, SHELF);
  const client = await connect(t, { cwd: project });

  const renamed = await rename(client, project, "function", "src/Shelf.elm", 10, 0, "isEmpty", "hasNothing");
  assert.equal(renamed.isError, false, renamed.text);
  const shelf = asTexts(SHELF);
  shelf["src/Shelf.elm"] = shelf["src/Shelf.elm"].replace("(Shelf, isEmpty)", "(Shelf, hasNothing)").replace("isEmpty : Shelf", "hasNothing : Shelf").replace("isEmpty shelf =", "hasNothing shelf =");
  shelf["src/Main.elm"] = shelf["src/Main.elm"].replace("Shelf.isEmpty", "Shelf.hasNothing");
  assert.deepEqual(textsOf(project, SHELF), shelf);
  await assertCompiles(client, project, "src/Main.elm");

  // The function of a package module keeps its name too
  const again = await rename(client, project, "function", "src/Bag.elm", 7, 0, "isEmpty", "hasNothing");
  assert.equal(again.isError, false, again.text);
  shelf["src/Bag.elm"] = shelf["src/Bag.elm"].replace("(Bag, isEmpty)", "(Bag, hasNothing)").replace("isEmpty : Bag", "hasNothing : Bag").replace("isEmpty bag =", "hasNothing bag =");
  shelf["src/Shelf.elm"] = shelf["src/Shelf.elm"].replace("Bag.isEmpty", "Bag.hasNothing");
  shelf["src/Main.elm"] = shelf["src/Main.elm"].replace("Bag.isEmpty []", "Bag.hasNothing []");
  assert.deepEqual(textsOf(project, SHELF), shelf);
  await assertCompiles(client, project, "src/Main.elm");
});

test("a function rename follows an import alias, and an alias that is another module's name", async (t) => {
  const files = {
    ...SHELF,
    // Here Bag is the alias of Shelf, and Bag.isEmpty is Shelf's function
    "src/Window.elm": ["module Window exposing (view)", "", "import Shelf as Bag", "", "", "view : Bag.Shelf -> Bool", "view shelf =", "    Bag.isEmpty shelf"],
  };
  const project = projectWith(t, files);
  const client = await connect(t, { cwd: project });

  const renamed = await rename(client, project, "function", "src/Tray.elm", 3, 0, "isEmpty", "isZero");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(files);
  texts["src/Tray.elm"] = texts["src/Tray.elm"].replaceAll("isEmpty", "isZero");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("B.isEmpty", "B.isZero");
  assert.deepEqual(textsOf(project, files), texts);

  const again = await rename(client, project, "function", "src/Bag.elm", 7, 0, "isEmpty", "hasNothing");
  assert.equal(again.isError, false, again.text);
  texts["src/Bag.elm"] = texts["src/Bag.elm"].replace("(Bag, isEmpty)", "(Bag, hasNothing)").replace("isEmpty : Bag", "hasNothing : Bag").replace("isEmpty bag =", "hasNothing bag =");
  texts["src/Shelf.elm"] = texts["src/Shelf.elm"].replace("Bag.isEmpty", "Bag.hasNothing");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("Bag.isEmpty []", "Bag.hasNothing []");
  assert.deepEqual(textsOf(project, files), texts);
  await assertCompiles(client, project, "src/Main.elm");
  await assertCompiles(client, project, "src/Window.elm");
});

const GREETING = {
  // A port module, whose port has a name of its own
  "src/Greeting.elm": ["port module Greeting exposing (greeting, sent)", "", "", "port sent : String -> Cmd msg", "", "", "greeting : String -> String", "greeting name =", '    "Hello, " ++ name'],
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Greeting exposing (greeting)",
    "import Html exposing (Html, text)",
    "",
    "",
    "isGreeting : String -> String -> Bool",
    "isGreeting text greeting =",
    "    String.startsWith greeting text",
    "",
    "",
    "viaLet : String -> String",
    "viaLet name =",
    "    let",
    "        greeting : String",
    "        greeting =",
    '            "Hi, "',
    "    in",
    "    greeting ++ name",
    "",
    "",
    "viaLambda : List String -> List String",
    "viaLambda =",
    '    List.map (\\greeting -> greeting ++ "!")',
    "",
    "",
    "viaCase : Maybe String -> String",
    "viaCase maybe =",
    "    case maybe of",
    "        Just greeting ->",
    "            greeting",
    "",
    "        Nothing ->",
    '            greeting "nobody"',
    "",
    "",
    "viaRecord : { greeting : String } -> String",
    "viaRecord { greeting } =",
    "    greeting",
    "",
    "",
    "viaUpdate : { name : String } -> { name : String }",
    "viaUpdate greeting =",
    '    { greeting | name = "x" }',
    "",
    "",
    "nested : { inner : { label : String -> String } }",
    "nested =",
    "    { inner = { label = greeting } }",
    "",
    "",
    "viaAlias : ( String, String ) -> String",
    "viaAlias (( first, _ ) as greeting) =",
    "    first ++ Tuple.second greeting",
    "",
    "",
    "main : Html msg",
    "main =",
    '    text (greeting (viaLet (viaCase Nothing ++ viaRecord { greeting = "x" } ++ viaAlias ( "a", "b" ))))',
  ],
};

test("a function rename leaves a local variable of the function's name as it is", async (t) => {
  const project = projectWith(t, GREETING);
  const client = await connect(t, { cwd: project });
  await assertCompiles(client, project, "src/Main.elm");

  const renamed = await rename(client, project, "function", "src/Greeting.elm", 6, 0, "greeting", "welcome");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(GREETING);
  texts["src/Greeting.elm"] = texts["src/Greeting.elm"].replaceAll("greeting", "welcome");
  texts["src/Main.elm"] = texts["src/Main.elm"]
    .replace("exposing (greeting)", "exposing (welcome)")
    .replace('greeting "nobody"', 'welcome "nobody"')
    .replace("label = greeting", "label = welcome")
    .replace("text (greeting (", "text (welcome (");
  assert.deepEqual(textsOf(project, GREETING), texts);
  await assertCompiles(client, project, "src/Main.elm");
});

test("a function rename that would make a name mean something else changes nothing and says where", async (t) => {
  const files = {
    ...GREETING,
    "src/Other.elm": ["module Other exposing (hello)", "", "", "hello : String", "hello =", '    "hello"'],
    "src/Uses.elm": [
      "module Uses exposing (local, shout, viaOther)",
      "",
      "import Greeting exposing (greeting)",
      "import Other exposing (hello)",
      "",
      "",
      "shout : String -> String",
      "shout loud =",
      "    greeting loud",
      "",
      "",
      "local : String",
      "local =",
      '    greeting "local"',
      "",
      "",
      "viaOther : String",
      "viaOther =",
      "    hello",
    ],
  };
  const project = projectWith(t, files);
  const client = await connect(t, { cwd: project });
  await assertCompiles(client, project, "src/Uses.elm");

  for (const [newName, reason] of [
    // The parameter loud would take the renamed call
    ["loud", "at src/Uses.elm:9 a local loud would hide the renamed function"],
    // Uses declares local itself, and its own declaration would win
    ["local", "at src/Uses.elm:9 local would name the local that Uses declares"],
    // Uses takes hello from Other already
    ["hello", "at src/Uses.elm:9 hello would also be the hello that the import of Other exposes"],
  ]) {
    assert.deepEqual(await rename(client, project, "function", "src/Greeting.elm", 6, 0, "greeting", newName), {
      text: `Error: Cannot rename greeting to ${newName}: ${reason}. No file was changed`,
      isError: true,
    });
  }
  assert.deepEqual(textsOf(project, files), asTexts(files));
});

const LABEL = {
  "src/Label.elm": [
    "module Label exposing (Kind(..), Label, describe, render, size)",
    "",
    "-- A tag, a count and a Text are words of this comment",
    "",
    "",
    "type Kind",
    "    = Plain",
    "    | Text",
    "",
    "",
    "type alias Label =",
    "    { tag : String",
    "    , kind : Kind",
    "    }",
    "",
    "",
    "describe : Label -> String",
    "describe label =",
    '    "tag: " ++ label.tag',
    "",
    "",
    "render : List tag -> Label -> String",
    "render items label =",
    "    String.fromInt (List.length items) ++ describe label",
    "",
    "",
    "size : List a -> Int",
    "size items =",
    "    let",
    "        count =",
    "            List.length items",
    "    in",
    "    count",
  ],
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Html exposing (Html, text)",
    "import Label exposing (Kind(..), Label)",
    "",
    "",
    "main : Html msg",
    "main =",
    '    text (Label.render [] { tag = "x", kind = Text } ++ String.fromInt (Label.size []))',
  ],
};

test("a rename takes a name that its module spells in a comment, a string, a field or a type variable, and refuses one that names something there", async (t) => {
  const project = projectWith(t, LABEL);
  const client = await connect(t, { cwd: project });
  await assertCompiles(client, project, "src/Main.elm");

  for (const [kind, line, character, from, to, reason] of [
    // Elm does not let a local variable take the name of a top-level value of its module, wherever it stands
    ["function", 17, 0, "describe", "count", "at src/Label.elm:30 a local count would shadow the renamed function, which Elm does not allow"],
    // The constructor of the record alias would be the variant's namesake
    ["type", 10, 11, "Label", "Plain", "Label already declares a variant Plain"],
  ]) {
    assert.deepEqual(await rename(client, project, kind, "src/Label.elm", line, character, from, to), {
      text: `Error: Cannot rename ${from} to ${to}: ${reason}. No file was changed`,
      isError: true,
    });
  }
  assert.deepEqual(textsOf(project, LABEL), asTexts(LABEL));

  const renamed = await rename(client, project, "function", "src/Label.elm", 17, 0, "describe", "tag");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(LABEL);
  texts["src/Label.elm"] = texts["src/Label.elm"].replace("Label, describe,", "Label, tag,").replace("describe : Label", "tag : Label").replace("describe label =", "tag label =").replace("++ describe label", "++ tag label");
  assert.deepEqual(textsOf(project, LABEL), texts);
  await assertCompiles(client, project, "src/Main.elm");

  // A custom type can take the name of a variant, which is a name of another kind
  const again = await rename(client, project, "type", "src/Label.elm", 5, 5, "Kind", "Text");
  assert.equal(again.isError, false, again.text);
  texts["src/Label.elm"] = texts["src/Label.elm"].replace("exposing (Kind(..),", "exposing (Text(..),").replace("type Kind", "type Text").replace("kind : Kind", "kind : Text");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("exposing (Kind(..), Label)", "exposing (Text(..), Label)");
  assert.deepEqual(textsOf(project, LABEL), texts);
  await assertCompiles(client, project, "src/Main.elm");
});

const COUNTER = {
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Counter",
    "import Html exposing (Html, text)",
    "import Timer",
    "",
    "",
    "main : Html msg",
    "main =",
    "    text (String.fromInt (Counter.update Counter.Reset 3 + Timer.update Timer.Reset 4))",
  ],
  "src/Counter.elm": [
    "module Counter exposing (Msg(..), update)",
    "",
    "",
    "type Msg",
    "    = Reset",
    "    | Increment",
    "",
    "",
    "update : Msg -> Int -> Int",
    "update msg count =",
    "    case msg of",
    "        Reset ->",
    "            0",
    "",
    "        Increment ->",
    "            count + 1",
  ],
  "src/Timer.elm": [
    "module Timer exposing (Msg(..), update)",
    "",
    "",
    "type Msg",
    "    = Reset",
    "    | Tick",
    "",
    "",
    "update : Msg -> Int -> Int",
    "update msg seconds =",
    "    case msg of",
    "        Reset ->",
    "            0",
    "",
    "        Tick ->",
    "            seconds + 1",
  ],
  // Takes Counter's variants along unqualified, names Timer's through an alias
  "src/Panel.elm": [
    "module Panel exposing (Reset(..), both, first)",
    "",
    "import Counter exposing (Msg(..))",
    "import Timer as T",
    "",
    "",
    "type Reset",
    "    = Soft",
    "",
    "",
    "both : List Msg",
    "both =",
    "    [ Reset, Increment ]",
    "",
    "",
    "first : Maybe Msg -> Maybe T.Msg -> Reset -> Int",
    "first counter timer reset =",
    "    case ( counter, timer, reset ) of",
    "        ( Just Reset, Just T.Reset, Soft ) ->",
    "            0",
    "",
    "        _ ->",
    "            Counter.update Increment (T.update T.Reset 1)",
  ],
};

test("a variant rename leaves the variants of the same name of other types as they are", async (t) => {
  const project = projectWith(t, COUNTER);
  const client = await connect(t, { cwd: project });
  await assertCompiles(client, project, "src/Panel.elm");

  const renamed = await rename(client, project, "variant", "src/Counter.elm", 4, 6, "Reset", "Clear");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(COUNTER);
  texts["src/Counter.elm"] = texts["src/Counter.elm"].replaceAll("Reset", "Clear");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("Counter.Reset", "Counter.Clear");
  texts["src/Panel.elm"] = texts["src/Panel.elm"].replace("[ Reset, Increment ]", "[ Clear, Increment ]").replace("( Just Reset,", "( Just Clear,");
  assert.deepEqual(textsOf(project, COUNTER), texts);
  await assertCompiles(client, project, "src/Main.elm");
  await assertCompiles(client, project, "src/Panel.elm");
});

test("a variant rename that would make a name mean something else changes nothing and says where", async (t) => {
  const project = projectWith(t, COUNTER);
  const client = await connect(t, { cwd: project });

  for (const [newName, reason] of [
    ["Increment", "Counter already declares a variant Increment"],
    // Panel declares a variant Soft of its own type Reset
    ["Soft", "at src/Panel.elm:13 Soft would name the Soft that Panel declares"],
  ]) {
    assert.deepEqual(await rename(client, project, "variant", "src/Counter.elm", 4, 6, "Reset", newName), {
      text: `Error: Cannot rename Reset to ${newName}: ${reason}. No file was changed`,
      isError: true,
    });
  }
  assert.deepEqual(textsOf(project, COUNTER), asTexts(COUNTER));
});

const MODE = {
  "src/Catalog.elm": ["module Catalog exposing (Lookup, empty)", "", "", "type Lookup", "    = Entry String", "", "", "empty : Lookup", "empty =", '    Entry ""'],
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Catalog exposing (Lookup)",
    "import Html exposing (Html, text)",
    "import Mode exposing (Mode(..))",
    "",
    "",
    "current : Catalog.Lookup",
    "current =",
    "    Catalog.empty",
    "",
    "",
    "other : Lookup",
    "other =",
    "    current",
    "",
    "",
    "main : Html msg",
    "main =",
    "    text (Mode.label Mode.Lookup ++ Mode.label Lookup)",
  ],
  "src/Mode.elm": [
    "module Mode exposing (Mode(..), label)",
    "",
    "",
    "type Mode",
    "    = Browse",
    "    | Lookup",
    "",
    "",
    "label : Mode -> String",
    "label mode =",
    "    case mode of",
    "        Browse ->",
    '            "browse"',
    "",
    "        Lookup ->",
    '            "lookup"',
  ],
};

test("a variant rename leaves a type of the variant's name as it is", async (t) => {
  const project = projectWith(t, MODE);
  const client = await connect(t, { cwd: project });
  await assertCompiles(client, project, "src/Main.elm");

  const renamed = await rename(client, project, "variant", "src/Mode.elm", 5, 6, "Lookup", "Find");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(MODE);
  texts["src/Mode.elm"] = texts["src/Mode.elm"].replaceAll("Lookup", "Find");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("Mode.label Mode.Lookup ++ Mode.label Lookup", "Mode.label Mode.Find ++ Mode.label Find");
  assert.deepEqual(textsOf(project, MODE), texts);
  await assertCompiles(client, project, "src/Main.elm");
});

test("the references of a function, a type and a variant are the places their renames change", async (t) => {
  for (const [files, path, line, character, expected] of [
    // The parameters, the variables of a let, a lambda and a case, a record pattern and a field keep out
    [GREETING, "src/Main.elm", 33, 12, [["src/Greeting.elm", 0, 31], ["src/Greeting.elm", 6, 0], ["src/Greeting.elm", 7, 0], ["src/Main.elm", 2, 26], ["src/Main.elm", 33, 12], ["src/Main.elm", 48, 24], ["src/Main.elm", 58, 10]]],
    [GREETING, "src/Greeting.elm", 7, 0, [["src/Greeting.elm", 0, 31], ["src/Greeting.elm", 6, 0], ["src/Greeting.elm", 7, 0], ["src/Main.elm", 2, 26], ["src/Main.elm", 33, 12], ["src/Main.elm", 48, 24], ["src/Main.elm", 58, 10]]],
    // The type Lookup and the variant Lookup are two names
    [MODE, "src/Main.elm", 12, 8, [["src/Catalog.elm", 0, 25], ["src/Catalog.elm", 3, 5], ["src/Catalog.elm", 7, 8], ["src/Main.elm", 2, 25], ["src/Main.elm", 7, 18], ["src/Main.elm", 12, 8]]],
    [MODE, "src/Main.elm", 19, 26, [["src/Main.elm", 19, 26], ["src/Main.elm", 19, 47], ["src/Mode.elm", 5, 6], ["src/Mode.elm", 14, 8]]],
    [MODE, "src/Mode.elm", 5, 6, [["src/Main.elm", 19, 26], ["src/Main.elm", 19, 47], ["src/Mode.elm", 5, 6], ["src/Mode.elm", 14, 8]]],
    // A variant of another type with the name, and a qualifier that is another module's alias, keep out too
    [COUNTER, "src/Counter.elm", 4, 6, null],
  ]) {
    const project = projectWith(t, files);
    const client = await connect(t, { cwd: project });
    const found = await callTool(client, "elm_references", { file_path: join(project, path), line, character });
    assert.equal(found.isError, false, found.text);
    const places = found.text.split("\n").slice(1);
    if (expected === null) {
      // The places that the rename changes, read from the texts before and after it
      const renamed = await rename(client, project, "variant", path, line, character, "Reset", "Clear");
      assert.equal(renamed.isError, false, renamed.text);
      const changed = Object.entries(files).flatMap(([file, lines]) => {
        const now = readFileSync(join(project, file), "utf-8").split("\n");
        return lines.flatMap((text, index) => [...text.matchAll(/(?<![A-Za-z0-9_])Reset(?![A-Za-z0-9_])/g)].filter((match) => now[index].slice(match.index, match.index + 5) === "Clear").map((match) => `${join(project, file)}:${index + 1}:${match.index}`));
      });
      assert.deepEqual([...places].sort(), changed.sort());
      assert.equal(places.length, 5, found.text);
    } else {
      assert.deepEqual(places, expected.map(([file, at, column]) => `${join(project, file)}:${at + 1}:${column}`), `${path}:${line}:${character}`);
    }
  }
});

test("a type rename leaves a variant of the type's name as it is", async (t) => {
  const project = projectWith(t, MODE);
  const client = await connect(t, { cwd: project });

  const renamed = await rename(client, project, "type", "src/Catalog.elm", 3, 5, "Lookup", "Index");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(MODE);
  texts["src/Catalog.elm"] = texts["src/Catalog.elm"].replaceAll("Lookup", "Index");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("exposing (Lookup)", "exposing (Index)").replace("Catalog.Lookup", "Catalog.Index").replace("other : Lookup", "other : Index");
  assert.deepEqual(textsOf(project, MODE), texts);
  await assertCompiles(client, project, "src/Main.elm");
});

const MONEY = {
  "src/Money.elm": [
    "module Money exposing (Cents(..), Price, add, price)",
    "",
    "",
    "type Cents",
    "    = Cents Int",
    "",
    "",
    "type alias Price =",
    "    { amount : Cents",
    "    }",
    "",
    "",
    "add : Cents -> Cents -> Cents",
    "add (Cents a) (Cents b) =",
    "    Cents (a + b)",
    "",
    "",
    "price : Int -> Price",
    "price n =",
    "    Price (Cents n)",
  ],
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Html exposing (Html, text)",
    "import Money exposing (Cents(..), Price)",
    "import Till",
    "",
    "",
    "total : Cents",
    "total =",
    "    Money.add (Cents 1) (Money.Cents 2)",
    "",
    "",
    "main : Html msg",
    "main =",
    "    case total of",
    "        Cents n ->",
    "            text (Till.show (Money.price n))",
  ],
  // A port module that names both through an alias, in a let and in a lambda
  "src/Till.elm": [
    "port module Till exposing (sent, show)",
    "",
    "import Money as M",
    "",
    "",
    "port sent : String -> Cmd msg",
    "",
    "",
    "show : M.Price -> String",
    "show p =",
    "    let",
    "        unwrap : M.Cents -> Int",
    "        unwrap (M.Cents n) =",
    "            n",
    "    in",
    "    String.fromInt (unwrap p.amount) ++ String.concat (List.map (\\(M.Cents n) -> String.fromInt n) [ .amount (M.Price (M.Cents 0)) ])",
  ],
};

test("a type rename leaves its variant of the type's name as it is, and takes a record alias's constructor along", async (t) => {
  const project = projectWith(t, MONEY);
  const client = await connect(t, { cwd: project });
  await assertCompiles(client, project, "src/Main.elm");

  // The variant Cents is a name of its own, which elm_rename_variant renames
  const renamed = await rename(client, project, "type", "src/Money.elm", 3, 5, "Cents", "Amount");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(MONEY);
  texts["src/Money.elm"] = texts["src/Money.elm"]
    .replace("(Cents(..), Price", "(Amount(..), Price")
    .replace("type Cents", "type Amount")
    .replace("amount : Cents", "amount : Amount")
    .replace("add : Cents -> Cents -> Cents", "add : Amount -> Amount -> Amount");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("exposing (Cents(..), Price)", "exposing (Amount(..), Price)").replace("total : Cents", "total : Amount");
  texts["src/Till.elm"] = texts["src/Till.elm"].replace("unwrap : M.Cents", "unwrap : M.Amount");
  assert.deepEqual(textsOf(project, MONEY), texts);
  await assertCompiles(client, project, "src/Main.elm");

  // The constructor of a record alias is the alias itself
  const again = await rename(client, project, "type", "src/Money.elm", 7, 11, "Price", "Cost");
  assert.equal(again.isError, false, again.text);
  texts["src/Money.elm"] = texts["src/Money.elm"].replace("(Amount(..), Price,", "(Amount(..), Cost,").replace("type alias Price", "type alias Cost").replace("price : Int -> Price", "price : Int -> Cost").replace("    Price (Cents n)", "    Cost (Cents n)");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("exposing (Amount(..), Price)", "exposing (Amount(..), Cost)");
  texts["src/Till.elm"] = texts["src/Till.elm"].replace("show : M.Price", "show : M.Cost").replace("(M.Price (M.Cents 0))", "(M.Cost (M.Cents 0))");
  assert.deepEqual(textsOf(project, MONEY), texts);
  await assertCompiles(client, project, "src/Main.elm");
});

const CART = {
  "src/Stock.elm": ["module Stock exposing (Item, label)", "", "", "type alias Item =", "    { name : String", "    }", "", "", "label : Item -> String", "label item =", "    item.name"],
  "src/Cart.elm": [
    "module Cart exposing (Item, describe)",
    "",
    "import Stock",
    "",
    "",
    "type alias Item =",
    "    { stock : Stock.Item",
    "    , count : Int",
    "    }",
    "",
    "",
    "describe : Item -> String",
    "describe item =",
    '    String.fromInt item.count ++ " " ++ Stock.label item.stock',
  ],
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Cart exposing (Item)",
    "import Html exposing (Html, text)",
    "import Stock",
    "",
    "",
    "apple : Stock.Item",
    "apple =",
    '    { name = "apple" }',
    "",
    "",
    "line : Item",
    "line =",
    "    Item apple 2",
    "",
    "",
    "main : Html msg",
    "main =",
    "    text (Cart.describe line)",
  ],
  "tests/CartCheck.elm": [
    "module CartCheck exposing (two)",
    "",
    "import Cart exposing (Item)",
    "import Stock as S",
    "",
    "",
    "pear : S.Item",
    "pear =",
    '    S.Item "pear"',
    "",
    "",
    "two : Item -> Bool",
    "two item =",
    "    item.count == 2 && (Cart.Item pear 2).count == 2",
  ],
};

test("a type rename leaves another module's type of the same name as it is, and reaches the test modules", async (t) => {
  const project = projectWith(t, CART);
  const client = await connect(t, { cwd: project });
  await assertCompiles(client, project, "tests/CartCheck.elm");

  const renamed = await rename(client, project, "type", "src/Cart.elm", 5, 11, "Item", "Line");
  assert.equal(renamed.isError, false, renamed.text);
  const texts = asTexts(CART);
  texts["src/Cart.elm"] = texts["src/Cart.elm"].replace("(Item, describe)", "(Line, describe)").replace("type alias Item", "type alias Line").replace("describe : Item", "describe : Line");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("exposing (Item)", "exposing (Line)").replace("line : Item", "line : Line").replace("Item apple 2", "Line apple 2");
  texts["tests/CartCheck.elm"] = texts["tests/CartCheck.elm"].replace("exposing (Item)", "exposing (Line)").replace("two : Item", "two : Line").replace("Cart.Item pear", "Cart.Line pear");
  assert.deepEqual(textsOf(project, CART), texts);
  await assertCompiles(client, project, "src/Main.elm");
  await assertCompiles(client, project, "tests/CartCheck.elm");

  const again = await rename(client, project, "type", "src/Stock.elm", 3, 11, "Item", "Thing");
  assert.equal(again.isError, false, again.text);
  texts["src/Stock.elm"] = texts["src/Stock.elm"].replaceAll("Item", "Thing");
  texts["src/Cart.elm"] = texts["src/Cart.elm"].replace("Stock.Item", "Stock.Thing");
  texts["src/Main.elm"] = texts["src/Main.elm"].replace("Stock.Item", "Stock.Thing");
  texts["tests/CartCheck.elm"] = texts["tests/CartCheck.elm"].replaceAll("S.Item", "S.Thing");
  assert.deepEqual(textsOf(project, CART), texts);
  await assertCompiles(client, project, "src/Main.elm");
  await assertCompiles(client, project, "tests/CartCheck.elm");
});

const TEAM = {
  "src/Account.elm": ["module Account exposing (Account, UserId, owner)", "", "", "type alias UserId =", "    String", "", "", "type alias Account =", "    { owner : UserId", "    }", "", "", "owner : Account -> UserId", "owner account =", "    account.owner"],
  "src/Team.elm": ["module Team exposing (UserId, lead)", "", "", "type alias UserId =", "    Int", "", "", "lead : UserId", "lead =", "    1"],
  "src/Main.elm": [
    "module Main exposing (main)",
    "",
    "import Account exposing (Account, UserId)",
    "import Html exposing (Html, text)",
    "import Team exposing (UserId)",
    "",
    "",
    "who : Account -> String",
    "who account =",
    "    Account.owner account",
    "",
    "",
    "number : Team.UserId",
    "number =",
    "    Team.lead",
    "",
    "",
    "main : Html msg",
    "main =",
    '    text (who { owner = "ada" } ++ String.fromInt number)',
  ],
};

test("a type rename takes the entry of an exposing list for the type of the import it stands in", async (t) => {
  for (const [path, changes] of [
    ["src/Team.elm", [["src/Team.elm", "UserId", "PersonId"], ["src/Main.elm", "Team exposing (UserId)", "Team exposing (PersonId)"], ["src/Main.elm", "Team.UserId", "Team.PersonId"]]],
    ["src/Account.elm", [["src/Account.elm", "UserId", "PersonId"], ["src/Main.elm", "(Account, UserId)", "(Account, PersonId)"]]],
  ]) {
    const project = projectWith(t, TEAM);
    const client = await connect(t, { cwd: project });
    const renamed = await rename(client, project, "type", path, 3, 11, "UserId", "PersonId");
    assert.equal(renamed.isError, false, renamed.text);
    const texts = asTexts(TEAM);
    for (const [file, from, to] of changes) {
      texts[file] = texts[file].replaceAll(from, to);
    }
    assert.deepEqual(textsOf(project, TEAM), texts, path);
    await assertCompiles(client, project, "src/Main.elm");
  }
});

const PRICE = {
  "src/Main.elm": ["module Main exposing (main)", "", "import Html exposing (Html, text)", "import Price", "", "", "main : Html msg", "main =", "    text (Price.format Price.Free)"],
  "src/Price.elm": [
    "module Price exposing (Price(..), Tag, format, label)",
    "",
    "",
    "type Price",
    "    = Free",
    "    | Cents Int",
    "",
    "",
    "type alias Tag =",
    "    { amount : Price",
    "    , note : String",
    "    }",
    "",
    "",
    "format : Price -> String",
    "format price =",
    "    case price of",
    "        Free ->",
    '            "free"',
    "",
    "        Cents cents ->",
    '            String.fromInt cents ++ " ct"',
    "",
    "",
    "label : Tag -> String",
    "label tag =",
    '    format tag.amount ++ " " ++ tag.note',
  ],
  "tests/PriceCheck.elm": [
    "module PriceCheck exposing (formatsFree, notes)",
    "",
    "import Price exposing (Tag)",
    "import Support",
    "",
    "",
    "formatsFree : Bool",
    "formatsFree =",
    '    Support.same (Price.format Price.Free) "free"',
    "",
    "",
    "notes : Tag -> String",
    "notes tag =",
    "    tag.note",
  ],
  // A module of the tests that the others import
  "tests/Support.elm": ["module Support exposing (same)", "", "", "same : String -> String -> Bool", "same one other =", "    one == other"],
};

test("the renames reach the test modules under tests/", async (t) => {
  for (const [kind, path, line, character, oldName, newName, changes] of [
    ["function", "src/Price.elm", 14, 0, "format", "toText", [["src/Price.elm", "format", "toText"], ["src/Main.elm", "Price.format", "Price.toText"], ["tests/PriceCheck.elm", "Price.format", "Price.toText"]]],
    ["variant", "src/Price.elm", 4, 6, "Free", "Gratis", [["src/Price.elm", "Free", "Gratis"], ["src/Main.elm", "Price.Free", "Price.Gratis"], ["tests/PriceCheck.elm", "Price.Free", "Price.Gratis"]]],
    ["field", "src/Price.elm", 10, 6, "note", "remark", [["src/Price.elm", "note", "remark"], ["tests/PriceCheck.elm", "tag.note", "tag.remark"]]],
    ["function", "tests/Support.elm", 3, 0, "same", "equal", [["tests/Support.elm", "same", "equal"], ["tests/PriceCheck.elm", "Support.same", "Support.equal"]]],
  ]) {
    const project = projectWith(t, PRICE);
    const client = await connect(t, { cwd: project });
    const renamed = await rename(client, project, kind, path, line, character, oldName, newName);
    assert.equal(renamed.isError, false, renamed.text);
    const texts = asTexts(PRICE);
    for (const [file, from, to] of changes) {
      texts[file] = texts[file].replaceAll(from, to);
    }
    assert.deepEqual(textsOf(project, PRICE), texts, `${kind} ${oldName}`);
    await assertCompiles(client, project, "tests/PriceCheck.elm");
  }
});

test("a module rename reaches the test modules, and a test module can be renamed", async (t) => {
  const project = projectWith(t, PRICE);
  const client = await connect(t, { cwd: project });

  const moved = await callTool(client, "elm_rename_file", { file_path: join(project, "src/Price.elm"), new_name: "Cost.elm" });
  assert.equal(moved.isError, false, moved.text);
  const check = readFileSync(join(project, "tests/PriceCheck.elm"), "utf-8");
  assert.equal(check, asTexts(PRICE)["tests/PriceCheck.elm"].replaceAll("Price", "Cost").replace("module CostCheck", "module PriceCheck"));
  await assertCompiles(client, project, "tests/PriceCheck.elm");

  // A test module is named by its path below tests/
  const renamed = await callTool(client, "elm_rename_file", { file_path: join(project, "tests/Support.elm"), new_name: "Helpers.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.equal(readFileSync(join(project, "tests/Helpers.elm"), "utf-8"), asTexts(PRICE)["tests/Support.elm"].replace("module Support", "module Helpers"));
  assert.match(readFileSync(join(project, "tests/PriceCheck.elm"), "utf-8"), /^import Helpers$/m);
  assert.match(readFileSync(join(project, "tests/PriceCheck.elm"), "utf-8"), /Helpers\.same/);
  await assertCompiles(client, project, "tests/PriceCheck.elm");
});

// A package of its own, whose elm.json lists the modules it exposes
function packageWith(t, exposed) {
  const project = tempDir(t);
  writeFileSync(
    join(project, "elm.json"),
    JSON.stringify(
      {
        type: "package",
        name: "author/shop",
        // Words that spell a module's name and are no entry of the list
        summary: "Shop.Units in grams",
        license: "BSD-3-Clause",
        version: "1.0.0",
        "exposed-modules": exposed,
        "elm-version": "0.19.0 <= v < 0.20.0",
        dependencies: { "elm/core": "1.0.0 <= v < 2.0.0" },
        "test-dependencies": {},
      },
      null,
      4
    ) + "\n"
  );
  writeSources(project, {
    "src/Shop/Units.elm": ["module Shop.Units exposing (grams)", "", "import Shop.Units.Extra", "", "", "grams : Int -> Int", "grams n =", "    Shop.Units.Extra.pad n"],
    "src/Shop/Units/Extra.elm": ["module Shop.Units.Extra exposing (pad)", "", "", "pad : Int -> Int", "pad n =", "    n"],
  });
  return project;
}

// Whether the package builds as the compiler builds it for its users, every exposed module in it
function assertPackageBuilds(project) {
  const built = spawnSync("elm", ["make", "--output=/dev/null"], { cwd: project, encoding: "utf-8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
}

test("a module rename and a module move change the module's name where a package lists the modules it exposes", async (t) => {
  for (const [exposed, renamed, moved] of [
    [["Shop.Units", "Shop.Units.Extra"], ["Shop.Measures", "Shop.Units.Extra"], ["Shop.Measures", "Tools.Pad"]],
    // Lists under titles. A title that spells a module's name is no module.
    [
      { "Shop.Units": ["Shop.Units"], Tools: ["Shop.Units.Extra"] },
      { "Shop.Units": ["Shop.Measures"], Tools: ["Shop.Units.Extra"] },
      { "Shop.Units": ["Shop.Measures"], Tools: ["Tools.Pad"] },
    ],
  ]) {
    const project = packageWith(t, exposed);
    const client = await connect(t, { cwd: project });
    const elmJson = () => JSON.parse(readFileSync(join(project, "elm.json"), "utf-8"));
    const before = elmJson();
    assertPackageBuilds(project);

    const renaming = await callTool(client, "elm_rename_file", { file_path: join(project, "src/Shop/Units.elm"), new_name: "Measures.elm" });
    assert.equal(renaming.isError, false, renaming.text);
    assert.deepEqual(elmJson(), { ...before, "exposed-modules": renamed });
    assertPackageBuilds(project);

    const moving = await callTool(client, "elm_move_file", { file_path: join(project, "src/Shop/Units/Extra.elm"), target_path: "src/Tools/Pad.elm" });
    assert.equal(moving.isError, false, moving.text);
    assert.deepEqual(elmJson(), { ...before, "exposed-modules": moved });
    assert.match(readFileSync(join(project, "src/Shop/Measures.elm"), "utf-8"), /^import Tools\.Pad$/m);
    assertPackageBuilds(project);
    // The layout of the file is the one it had
    assert.equal(readFileSync(join(project, "elm.json"), "utf-8"), JSON.stringify(elmJson(), null, 4) + "\n");
  }
});

test("the uses in test modules are references, and their symbols are found", async (t) => {
  const project = projectWith(t, PRICE);
  const client = await connect(t, { cwd: project });

  const references = await callTool(client, "elm_references", { file_path: join(project, "src/Price.elm"), line: 14, character: 0 });
  assert.equal(references.isError, false, references.text);
  assert.match(references.text, /tests\/PriceCheck\.elm/);
  const symbols = await callTool(client, "elm_symbols", { file_path: join(project, "tests/PriceCheck.elm") });
  assert.match(symbols.text, /formatsFree/);
});

test("elm_diagnostics builds a test module as elm-test does", async (t) => {
  const files = {
    ...PRICE,
    // elm/json is a test-dependency, and only an indirect dependency of the application
    "tests/DecodeCheck.elm": ["module DecodeCheck exposing (decoded)", "", "import Json.Decode", "import Price", "import Support", "", "", "decoded : Bool", "decoded =", '    Support.same (Price.format Price.Free) (Result.withDefault "" (Json.Decode.decodeString Json.Decode.string "\\"free\\""))'],
    "tests/Broken.elm": ["module Broken exposing (wrong)", "", "import Price", "", "", "wrong : Int", "wrong =", "    Price.format Price.Free"],
  };
  const project = projectWith(t, files);
  const elmJson = JSON.parse(ELM_JSON);
  elmJson["test-dependencies"].direct["elm/json"] = elmJson.dependencies.indirect["elm/json"];
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson, null, 4));
  const client = await connect(t, { cwd: project });

  await assertCompiles(client, project, "tests/DecodeCheck.elm");
  const broken = await callTool(client, "elm_diagnostics", { file_path: join(project, "tests/Broken.elm") });
  assert.equal(broken.isError, false, broken.text);
  assert.match(broken.text, /^Line 8:5 - TYPE MISMATCH/);
  // The source modules are built in the project itself, which elm-test leaves alone
  await assertCompiles(client, project, "src/Main.elm");
  assert.deepEqual(textsOf(project, files), asTexts(files));
});
