import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
// Render markdown (no raw HTML) then sanitize — content is untrusted peer input.
window.MD = {
  render(src) { return DOMPurify.sanitize(md.render(src || ""), { USE_PROFILES: { html: true } }); },
};
