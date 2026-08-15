#!/usr/bin/env sh
# gen-icons.sh — regenerate the PWA raster icons from the SVG sources into
# web/src/ (flat — the Makefile's `cp web/src/*` is non-recursive). Run this
# whenever the mark changes. Requires rsvg-convert (librsvg) + ImageMagick.
#
#   sh scripts/gen-icons.sh
set -eu
here="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
src="$here/web/src"
maskable="$here/scripts/icons/maskable.svg"

# "any" icons — the rounded-tile mark (transparent corners are fine here).
rsvg-convert -w 192 -h 192 "$src/favicon.svg" -o "$src/icon-192.png"
rsvg-convert -w 512 -h 512 "$src/favicon.svg" -o "$src/icon-512.png"

# maskable — full-bleed opaque, padded into the safe zone for launcher masking.
rsvg-convert -w 512 -h 512 "$maskable" -o "$src/icon-maskable-512.png"

# apple-touch — opaque (iOS ignores alpha and masks to a squircle); flatten the
# transparent tile corners onto the tile background so there is no black fringe.
rsvg-convert -w 180 -h 180 "$src/favicon.svg" -o "$src/.apple-tmp.png"
magick "$src/.apple-tmp.png" -background '#161b22' -flatten "$src/apple-touch-icon.png"
rm -f "$src/.apple-tmp.png"

echo "generated: icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png"
