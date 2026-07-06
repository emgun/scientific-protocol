# Release

The public npm package is `scientific-protocol`.
The public PyPI package is `scientific-protocol-client`.

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

Configure PyPI Trusted Publishing for the `scientific-protocol-client` project:

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

## PyPI Release Sequence

1. Update the `python/pyproject.toml` version.
2. Run the Python package check:

   ```bash
   cd python
   python -m pip install --upgrade build twine
   python -m build
   python -m twine check dist/*
   python -m pip install dist/*.whl
   sp-agent-client --help >/dev/null
   python -c "import scientific_protocol_client"
   ```

3. Commit the version change.
4. Tag the commit as `py-vX.Y.Z`, matching `python/pyproject.toml`.
5. Push `main` and the tag.
6. Confirm the `Release Python client` workflow passes and PyPI shows the new version.

The workflow refuses to publish if the tag does not start with `py-v` or if the tag does not match
the Python package version.
