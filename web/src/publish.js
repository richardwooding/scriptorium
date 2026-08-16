// publish.js (window.Publish) — browser-only "Publish to GitHub", BYO token.
//
// Mirrors the AI assistant: a self-contained IIFE that reads a Personal Access
// Token from localStorage and calls api.github.com DIRECTLY (GitHub sends CORS
// headers) — the scriptorium relay is never in the loop. It pushes the whole
// workspace as a real Git commit via the REST Git Data API (blobs → tree →
// commit → ref); the actual build + artifact publishing is delegated to GitHub
// Actions (optional starter workflows the user adds to the workspace). No Go /
// relay / server change. See docs/PUBLISH.md for the trust boundary + scopes.
(function () {
  "use strict";

  const API = "https://api.github.com";

  const KEYS = {
    token: "scriptorium-gh-token",
    owner: "scriptorium-gh-owner",   // optional; defaults to the token's login
    repo: "scriptorium-gh-repo",     // optional; defaults to the workspace name
    branch: "scriptorium-gh-branch", // default "main"
    private: "scriptorium-gh-private",
  };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } };

  function config() {
    return {
      token: lsGet(KEYS.token) || "",
      owner: (lsGet(KEYS.owner) || "").trim(),
      repo: (lsGet(KEYS.repo) || "").trim(),
      branch: (lsGet(KEYS.branch) || "").trim() || "main",
      private: lsGet(KEYS.private) === "1",
    };
  }
  function isConfigured() { return !!config().token; }

  const el = (id) => document.getElementById(id);
  let busy = false;

  // base64 of a Uint8Array (char-by-char loop is stack-safe for large blobs).
  function b64encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64decode(s) {
    const bin = atob((s || "").replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function sanitizeRepo(s) {
    return (s || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "workspace";
  }
  function defaultRepoName() {
    const W = window.Workspace;
    let n = "";
    try { n = (W && W.getName && W.getName()) || ""; } catch (_) { /* ignore */ }
    if (!n) { try { n = decodeURIComponent((location.hash || "").replace(/^#/, "")); } catch (_) { n = ""; } }
    return sanitizeRepo(n || "workspace");
  }

  // ---- GitHub REST helper ------------------------------------------------
  async function gh(method, path, body, opts) {
    opts = opts || {};
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    const tok = config().token;
    if (tok) headers.authorization = "Bearer " + tok; // omit when empty → public repos work unauthenticated
    if (body) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error("network error reaching GitHub: " + (e && e.message ? e.message : e));
    }
    if (res.status === 404 && opts.allow404) return null;
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = j.message || JSON.stringify(j); } catch (_) { /* non-JSON */ }
      throw new Error(mapError(res, detail));
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function mapError(res, detail) {
    if (res.status === 401) return "401 — bad or expired token (check ⚙ settings)";
    if (res.status === 403) {
      return res.headers.get("x-ratelimit-remaining") === "0"
        ? "403 — GitHub rate limit reached; try again later"
        : "403 — token is missing a required scope (need repo + workflow)";
    }
    if (res.status === 404) return "404 — not found, or the token can't access it";
    if (res.status === 422) return "422 — " + (detail || "validation failed (pushing workflow files needs the 'workflow' scope)");
    return res.status + " — " + (detail || res.statusText);
  }

  // ---- publish flow ------------------------------------------------------
  async function publish() {
    if (busy) return;
    const cfg = config();
    if (!cfg.token) { openSettings(); return; }
    const W = window.Workspace;
    if (!W || !W.ai) { logErr("workspace not ready — reload the page"); return; }

    // Snapshot every file (text + binary) as base64 blobs; skip directories.
    const files = [];
    for (const node of W.ai.list()) {
      if (node.kind === "dir") continue;
      let bytes;
      try { bytes = W.readBytes(node.path); } catch (_) { continue; }
      files.push({ path: node.path, b64: b64encode(bytes) });
    }
    if (!files.length) { logErr("nothing to publish — the workspace is empty"); return; }

    busy = true; setBusy(true, "publish"); clearLog();
    try {
      const me = await gh("GET", "/user");
      const login = me.login;
      const owner = cfg.owner || login;
      const repo = sanitizeRepo(cfg.repo || defaultRepoName());
      const branch = cfg.branch;
      log("target: " + owner + "/" + repo + " @ " + branch);

      let r = await gh("GET", "/repos/" + owner + "/" + repo, null, { allow404: true });
      if (!r) {
        log("creating repository…");
        const path = owner.toLowerCase() === login.toLowerCase() ? "/user/repos" : "/orgs/" + owner + "/repos";
        r = await gh("POST", path, { name: repo, private: cfg.private, auto_init: false });
      }
      const repoUrl = r.html_url;

      const ref = await gh("GET", "/repos/" + owner + "/" + repo + "/git/ref/heads/" + branch, null, { allow404: true });
      const baseCommit = ref ? ref.object.sha : null;

      log("uploading " + files.length + " file(s)…");
      const tree = [];
      for (const f of files) {
        const b = await gh("POST", "/repos/" + owner + "/" + repo + "/git/blobs", { content: f.b64, encoding: "base64" });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
      }
      // Full snapshot: no base_tree, so the repo mirrors the workspace exactly
      // (deletions propagate). Parent = current head when the branch exists.
      const t = await gh("POST", "/repos/" + owner + "/" + repo + "/git/trees", { tree });
      const commit = await gh("POST", "/repos/" + owner + "/" + repo + "/git/commits", {
        message: "Publish from scriptorium", tree: t.sha, parents: baseCommit ? [baseCommit] : [],
      });
      if (ref) await gh("PATCH", "/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch, { sha: commit.sha });
      else await gh("POST", "/repos/" + owner + "/" + repo + "/git/refs", { ref: "refs/heads/" + branch, sha: commit.sha });

      log("✓ published " + files.length + " file(s)");
      logLink("open repository", repoUrl);
      logLink("view commit", repoUrl + "/commit/" + commit.sha);
      logLink("Actions (build & publish artifacts)", repoUrl + "/actions");
      setStatus("published");
    } catch (e) {
      logErr(e && e.message ? e.message : String(e));
      setStatus("");
    } finally {
      busy = false; setBusy(false);
    }
  }

  // ---- import flow (mirror of publish; public repos need no token) --------
  async function importFromGitHub() {
    if (busy) return;
    const W = window.Workspace;
    if (!W || !W.importReplace) { logErr("workspace not ready — reload the page"); return; }
    const cfg = config();
    const repo = sanitizeRepo(cfg.repo || defaultRepoName());
    let owner = cfg.owner;

    busy = true; setBusy(true, "import"); clearLog();
    try {
      if (!owner) {
        if (!cfg.token) throw new Error("set Owner (and Repository) in ⚙ settings — a public import needs the owner");
        owner = (await gh("GET", "/user")).login;
      }
      if (!window.confirm("Import " + owner + "/" + repo + " — this REPLACES the current workspace for everyone. Continue?")) {
        log("import cancelled");
        return;
      }
      log("importing " + owner + "/" + repo + " …");
      // Resolve branch → tree (fall back to the repo's default branch).
      let branch = cfg.branch;
      let br = await gh("GET", "/repos/" + owner + "/" + repo + "/branches/" + encodeURIComponent(branch), null, { allow404: true });
      if (!br) {
        const r = await gh("GET", "/repos/" + owner + "/" + repo);
        branch = r.default_branch;
        br = await gh("GET", "/repos/" + owner + "/" + repo + "/branches/" + encodeURIComponent(branch));
      }
      const treeSha = br.commit.commit.tree.sha;
      const tree = await gh("GET", "/repos/" + owner + "/" + repo + "/git/trees/" + treeSha + "?recursive=1");
      if (tree.truncated) log("note: the repo is large — GitHub truncated the tree; some files may be missing");
      let entries = tree.tree.filter((e) => e.type === "blob");
      const MAX_FILES = 400;
      let capped = false;
      if (entries.length > MAX_FILES) { entries = entries.slice(0, MAX_FILES); capped = true; }
      log("fetching " + entries.length + " file(s)…");
      const files = [];
      for (const e of entries) {
        if (e.size > 5 * 1024 * 1024) { log("skip (large): " + e.path); continue; }
        const blob = await gh("GET", "/repos/" + owner + "/" + repo + "/git/blobs/" + e.sha);
        files.push({ path: e.path, bytes: b64decode(blob.content) });
      }
      const res = W.importReplace(files);
      log("✓ imported " + res.written + " file(s) from " + owner + "/" + repo + " @ " + branch);
      if (capped) log("only the first " + MAX_FILES + " files were imported (repo is large)");
      for (const s of res.skipped.slice(0, 8)) log("skipped " + s.path + " (" + s.reason + ")");
      if (res.skipped.length > 8) log("…and " + (res.skipped.length - 8) + " more skipped");
      logLink("open repository", "https://github.com/" + owner + "/" + repo);
      setStatus("imported");
    } catch (e) {
      logErr(e && e.message ? e.message : String(e));
      setStatus("");
    } finally {
      busy = false; setBusy(false);
    }
  }

  // ---- starter workflows (written into the workspace, then pushed) --------
  const WORKFLOWS = {
    release: {
      path: ".github/workflows/release.yml",
      content: [
        "# Starter: build on tag push and attach artifacts to a GitHub Release.",
        "# Edit the Build step for your toolchain.",
        "name: release",
        "on:",
        "  push:",
        "    tags: [\"v*\"]",
        "permissions:",
        "  contents: write",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - name: Build",
        "        run: |",
        "          mkdir -p dist",
        "          # TODO: replace with your build, e.g.:",
        "          #   go build -o dist/ ./...",
        "          #   npm ci && npm run build && cp -r build/* dist/",
        "          echo \"add your build here\" > dist/BUILD.txt",
        "      - name: Create Release",
        "        uses: softprops/action-gh-release@v2",
        "        with:",
        "          files: dist/**",
        "",
      ].join("\n"),
    },
    pages: {
      path: ".github/workflows/pages.yml",
      content: [
        "# Starter: build a static site and deploy to GitHub Pages.",
        "# Enable Pages first: repo Settings → Pages → Source = GitHub Actions.",
        "name: pages",
        "on:",
        "  push:",
        "    branches: [\"main\"]",
        "permissions:",
        "  contents: read",
        "  pages: write",
        "  id-token: write",
        "jobs:",
        "  deploy:",
        "    environment:",
        "      name: github-pages",
        "      url: ${{ steps.deployment.outputs.page_url }}",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - name: Build",
        "        run: |",
        "          mkdir -p _site",
        "          # TODO: build your static site into ./_site",
        "          cp -r . _site 2>/dev/null || true",
        "      - uses: actions/upload-pages-artifact@v3",
        "        with:",
        "          path: _site",
        "      - id: deployment",
        "        uses: actions/deploy-pages@v4",
        "",
      ].join("\n"),
    },
    npm: {
      path: ".github/workflows/npm-publish.yml",
      content: [
        "# Starter: publish an npm package on tag push.",
        "# Add an NPM_TOKEN repo secret: Settings → Secrets and variables → Actions.",
        "name: npm-publish",
        "on:",
        "  push:",
        "    tags: [\"v*\"]",
        "jobs:",
        "  publish:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: \"20\"",
        "          registry-url: \"https://registry.npmjs.org\"",
        "      - run: npm ci",
        "      - run: npm run build --if-present",
        "      - run: npm publish --provenance --access public",
        "        env:",
        "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
        "",
      ].join("\n"),
    },
    container: {
      path: ".github/workflows/container.yml",
      content: [
        "# Starter: build a container image and push to GHCR (ghcr.io).",
        "# Requires a Dockerfile in the repo root; uses the built-in GITHUB_TOKEN.",
        "name: container",
        "on:",
        "  push:",
        "    branches: [\"main\"]",
        "    tags: [\"v*\"]",
        "permissions:",
        "  contents: read",
        "  packages: write",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: docker/login-action@v3",
        "        with:",
        "          registry: ghcr.io",
        "          username: ${{ github.actor }}",
        "          password: ${{ secrets.GITHUB_TOKEN }}",
        "      - id: meta",
        "        uses: docker/metadata-action@v5",
        "        with:",
        "          images: ghcr.io/${{ github.repository }}",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        "          context: .",
        "          push: true",
        "          tags: ${{ steps.meta.outputs.tags }}",
        "          labels: ${{ steps.meta.outputs.labels }}",
        "",
      ].join("\n"),
    },
  };

  // addWorkflows writes the selected starter workflow files INTO the workspace
  // (collaborative + editable + reviewable), so they ride the next publish.
  function addWorkflows(keys) {
    const W = window.Workspace;
    if (!W || !W.ai) return 0;
    const files = [];
    for (const k of keys) { const wf = WORKFLOWS[k]; if (wf) files.push({ path: wf.path, content: wf.content }); }
    if (!files.length) return 0;
    if (W.ai.writeMany) W.ai.writeMany(files);
    else for (const f of files) W.ai.write(f.path, f.content);
    return files.length;
  }

  // ---- log + status UI ---------------------------------------------------
  function clearLog() { const l = el("publish-log"); if (l) l.textContent = ""; }
  function appendLine(cls, text) {
    const l = el("publish-log"); if (!l) return;
    const d = document.createElement("div"); d.className = cls; d.textContent = text;
    l.appendChild(d); l.scrollTop = l.scrollHeight;
  }
  function log(text) { appendLine("pub-line", text); }
  function logErr(text) { appendLine("pub-err", "⚠ " + text); }
  function logLink(text, href) {
    const l = el("publish-log"); if (!l) return;
    const a = document.createElement("a");
    a.className = "pub-link"; a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = "→ " + text;
    l.appendChild(a); l.scrollTop = l.scrollHeight;
  }
  function setStatus(text) {
    const s = el("publish-status"); if (!s) return;
    if (!text) { s.hidden = true; s.textContent = ""; return; }
    s.hidden = false; s.textContent = "⇧ " + text;
  }
  function setBusy(b, which) {
    const p = el("btn-publish-now"), i = el("btn-import-now");
    if (p) { p.disabled = b; p.textContent = b && which === "publish" ? "Publishing…" : "Publish to GitHub"; }
    if (i) { i.disabled = b; i.textContent = b && which === "import" ? "Importing…" : "⤓ Import from GitHub"; }
  }
  function refreshTarget() {
    const cfg = config();
    const t = el("publish-target");
    if (t) t.textContent = (cfg.owner || "your account") + "/" + (sanitizeRepo(cfg.repo || defaultRepoName())) + " @ " + cfg.branch;
  }

  function onAddWorkflows() {
    const keys = ["release", "pages", "npm", "container"].filter((k) => { const c = el("wf-" + k); return c && c.checked; });
    if (!keys.length) { log("pick at least one workflow to add"); return; }
    const n = addWorkflows(keys);
    log("added " + n + " workflow file(s) under .github/workflows/ — they'll be included on publish");
    keys.forEach((k) => { const c = el("wf-" + k); if (c) c.checked = false; });
  }

  // ---- settings modal ----------------------------------------------------
  function openSettings() {
    const cfg = config();
    if (el("gh-token")) el("gh-token").value = cfg.token;
    if (el("gh-owner")) el("gh-owner").value = cfg.owner;
    if (el("gh-repo")) el("gh-repo").value = cfg.repo || defaultRepoName();
    if (el("gh-branch")) el("gh-branch").value = cfg.branch;
    if (el("gh-private")) el("gh-private").checked = cfg.private;
    if (el("publish-settings")) el("publish-settings").hidden = false;
  }
  function closeSettings() { if (el("publish-settings")) el("publish-settings").hidden = true; }
  function saveSettings() {
    lsSet(KEYS.token, (el("gh-token").value || "").trim());
    lsSet(KEYS.owner, (el("gh-owner").value || "").trim());
    lsSet(KEYS.repo, (el("gh-repo").value || "").trim());
    lsSet(KEYS.branch, (el("gh-branch").value || "").trim() || "main");
    lsSet(KEYS.private, el("gh-private") && el("gh-private").checked ? "1" : "0");
    closeSettings();
    refreshTarget();
    log("settings saved");
  }
  function forgetKey() {
    lsDel(KEYS.token);
    if (el("gh-token")) el("gh-token").value = "";
    log("token forgotten (removed from this browser)");
  }

  // ---- pane visibility ---------------------------------------------------
  function isOpen() { const p = el("publish-pane"); return p && !p.hidden; }
  function open() {
    const p = el("publish-pane"); if (p) p.hidden = false;
    const btn = el("btn-publish"); if (btn) btn.setAttribute("aria-expanded", "true");
    refreshTarget();
    if (!isConfigured()) openSettings();
  }
  function close() {
    const p = el("publish-pane"); if (p) p.hidden = true;
    const btn = el("btn-publish"); if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function toggle() { if (isOpen()) close(); else open(); }

  // ---- init --------------------------------------------------------------
  function init() {
    busy = false;
    clearLog(); setStatus("");
    wireOnce("btn-publish", "click", toggle);
    wireOnce("btn-publish-close", "click", close);
    wireOnce("btn-publish-settings", "click", openSettings);
    wireOnce("btn-publish-now", "click", publish);
    wireOnce("btn-import-now", "click", importFromGitHub);
    wireOnce("btn-add-workflows", "click", onAddWorkflows);
    wireOnce("btn-gh-save", "click", saveSettings);
    wireOnce("btn-gh-forget", "click", forgetKey);
    wireOnce("btn-gh-close-settings", "click", closeSettings);
    log(isConfigured() ? "Ready. Publish pushes this workspace to GitHub; Actions builds & publishes artifacts." : "Add a GitHub token (⚙) to start. It stays in this browser.");
    refreshTarget();
  }
  function wireOnce(id, ev, fn) {
    const node = el(id);
    if (node && !node["_w_" + ev]) { node.addEventListener(ev, fn); node["_w_" + ev] = true; }
  }

  window.Publish = { init, open, close, toggle, openSettings, isConfigured, publish, importFromGitHub, addWorkflows };
})();
