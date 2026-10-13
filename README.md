# YAML Scheme Validator

A VS Code extension (TypeScript) that validates YAML configuration files
against a *scheme*, a **JSON Schema (2020-12) written in YAML**, next to them
or declared in their first line. It follows `extends` includes recursively and
assists while editing. Because schemes are standard JSON Schema, the
[Red Hat YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
and other JSON Schema tools can use the same files as a backup.

| Feature | |
|---|---|
| Scheme lookup | `name.yml` is validated by `name.schema.yml` in the same folder (`.yaml` works too, the `schema` part is configurable), or by the scheme named in its first line: `# yaml-language-server: $schema=path/to/x.schema.yml` |
| Schemes | JSON Schema 2020-12 (or draft-07 / 2019-09) in YAML, including `$ref` to other files, plus optional extensions for messages, severities and links |
| Includes | `extends: other.yml`, `extends: [a.yml, b.yml]` or `key: !extends other.yml`, fully recursive with cycle detection |
| Diagnostics | Error / warning / info squiggles with customizable messages, clickable links to the scheme rule, related files and the include chain |
| Live refresh | Revalidates while typing and whenever a YAML file, an included file or a scheme changes on disk (similar to CMake re-configuring) |
| Completion | Keys (with snippets for enums, booleans, defaults, objects and arrays), values, `extends` file paths |
| Hover | Description, type, default, allowed values, constraints and a link to the definition in the scheme |
| Navigation | Ctrl+Click on `extends` paths, *Go to Definition* on keys (jumps into the scheme) and on `$ref` in schemes |
| Anchors | Unused anchors (`&name`) are greyed out; hover over `&name` or `*name` shows the anchored content and where it is used; *Go to Definition* / *Find All References* |

Scheme files themselves are checked against a built-in meta-scheme, so
you get completion, hover help and errors while writing schemes as well.

## Installation

Download `yaml-scheme-validator-<version>.vsix` from the
[GitHub releases](https://github.com/kaiberggold/yaml-schema-validator/releases)
and install it with *Extensions: Install from VSIX…* in the command palette, or:

```sh
code --install-extension yaml-scheme-validator-<version>.vsix
```

Every build on GitHub Actions also keeps the `.vsix` as a build artifact.

## Quick start

```
config/
├── app.yml                 # validated by app.schema.yml
├── app.schema.yml
├── base.yml                # no own scheme: validated through app.schema.yml
└── database/
    ├── db.yml              # validated by db.schema.yml only
    └── db.schema.yml
```

`app.yml`

```yaml
# yaml-language-server: $schema=app.schema.yml
extends: base.yml               # merge base.yml into this mapping
name: demo
server:
  port: 8080
database:
  extends: database/db.yml      # merge db.yml here
```

`app.schema.yml`

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
description: Application configuration.
type: object
required: [name, server]
additionalProperties: false
properties:
  extends:                       # declare the include key for other JSON Schema tools
    type: [string, array]
  name:
    type: string
    pattern: "^[a-z][a-z0-9-]*$"
    description: Technical name of the application.
    patternErrorMessage: "The name must be lowercase kebab-case"
  server:
    $ref: "#/$defs/server"
  database:
    type: object
$defs:
  server:
    type: object
    properties:
      port:
        type: integer
        minimum: 1
        maximum: 65535
        default: 8080
        x-see: docs/server.md:12      # clickable in the problem's details
```

The first line of `app.yml` is optional for this extension (the sibling
`app.schema.yml` is found anyway). It lets the Red Hat YAML extension use the same
scheme, see [Red Hat YAML as backup](#red-hat-yaml-as-backup).

A complete example lives in [`example/`](example/). Press <kbd>F5</kbd> in this
repository to open it in an Extension Development Host.

## Declaring the scheme in the first line

Instead of a sibling `name.schema.yml`, a YAML file can name its scheme in its
**first line**:

```yaml
# yaml-language-server: $schema=../schemas/app.schema.yml
extends: ../app.yml
mode: production
```

- This is the modeline of the Red Hat YAML extension, so both extensions use it.
  `# schema: …`, `# $schema: …`, `# scheme: …` and `#schema=…` are accepted as
  well. The path is relative to the file and may be quoted.
- A declaration takes precedence over a sibling scheme file.
- Included files may declare their own scheme the same way.
- Missing declared files are reported on the first line. The declared scheme
  should follow the naming convention (`*.schema.yml`), otherwise it is used
  but not validated itself (a warning says so).
- The path is a link (Ctrl+Click), has a hover, and completion offers scheme
  files while typing it.
- **YAML Scheme: Add Red Hat YAML Modeline** writes the line for the current file.

## Includes (`extends`)

- `extends: path` or `extends: [path1, path2]` inside any mapping merges the
  mappings of the referenced files into that mapping. Later files override
  earlier ones and keys written next to `extends` override everything included.
  Nested mappings are merged deeply, lists and scalars are replaced.
- `key: !extends path` replaces the value with the whole content of the file
  (any type). `!extends [a.yml, b.yml]` merges several mappings.
- Paths are relative to the including file; the `.yml` / `.yaml` extension may be omitted.
- Includes are resolved recursively; cycles (`a → b → a`), missing files and
  non-mapping files used for merging are reported at the include.
- The YAML merge key `<<: *anchor` and aliases are supported as well.
- Scheme files have no includes; they reference each other with `$ref`.
- The keyword can be changed with `yamlScheme.extendKeyword`; the tag is always
  `!` followed by the keyword.

### How included files are validated

1. An included file that has **its own scheme** (`db.yml` + `db.schema.yml`, or
   one declared in its first line) is validated **only against that scheme**.
   In the including file its keys just count as present, so they satisfy
   `required` there but are never reported as unknown or wrongly typed.
2. An included file **without its own scheme** is validated as part of the
   merged result of the including file, against the including file's scheme.
   Problems are reported in the file where the offending key or value is
   written, with the include chain attached as related locations.
3. The `extends` line shows a **summary** (`Included file 'db.yml' has 2 errors`)
   whose related locations jump to every problem in the included tree.

Completion and hover in an included file without own scheme use the part of the
including file's scheme where it is mounted (the status bar shows `via app.yml`).

## Scheme reference

Schemes are [JSON Schema 2020-12](https://json-schema.org/specification) documents
written in YAML (the current version, used when `$schema` is missing). All
validation keywords are supported:

| Keywords | |
|---|---|
| `type` | `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`, or a list of them |
| `enum`, `const` | Allowed values |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | Numbers |
| `minLength`, `maxLength`, `pattern`, `format` | Strings. Checked formats: `date-time`, `date`, `time`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `json-pointer`, `regex` |
| `prefixItems`, `items`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `unevaluatedItems` | Arrays |
| `properties`, `patternProperties`, `additionalProperties`, `required`, `propertyNames`, `minProperties`, `maxProperties`, `dependentRequired`, `dependentSchemas`, `unevaluatedProperties` | Objects |
| `allOf`, `anyOf`, `oneOf`, `not`, `if` / `then` / `else` | Combinations |
| `$ref`, `$defs`, `$anchor` | `#/$defs/x`, any JSON pointer, `#anchor`, `other.schema.yml` or `other.schema.yml#/$defs/x` (`$dynamicRef` is resolved like `$ref`) |
| `true` / `false` | Boolean schemas (`legacyKey: false` forbids a key) |
| `title`, `description`, `default`, `examples`, `deprecated`, `$comment`, `$schema`, `$id` | Documentation, used by hover and completion |

`unevaluatedProperties: false` reports keys that no keyword evaluated, including
keys declared in `allOf`, `anyOf`, `oneOf`, `if` / `then` / `else` or a `$ref`;
`additionalProperties: false` only sees the `properties` next to it.

Older schemes keep working: with `$schema: "http://json-schema.org/draft-07/schema#"`
(or `2019-09`) the draft-07 forms `definitions`, `dependencies`, `items: [...]` +
`additionalItems` are understood (they are accepted in 2020-12 schemes as well).
The only difference in behaviour is `$ref`: since 2019-09 keywords next to a
`$ref` apply too, in draft-07 they only add documentation and messages.

As in JSON Schema, keys that are not listed are allowed unless
`additionalProperties: false` is set. For keys whose names are free but whose
content follows one structure, use `additionalProperties` (or
`patternProperties`) with a schema.

### Extensions

These keywords are ignored by standard JSON Schema validators. The first group
is also understood by VS Code and Red Hat YAML:

| Keyword | |
|---|---|
| `errorMessage` | Message (text) for every problem of this schema |
| `patternErrorMessage` | Message when `pattern` does not match |
| `markdownDescription` | Help text in Markdown (preferred over `description` in hover) |
| `deprecationMessage` | Marks the key as deprecated with this reason (`deprecated: true` works too); reported as a warning with strike-through |
| `defaultSnippets` | Completion snippets: `[{label, body}]` or `[{label, bodyText}]` |
| `x-errorMessages` | Message templates per keyword, e.g. `{minimum: "...", required: "..."}`; override `errorMessage` |
| `x-severity` | `error` / `warning` / `info` / `hint`, or a map per keyword (`{additionalProperties: error}`) |
| `x-see` | Files attached to every problem as clickable locations: `docs/a.md:12`, `docs/a.md#L12` or `{file, line, label}` (or a list) |

Any other `x-…` keyword is accepted and ignored.

### Message placeholders

Problem kinds (the keys of `x-errorMessages` / `x-severity`) are the keyword
names: `type`, `required`, `additionalProperties` (unknown key), `enum`, `const`,
`pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `minItems`,
`maxItems`, `uniqueItems`, `contains`, `maxContains`, `additionalItems` (`items: false`),
`unevaluatedItems`, `minProperties`, `maxProperties`, `propertyNames`, `dependentRequired`,
`unevaluatedProperties`, `anyOf`, `oneOf`, `not`,
`false`, `deprecated`. A message for `required` can be written on the object or
on the required property itself.

Placeholders: `${key}`, `${path}`, `${value}`, `${actual}`, `${expected}`,
`${allowed}`, `${hint}`, `${parent}` (the object a missing / unknown key belongs
to), `${file}`, `${line}` (location of the problem), `${scheme}`, `${ruleLine}`
(location of the rule), `${title}`, `${description}`, `${default}`, `${const}`,
`${format}`, the keyword values (`${minimum}`, `${maxLength}`, `${pattern}`, ...),
plus `${count}` (number of items / keys), `${length}` (string length),
`${reason}` (deprecation), `${dependency}` and `${missing}` (`dependentRequired`).

Red Hat YAML shows `errorMessage` / `patternErrorMessage` verbatim, without filling in
placeholders. Put messages with placeholders into `x-errorMessages`; Red Hat
ignores those and shows its own text.

Each diagnostic's code (e.g. `pattern`) links to the rule in the scheme, and the
problem details list the rule, `x-see` files and the include chain as clickable
locations.

## Red Hat YAML as backup

Scheme files are valid JSON Schemas (2020-12 is supported by Red Hat YAML), so the Red Hat YAML extension (and
other tools built on `yaml-language-server`, or any JSON Schema validator after
converting the YAML) can validate with them:

- Associate the files with the modeline in the first line
  (`# yaml-language-server: $schema=app.schema.yml`, written by
  **YAML Scheme: Add Red Hat YAML Modeline**) or with Red Hat's `yaml.schemas`
  setting. Red Hat does not know the `name.schema.yml` naming convention.
- Red Hat does not resolve `extends`: it validates every file on its own.
  - Declare `extends` in the scheme (`extends: {type: [string, array]}`) when
    `additionalProperties: false` is used.
  - Keys that only come from included files are reported as missing there.
  - Prefer `key:` + `extends: file.yml` over `key: !extends file.yml`, because
    Red Hat sees the tag form as a string. The modeline command adds
    `!extends` to `yaml.customTags`, so the tag itself is accepted.
- When both extensions are active, both report problems. Set
  `"yaml.validate": false` in the workspace to keep Red Hat for completion only.

## Anchors and aliases

- An anchor (`&name`) that no alias (`*name`) uses is shown greyed out, with
  "Anchor '&name' is never used" on hover (disable with `yamlScheme.unusedAnchors`).
- Hovering over `&name` shows the anchored content and the lines that use it;
  hovering over `*name` shows the content it stands for and where the anchor is.
- *Go to Definition* on an alias jumps to its anchor, *Find All References* on
  either lists the anchor and all its aliases.

## Commands and settings

| Command | |
|---|---|
| `YAML Scheme: Revalidate All Files` | Rescan the workspace and validate everything |
| `YAML Scheme: Open Scheme for Current File` | Open the scheme (or the validated file from a scheme). Offers to generate a starter scheme from the file's content when none exists. Also available by clicking the status bar item |
| `YAML Scheme: Add Red Hat YAML Modeline` | Write `# yaml-language-server: $schema=…` as the first line of the current file |

| Setting | Default | |
|---|---|---|
| `yamlScheme.extendKeyword` | `extends` | Include keyword; the tag form uses the same word (`!extends`) |
| `yamlScheme.schemeInfix` | `schema` | Scheme files are named `name.<infix>.yml` |
| `yamlScheme.unknownKeySeverity` | `warning` | Severity of keys forbidden by `additionalProperties: false` (`ignore` to disable) |
| `yamlScheme.includeSummary` | `true` | Summary diagnostic on `extends` lines |
| `yamlScheme.unusedAnchors` | `true` | Grey out anchors that no alias uses |
| `yamlScheme.debounceMs` | `250` | Delay before revalidating |
| `yamlScheme.exclude` | `**/{node_modules,.git}/**` | Ignored when searching for schemes |

## YAML support

Parsing is done by the [`yaml`](https://eemeli.org/yaml/) package (YAML 1.2,
bundled into the extension, so nothing has to be installed). Anchors, aliases,
tags and the merge key `<<` are supported. Only the first document of a file is
validated. Values are typed with the YAML 1.2 core schema (`yes` is a string,
`1.2` is a number, so quote versions). As in JSON Schema, `1.0` counts as an
integer.

## Development

```sh
npm install
npm run bundle     # esbuild → dist/extension.js (the `yaml` package is inlined)
npm run typecheck
npm test           # tsc → out/, unit tests with node:test
npm run package    # vsce package (runs a minified bundle first)
```

Versions: every change gets the next development version and a git tag, e.g.
`0.4.0` → `0.5.0-devel.1` → `0.5.0-devel.2`. `npm run bump -- patch|minor|major`
computes it (a bigger change raises the upcoming release: `0.4.1-devel.3` + minor
→ `0.5.0-devel.1`) and keeps the `## 0.5.0 (in development)` heading of
`CHANGELOG.md` in sync. Development tags (`v0.5.0-devel.2`) are built by GitHub
Actions (the `.vsix` is a build artifact) but not released.

Releases are made by hand: `npm run bump -- release` (turns `0.5.0-devel.2` into
`0.5.0` and the changelog heading into `## 0.5.0`), commit, then push the tag
`v0.5.0`. The workflow in `.github/workflows/build.yml` builds the `.vsix` and
publishes a GitHub release with it.

All packages are dev dependencies: the published extension is a single bundled
file without `node_modules`. Open the repository in VS Code and press
<kbd>F5</kbd> to bundle and start an Extension Development Host with the
`example` folder.

Source layout: `src/core/` contains the editor independent parts (YAML adapter
around the `yaml` package, include resolver, scheme compiler, validator,
completion / hover logic) and is covered by the tests in `src/test/`;
`src/manager.ts` tracks files and diagnostics; `src/providers.ts` adapts the
core to the VS Code API.
