# Release

The public npm package is `scientific-protocol`.

## Trusted Publishing

Configure npm Trusted Publishing for the `scientific-protocol` package:

- Publisher: GitHub Actions
- Organization or user: `emgun`
- Repository: `scientific-protocol`
- Workflow filename: `release.yml`
- Environment name: leave blank unless releases are later gated by a GitHub deployment environment
- Allowed action: `npm publish`

The release workflow uses GitHub OIDC through `id-token: write`. It does not use `NPM_TOKEN`.

## Release Sequence

1. Update the `package.json` version.
2. Run `npm run lint`, `npm run typecheck`, `npm run test:all`, and `npm run gas:check`.
3. Commit the version change.
4. Tag the commit as `vX.Y.Z`, matching `package.json`.
5. Push `main` and the tag.
6. Confirm the `Release` workflow passes and npm shows the new version.

The workflow refuses to publish if the tag does not match `package.json` or if the package version
already exists on npm.
