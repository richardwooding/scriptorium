// Lazy bundle: KaTeX math renderer. Loaded on demand by markdown.js's enrich()
// only when the document contains math. Exposes window.katex. Its CSS (with
// woff2 fonts inlined) is web/src/katex.css, lazy-linked alongside this.
import katex from "katex";
window.katex = katex;
