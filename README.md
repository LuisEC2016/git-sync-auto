# Git Sync Auto

Git Sync Auto syncs a local desktop vault with Git automatically.

The plugin runs standard Git commands from the vault folder, but it plans each sync before changing the repository:

- `git status --porcelain`
- `git add -A` with the plugin `data.json` excluded by default
- `git commit -m "<commit message>"` when committable local changes exist
- `git fetch` and `git rebase --autostash` only when the branch is behind the pull target
- `git push` only when the local branch has commits the remote does not have

If a secondary remote contains commits that are not present locally, the plugin stops instead of overwriting that remote.

## Requirements

- Obsidian desktop.
- Git installed and available on `PATH`.
- The vault folder must already be a Git repository.
- The repository remote must already be configured if you want default upstream `pull` and `push` to work.

This plugin is desktop-only because Git execution requires local system commands.

## Commands

- **Sync vault with Git**: Runs one smart Git sync immediately.
- **Pull remote changes**: Fetches and rebases remote changes without committing or pushing local edits.
- **Show sync status**: Shows `git status --short --branch` and the local upstream relation when available.
- **Test Git connection**: Verifies configured remotes with `git ls-remote --heads`.
- **Open Git sync view**: Opens a side-panel view with branch status, local changes, conflicts, and recent commits.

## Settings

- **Enable automatic sync**: Runs Git sync after vault changes settle. This is off by default.
- **Sync on startup**: Runs one sync when Obsidian loads the plugin.
- **Check status on startup**: Fetches remote status at startup and warns when the vault is behind. This is off by default.
- **Sync delay**: Debounces automatic sync after file changes.
- **Periodic full sync**: Runs commit, pull, and push on a configured minute interval.
- **Periodic pull**: Pulls remote changes on a configured minute interval without pushing local edits.
- **Sync on close**: Runs a best-effort sync when the plugin unloads.
- **Commit message template**: Commit message used for automatic and manual commits. Supports `{host}`, `{date}`, and `{time}`.
- **Commit author name/email**: Optional per-commit author identity without changing global Git config.
- **Protect plugin settings**: Excludes `.obsidian/plugins/git-sync-auto/data.json` from commits. Keep this enabled if you store remote tokens in the plugin settings.
- **Exclude Obsidian workspace**: Excludes `.obsidian/workspace.json` and `.obsidian/workspace` from commits.
- **Manage .gitignore**: Adds protected plugin and workspace paths to the vault `.gitignore`.
- **Maximum file size**: Unstages files larger than the configured MB limit before commit.
- **Exclude patterns**: Unstages files matching configured vault-relative glob patterns.
- **Notice level**: Controls whether all notices, warnings/errors, or only errors are shown.
- **Remotes**: Optional remote definitions with per-remote URL, username, token, primary flag, and enabled flag. The primary remote is fetched and rebased first; all enabled remotes receive safe fast-forward pushes.

## Privacy and network use

Git Sync Auto does not collect telemetry and does not read files outside the vault path.

The plugin can make network requests indirectly through Git when `git fetch`, `git rebase`, `git push`, or `git ls-remote` contacts your configured remote. Startup checks, periodic sync, and periodic pull are disabled by default.

Remote tokens are stored by Obsidian in this plugin's data file. The plugin excludes that file from its own commits by default, but you should also keep plugin data ignored in your vault repository.

## Development

Install dependencies:

```bash
npm install
```

Run a production build:

```bash
npm run build
```

Run lint checks:

```bash
npm run lint
```

For local testing, copy `manifest.json`, `main.js`, and `styles.css` to:

```text
<Vault>/.obsidian/plugins/git-sync-auto/
```

Then reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Releases

1. Update the version in `manifest.json`, `package.json`, and `versions.json`.
2. Commit the changes and push to `main`.
3. Create and push an annotated tag matching the version:

```bash
git tag -a 1.0.2 -m "1.0.2"
git push origin 1.0.2
```

The CI workflow triggers on the tag push, builds the plugin, and creates a **draft** GitHub Release with `main.js`, `manifest.json`, and `styles.css` attached. Open the draft release on GitHub, add release notes, and publish it.

---

## First-time repository setup

Follow these steps once after uploading the code for the first time and before the first release.

### 1. Create the repository on GitHub

1. Go to **github.com/new**
2. Name: `git-sync-auto`
3. Visibility: **Public** (required for Obsidian Community Plugins)
4. Do **not** initialize with a README or `.gitignore` — the local repo already has them
5. Click **Create repository**

### 2. Connect the local repo and push

```bash
git remote set-url origin https://github.com/YOUR_USERNAME/git-sync-auto.git
git push -u origin main
```

If GitHub asks for credentials, use a **Personal Access Token (PAT)** as the password (classic token with `repo` scope, or a fine-grained token with *Contents: read and write*).

### 3. Enable Actions and grant write permissions

1. In your repo go to **Settings → Actions → General**
2. Under *Actions permissions* select **Allow all actions and reusable workflows**
3. Under *Workflow permissions* select **Read and write permissions**
4. Save

No manual secrets are needed. The workflow uses the automatic `GITHUB_TOKEN` that GitHub injects into every run with these permissions declared in `release.yml`:

```yaml
permissions:
  contents: write      # create/delete releases and tags
  id-token: write      # build provenance attestation
  attestations: write
```

### 4. How the CI workflow works

Pushing an annotated tag triggers `.github/workflows/release.yml`:

1. Runs `npm ci && npm run build`
2. Attests build provenance for `main.js` and `manifest.json`
3. Creates a **draft** GitHub Release tagged at the pushed tag
4. Uploads `main.js`, `manifest.json`, and `styles.css` as release assets

Open the draft on GitHub, add release notes, and publish.

### 5. Publishing a new version

```bash
# 1. Update manifest.json, package.json, versions.json, commit, push main
git tag -a 1.0.2 -m "1.0.2"
git push origin 1.0.2
```
