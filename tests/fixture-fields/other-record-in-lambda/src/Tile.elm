module Tile exposing (Tile, show)


type alias Tile =
    { title : String
    , size : Int
    }


show : Tile -> String
show tile =
    tile.title
