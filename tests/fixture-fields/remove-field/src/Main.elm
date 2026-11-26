port module Main exposing (main)

import Account as Acc exposing (Account, Holder(..), Login)
import Html exposing (Html, text)
import Other exposing (Other)


port sendTitle : String -> Cmd msg


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
    List.map (\account -> account.title ++ account.owner) accounts


accessor : List Acc.Account -> List String
accessor accounts =
    List.map .title accounts


onlyField : List Account -> List String
onlyField accounts =
    List.map (\{ title } -> title) accounts


twoFields : Account -> String
twoFields { owner, title } =
    owner ++ title


letBound : Login -> String
letBound login =
    let
        account =
            login.account
    in
    account.title


retitled : Account -> Account
retitled account =
    { account | title = account.title ++ "!" }


reranked : Account -> Account
reranked account =
    { account | title = "x", rank = 1 }


titleOf : { a | title : String } -> String
titleOf record =
    record.title


inline : { title : String, owner : String, rank : Int } -> Account
inline record =
    record


built : Account
built =
    { title = "Savings"
    , owner = "Ada"
    , rank = 2
    }


otherTitle : Other -> String
otherTitle other =
    other.title ++ Other.describe { title = "o", size = 1 }


main : Html msg
main =
    text
        (String.concat
            [ chained { account = built, token = "" }
            , String.concat (lambda [ Acc.blank ])
            , String.concat (accessor [ inline built ])
            , String.concat (onlyField [ retitled built ])
            , twoFields (reranked built)
            , letBound { account = built, token = "" }
            , caseBranch (Holds built)
            , titleOf built
            , otherTitle { title = "", size = 0 }
            ]
        )
