# Trusted Publishing Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an npm Trusted Publishing release path for the public `scientific-protocol` package so future releases do not require long-lived npm tokens.

**Architecture:** Keep the release path in the public protocol repo. GitHub Actions runs a tag-triggered `release.yml` workflow with OIDC permission, validates that the git tag matches `package.json`, runs the same protocol checks as CI, performs a package dry run, then publishes with `npm publish` through npm Trusted Publishing. A short runbook documents the one required npm-side trusted publisher setting and the release sequence.

**Tech Stack:** GitHub Actions, npm Trusted Publishing/OIDC, Node 22.14, npm 11, Foundry, Hardhat, TypeScript.

---

### Task 1: Add Trusted Publishing Release Workflow

**Files:**

- Create: `.github/workflows/release.yml`
- Modify: `package.json`

- [x] **Step 1: Create the release workflow**

Add `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:
    inputs:
      tag:
        description: "Existing release tag to publish, for example v0.1.1"
        required: true
        type: string

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    name: Publish npm package
    runs-on: ubuntu-latest
    timeout-minutes: 30
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: scientific_protocol
          POSTGRES_HOST_AUTH_METHOD: trust
          POSTGRES_USER: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d scientific_protocol"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      SP_COMPOSE_POSTGRES_PORT: "5434"
      SP_DATABASE_URL: postgresql://postgres@127.0.0.1:5432/scientific_protocol

    steps:
      - name: Checkout release ref
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.inputs.tag || github.ref }}

      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: 22.14.0
          registry-url: https://registry.npmjs.org

      - name: Setup npm trusted publishing CLI
        run: |
          npm install -g npm@^11.5.1
          npm --version

      - name: Setup Foundry
        uses: foundry-rs/foundry-toolchain@v1
        with:
          version: v1.5.1

      - name: Install Foundry dependencies
        run: forge install foundry-rs/forge-std@v1.9.7 --no-git --shallow

      - name: Install dependencies
        run: npm ci

      - name: Validate tag and package metadata
        run: |
          release_ref="${{ github.event.inputs.tag || github.ref_name }}"
          package_name="$(node -p "require('./package.json').name")"
          package_version="$(node -p "require('./package.json').version")"
          tag_version="${release_ref#v}"
          if [ "$release_ref" = "$tag_version" ] || [ "$tag_version" != "$package_version" ]; then
            echo "Release tag $release_ref must be v$package_version for $package_name"
            exit 1
          fi
          if npm view "$package_name@$package_version" version --json >/dev/null 2>&1; then
            echo "$package_name@$package_version is already published"
            exit 1
          fi

      - name: Validate environment
        run: npm run validate:env

      - name: Generate contract artifacts
        run: |
          npm run build
          git diff --exit-code -- src/generated/contracts.ts

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm run test:all

      - name: Gas snapshot check
        run: npm run gas:check

      - name: Package dry run
        run: npm pack --dry-run

      - name: Publish to npm
        run: npm publish --access public
```

- [x] **Step 2: Pin the npm registry in package metadata**

Update `package.json`:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/"
}
```

- [x] **Step 3: Validate workflow syntax and package metadata locally**

Run:

```bash
npm run lint:prettier
npm pack --dry-run
```

Expected: Prettier passes, and the dry run reports `scientific-protocol@0.1.0` package contents without publishing.

### Task 2: Add Release Runbook

**Files:**

- Create: `docs/release.md`
- Modify: `README.md`

- [x] **Step 1: Document the npm-side trusted publisher setting**

Add `docs/release.md` with:

```markdown
# Release

The public npm package is `scientific-protocol`.

## One-time npm setup

In the npm package settings for `scientific-protocol`, configure Trusted Publishing:

- Publisher: GitHub Actions
- Organization or user: `emgun`
- Repository: `scientific-protocol`
- Workflow filename: `release.yml`
- Environment name: leave blank unless the workflow is later moved behind a GitHub deployment environment
- Allowed actions: `npm publish`

The workflow uses GitHub OIDC through `id-token: write`; it does not use `NPM_TOKEN`.

## Release sequence

1. Update `package.json` version.
2. Run `npm run lint`, `npm run typecheck`, `npm run test:all`, and `npm run gas:check`.
3. Commit the version change.
4. Tag the commit as `vX.Y.Z`, matching `package.json`.
5. Push `main` and the tag.
6. Confirm the `Release` workflow passes and npm shows the new version.

The workflow refuses to publish if the tag does not match `package.json` or if that package version already exists on npm.
```

- [x] **Step 2: Link the release runbook from README**

Add one concise release sentence near the package surface section:

```markdown
Release process: see [docs/release.md](docs/release.md).
```

- [x] **Step 3: Validate docs**

Run:

```bash
npm run lint:prettier
```

Expected: Prettier passes.

### Task 3: Final Verification and Publish Branch

**Files:**

- Verify only.

- [x] **Step 1: Run focused local release checks**

Run:

```bash
npm run lint:biome
npm run lint:prettier
npm pack --dry-run
git diff --check
```

Expected: all commands pass.

- [x] **Step 2: Commit and push**

Run:

```bash
git status --short
git add .github/workflows/release.yml package.json README.md docs/release.md docs/superpowers/plans/2026-06-19-trusted-publishing-release-workflow.md
git commit -m "ci: add trusted npm release workflow"
git push -u origin codex/trusted-publishing-release-workflow
```

Expected: branch pushes successfully for review or fast-forward merge.

- [x] **Step 3: Confirm non-automatable npm account step**

Report that npm Trusted Publishing must still be configured in the npm package settings before the next tag publish. Do not claim the workflow can publish until that npm-side setting exists.
