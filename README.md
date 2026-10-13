# YAML Scheme Validator

A VS Code extension (TypeScript) that validates YAML
configuration files against a *scheme* file (next to them or declared in their
first line), follows `extends`
includes recursively, and assists while editing.

| Feature | |
|---|---|
| Scheme lookup | `name.yml` is validated by `name.schema.yml` in the same folder (`.yaml` works too, the `schema` part is configurable), or by the scheme named in its first line: `# schema: path/to/x.schema.yml` |
| Includes | `extends: other.yml`, `extends: [a.yml, b.yml]` or `key: !extends other.yml`, fully recursive with cycle detection |
| Diagnostics | Error / warning / info squiggles with customizable messages, clickable links to the scheme rule, related files and the include chain |
| Live refresh | Revalidates while typing and whenever a YAML file, an included file or a scheme changes on disk (similar to CMake re-configuring) |
| Completion | Keys (with snippets for enums, booleans, defaults, maps and lists), values, `extends` file paths |
| Hover | Description, type, default, allowed values, constraints and a link to the definition in the scheme |
| Navigation | Ctrl+Click on `extends` paths, *Go to Definition* on keys (jumps into the scheme) and on `ref:` in schemes |

Scheme files themselves are validated against a built-in meta scheme, so you get
completion, hover help and errors while writing schemes as well.

## Quick start

```
config/
├── app.yml                 # validated by app.schema.yml
├── app.schema.yml
├── base.yml                # no own scheme: validated through app.schema.yml
└── database/
    ├── db.yml              # validated by db.schema.yml AND as part of app.yml
    └── db.schema.yml
```

`app.yml`

```yaml
extends: base.yml               # merge base.yml into this mapping
name: demo
server:
  port: 8080
database: !extends database/db.yml   # value = content of db.yml
```

`app.schema.yml`

```yaml
description: Application configuration.
type: map
properties:
  name:
    type: string
    required: true
    pattern: "^[a-z][a-z0-9-]*$"
    description: Technical name of the application.
    messages:
      pattern: "'${value}' must be kebab-case (rule in ${scheme}:${ruleLine})"
  server:
    ref: server
  database:
    type: map
    additionalProperties: true
definitions:
  server:
    properties:
      port:
        type: integer
        min: 1
        max: 65535
        default: 8080
        see: docs/server.md:12          # clickable in the problem's details
```

A complete example lives in [`example/`](example/). Press <kbd>F5</kbd> in this
repository to open it in an Extension Development Host.

## Declaring the scheme in the first line

Instead of a sibling `name.schema.yml`, a YAML file can name its scheme in its
**first line**:

```yaml
# schema: ../schemas/app.schema.yml
extends: ../app.yml
mode: production
```

- The path is relative to the file; `# $schema: …`, `# scheme: …` and
  `#schema=…` are accepted as well, and the path may be quoted.
- A declaration takes precedence over a sibling scheme file.
- Included files may declare their own scheme the same way.
- Missing declared files are reported on the first line. The declared scheme
  should follow the naming convention (`*.schema.yml`), otherwise it is used
  but not validated itself (a warning says so).
- The path is a link (Ctrl+Click), has a hover, and completion offers scheme
  files while typing it.

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
- In scheme files `extends` is only recognised at the root, so schemes can share
  `definitions` (the key `extends` stays usable as a property name).
- The keyword can be changed with `yamlScheme.extendKeyword`; the tag is always
  `!` followed by the keyword.

### How included files are validated

1. The **merged result** of the main file is validated against the main
   scheme. Problems are reported in the file where the offending key or value
   is written, with the include chain attached as related locations.
2. Every included file that has **its own scheme** (`db.yml` + `db.schema.yml`)
   is additionally validated against it.
3. The `extends` line shows a **summary** (`Included file 'db.yml' has 2 errors`)
   whose related locations jump to every problem in the included tree.

Completion and hover in an included file without own scheme use the part of the
including file's scheme where it is mounted (the status bar shows `via app.yml`).

## Scheme reference

A scheme node is a mapping with the keywords below. As a shorthand a property
can be just a type name: `port: integer`.

| Keyword | Meaning |
|---|---|
| `type` | `string`, `number`, `integer`, `boolean`, `map`, `list`, `null`, `any` or a list of them (aliases: `str`, `float`, `int`, `bool`, `object`, `dict`, `array`, `seq`) |
| `description`, `title` | Help text (Markdown) for hover and completion |
| `required` | The key must be present in the enclosing mapping |
| `default`, `examples` | Shown in hover, inserted / offered by completion |
| `enum` | Allowed values |
| `pattern` | Regular expression (JavaScript syntax) for strings |
| `min`, `max` | Numeric range |
| `minLength`, `maxLength` | String length |
| `minItems`, `maxItems`, `uniqueItems` | List constraints |
| `properties` | Keys of a mapping → scheme nodes |
| `additionalProperties` | `false` (default when `properties` is given) reports unknown keys, `true` allows them, a node validates them |
| `items` | Scheme node for list items |
| `ref` | Use an entry of the root `definitions` |
| `anyOf` | The value must match one of several nodes |
| `deprecated` | `true` or a reason; reported as a warning with strike-through |
| `severity` | `error` / `warning` / `info` / `hint`, or a map per problem kind (`{unknownKey: error}`) |
| `message`, `messages` | Custom message for all problems of the node, or per problem kind |
| `see` | Files attached to every problem as clickable locations: `docs/a.md:12`, `docs/a.md#L12` or `{file, line, label}` |
| `snippet` | Snippet inserted after `key: ` by completion, e.g. `"${1:localhost}"` |
| `definitions` | (root) Reusable nodes for `ref` |

### Problem kinds and message placeholders

Kinds: `type`, `required`, `unknownKey`, `enum`, `pattern`, `min`, `max`,
`minLength`, `maxLength`, `minItems`, `maxItems`, `uniqueItems`, `anyOf`,
`deprecated`. A `required` message belongs on the required property, an
`unknownKey` message on the mapping.

Placeholders in `message` / `messages`:
`${key}`, `${path}`, `${value}`, `${actual}`, `${expected}`, `${allowed}`,
`${hint}`, `${file}`, `${line}` (location of the problem), `${scheme}`,
`${ruleLine}` (location of the rule), `${title}`, `${description}`,
`${default}`, and the constraints `${min}`, `${max}`, `${minLength}`,
`${maxLength}`, `${minItems}`, `${maxItems}`, `${pattern}`, plus `${count}`
(list size), `${length}` (string length) and `${reason}` (deprecation).

Each diagnostic's code (e.g. `pattern`) links to the rule in the scheme, and the
problem details list the rule, `see` files and the include chain as clickable
locations.

## Commands and settings

| Command | |
|---|---|
| `YAML Scheme: Revalidate All Files` | Rescan the workspace and validate everything |
| `YAML Scheme: Open Scheme for Current File` | Open the scheme (or the validated file from a scheme). Offers to generate a starter scheme from the file's content when none exists. Also available by clicking the status bar item |

| Setting | Default | |
|---|---|---|
| `yamlScheme.extendKeyword` | `extends` | Include keyword; the tag form uses the same word (`!extends`) |
| `yamlScheme.schemeInfix` | `schema` | Scheme files are named `name.<infix>.yml` |
| `yamlScheme.unknownKeySeverity` | `warning` | Severity of undeclared keys (`ignore` to disable) |
| `yamlScheme.includeSummary` | `true` | Summary diagnostic on `extends` lines |
| `yamlScheme.debounceMs` | `250` | Delay before revalidating |
| `yamlScheme.exclude` | `**/{node_modules,.git}/**` | Ignored when searching for schemes |

## YAML support

Parsing is done by the [`yaml`](https://eemeli.org/yaml/) package (YAML 1.2,
bundled into the extension, so nothing has to be installed). Anchors, aliases,
tags and the merge key `<<` are supported. Only the first document of a file is
validated. Values are typed with the YAML 1.2 core schema (`yes` is a string,
`1.2` is a number, so quote versions).

## Development

```sh
npm install
npm run bundle     # esbuild → dist/extension.js (the `yaml` package is inlined)
npm run typecheck
npm test           # tsc → out/, unit tests with node:test
npm run package    # vsce package (runs a minified bundle first)
```

All packages are dev dependencies: the published extension is a single bundled
file without `node_modules`. Open the repository in VS Code and press
<kbd>F5</kbd> to bundle and start an Extension Development Host with the
`example` folder.

Source layout: `src/core/` contains the editor independent parts (YAML adapter
around the `yaml` package, include resolver, scheme compiler, validator,
completion / hover logic) and is covered by the tests in `src/test/`;
`src/manager.ts` tracks files and diagnostics; `src/providers.ts` adapts the
core to the VS Code API.
