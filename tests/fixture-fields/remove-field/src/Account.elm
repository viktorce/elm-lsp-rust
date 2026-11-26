module Account exposing (Account, Holder(..), Login, blank)


type alias Account =
    { title : String
    , owner : String
    , rank : Int
    }


type alias Login =
    { account : Account
    , token : String
    }


type Holder
    = Holds Account
    | Nobody


blank : Account
blank =
    { title = "", owner = "", rank = 0 }
