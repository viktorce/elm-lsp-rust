module Main exposing (main)

import Html exposing (Html, text)
import Item exposing (Item)
import Old.Item


label : Item -> String
label item =
    item.title


main : Html msg
main =
    text (label { title = "Lamp", price = 3 } ++ Item.describe { title = "Desk", price = 9 } ++ String.fromInt (Old.Item.code { code = 1 }))
