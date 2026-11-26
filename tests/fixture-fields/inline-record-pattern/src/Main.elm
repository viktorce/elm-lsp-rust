module Main exposing (main)

import Html exposing (Html, text)
import Notice exposing (Notice)


describe : Notice -> String
describe notice =
    notice.title ++ ": " ++ notice.action


main : Html msg
main =
    text (describe (Notice.fromPayload { title = "Lamp", action = "buy" }))
