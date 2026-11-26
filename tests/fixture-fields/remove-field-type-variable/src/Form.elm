module Form exposing (Context, Named, empty)


type alias Context value extra =
    { fields : List String
    , result : Result String value
    , nested : { inner : List value }
    , note : Maybe extra
    , attempted : Bool
    }


empty : Context () String
empty =
    { fields = [], result = Ok (), nested = { inner = [] }, note = Nothing, attempted = False }


type alias Named base =
    { base
        | label : String
        , order : Int
    }
