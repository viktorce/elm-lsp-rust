module Notice exposing (Notice, fromPayload)


type alias Notice =
    { title : String
    , action : String
    , read : Bool
    }


fromPayload : { title : String, action : String } -> Notice
fromPayload { title, action } =
    { title = title
    , action = action
    , read = False
    }
