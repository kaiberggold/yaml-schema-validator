import * as path from 'path';

/** Virtual path of the built-in meta scheme that validates `*.scheme.yml` files. */
export const META_FILE = path.join(path.sep, '__yaml_scheme_builtin__', 'meta.scheme.yml');

const KINDS: [string, string][] = [
    ['type', 'The value has the wrong type.'],
    ['required', 'A required key is missing (set on the required property).'],
    ['unknownKey', 'A key is not declared in `properties` (set on the mapping).'],
    ['enum', 'The value is not one of the `enum` values.'],
    ['pattern', 'The string does not match `pattern`.'],
    ['min', 'The number is smaller than `min`.'],
    ['max', 'The number is larger than `max`.'],
    ['minLength', 'The string is shorter than `minLength`.'],
    ['maxLength', 'The string is longer than `maxLength`.'],
    ['minItems', 'The list has fewer than `minItems` items.'],
    ['maxItems', 'The list has more than `maxItems` items.'],
    ['uniqueItems', 'The list contains duplicates.'],
    ['anyOf', 'The value matches none of the `anyOf` alternatives.'],
    ['deprecated', 'The key is deprecated.'],
];

const kindProps = (valueRef: string) =>
    KINDS.map(([k, d]) => `      ${k}:\n        ref: ${valueRef}\n        description: ${JSON.stringify(d)}`).join('\n');

export const META_TEXT = `
description: |
  **Scheme file.** Describes the YAML file with the same base name in the same
  folder: \`app.scheme.yml\` validates \`app.yml\`. The root of the file is a
  scheme node (usually \`type: map\` with \`properties\`).
ref: node
definitions:
  typeName:
    description: |
      One of \`string\`, \`number\`, \`integer\`, \`boolean\`, \`map\`, \`list\`, \`null\`, \`any\`
      (aliases: \`str\`, \`float\`, \`int\`, \`bool\`, \`object\`, \`dict\`, \`array\`, \`seq\`).
    enum: [string, number, integer, boolean, map, list, null, any, str, float, int, bool, object, dict, array, seq]
  severity:
    enum: [error, warning, info, hint]
  message:
    type: string
    description: |
      Message template. Placeholders: \`\${key}\`, \`\${path}\`, \`\${value}\`, \`\${actual}\`,
      \`\${expected}\`, \`\${allowed}\`, \`\${file}\`, \`\${line}\`, \`\${scheme}\` and the
      constraint values such as \`\${min}\`, \`\${max}\` or \`\${pattern}\`.
  seeEntry:
    anyOf:
      - type: string
        description: "A file path relative to the scheme, optionally with a line: \`docs/config.md:12\` or \`docs/config.md#L12\`."
      - type: map
        properties:
          file:
            type: string
            required: true
            description: File path relative to the scheme file.
          line:
            type: integer
            min: 1
            description: 1-based line number.
          label:
            type: string
            description: Text shown for the link.
  nodeOrType:
    anyOf:
      - ref: node
      - ref: typeName
      - type: null
  node:
    type: map
    description: A scheme node describing one YAML value.
    properties:
      type:
        description: |
          Expected type of the value. A list allows several types, e.g. \`[string, integer]\`.
          Without \`type\` the node accepts anything (or a map/list if \`properties\`/\`items\` are given).
        anyOf:
          - ref: typeName
          - type: list
            items:
              ref: typeName
      title:
        type: string
        description: Short name shown in hover and completion.
      description:
        type: string
        description: Help text (Markdown) shown when hovering over the key and in completion.
      required:
        type: boolean
        description: The key must be present in the enclosing mapping.
      default:
        description: Default value. Shown in hover and inserted by completion.
      enum:
        type: list
        description: List of allowed values.
        items:
          type: [string, number, boolean, null]
      examples:
        type: list
        description: Example values, offered by completion.
      pattern:
        type: string
        description: Regular expression (JavaScript syntax) that string values must match.
      min:
        type: number
        description: Smallest allowed number.
      max:
        type: number
        description: Largest allowed number.
      minLength:
        type: integer
        min: 0
        description: Minimal string length.
      maxLength:
        type: integer
        min: 0
        description: Maximal string length.
      minItems:
        type: integer
        min: 0
        description: Minimal number of list items.
      maxItems:
        type: integer
        min: 0
        description: Maximal number of list items.
      uniqueItems:
        type: boolean
        description: List items must be unique.
      properties:
        type: map
        description: |
          Keys of a mapping and their scheme nodes. A type name can be used as a
          shorthand, e.g. \`port: integer\`.
        additionalProperties:
          ref: nodeOrType
      additionalProperties:
        description: |
          \`true\` allows keys that are not listed in \`properties\`, \`false\` reports them.
          A scheme node validates the values of all unlisted keys.
          Default: \`false\` when \`properties\` is given, otherwise \`true\`.
        anyOf:
          - type: boolean
          - ref: node
          - ref: typeName
      items:
        ref: nodeOrType
        description: Scheme node for every item of a list.
      ref:
        type: string
        description: Name of an entry in the root \`definitions\` to use for this node.
      anyOf:
        type: list
        minItems: 1
        description: The value must match at least one of the given scheme nodes.
        items:
          ref: nodeOrType
      deprecated:
        type: [boolean, string]
        description: Marks the key as deprecated. A string is used as the reason.
      severity:
        description: Overrides the severity of problems found by this node, either for all problems or per problem kind.
        anyOf:
          - ref: severity
          - type: map
            properties:
${kindProps('severity').replace(/^/gm, '        ')}
      message:
        ref: message
        description: |
          Custom message for every problem reported by this node. Placeholders:
          \`\${key}\`, \`\${path}\`, \`\${value}\`, \`\${actual}\`, \`\${expected}\`, \`\${allowed}\`,
          \`\${file}\`, \`\${line}\`, \`\${scheme}\` and constraint values like \`\${min}\`.
      messages:
        type: map
        description: Custom message templates per problem kind (override \`message\`).
        properties:
${kindProps('message').replace(/^/gm, '    ')}
      see:
        description: |
          Related files (e.g. documentation) attached to every problem of this node
          as clickable locations.
        anyOf:
          - ref: seeEntry
          - type: list
            items:
              ref: seeEntry
      snippet:
        type: string
        description: |
          VS Code snippet inserted after \`key: \` by completion, e.g. \`\${1:localhost}\`.
      definitions:
        type: map
        description: |
          Reusable scheme nodes (root only). Reference them with \`ref: <name>\`.
        additionalProperties:
          ref: node
`;
