# Notes for Claude

## Versioning (always)

Every change to the extension (code in `src/`, `package.json` contributions, the
built-in meta-scheme, behaviour or documentation shipped in the `.vsix`) bumps
the version in `package.json` **in the same commit**, together with a matching
section in `CHANGELOG.md`:

- patch (`0.3.0` → `0.3.1`): bug fixes, wording, docs
- minor (`0.3.x` → `0.4.0`): new features, and breaking changes while the version is `0.x`

Run `npm install` afterwards so `package-lock.json` carries the same version.

Repository-only changes (tests, `example/`, `.vscode/`, `CLAUDE.md`, build or
lock files, anything not shipped in the `.vsix`) do **not** bump the version.

## Checks before committing

```sh
npm run typecheck
npm test
npm run bundle
```
