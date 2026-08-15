package main

import "testing"

func TestContentType(t *testing.T) {
	cases := map[string]string{
		"scriptorium.wasm":  "application/wasm",
		"app.js":            "text/javascript; charset=utf-8",
		"style.css":         "text/css; charset=utf-8",
		"index.html":        "text/html; charset=utf-8",
		"manifest.json":     "application/json",
		"app.webmanifest":   "application/json",
		"favicon.svg":       "image/svg+xml",
		"icon-192.png":      "image/png",
		"apple-touch-icon.png": "image/png",
		"favicon.ico":       "image/x-icon",
		"scriptorium.bin":   "application/octet-stream",
	}
	for name, want := range cases {
		if got := contentType(name); got != want {
			t.Errorf("contentType(%q) = %q, want %q", name, got, want)
		}
	}
}
