---
name: release
description: Release a new version of antigravity-booster (bumps version, tags git, pushes, triggers npm publish)
license: MIT
user-invocable: true
metadata:
  version: 1.0.0
  internal: true
---

# Release

Use this command to release a new version of `antigravity-booster`.

## Arguments

- First positional argument: Version bump type — "patch", "minor", or "major". Defaults to "minor" if not specified.

## Steps

1. **Determine the new version.** Read the current version from `package.json`. Apply the requested semver bump (default "minor") to compute the new version number.

2. **Verify preconditions — all must pass before any changes are made:**

   a. Working tree is clean:
   ```bash
   git status --porcelain
   ```
   Must be empty. If not, abort and tell the user to commit or stash changes first.

   b. On the `main` branch:
   ```bash
   git branch --show-current
   ```
   Must return `main`. If not, abort.

   c. Up to date with remote:
   ```bash
   git fetch origin
   git status -uno
   ```
   Output must not contain "Your branch is behind". If it does, abort and tell the user to pull first.

   d. `repository.url` is set in `package.json`:
   ```bash
   node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); process.exit(p.repository?.url ? 0 : 1)"
   ```
   Must exit 0. If missing, abort and print:
   > `repository.url` is required for `--provenance` publishing. Add it to `package.json`:
   > `"repository": { "type": "git", "url": "https://github.com/ORG/REPO.git" }`

   e. No `file:` dependencies in `package.json`:
   ```bash
   grep -c '"file:' package.json
   ```
   Must return `0`. If any `file:` deps are found, abort and print:
   > `file:` dependencies cannot be published to npm. Replace them with registry versions before releasing.
   > Found: (list each `file:` dep and its key)

   f. Tests pass:
   ```bash
   npm test
   ```
   Must exit 0. If tests fail, abort — do not proceed.

3. **Bump version:**
   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   ```
   This atomically updates the `"version"` field in both `package.json` and `package-lock.json`.

4. **Commit the bump on a release branch.** `main` is protected by the
   `main-protection` ruleset (1 approving review + code-owner review), and its
   only bypass is `pull_request` mode — so a direct `git push origin main` is
   rejected for everyone, including admins. The bump has to land via a PR.
   ```bash
   git checkout -b release/vX.Y.Z
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "chore: bump version to X.Y.Z"
   git push -u origin release/vX.Y.Z
   gh pr create --title "chore: release X.Y.Z" --body "Version bump + changelog for X.Y.Z."
   ```
   Also move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
   `## [X.Y.Z] — YYYY-MM-DD` heading in this commit.

5. **Get the PR reviewed and merged.** Wait for CI and an approval, then merge.
   Do not tag before it lands: `publish.yml` refuses to publish a tag that is not
   an ancestor of `main`, so a tag on an unmerged commit fails the release.

6. **Tag the merged commit on main and push the tag:**
   ```bash
   git checkout main && git pull origin main
   # Confirm you are tagging the bump you just merged.
   node -p "require('./package.json').version"   # must equal X.Y.Z
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   Tag creation is restricted by the `release tags` ruleset (`refs/tags/v*`), which
   grants an always-bypass to the maintainer role — so this push succeeds for a
   maintainer and is refused for everyone else. That tag push is what triggers
   the publish.

7. **Confirm completion.** Print a summary:
   ```
   Released: X.Y.Z (was A.B.C)
   Tag:      vX.Y.Z pushed to origin

   GitHub Actions will publish to npm on tag push, but the job waits for
   approval first: it runs under the `npm-publish` protected environment,
   which requires a reviewer. Approve it under the repo's Actions tab.

   The publish job verifies the tag is an ancestor of main and that it
   matches package.json's version, then publishes with --provenance
   --access public via npm OIDC trusted publishing (no NPM_TOKEN).

   If the publish job fails with ENEEDAUTH, trusted publishing is not
   configured for antigravity-booster on npmjs.com. See
   docs/github-rulesets/README.md § "npm trusted publishing (OIDC)".
   ```
