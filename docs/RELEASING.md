# Releasing a new version (auto-update)

IPO Manager ships auto-updates through **GitHub Releases** using
[`electron-updater`](https://www.electron.build/auto-update). The app checks for
a newer version on every launch (and when you click the ⟳ button next to the
version in the sidebar). When a newer release exists on GitHub it downloads in
the background and shows a "Restart and install" banner.

For this to work, each new version's installer **must be published to a GitHub
Release** so the app can find `latest.yml`. Building locally with `build:win`
does **not** publish — it only produces the `.exe` in `dist/`.

## One-time setup

1. Confirm the publish target in `package.json` → `build.publish` points at the
   real repo:

   ```json
   "publish": [
     { "provider": "github", "owner": "DaiyaAkshay", "repo": "ipo-manager" }
   ]
   ```

   ⚠️ If the owner/repo is wrong, the app will never find updates. Fix it to
   match the GitHub repository that will host the releases.

2. Create a GitHub **Personal Access Token** with `repo` scope (or `public_repo`
   if the repo is public): GitHub → Settings → Developer settings → Personal
   access tokens. This lets `electron-builder` upload the installer to a Release.

## Publishing a new version

From the project folder (`H:\ipo-manager_1\ipo-manager`):

1. **Bump the version.** Edit `"version"` in `package.json` (e.g. `0.3.5` →
   `0.3.6`), or run:

   ```powershell
   npm version patch --no-git-tag-version
   ```

   The number must be **higher** than the version users currently run — that is
   exactly what the updater compares.

2. **Provide the token** (PowerShell, current session only):

   ```powershell
   $env:GH_TOKEN = "ghp_your_token_here"
   ```

3. **Build and publish:**

   ```powershell
   npm run release
   ```

   This runs `electron-vite build` then
   `electron-builder --win --publish always`, which uploads the installer plus
   `latest.yml` to a GitHub Release tagged `v<version>`.

4. **Publish the draft release.** By default `electron-builder` creates the
   Release as a **draft**, and the updater ignores drafts. Open the repo's
   *Releases* page on GitHub and click **Publish release** on the new
   `v<version>` draft. (Attach release notes if you like.)

   > To skip this manual step and have `npm run release` publish immediately to
   > all users, add `"releaseType": "release"` inside the `build.publish` github
   > entry. Left as a draft by default so you can review before shipping.

## How users receive it

- On next launch (or on ⟳ click) the app compares its version to the newest
  **published** GitHub Release.
- If newer, it downloads in the background → shows the banner → the user clicks
  **Restart and install**. The pre-quit hook still flushes a final encrypted
  backup before the executable is replaced.
- Up-to-date manual checks show a "You're on the latest version" toast; the
  automatic launch check stays silent when already current.

## Notes

- Auto-update is **disabled in `npm run dev`** (electron-vite sets
  `ELECTRON_RENDERER_URL`). Test it against an installed build.
- No code signing is configured, so Windows SmartScreen may warn on first run of
  each new installer; that does not affect the update mechanism itself.
- If a check fails (GitHub unreachable), the app retries once after 30s and
  otherwise stays quiet — users can keep working on the current version.
