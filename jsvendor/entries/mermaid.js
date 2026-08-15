// Lazy bundle: Mermaid diagram renderer. Loaded on demand by markdown.js's
// enrich() only when a ```mermaid block is present. Exposes window.mermaid.
import mermaid from "mermaid";
window.mermaid = mermaid;
