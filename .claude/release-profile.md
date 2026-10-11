---
project: antigravity-booster
registry: npm
package: antigravity-booster
versionSource: package.json
bumpSites:
  - package.json:version
  - package-lock.json:version
  - package-lock.json:packages[""].version
  - plugin.json:version
preconditions:
  - npm ci
  - npm run build
  - git diff --exit-code -- dist vendor
  - npm test
  - cd website && node scripts/gen-reference.mjs --check
landing: pr
publishTrigger: tag
publishEnvironment: npm-publish
publishWorkflow: .github/workflows/publish.yml
verify:
  - npm view antigravity-booster@{{version}} version
  - '[ "$(npm view antigravity-booster dist-tags.latest)" = "{{version}}" ]'
  - npm view antigravity-booster@{{version}} --json | jq -e '.dist.attestations.provenance' >/dev/null
---

## Quirks

- **Lockstep (D11):** `plugin.json` and `package.json` versions must match. The
  git-URL plugin install reads `plugin.json`; npm reads `package.json`.
- **No changelog generator.** Promote `## [Unreleased]` in `CHANGELOG.md` to
  `## [X.Y.Z] - YYYY-MM-DD` by hand and curate it; leave an empty Unreleased.
- **Website partials are generated from `CHANGELOG.md` and the version.** After
  the bump and changelog edit (Step 5), run `cd website && node scripts/gen-reference.mjs`
  and commit the regenerated `website/generated/*.mdx` in the bump PR. The
  `--check` precondition fails closed on drift; the Docs workflow's `gen-check` job
  fails on main otherwise (1.1.0 shipped that way, fixed by #112).
- **`dist/` reads the version from `package.json` at runtime**, so a bump does
  not change the committed bundles. The precondition drift check proves that.
- **Landing is a PR:** `main` is protected (Code Owner review, `enforce_admins`).
- **Tag creation is admin-restricted** by the `release tags` ruleset. Trust
  `git ls-remote` over any refusal text.
- **The publish job re-runs `npm ci` and `npm test`** and refuses a tag that is
  not an ancestor of `origin/main` or doesn't match `package.json`.
- **OIDC history:** 0.8.0, 1.0.0 and 1.1.0 (2026-10-10, run 38098500425) are on
  npm with provenance, and no `NPM_TOKEN` exists at any scope now. The trusted-publisher configuration itself is still
  owner-confirmed at Step 8.
