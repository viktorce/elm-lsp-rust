module Draft exposing (Draft, Msg(..), update)


type alias Draft =
    { title : String
    , saved : Bool
    }


type Msg
    = Retitle String
    | Clean


update : Msg -> Draft -> Draft
update msg draft =
    case msg of
        Retitle title ->
            change (\current -> { current | title = title }) draft

        Clean ->
            { draft | saved = True }


change : (Draft -> Draft) -> Draft -> Draft
change edit draft =
    edit draft
