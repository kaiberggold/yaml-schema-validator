# Changelog

## 0.2.0

- **Breaking:** the include keyword now defaults to `extends` (tag form `!extends`; the tag
  always follows `yamlScheme.extendKeyword`).
- **Breaking:** scheme files are now named `name.schema.yml` by default. The middle part is
  configurable with `yamlScheme.schemeInfix` (set it to `scheme` for the previous naming).
- A YAML file can declare its scheme in its first line: `# schema: path/to/file.schema.yml`.
  The declaration has a link, hover and path completion, and is watched like any other dependency.
- YAML parsing now uses the `yaml` package (full YAML 1.2), bundled with esbuild into `dist/extension.js`.

## 0.1.0

- Initial version: validation of `name.yml` against `name.scheme.yml`, recursive `extend` includes,
  diagnostics with clickable rule / include locations, completion, hover, go to definition,
  document links and automatic revalidation on file changes.
