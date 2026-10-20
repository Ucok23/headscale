// Package ui embeds the built admin web UI (ui/dist) so it can be served by
// the headscale binary. Build the UI first with `npm run build` in this
// directory; a bare checkout only contains a placeholder.
package ui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// Handler serves the UI under the given URL prefix (e.g. "/admin"). Unknown
// paths fall back to index.html so client-side routing works.
func Handler(prefix string) http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // dist is embedded at compile time; cannot fail
	}

	files := http.StripPrefix(prefix, http.FileServerFS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(strings.TrimPrefix(r.URL.Path, prefix)), "/")
		if name == "" {
			name = "index.html"
		}

		if _, err := fs.Stat(sub, name); err != nil {
			r.URL.Path = prefix + "/"
		}

		files.ServeHTTP(w, r)
	})
}
