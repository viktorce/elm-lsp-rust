module Main exposing (main)

import Account exposing (Account, Holder(..), Login)
import Html exposing (Html, text)


annotated : Account -> String
annotated account =
    account.title


chained : Login -> String
chained login =
    login.account.title


caseBranch : Holder -> String
caseBranch holder =
    case holder of
        Holds account ->
            account.title

        Nobody ->
            ""


lambda : List Account -> List String
lambda accounts =
    List.map (\account -> account.title) accounts


accessor : List Account -> List String
accessor accounts =
    List.map .title accounts


lambdaPattern : List Account -> List String
lambdaPattern accounts =
    List.map (\{ title } -> title) accounts


letBound : Login -> String
letBound login =
    let
        account =
            login.account
    in
    account.title


main : Html msg
main =
    text (annotated { title = "Savings", owner = "Ada" })
