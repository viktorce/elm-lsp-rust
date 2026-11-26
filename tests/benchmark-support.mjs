/**
 * Helpers and fixtures of the benchmark's tests, in a module of their own so
 * that more than one of the tests/benchmark*.test.mjs files can use them.
 */

import { execFileSync } from "child_process";
import { join } from "path";
import { REPO } from "./support.mjs";

export const BENCH = join(REPO, "benchmarks/bench.mjs");

// Stands in for the Elm compiler, and the stand-ins of the harnesses lie beside it
export const FAKE_COMPILER = join(REPO, "tests/fakes/elm-make.mjs");

// git in a test repository, with an identity and without signing, whatever this machine's configuration says
export const git = (repo, ...args) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]).toString();

// Turn a directory into a git repository with one commit.
export function gitRepository(dir) {
  git(dir, "init", "--quiet");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "--message", "fixture");
  return dir;
}

export const SHAPES = [
  "module Shapes exposing (Shape(..), Point, area)",
  "",
  "import Json.Decode as Decode exposing (Decoder)",
  "import Html",
  "",
  "",
  "type Shape",
  "    = Circle Float",
  "    | Polygon",
  "        { sides : Int",
  "        , length : Float",
  "        }",
  "    | Dot",
  "",
  "",
  "type alias Point =",
  "    { x : Float",
  "    , y : Float",
  "    , label :",
  "        { text : String",
  "        , size : Int",
  "        }",
  "    }",
  "",
  "",
  "type alias Id =",
  "    Int",
  "",
  "",
  "area : Shape -> Float",
  "area shape =",
  "    0",
  "",
].join("\n");

// What the compiler takes as well: the name of a declaration on a line below its first word, and
// the colon of a type annotation on a line below the name
export const SPREAD = [
  "module",
  "    Layout",
  "    exposing",
  "    ( Shape(..)",
  "    , area",
  "    )",
  "",
  "import",
  "    Html",
  "    exposing (Html)",
  "",
  "",
  "type",
  "    Shape",
  "    = Circle Float",
  "    | Dot",
  "",
  "",
  "type alias",
  "    Point",
  "    =",
  "    { x : Float, y : Float }",
  "",
  "",
  "area",
  "    : Shape -> Point -> Html msg",
  "area shape point =",
  '    Html.text ""',
  "",
  "",
  "hidden : Int",
  "hidden =",
  "    1",
  "",
].join("\n");

// What a session left behind, as far as a test says
export const left = (parts) => ({ changed: [], patch: "", originals: new Map(), committed: new Set(), ...parts });
