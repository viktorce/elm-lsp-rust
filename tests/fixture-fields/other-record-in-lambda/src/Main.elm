module Main exposing (main)

import Tile
import Draft
import Html exposing (Html, text)


main : Html msg
main =
    text (Tile.show { title = "Lamp", size = 3 } ++ (Draft.update (Draft.Retitle "Title") { title = "", saved = False }).title)
