import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { load as loadYaml } from "js-yaml";
import { parse as parseToml } from "smol-toml";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

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
    return DOMPurify.sanitize(prefix + md.render(body), { USE_PROFILES: { html: true } });
  },
};
