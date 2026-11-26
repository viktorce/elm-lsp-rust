module Item exposing (Item, describe)


type alias Item =
    { title : String
    , price : Int
    }


describe : Item -> String
describe item =
    item.title ++ " for " ++ String.fromInt item.price
