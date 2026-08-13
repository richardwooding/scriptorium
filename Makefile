GOROOT := $(shell go env GOROOT)

.PHONY: web wasm serve test lint clean vendor-js

# web copies the client sources + wasm_exec.js into dist. It does NOT run
# esbuild — the vendored JS bundles are committed (see vendor-js).
web:
	mkdir -p web/dist
	cp web/src/* web/dist/
	cp "$(GOROOT)/lib/wasm/wasm_exec.js" web/dist/

wasm: web
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o web/dist/scriptorium.wasm ./cmd/scriptorium-wasm
	go run ./cmd/compress-assets web/dist

serve: wasm
	go run ./cmd/scriptorium

# vendor-js regenerates the committed browser bundles (Yjs, editor, markdown)
# from pinned versions via esbuild. Run only when bumping a dependency; the
# output is committed and CI diff-checks it. (Wired in M3.)
vendor-js:
	sh scripts/vendor-js.sh

test:
	go test -race ./...

lint:
	go vet ./...
	golangci-lint run

clean:
	rm -f scriptorium
	find web/dist -type f ! -name .gitkeep -delete
