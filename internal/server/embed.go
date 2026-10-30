package server

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embeddedDist embed.FS

func distFS() (fs.FS, error) {
	return fs.Sub(embeddedDist, "dist")
}
