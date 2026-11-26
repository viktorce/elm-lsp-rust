module Old.Item exposing (Item, code)


type alias Item =
    { code : Int
    }


code : Item -> Int
code item =
    item.code
