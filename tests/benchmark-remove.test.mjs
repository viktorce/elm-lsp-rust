/**
 * The two removal tasks of the benchmark: which variants and fields they
 * take, the removal as the plan makes it, and the verdict on what a session
 * leaves. Nothing here runs a compiler. The plan builds the removal and a
 * rename of the target before it takes one, and the compiler's part in that
 * is in benchmark.test.mjs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { scanSource } from "../benchmarks/lib/elm-source.mjs";
import { removedFrom, withoutTodoMessages } from "../benchmarks/lib/remove.mjs";
import { TASK_TYPES, unmetExpectations } from "../benchmarks/lib/tasks.mjs";
import { tempDir } from "./support.mjs";
import { left } from "./benchmark-support.mjs";

const taskType = (id) => TASK_TYPES.find((type) => type.id === id);

const project = (sources) => Object.entries(sources).map(([file, text]) => scanSource(file, text));

const lines = (...each) => `${each.join("\n")}\n`;

const SIGNAL = lines(
  "module Signal exposing (Light(..), describe, next)",
  "",
  "import Words exposing (shout)",
  "",
  "",
  "type Light",
  "    = Walk Int String",
  "    | Wait",
  "    | Halt",
  "",
  "",
  "describe : Light -> String",
  "describe light =",
  "    case light of",
  "        Walk speed _ ->",
  "            String.fromInt speed",
  "",
  "        Wait ->",
  '            shout "wait"',
  "",
  "        Halt ->",
  '            "halt"',
  "",
  "",
  "next : Light -> Light",
  "next light =",
  "    case ( light, 1 ) of",
  "        ( Walk _ _, _ ) ->",
  "            Wait",
  "",
  "        ( Wait, _ ) ->",
  "            Walk 1",
  '                "a"',
  "",
  "        ( Halt, _ ) ->",
  '            Walk 2 <| "b"'
);

const HOME = lines(
  "module Page.Home exposing (view)",
  "",
  "import Signal as S exposing (Light(..))",
  "",
  "",
  "view : Maybe S.Light -> List String",
  "view light =",
  "    case light of",
  "        Just (S.Walk _ label) ->",
  "            [ label ]",
  "",
  "        Just Wait ->",
  '            List.map S.describe [ Wait, S.Halt, S.Walk 3 "c" ]',
  "",
  "        _ ->",
  '            List.map S.describe (List.map Walk [ 1 ] |> List.map (\\make -> make "d"))'
);

const LIGHTS = {
  "src/Signal.elm": SIGNAL,
  "src/Page/Home.elm": HOME,
  "src/Words.elm": lines("module Words exposing (shout)", "", "", "shout : String -> String", "shout =", "    String.toUpper"),
  // A type of its own with a variant of the same name, and one with a variant that every module has
  "src/Door.elm": lines("module Door exposing (Door(..), Answer(..))", "", "", "type Door", "    = Open", "    | Halt", "", "", "type Answer", "    = Nothing", "    | Maybe"),
};

test("a variant is removed where its name tells it apart, from a type that keeps another variant", () => {
  const candidates = taskType("remove-variant").candidates(project(LIGHTS));
  // Halt is on two types, and Nothing is a variant that every module has
  assert.deepEqual(
    candidates.map(({ key, size, users }) => [key, size, users]),
    [
      ["src/Signal.elm:Light.Walk", 2, ["src/Signal.elm", "src/Page/Home.elm"]],
      ["src/Signal.elm:Light.Wait", 2, ["src/Signal.elm", "src/Page/Home.elm"]],
      ["src/Door.elm:Door.Open", 1, ["src/Door.elm"]],
      ["src/Door.elm:Answer.Maybe", 1, ["src/Door.elm"]],
    ]
  );
  const walk = candidates.find((candidate) => candidate.variant === "Walk");
  const { prompt, expect } = taskType("remove-variant").build(walk, "elm make src/Main.elm");
  assert.equal(
    prompt.split("\n\n")[0],
    "Remove the variant `Walk` from the custom type `Light` in `src/Signal.elm`. " +
      "Remove every branch of a `case` whose pattern names `Walk`, also where it stands inside a tuple or inside the pattern of another variant, as in `( Walk, _ )` or `Just Walk`, since such a branch can no longer match. " +
      "A `case` that is left with one branch stays a `case`. " +
      "Replace every other use of `Walk`, also one written with a qualifier, with `Debug.todo` and a string literal of your choice for its message. " +
      "Where arguments follow `Walk` directly, as in `Walk a b`, the whole application with its arguments is replaced. " +
      "Elsewhere, as in `List.map Walk items` or `Walk <| a`, only the name is. " +
      "Leave every other function, variable and import as it is, also one that the removal leaves unused."
  );
  assert.match(prompt, /\n\nChange nothing else\. The project compiles with `elm make src\/Main\.elm`/);
  assert.deepEqual(
    expect.map((expectation) => expectation.kind),
    ["type-lacks-variant", "removes-only", "only-elm-files"]
  );
});

test("the plan removes the branches that match on the variant and replaces each other use of it", () => {
  const removal = { of: "variant", file: "src/Signal.elm", module: "Signal", type: "Light", variant: "Walk", users: ["src/Signal.elm", "src/Page/Home.elm"] };
  const signal = removedFrom(removal, "src/Signal.elm", SIGNAL);
  // The first variant goes with the bar behind it. The application over two lines is replaced whole,
  // and the one before <| up to the operator.
  assert.match(signal, /^type Light\n    = Wait\n    \| Halt\n/m);
  assert.match(signal, /^describe light =\n    case light of\n        Wait ->\n/m);
  assert.match(signal, /^        \( Wait, _ \) ->\n            \(Debug\.todo "Walk was removed"\)\n\n        \( Halt, _ \) ->\n            \(Debug\.todo "Walk was removed"\) <\| "b"\n$/m);
  // The helper of the branch that went stays, and so does the import
  assert.match(signal, /^import Words exposing \(shout\)$/m);
  assert.doesNotMatch(signal, /Walk [_1]|speed/);

  const home = removedFrom(removal, "src/Page/Home.elm", HOME);
  assert.equal(
    home,
    lines(
      "module Page.Home exposing (view)",
      "",
      "import Signal as S exposing (Light(..))",
      "",
      "",
      "view : Maybe S.Light -> List String",
      "view light =",
      "    case light of",
      "        Just Wait ->",
      '            List.map S.describe [ Wait, S.Halt, (Debug.todo "Walk was removed") ]',
      "",
      "        _ ->",
      '            List.map S.describe (List.map (Debug.todo "Walk was removed") [ 1 ] |> List.map (\\make -> make "d"))'
    )
  );

  // A case left with one branch stays a case, and the last variant goes with the bar in front of it
  const halt = removedFrom({ ...removal, variant: "Halt" }, "src/Signal.elm", SIGNAL);
  assert.match(halt, /^type Light\n    = Walk Int String\n    \| Wait\n/m);
  assert.doesNotMatch(halt, /Halt/);

  // The trial's rename reaches every use that the removal reads, also in a pattern and behind a qualifier
  const [renamed, removed] = taskType("remove-variant").trial.edits({ ...removal }, (file) => LIGHTS[file]);
  assert.deepEqual(removed, { "src/Signal.elm": signal, "src/Page/Home.elm": home });
  assert.equal(renamed["src/Page/Home.elm"], HOME.replaceAll("Walk", "WalkRenamed"));
  assert.equal(renamed["src/Signal.elm"], SIGNAL.replaceAll("Walk", "WalkRenamed"));
});

test("the plan reads what follows a use of the variant as Elm does, and leaves the variant alone where it cannot", () => {
  const removal = { of: "variant", file: "src/Signal.elm", module: "Signal", type: "Light", variant: "Walk", users: ["src/Signal.elm"] };
  const ending = (body) => SIGNAL.replace('Walk 2 <| "b"', body);
  // A lambda as the last argument
  assert.equal(removedFrom(removal, "src/Signal.elm", ending('Walk 2 \\x -> "b"')), null);
  // A minus sign with no blank behind it is a negation, and one with blanks around it subtracts
  assert.match(removedFrom(removal, "src/Signal.elm", ending('Walk -2 "b"')), /^            \(Debug\.todo "Walk was removed"\)\n$/m);
  assert.match(removedFrom(removal, "src/Signal.elm", ending('Walk - 2 "b"')), /\(Debug\.todo "Walk was removed"\) - 2 "b"/);
  // A branch on the line of `of`
  assert.equal(removedFrom(removal, "src/Signal.elm", SIGNAL.replace("case light of\n        Walk", "case light of Walk")), null);
  // A file that names no variant of the type is the same afterwards
  assert.equal(removedFrom(removal, "src/Words.elm", LIGHTS["src/Words.elm"]), LIGHTS["src/Words.elm"]);
});

// The files of a project written into a directory, with what a session changed of them, judged
function judging(t, sources, expect) {
  const elmRoot = tempDir(t);
  const write = (file, text) => {
    mkdirSync(join(elmRoot, file, ".."), { recursive: true });
    writeFileSync(join(elmRoot, file), text);
  };
  return (changes) => {
    for (const [file, text] of Object.entries({ ...sources, ...changes })) write(file, text);
    const changed = Object.keys(changes);
    return unmetExpectations(elmRoot, expect, left({ changed, originals: new Map(changed.map((file) => [file, sources[file] ?? null])), committed: new Set(Object.keys(sources)) }));
  };
}

test("a variant's removal is judged by the plan's own, with any message and the brackets free", (t) => {
  const [walk] = taskType("remove-variant").candidates(project(LIGHTS)).filter((candidate) => candidate.variant === "Walk");
  const { expect } = taskType("remove-variant").build(walk, "elm make src/Main.elm");
  const [, removed] = taskType("remove-variant").trial.edits(walk, (file) => LIGHTS[file]);
  const judge = judging(t, LIGHTS, expect);
  assert.deepEqual(judge(removed), []);
  const home = removed["src/Page/Home.elm"];
  // Another message, without brackets where none are needed, with <| and laid out anew
  const free = home.replace('[ Wait, S.Halt, (Debug.todo "Walk was removed") ]', '[ Wait\n              , S.Halt\n              , Debug.todo <| "gone"\n              ]');
  assert.deepEqual(judge({ ...removed, "src/Page/Home.elm": free }), []);
  assert.deepEqual(judge({ ...removed, "src/Page/Home.elm": home.replace('(Debug.todo "Walk was removed") [ 1 ]', '((Debug.todo ("""x"""))) [ 1 ]') }), []);

  // The arguments left behind the Debug.todo, a catch-all in the place of a branch, a helper and an import
  // that the removal leaves unused taken out, and a branch that stays
  const signal = removed["src/Signal.elm"];
  assert.deepEqual(judge({ ...removed, "src/Page/Home.elm": home.replace('(Debug.todo "Walk was removed") ]', '(Debug.todo "Walk was removed") 3 "c" ]') }), [
    'src/Page/Home.elm is not what the removal makes of it: ] became 3',
  ]);
  assert.deepEqual(judge({ ...removed, "src/Page/Home.elm": home.replace("Just Wait ->", "Just _ ->") }), ["src/Page/Home.elm is not what the removal makes of it: Wait became _"]);
  assert.deepEqual(judge({ ...removed, "src/Signal.elm": signal.replace("import Words exposing (shout)\n", "") }), [
    'src/Signal.elm is not what the removal makes of it: the module line and the imports no longer have "import Words exposing (shout)"',
  ]);
  assert.deepEqual(judge({ ...removed, "src/Words.elm": "module Words exposing (shout)\n" }), [
    "src/Words.elm is not what the removal makes of it: shout became the end of the file",
  ]);
  // Every construction replaced, and the branch that matches on the variant left in place
  assert.deepEqual(judge({ ...removed, "src/Page/Home.elm": HOME.replace('S.Walk 3 "c"', 'Debug.todo "x"').replace("List.map Walk", 'List.map (Debug.todo "x")') }), [
    "src/Page/Home.elm is not what the removal makes of it: Wait became (",
  ]);
  // The variant left on its type, and a file that the removal does not touch, changed in a comment only
  assert.deepEqual(judge({ ...removed, "src/Signal.elm": signal.replace("    = Wait", "    = Walk Int String\n    | Wait") }), [
    "Light in src/Signal.elm still has the variant Walk",
    "src/Signal.elm is not what the removal makes of it: Wait became Walk",
  ]);
  assert.deepEqual(judge({ ...removed, "src/Words.elm": LIGHTS["src/Words.elm"].replace("shout =", "-- Walk is gone\nshout =") }), []);
});

const PEOPLE = {
  "src/Person.elm": lines(
    "module Person exposing (Person, Team, first, score)",
    "",
    "",
    "type alias Person =",
    "    { name : String",
    "    , email : String",
    "    , rank : Int",
    "    }",
    "",
    "",
    "type alias Team =",
    "    { title : String",
    "    , people : List Person",
    "    }",
    "",
    "",
    "first : Person",
    "first =",
    '    { name = "a", email = "b", rank = 3 }',
    "",
    "",
    "score : Person -> Int",
    "score person =",
    "    person.rank + String.length person.email"
  ),
  "src/Page.elm": lines(
    "module Page exposing (view)",
    "",
    "import Person exposing (Person, Team)",
    "",
    "",
    "view : Team -> List String",
    "view team =",
    "    let",
    "        bumped =",
    "            { first | rank = 1 }",
    "",
    "        first : Person",
    "        first =",
    "            Person.first",
    "",
    "        email =",
    "            Person.email",
    "    in",
    "    List.map .email team.people",
    "        ++ [ { first | rank = 2, email = \"c\" }.email, (List.head team.people |> Maybe.map .email |> Maybe.withDefault \"\") ]",
    "        ++ [ (Person.score bumped |> String.fromInt), team.title, email ]"
  ),
  // A function of a module with the field's name, which a read of the field is not
  "src/Person/Email.elm": lines("module Person.Email exposing (email)", "", "", "email : String", "email =", '    "x"'),
};

test("a field is removed where it is on one record type alone, no pattern binds it and no code builds its alias as a function", () => {
  const candidates = (sources) => taskType("remove-field").candidates(project({ ...PEOPLE, ...sources })).map(({ key, size }) => [key, size]);
  assert.deepEqual(candidates({}), [
    ["src/Person.elm:Person.name", 1],
    ["src/Person.elm:Person.email", 2],
    ["src/Person.elm:Person.rank", 2],
    ["src/Person.elm:Team.title", 2],
    ["src/Person.elm:Team.people", 2],
  ]);
  // A field of the same name on another record type, in an alias or in an annotation
  assert.deepEqual(
    candidates({ "src/Other.elm": lines("module Other exposing (other)", "", "", "other : { rank : Int } -> Int", "other =", "    .rank") }).map(([key]) => key),
    ["src/Person.elm:Person.name", "src/Person.elm:Person.email", "src/Person.elm:Team.title", "src/Person.elm:Team.people"]
  );
  // A record pattern that names it, and the alias called as a function
  assert.deepEqual(
    candidates({ "src/Other.elm": lines("module Other exposing (other)", "", "import Person exposing (Person)", "", "", "other : Person -> Int", "other { rank } =", "    rank") }).map(([key]) => key),
    ["src/Person.elm:Person.name", "src/Person.elm:Person.email", "src/Person.elm:Team.title", "src/Person.elm:Team.people"]
  );
  assert.deepEqual(
    candidates({ "src/Other.elm": lines("module Other exposing (other)", "", "import Person exposing (Team)", "", "", "other : Team", "other =", '    Person.Team "t" []') }).map(([key]) => key),
    ["src/Person.elm:Person.name", "src/Person.elm:Person.email", "src/Person.elm:Person.rank"]
  );

  const email = taskType("remove-field").candidates(project(PEOPLE)).find((candidate) => candidate.field === "email");
  const { prompt } = taskType("remove-field").build(email, "elm make src/Main.elm");
  assert.equal(
    prompt.split("\n\n")[0],
    "Remove the field `email` from the record type alias `Person` in `src/Person.elm`. " +
      "Take it out of every record that is built with it, as in `{ email = ..., ... }`, together with its value, and out of every record update that sets it, as in `{ r | email = ... }`. " +
      "An update that sets no other field becomes the record alone, `r`. " +
      "Replace every read of the field with `Debug.todo` and a string literal of your choice for its message. " +
      "A read with a dot, as in `user.email` or `(get id).email`, is replaced together with the record in front of the dot, and a field read behind it stays, as in `(Debug.todo \"...\").next` for `user.email.next`. " +
      "An accessor function, `.email`, also in a pipeline as in `user |> .email`, becomes a function that ignores its argument, `\\_ -> Debug.todo \"...\"`. " +
      "No other record type of the project has a field `email`, no record pattern names it, and no code calls `Person` as a function. " +
      "Leave every other function, variable and import as it is, also one that the removal leaves unused."
  );
});

test("the plan takes the field out of records and replaces each read of it", () => {
  const removal = { of: "field", file: "src/Person.elm", module: "Person", alias: "Person", field: "email", fields: ["name", "email", "rank"], users: ["src/Person.elm", "src/Page.elm"] };
  const person = removedFrom(removal, "src/Person.elm", PEOPLE["src/Person.elm"]);
  assert.match(person, /^type alias Person =\n    \{ name : String\n    , rank : Int\n    \}$/m);
  assert.match(person, /^    \{ name = "a", rank = 3 \}$/m);
  assert.match(person, /^    person\.rank \+ String\.length \(Debug\.todo "email was removed"\)$/m);
  const page = removedFrom(removal, "src/Page.elm", PEOPLE["src/Page.elm"]);
  // The function of the same name and the variable stay, an accessor becomes a function, and an update loses the field
  assert.match(page, /^            Person\.email$/m);
  assert.match(page, /team\.title, email \]$/m);
  assert.match(page, /^    List\.map \(\\_ -> Debug\.todo "email was removed"\) team\.people$/m);
  assert.match(page, /\[ \(Debug\.todo "email was removed"\), \(List\.head team\.people \|> Maybe\.map \(\\_ -> Debug\.todo "email was removed"\) \|>/);

  // An update that sets the field alone becomes the record, and the first field goes with the comma behind it
  const name = removedFrom({ ...removal, field: "rank" }, "src/Page.elm", PEOPLE["src/Page.elm"]);
  assert.match(name, /^        bumped =\n            first\n/m);
  assert.match(name, /\[ \{ first \| email = "c" \}\.email,/);
  assert.match(removedFrom({ ...removal, field: "name" }, "src/Person.elm", PEOPLE["src/Person.elm"]), /^    \{ email : String\n    , rank : Int\n    \}$/m);

  // A record with other fields than the alias's, and a record pattern, are no records of the alias that the plan can tell
  assert.equal(removedFrom(removal, "src/Page.elm", PEOPLE["src/Page.elm"].replace("team.title, email ]", 'team.title, { email = "x" }.email ]')), null);
  assert.equal(removedFrom(removal, "src/Page.elm", PEOPLE["src/Page.elm"].replace("bumped =", "bumped { email } =")), null);
});

test("a field's removal is judged by the plan's own, with the accessor's function written as the session likes", (t) => {
  const email = taskType("remove-field").candidates(project(PEOPLE)).find((candidate) => candidate.field === "email");
  const { expect } = taskType("remove-field").build(email, "elm make src/Main.elm");
  const [renamed, removed] = taskType("remove-field").trial.edits(email, (file) => PEOPLE[file]);
  assert.equal(renamed["src/Page.elm"], PEOPLE["src/Page.elm"].replace(".email team", ".emailRenamed team").replace("}.email,", "}.emailRenamed,").replace("Maybe.map .email", "Maybe.map .emailRenamed").replace('email = "c"', 'emailRenamed = "c"'));
  const judge = judging(t, PEOPLE, expect);
  assert.deepEqual(judge(removed), []);
  const page = removed["src/Page.elm"];
  assert.deepEqual(judge({ ...removed, "src/Page.elm": page.replace('(\\_ -> Debug.todo "email was removed") team', '(\\person -> Debug.todo "none") team') }), []);
  // A plain Debug.todo where a function was asked for, and the read left in place
  assert.deepEqual(judge({ ...removed, "src/Page.elm": page.replace('(\\_ -> Debug.todo "email was removed") team', 'Debug.todo "none" team') }), [
    "src/Page.elm is not what the removal makes of it: \\ -> Debug.todo became Debug.todo",
  ]);
  assert.deepEqual(judge({ ...removed, "src/Person.elm": removed["src/Person.elm"].replace('(Debug.todo "email was removed")', "person.email") }), [
    "src/Person.elm is not what the removal makes of it: Debug.todo became person",
  ]);
  // The field left on the alias
  assert.deepEqual(judge({ "src/Page.elm": page }), [
    "Person in src/Person.elm still has the field email",
    "src/Person.elm is not what the removal makes of it: rank became email",
  ]);
});

test("Debug.todo with a message is one token, in brackets or not, and so is a function that returns one", () => {
  const tokens = (text) => text.match(/"[^"]*"|[\p{L}_][\p{L}0-9_]*|\S/gu);
  assert.deepEqual(withoutTodoMessages(tokens('f (Debug.todo "a") x')), ["f", "Debug.todo", "x"]);
  assert.deepEqual(withoutTodoMessages(tokens('f ((Debug.todo <| ("b"))) x')), ["f", "Debug.todo", "x"]);
  assert.deepEqual(withoutTodoMessages(tokens('List.map (\\_ -> Debug.todo "c") xs')), ["List", ".", "map", "\\ -> Debug.todo", "xs"]);
  // Without a literal for its message it stays as it is
  assert.deepEqual(withoutTodoMessages(tokens("Debug.todo message")), ["Debug", ".", "todo", "message"]);
});
