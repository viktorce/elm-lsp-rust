module Main exposing (main)

import Draft exposing (Draft)
import Html exposing (Html, text)
import Tile exposing (Tile)


titleOf : { a | title : String } -> String
titleOf record =
    record.title


main : Html msg
main =
    text (titleOf { title = "Lamp", size = 3 } ++ titleOf { title = "Note", saved = False })


both : Tile -> Draft -> String
both tile draft =
    titleOf tile ++ titleOf draft
