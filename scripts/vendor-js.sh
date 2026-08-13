#!/usr/bin/env sh
# vendor-js.sh — regenerate the committed browser bundles in web/src from the
# pinned sources in jsvendor/. Run on a dependency bump; the output is
# committed and CI diff-checks it. Produces self-contained IIFE bundles that
# expose a single global each (window.Y/YProto, window.CMEditor, window.MD),
# so web/src/*.js can use them as plain <script>s with no import map.
set -eu
here="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$here/jsvendor"
npm install --no-audit --no-fund --silent
run() {
  ./node_modules/.bin/esbuild "entries/$1.js" \
    --bundle --format=iife --minify --target=es2020 \
    --outfile="$here/web/src/$2.bundle.js"
}
run editor editor
run markdown markdown
# record the resolved versions for drift detection
node -e 'const p=require("./package.json").dependencies;console.log(Object.entries(p).map(([k,v])=>k+"@"+v).join("\n"))' > "$here/web/src/.js-vendor-version"
echo "vendored: $(cd "$here/web/src" && ls *.bundle.js)"
