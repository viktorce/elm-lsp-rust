module Other exposing (Other, describe)


type alias Other =
    { title : String
    , size : Int
    }


describe : Other -> String
describe other =
    other.title ++ String.fromInt other.size
