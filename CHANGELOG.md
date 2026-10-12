# Changelog

## Unreleased

- YAML parsing now uses the `yaml` package (full YAML 1.2), bundled with esbuild into `dist/extension.js`.

## 0.1.0

- Initial version: validation of `name.yml` against `name.scheme.yml`, recursive `extend` includes,
  diagnostics with clickable rule / include locations, completion, hover, go to definition,
  document links and automatic revalidation on file changes.
