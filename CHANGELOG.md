# Changelog

## 0.5.0

- JSON Schema 2020-12 (the current version) is the default for scheme files: `$defs`, `prefixItems`,
  `dependentRequired`, `dependentSchemas`, `unevaluatedProperties`, `unevaluatedItems`, `minContains`,
  `maxContains`, `$anchor` (`$dynamicRef` resolved like `$ref`). Keywords next to `$ref` now apply as well;
  schemes with a draft-07 `$schema` keep the draft-07 behaviour. Built-in meta-scheme, examples and
  generated starter schemes use 2020-12.
- Problem kind `dependencies` is now `dependentRequired` (for `x-errorMessages` / `x-severity`).

## 0.4.1

- Completion: a value chosen right after `key:` gets the separating space (`key: value`).
- Docs: development versions (`0.5.0-devel.1`, ...) with git tags, and how releases are made.

## 0.4.0

- Anchors (`&name`) that no alias uses are greyed out with a hint (setting `yamlScheme.unusedAnchors`).
- Hover over an anchor or alias shows the anchored content, where it is used and where it is defined.
- *Go to Definition* on an alias jumps to its anchor; *Find All References* lists the anchor and its aliases.

## 0.3.1

- Docs: installation from GitHub releases.

## 0.3.0

- **Breaking:** scheme files are now JSON Schema draft-07 documents written in YAML, so the
  Red Hat YAML extension and other JSON Schema tools can use them:
  - `object` / `array` instead of `map` / `list`; no `any` (omit `type`) and no type shorthand
    (`port: integer` becomes `port: {type: integer}`).
  - `required: [a, b]` on the object instead of `required: true` on the property.
  - `minimum` / `maximum` instead of `min` / `max`; `$ref: "#/definitions/x"` instead of `ref: x`.
  - `additionalProperties` defaults to `true`; set it to `false` to report unknown keys.
  - `errorMessage` is a single text; per-keyword messages move to `x-errorMessages`
    (keys are keyword names, e.g. `additionalProperties` for unknown keys, `minimum`, `maximum`).
  - `severity` → `x-severity`, `see` → `x-see`, `snippet` → `defaultSnippets`,
    `deprecated: "reason"` → `deprecationMessage: "reason"`.
  - Scheme files no longer support `extends`; use `$ref` to other scheme files.
- All draft-07 keywords are validated: `const`, `format`, exclusive bounds, `multipleOf`,
  `patternProperties`, `propertyNames`, `dependencies`, tuple `items` / `additionalItems`,
  `contains`, `min`/`maxProperties`, `allOf`, `oneOf`, `not`, `if`/`then`/`else`, boolean schemas
  and `$ref` with JSON pointers and to other files.
- The Red Hat modeline `# yaml-language-server: $schema=…` declares the scheme; new command
  *Add Red Hat YAML Modeline*.
- Supported VS Code / Red Hat keywords: `patternErrorMessage`, `markdownDescription`,
  `deprecationMessage`, `defaultSnippets`.
- Content included from a file that has its own scheme is now validated only against that
  scheme. The including scheme no longer reports its keys (they still satisfy `required`).

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
