# Publish to GitHub — how it works and what leaves your browser

scriptorium can **publish a workspace to GitHub**: open the **⇧ Publish** panel,
add your own GitHub token, and push the whole workspace to a repo as a real Git
commit. From there, **GitHub Actions builds and publishes the artifacts** —
scriptorium itself builds nothing.

Like the AI assistant, this is **local to your browser** and **bring-your-own
credentials**. It calls `api.github.com` **directly** — the scriptorium relay is
never in the loop, and there is no server-side build.

## Bring your own token

Create a **GitHub Personal Access Token** and paste it into **⇧ Publish → ⚙**.

- **Classic PAT** — needs the **`repo`** scope (create the repo + push code) and,
  to push workflow files under `.github/workflows/`, the **`workflow`** scope.
- **Fine-grained PAT** — grant, on the target account/repo: **Contents:
  Read/write**, **Administration: Read/write** (to create a new repo),
  **Workflows: Read/write** (to push workflow files), **Actions: Read** (run
  status), **Metadata: Read**.

Leave **Owner** blank to publish under your own login, or set an **org** name to
publish there (the token must be allowed to create/write repos in that org).

## What it does

1. Ensures the repo exists (creates it if missing).
2. Snapshots every file in the workspace (text **and** binary) and pushes them as
   one commit via the Git Data API (blobs → tree → commit → branch ref). The push
   is a **full snapshot**: the repo branch is made to mirror the workspace exactly
   (including deletions) — it is not a 3-way merge with divergent history.
3. Links you to the repo, the commit, and the **Actions** tab.

Empty folders are not pushed (Git tracks files, not directories) — same as the
ZIP export.

## Import from GitHub

**⤓ Import from GitHub** does the reverse: it pulls the configured repo's files
into the workspace so you can edit them together (then Publish pushes back). It
fetches the branch's tree and each file via the GitHub API, and **replaces the
current workspace** (a confirm guards it, and it's one undo step). Text files
become editable; binaries become view-only, subject to the same per-file (5 MiB)
and whole-workspace size caps — oversized/over-budget files are skipped and
listed. A **public repo needs no token**; a private one uses the same token as
Publish. Large repos are capped (first 400 files) and may hit GitHub's
unauthenticated rate limit — add a token for headroom.

## Build & publish artifacts (GitHub Actions)

The **build** happens in GitHub Actions, using standard workflows. The Publish
panel can scaffold starter workflows into your workspace (under
`.github/workflows/`) — pick any and click **Add to workspace**, then Publish:

- **GitHub Release** — build on a `v*` tag and attach artifacts to a Release.
- **GitHub Pages** — build a static site and deploy to Pages (enable Pages:
  repo *Settings → Pages → Source = GitHub Actions*).
- **npm package** — publish on a `v*` tag (add an **`NPM_TOKEN`** repo secret:
  *Settings → Secrets and variables → Actions*).
- **Container → GHCR** — build an image and push to `ghcr.io` (needs a
  `Dockerfile`; uses the built-in `GITHUB_TOKEN`).

The templates are **starting points** — edit the Build step for your toolchain.
Any secrets or prerequisites live in **GitHub**, never in scriptorium.

## The trust boundary

- The relay only ever sees opaque, encrypted frames — unchanged. But when **you**
  publish, your workspace's code is sent **to GitHub**. That is a deliberate
  egress **outside** scriptorium's end-to-end-encrypted session, and it happens
  only because you added a token and clicked Publish.
- Your **token** is stored only in your browser (`localStorage`) and sent only to
  GitHub — never to the scriptorium server, never to other participants. Because
  it's in `localStorage`, a successful XSS could read it: use **⚙ → Forget
  token**, and prefer a **scoped, low-privilege, expiring** PAT.
