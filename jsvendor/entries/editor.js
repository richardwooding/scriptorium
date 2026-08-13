// Bundled Yjs + CodeMirror 6 + the Yjs binding + a language-by-extension map.
// Exposes window.Y / window.YProto (Yjs + awareness) AND window.CMEditor from a
// SINGLE bundle, so there is exactly ONE copy of Yjs in the page — importing
// Yjs twice breaks its constructor/instanceof checks and silently stops
// y-codemirror.next from binding (the editor looks frozen). workspace.js
// creates docs with the same window.Y this file binds against.
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness.js";
window.Y = Y;
window.YProto = { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates };

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

// gloam-flavoured dark theme (purple accent, near-black panels).
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

window.CMEditor = {
  // create({parent, ytext, awareness, path}) → { view, setLanguage(path), destroy() }
  create({ parent, ytext, awareness, path }) {
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
          gloamTheme, syntaxHighlighting(gloamHighlight),
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
      destroy() { view.destroy(); },
    };
  },
  languageForPath: (p) => extOf(p),
};

function extOf(path) {
  const base = (path || "").split("/").pop();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}
