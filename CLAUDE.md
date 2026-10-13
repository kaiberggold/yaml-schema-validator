# Notes for Claude

## Versioning (always)

Every change to the extension (code in `src/`, `package.json` contributions, the
built-in meta-scheme, behaviour or documentation shipped in the `.vsix`) gets the
next **development version** and a **git tag**, in the same commit:

1. `npm run bump -- <level>` with the level of the change:
   - `patch`: bug fixes, wording, docs
   - `minor`: new features, and breaking changes while the version is `0.x`
   - `major`: breaking changes from `1.0.0` on

   It sets `<next release>-devel.<n>` in `package.json` / `package-lock.json`
   (`0.4.0` → `0.5.0-devel.1` → `0.5.0-devel.2`, a bigger change raises the
   upcoming release: `0.4.1-devel.3` + minor → `0.5.0-devel.1`) and keeps the
   `## <next release> (in development)` heading of `CHANGELOG.md` in sync.
2. Add the change as a bullet under that heading.
3. Commit, then `git tag v<version>` on that commit and push the branch and the tag.

Releases are **only made by the user** (never on your own): `npm run bump -- release`
turns `0.5.0-devel.2` into `0.5.0` (and the heading into `## 0.5.0`); after the
commit the tag `v0.5.0` makes the workflow publish a GitHub release.

Repository-only changes (tests, `example/`, `.vscode/`, `.github/`, `scripts/`,
`CLAUDE.md`, build or lock files, anything not shipped in the `.vsix`) get **no**
version change and no tag.

## Checks before committing

```sh
npm run typecheck
npm test
npm run bundle
```
