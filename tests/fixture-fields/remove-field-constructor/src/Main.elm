module Main exposing (main)

import Account exposing (Account)
import Html exposing (Html, text)


savings : Account
savings =
    Account.Account "Savings" "Ada"


main : Html msg
main =
    text (savings.title ++ savings.owner)
