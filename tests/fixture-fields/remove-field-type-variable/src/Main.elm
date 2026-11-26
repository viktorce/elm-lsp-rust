module Main exposing (main)

import Form exposing (Context)
import Html exposing (Html, text)


describe : Context value extra -> String
describe context =
    case context.result of
        Ok _ ->
            String.join ", " context.fields

        Err error ->
            error


main : Html msg
main =
    text (describe Form.empty)
