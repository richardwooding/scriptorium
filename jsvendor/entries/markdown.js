import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { load as loadYaml } from "js-yaml";
import { parse as parseToml } from "smol-toml";
import texmath from "markdown-it-texmath";
import hljs from "highlight.js/lib/core";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import bash from "highlight.js/lib/languages/bash";
import mdLang from "highlight.js/lib/languages/markdown";

// Curated highlight.js languages (mirrors the editor's set). Each registers its
// own aliases (javascript→js/jsx/mjs, xml→html, bash→sh, …).
for (const [name, lang] of Object.entries({
  go, javascript, typescript, json, yaml, xml, css, python, rust, bash, markdown: mdLang,
})) hljs.registerLanguage(name, lang);

// markdown-it: highlight fenced code (and emit a placeholder for ```mermaid),
// and parse $…$ / $$…$$ into placeholders that enrich() renders with KaTeX.
const md = new MarkdownIt({
  html: false, linkify: true, breaks: false,
  highlight(str, lang) {
    // Mermaid source rides as escaped TEXT content (DOMPurify strips a data-src
    // attribute that contains "-->"); enrich() stashes it and renders the SVG.
    if (lang === "mermaid") return '<pre class="mermaid">' + esc(str) + "</pre>";
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs"><code class="language-' + esc(lang) + '">' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + "</code></pre>";
      } catch (_) { /* fall through to plain */ }
    }
    return '<pre class="hljs"><code>' + esc(str) + "</code></pre>";
  },
});

// Math: texmath robustly finds $…$ / $$…$$ (handles currency/escapes); a stub
// "engine" emits an escaped placeholder — the real KaTeX render happens in
// enrich() from the lazy bundle, so KaTeX stays out of this eager bundle.
const mathStub = {
  renderToString(tex, opts) {
    return '<span class="math-tex" data-display="' + (opts && opts.displayMode ? "1" : "0") + '">' + esc(tex) + "</span>";
  },
};
md.use(texmath, { engine: mathStub, delimiters: "dollars" });

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// detectFrontMatter recognizes a leading YAML (---), TOML (+++), or JSON ({...})
// block — only at the very start, so a mid-document `---` stays a thematic break.
// Returns { format, raw, body } or null.
function detectFrontMatter(src) {
  const s = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src; // strip BOM
  let m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(s);
  if (m) return { format: "yaml", raw: m[1], body: s.slice(m[0].length) };
  m = /^\+\+\+[ \t]*\r?\n([\s\S]*?)\r?\n\+\+\+[ \t]*(?:\r?\n|$)/.exec(s);
  if (m) return { format: "toml", raw: m[1], body: s.slice(m[0].length) };
  if (/^\s*\{/.test(s)) {
    const end = jsonObjectEnd(s);
    if (end > 0) return { format: "json", raw: s.slice(0, end), body: s.slice(end).replace(/^\r?\n/, "") };
  }
  return null;
}

// jsonObjectEnd returns the index just past the matching close of the leading
// { ... } object (string-aware), or -1 if unbalanced — so a stray `{` in prose
// is never mistaken for front matter.
function jsonObjectEnd(s) {
  let i = 0;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== "{") return -1;
  let depth = 0, inStr = false, escaped = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function parseFrontMatter(fm) {
  if (fm.format === "yaml") return loadYaml(fm.raw);
  if (fm.format === "toml") return parseToml(fm.raw);
  return JSON.parse(fm.raw);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function scalar(x) {
  if (x === null || x === undefined) return "";
  if (x instanceof Date) return isNaN(x.getTime()) ? String(x) : x.toISOString().replace(/\.000Z$/, "Z");
  return String(x);
}

function renderValue(v) {
  if (v === null || v === undefined || v === "") return "&mdash;";
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== "object")) {
      return v.map((x) => '<span class="fm-pill">' + esc(scalar(x)) + "</span>").join("");
    }
    return "<code>" + esc(JSON.stringify(v)) + "</code>";
  }
  if (typeof v === "object" && !(v instanceof Date)) return "<code>" + esc(JSON.stringify(v)) + "</code>";
  return esc(scalar(v));
}

// renderCard turns a parsed front-matter object into a metadata card. Keys are
// escaped labels; values are escaped text / pills / compact JSON for nesting.
function renderCard(obj) {
  const rows = Object.keys(obj)
    .map((k) => "<dt>" + esc(k) + "</dt><dd>" + renderValue(obj[k]) + "</dd>")
    .join("");
  return '<div class="md-frontmatter"><dl>' + rows + "</dl></div>";
}

function rawBlock(fm) {
  return '<pre class="md-frontmatter-raw" data-format="' + esc(fm.format) + '">' + esc(fm.raw) + "</pre>";
}

// Render markdown (no raw HTML) then sanitize — content is untrusted peer input.
// A leading front-matter block (YAML/TOML/JSON) is parsed and rendered as a
// metadata card instead of leaking through as an <hr> + setext heading.
// ---- lazy loaders (script bundles + a stylesheet, injected once) ----------
const scripts = {};
function loadScript(src) {
  if (!scripts[src]) {
    scripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }
  return scripts[src];
}
function loadCss(href) {
  if (document.querySelector('link[data-md-css="' + href + '"]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href; l.setAttribute("data-md-css", href);
  document.head.appendChild(l);
}
function pickTheme(opts) {
  if (opts && (opts.theme === "light" || opts.theme === "dark")) return opts.theme;
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

let mmdSeq = 0;
let mmdTheme = null;
async function renderMermaid(root, theme) {
  const want = theme === "light" ? "default" : "dark";
  // Synchronously stash each diagram's source into a JS-set data-src (not
  // sanitized) and clear the text, so the CSS "rendering…" hint shows during the
  // lazy load. Skip diagrams already rendered for the current theme.
  const todo = [];
  for (const node of root.querySelectorAll("pre.mermaid")) {
    if (node.getAttribute("data-src") === null) {
      node.setAttribute("data-src", node.textContent || "");
      node.textContent = "";
    }
    if (node.getAttribute("data-theme-rendered") === want && node.querySelector("svg")) continue;
    todo.push(node);
  }
  if (!todo.length) return;
  await loadScript("mermaid.bundle.js");
  const mermaid = window.mermaid;
  if (mmdTheme !== want) { mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: want }); mmdTheme = want; }
  for (const node of todo) {
    const src = node.getAttribute("data-src") || "";
    try {
      const { svg } = await mermaid.render("mmd-" + (++mmdSeq), src);
      node.innerHTML = svg; // data-src kept for re-theming
      node.setAttribute("data-theme-rendered", want);
    } catch (e) {
      node.textContent = "diagram error: " + (e && e.message ? e.message : e);
    }
  }
}
async function renderMath(root) {
  const nodes = root.querySelectorAll(".math-tex:not([data-done])");
  if (!nodes.length) return;
  await loadScript("katex.bundle.js");
  loadCss("katex.css");
  const katex = window.katex;
  for (const node of nodes) {
    const tex = node.textContent;
    try {
      katex.render(tex, node, { displayMode: node.getAttribute("data-display") === "1", throwOnError: false, output: "html" });
    } catch (_) { /* katex handles its own errors with throwOnError:false */ }
    node.setAttribute("data-done", "1");
  }
}

// Render markdown (no raw HTML) then sanitize — content is untrusted peer input.
// A leading front-matter block (YAML/TOML/JSON) becomes a metadata card; fenced
// code is highlighted; ```mermaid and $…$/$$…$$ become placeholders that
// enrich() fills asynchronously (see below).
window.MD = {
  render(src) {
    src = src || "";
    let prefix = "";
    let body = src;
    const fm = detectFrontMatter(src);
    if (fm) {
      try {
        const obj = parseFrontMatter(fm);
        prefix = isPlainObject(obj) ? renderCard(obj) : rawBlock(fm);
      } catch (_) {
        prefix = rawBlock(fm); // malformed → show it neatly, never the ugly hr+h2
      }
      body = fm.body;
    }
    // ADD_TAGS keeps texmath's <eq>/<eqn> wrappers so the .math-tex placeholders
    // inside them survive; hljs/mermaid output is plain HTML. Post-pass renders
    // (Mermaid SVG, KaTeX) run AFTER this and are safe by construction.
    return DOMPurify.sanitize(prefix + md.render(body), {
      USE_PROFILES: { html: true }, ADD_TAGS: ["eq", "eqn"],
    });
  },
  // enrich fills in Mermaid diagrams + KaTeX math inside an already-rendered
  // container, lazy-loading each renderer on first use. Idempotent (KaTeX nodes
  // are marked done; Mermaid re-renders from data-src so a theme flip restyles).
  async enrich(root, opts) {
    if (!root) return;
    const theme = pickTheme(opts);
    try { await renderMermaid(root, theme); } catch (_) { /* leave placeholder */ }
    try { await renderMath(root); } catch (_) { /* leave placeholder */ }
  },
};
