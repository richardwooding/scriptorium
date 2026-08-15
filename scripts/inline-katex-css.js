// inline-katex-css.js — produce a self-contained web/src/katex.css from the
// vendored KaTeX stylesheet, with the woff2 fonts base64-inlined and the
// woff/ttf fallbacks dropped. Run from scripts/vendor-js.sh (cwd = jsvendor).
//   node scripts/inline-katex-css.js <out-path>
const fs = require("fs");
const path = require("path");

const dist = path.join(process.cwd(), "node_modules", "katex", "dist");
let css = fs.readFileSync(path.join(dist, "katex.min.css"), "utf8");

// Drop the non-woff2 sources so the browser only ever uses the inlined woff2.
css = css.replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");

// Inline each woff2 font file as a data: URI.
css = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_m, name) => {
  const bytes = fs.readFileSync(path.join(dist, "fonts", name));
  return "url(data:font/woff2;base64," + bytes.toString("base64") + ")";
});

const out = process.argv[2];
fs.writeFileSync(out, css);
console.log("katex.css: " + Math.round(css.length / 1024) + "KB (fonts inlined)");
