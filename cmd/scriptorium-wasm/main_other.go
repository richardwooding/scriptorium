//go:build !(js && wasm)

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "scriptorium-wasm is the browser core; build it with:")
	fmt.Fprintln(os.Stderr, "  GOOS=js GOARCH=wasm go build -o web/dist/scriptorium.wasm ./cmd/scriptorium-wasm")
	os.Exit(1)
}
