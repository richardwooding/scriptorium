// Bundled Yjs + CodeMirror 6 + the Yjs binding + a language-by-extension map.
// Exposes window.Y / window.YProto (Yjs + awareness) AND window.CMEditor from a
// SINGLE bundle, so there is exactly ONE copy of Yjs in the page — importing
// Yjs twice breaks its constructor/instanceof checks and silently stops
// y-codemirror.next from binding (the editor looks frozen). workspace.js
// creates docs with the same window.Y this file binds against.
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness.js";
// y-indexeddb rides THIS bundle so it shares the one Yjs above — a second Yjs
// copy would make its instanceof checks fail. workspace.js attaches it to the
// window.Y-created doc for offline-first, plaintext-at-rest local persistence.
import { IndexeddbPersistence } from "y-indexeddb";
window.Y = Y;
window.YProto = { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates };
window.YIndexeddb = IndexeddbPersistence;

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { yCollab } from "y-codemirror.next";

import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { StreamLanguage } from "@codemirror/language";
import { go } from "@codemirror/legacy-modes/mode/go";
import { shell } from "@codemirror/legacy-modes/mode/shell";

// gloam-flavoured DARK theme (purple accent, near-black panels). GitHub-dark
// syntax palette — tuned for the dark #0d1117 background.
const gloamTheme = EditorView.theme({
  "&": { color: "#e6edf3", backgroundColor: "transparent", height: "100%" },
  ".cm-content": { caretColor: "#a371f7", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#a371f7" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#2d2352" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#6e7681", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(163,113,247,0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
}, { dark: true });

const gloamHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#ff7b72" },
  { tag: [t.string, t.special(t.string)], color: "#a5d6ff" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#8b949e", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "#79c0ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#d2a8ff" },
  { tag: [t.typeName, t.className, t.namespace], color: "#ffa657" },
  { tag: [t.propertyName, t.attributeName], color: "#7ee787" },
  { tag: [t.heading], color: "#d2a8ff", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#a5d6ff", textDecoration: "underline" },
]);

// gloam LIGHT theme — GitHub-light palette, strong contrast on the white
// (#ffffff) background used in light mode. Keeps the purple accent on-brand.
const gloamThemeLight = EditorView.theme({
  "&": { color: "#1f2328", backgroundColor: "transparent", height: "100%" },
  ".cm-content": { caretColor: "#7c3aed", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#7c3aed" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#e2d5fb" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#818b98", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(124,58,237,0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
}, { dark: false });

const gloamHighlightLight = HighlightStyle.define([
  { tag: t.keyword, color: "#cf222e" },
  { tag: [t.string, t.special(t.string)], color: "#0a3069" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "#0550ae" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.propertyName, t.attributeName], color: "#116329" },
  { tag: [t.heading], color: "#8250df", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#0a3069", textDecoration: "underline" },
]);

// Effective theme: an explicit <html data-theme> wins, else the OS preference.
function effectiveTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// The theme + syntax highlight extensions for a mode, swapped as one unit via a
// Compartment so a theme flip is a cheap reconfigure (no view rebuild).
function themeExt(mode) {
  return mode === "light"
    ? [gloamThemeLight, syntaxHighlighting(gloamHighlightLight)]
    : [gloamTheme, syntaxHighlighting(gloamHighlight)];
}

function langForExt(ext) {
  switch (ext) {
    case "md": case "markdown": return markdown();
    case "js": case "mjs": case "cjs": case "jsx": return javascript({ jsx: true });
    case "ts": case "tsx": return javascript({ typescript: true, jsx: true });
    case "json": return json();
    case "yaml": case "yml": return yaml();
    case "html": case "htm": return html();
    case "css": return css();
    case "py": return python();
    case "rs": return rust();
    case "go": return StreamLanguage.define(go);
    case "sh": case "bash": case "zsh": return StreamLanguage.define(shell);
    default: return [];
  }
}

const language = new Compartment();
const theme = new Compartment();

window.CMEditor = {
  // create({parent, ytext, awareness, path, theme}) → { view, setLanguage(path), setTheme(mode), destroy() }
  create({ parent, ytext, awareness, path, theme: mode }) {
    const initial = mode === "light" || mode === "dark" ? mode : effectiveTheme();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(), foldGutter(), drawSelection(), highlightActiveLine(),
          history(), indentOnInput(), bracketMatching(), closeBrackets(),
          autocompletion(), highlightSelectionMatches(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
                     ...historyKeymap, ...completionKeymap, indentWithTab]),
          theme.of(themeExt(initial)),
          language.of(langForExt(extOf(path))),
          // yCollab binds the editor to the Y.Text and renders remote cursors
          // from awareness; it also feeds local edits back into the Y.Doc.
          yCollab(ytext, awareness),
        ],
      }),
    });
    return {
      view,
      setLanguage(p) { view.dispatch({ effects: language.reconfigure(langForExt(extOf(p))) }); },
      // Hot-swap the theme + syntax palette without rebuilding the view, so the
      // cursor, selection, and yCollab binding survive a light/dark flip.
      setTheme(m) { view.dispatch({ effects: theme.reconfigure(themeExt(m === "light" ? "light" : "dark")) }); },
      destroy() { view.destroy(); },
    };
  },
  languageForPath: (p) => extOf(p),
  effectiveTheme,
};

function extOf(path) {
  const base = (path || "").split("/").pop();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}
