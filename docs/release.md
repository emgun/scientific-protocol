# Release

The public npm package is `scientific-protocol`.
The public PyPI package is `scientific-protocol`.

## Trusted Publishing

### npm

Configure npm Trusted Publishing for the `scientific-protocol` package:

- Publisher: GitHub Actions
- Organization or user: `emgun`
- Repository: `scientific-protocol`
- Workflow filename: `release.yml`
- Environment name: leave blank unless releases are later gated by a GitHub deployment environment
- Allowed action: `npm publish`

The release workflow uses GitHub OIDC through `id-token: write`. It does not use `NPM_TOKEN`.

### PyPI

Configure PyPI Trusted Publishing for the `scientific-protocol` project:

- Publisher: GitHub Actions
- Owner: `emgun`
- Repository: `scientific-protocol`
- Workflow filename: `release-pypi.yml`
- Environment name: `pypi`

The PyPI release workflow uses GitHub OIDC through `id-token: write`. It does not use a long-lived
PyPI API token.

## npm Release Sequence

1. Update the `package.json` version.
2. Run `npm run lint`, `npm run typecheck`, `npm run test:all`, and `npm run gas:check`.
3. Commit the version change.
4. Tag the commit as `vX.Y.Z`, matching `package.json`.
5. Push `main` and the tag.
6. Confirm the `Release` workflow passes and npm shows the new version.

The workflow refuses to publish if the tag does not match `package.json` or if the package version
already exists on npm.

The same `vX.Y.Z` tag triggers `release-container.yml`. It publishes immutable version and commit
tags to `ghcr.io/emgun/scientific-protocol-service`, generates an SBOM and registry provenance, and
attests the resulting digest. It does not publish `latest`.

For the prepared breaking release, the exact next release action after review and merge is:

```bash
git tag -s v0.3.0 -m "scientific-protocol 0.3.0"
git push origin main v0.3.0
```

Do not create that tag until CI, the package dry run, a credential-free container smoke, and the
0.3.0 deployment/migration review pass. After publication, deploy the GHCR image by digest and
record the digest with the deployment manifest and database backup. See
[reference-service.md](./reference-service.md) and [migrations/0.3.0.md](./migrations/0.3.0.md).

## PyPI Release Sequence

1. Update the `python/pyproject.toml` version.
2. Run the Python package check:

   ```bash
   cd python
   python -m pip install --upgrade build twine
   python -m build
   python -m twine check dist/*
   python -m pip install dist/*.whl
   scientific-protocol --help >/dev/null
   sp-agent-client --help >/dev/null
   python -c "import scientific_protocol"
   python -c "import scientific_protocol_client"
   ```

3. Commit the version change.
4. Tag the commit as `py-vX.Y.Z`, matching `python/pyproject.toml`.
5. Push `main` and the tag.
6. Confirm the `Release Python client` workflow passes and PyPI shows the new version.

The workflow refuses to publish if the tag does not start with `py-v` or if the tag does not match
the Python package version.
