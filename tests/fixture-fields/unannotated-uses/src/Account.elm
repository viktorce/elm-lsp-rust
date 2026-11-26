module Account exposing (Account, Holder(..), Login)


type alias Account =
    { title : String
    , owner : String
    }


type alias Login =
    { account : Account
    , token : String
    }


type Holder
    = Holds Account
    | Nobody
