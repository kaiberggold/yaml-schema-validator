import * as path from 'path';

/** Virtual path of the built-in meta scheme that validates scheme files. */
export const META_FILE = path.join(path.sep, '__yaml_scheme_builtin__', 'meta.schema.yml');

/** Problem kinds that can be used as keys of `x-errorMessages` / `x-severity` maps. */
const KINDS: [string, string][] = [
    ['type', 'The value has the wrong type.'],
    ['required', 'A required key is missing.'],
    ['additionalProperties', 'A key is not allowed (`additionalProperties: false`).'],
    ['additionalItems', 'The array has more items than allowed.'],
    ['enum', 'The value is not one of the `enum` values.'],
    ['const', 'The value is not the `const` value.'],
    ['pattern', 'The string does not match `pattern`.'],
    ['format', 'The string does not match `format`.'],
    ['minimum', 'The number is smaller than `minimum`.'],
    ['maximum', 'The number is larger than `maximum`.'],
    ['exclusiveMinimum', 'The number is not greater than `exclusiveMinimum`.'],
    ['exclusiveMaximum', 'The number is not less than `exclusiveMaximum`.'],
    ['multipleOf', 'The number is not a multiple of `multipleOf`.'],
    ['minLength', 'The string is shorter than `minLength`.'],
    ['maxLength', 'The string is longer than `maxLength`.'],
    ['minItems', 'The array has fewer than `minItems` items.'],
    ['maxItems', 'The array has more than `maxItems` items.'],
    ['uniqueItems', 'The array contains duplicates.'],
    ['contains', 'No array item matches `contains`.'],
    ['minProperties', 'The object has fewer than `minProperties` keys.'],
    ['maxProperties', 'The object has more than `maxProperties` keys.'],
    ['propertyNames', 'A key does not match `propertyNames`.'],
    ['dependencies', 'A key required by `dependencies` is missing.'],
    ['anyOf', 'The value matches none of the `anyOf` alternatives.'],
    ['oneOf', 'The value does not match exactly one `oneOf` alternative.'],
    ['not', 'The value matches the `not` schema.'],
    ['false', 'The value is forbidden by a `false` schema.'],
    ['deprecated', 'The key is deprecated.'],
];

const kindProps = (valueRef: string, indent: string) =>
    KINDS.map(([k, d]) => `${indent}${k}:\n${indent}  $ref: "${valueRef}"\n${indent}  description: ${JSON.stringify(d)}`).join('\n');

const schemaRef = '"#/definitions/schema"';

export const META_TEXT = `
$schema: "http://json-schema.org/draft-07/schema#"
description: |
  **Scheme file** (a JSON Schema draft-07 document written in YAML). It validates
  the YAML file with the same base name in the same folder (\`app.schema.yml\`
  validates \`app.yml\`) and files that declare it in their first line
  (\`# yaml-language-server: $schema=app.schema.yml\` or \`# schema: app.schema.yml\`).
$ref: ${schemaRef}
definitions:
  typeName:
    enum: [string, number, integer, boolean, object, array, "null"]
    x-errorMessages:
      enum: "'\${value}' is not a JSON Schema type.\${hint} Use one of: string, number, integer, boolean, object, array, null (object instead of map, array instead of list)"
  nonNegativeInteger:
    type: integer
    minimum: 0
  stringArray:
    type: array
    items:
      type: string
    uniqueItems: true
  schemaArray:
    type: array
    minItems: 1
    items:
      $ref: ${schemaRef}
  severity:
    enum: [error, warning, info, hint]
  message:
    type: string
    description: |
      Message template. Placeholders: \`\${key}\`, \`\${path}\`, \`\${value}\`, \`\${actual}\`,
      \`\${expected}\`, \`\${allowed}\`, \`\${hint}\`, \`\${file}\`, \`\${line}\`, \`\${scheme}\`,
      \`\${ruleLine}\` and the keyword values such as \`\${minimum}\` or \`\${pattern}\`.
  seeEntry:
    anyOf:
      - type: string
        description: "A file path relative to the scheme, optionally with a line: \`docs/config.md:12\` or \`docs/config.md#L12\`."
      - type: object
        required: [file]
        additionalProperties: false
        properties:
          file:
            type: string
            description: File path relative to the scheme file.
          line:
            type: integer
            minimum: 1
            description: 1-based line number.
          label:
            type: string
            description: Text shown for the link.
  schema:
    type: [object, boolean]
    description: |
      A JSON Schema. \`true\` accepts every value, \`false\` none.
    additionalProperties: false
    patternProperties:
      "^x-":
        description: Extension keyword, ignored by the validator.
    x-errorMessages:
      additionalProperties: "Unknown keyword '\${key}'.\${hint}"
    properties:
      $schema:
        type: string
        description: "JSON Schema dialect, e.g. \`http://json-schema.org/draft-07/schema#\`."
      $id:
        type: string
        description: Identifier of the schema (not used for validation).
      $ref:
        type: string
        description: |
          Reference to another schema: \`#/definitions/name\` in this file,
          \`other.schema.yml\` or \`other.schema.yml#/definitions/name\` (relative to this file).
          Other keywords next to \`$ref\` only add documentation and messages.
      $comment:
        type: string
        description: A comment for schema authors.
      title:
        type: string
        description: Short name shown in hover and completion.
      description:
        type: string
        description: Help text shown when hovering over the key and in completion.
      markdownDescription:
        type: string
        description: Help text in Markdown (preferred over \`description\` for hover).
      default:
        description: Default value. Shown in hover and inserted by completion.
      examples:
        type: array
        description: Example values, offered by completion.
      readOnly:
        type: boolean
      writeOnly:
        type: boolean
      type:
        description: |
          Expected type: \`string\`, \`number\`, \`integer\`, \`boolean\`, \`object\`, \`array\` or \`null\`,
          or a list of them, e.g. \`[string, integer]\`. Without \`type\` every type is accepted.
        anyOf:
          - $ref: "#/definitions/typeName"
          - type: array
            minItems: 1
            uniqueItems: true
            items:
              $ref: "#/definitions/typeName"
      enum:
        type: array
        description: List of allowed values.
      const:
        description: The only allowed value.
      multipleOf:
        type: number
        exclusiveMinimum: 0
        description: The number must be a multiple of this value.
      minimum:
        type: number
        description: Smallest allowed number.
      maximum:
        type: number
        description: Largest allowed number.
      exclusiveMinimum:
        type: number
        description: The number must be greater than this value.
      exclusiveMaximum:
        type: number
        description: The number must be less than this value.
      minLength:
        $ref: "#/definitions/nonNegativeInteger"
        description: Minimal string length.
      maxLength:
        $ref: "#/definitions/nonNegativeInteger"
        description: Maximal string length.
      pattern:
        type: string
        format: regex
        description: Regular expression (ECMAScript syntax) that strings must match.
      format:
        type: string
        description: |
          Format of a string. Checked: \`date-time\`, \`date\`, \`time\`, \`email\`, \`hostname\`,
          \`ipv4\`, \`ipv6\`, \`uri\`, \`uri-reference\`, \`json-pointer\`, \`regex\`.
        examples: [date-time, date, time, email, hostname, ipv4, ipv6, uri, uri-reference, json-pointer, regex]
      items:
        description: Schema for every array item, or a list of schemas for the items by position.
        anyOf:
          - $ref: ${schemaRef}
          - $ref: "#/definitions/schemaArray"
      additionalItems:
        $ref: ${schemaRef}
        description: Schema for items after those listed in \`items\` (when \`items\` is a list).
      minItems:
        $ref: "#/definitions/nonNegativeInteger"
        description: Minimal number of array items.
      maxItems:
        $ref: "#/definitions/nonNegativeInteger"
        description: Maximal number of array items.
      uniqueItems:
        type: boolean
        description: Array items must be unique.
      contains:
        $ref: ${schemaRef}
        description: At least one array item must match this schema.
      properties:
        type: object
        description: Keys of an object and their schemas.
        additionalProperties:
          $ref: ${schemaRef}
      patternProperties:
        type: object
        description: Schemas for keys matching a regular expression.
        propertyNames:
          format: regex
        additionalProperties:
          $ref: ${schemaRef}
      additionalProperties:
        $ref: ${schemaRef}
        description: |
          Schema for keys not matched by \`properties\` / \`patternProperties\`.
          \`false\` reports such keys as unknown. JSON Schema default: \`true\`.
      required:
        $ref: "#/definitions/stringArray"
        description: Keys that must be present, e.g. \`[name, port]\`.
        x-errorMessages:
          type: "In JSON Schema 'required' is a list of keys on the enclosing object, e.g. 'required: [name]'"
      minProperties:
        $ref: "#/definitions/nonNegativeInteger"
        description: Minimal number of keys.
      maxProperties:
        $ref: "#/definitions/nonNegativeInteger"
        description: Maximal number of keys.
      propertyNames:
        $ref: ${schemaRef}
        description: |
          Schema every key must match, e.g. \`{pattern: "^[a-z]+$"}\`.
      dependencies:
        type: object
        description: "When a key is present: other keys that must be present (list) or a schema the object must match."
        additionalProperties:
          anyOf:
            - $ref: ${schemaRef}
            - $ref: "#/definitions/stringArray"
      definitions:
        type: object
        description: |
          Reusable schemas, referenced with \`$ref: "#/definitions/<name>"\`.
        additionalProperties:
          $ref: ${schemaRef}
      allOf:
        $ref: "#/definitions/schemaArray"
        description: The value must match all schemas.
      anyOf:
        $ref: "#/definitions/schemaArray"
        description: The value must match at least one schema.
      oneOf:
        $ref: "#/definitions/schemaArray"
        description: The value must match exactly one schema.
      not:
        $ref: ${schemaRef}
        description: The value must not match this schema.
      if:
        $ref: ${schemaRef}
        description: If the value matches this schema, \`then\` applies, otherwise \`else\`.
      then:
        $ref: ${schemaRef}
      else:
        $ref: ${schemaRef}
      contentMediaType:
        type: string
      contentEncoding:
        type: string
      deprecated:
        type: boolean
        description: Marks the key as deprecated (reported as a warning).
      deprecationMessage:
        type: string
        description: Marks the key as deprecated, with this text as the reason.
      errorMessage:
        $ref: "#/definitions/message"
        description: |
          Custom message for every problem of this schema (also used by VS Code / Red Hat YAML).
          Use \`x-errorMessages\` for messages per keyword.
        x-errorMessages:
          type: "'errorMessage' must be a single text; use 'x-errorMessages' for messages per keyword"
      patternErrorMessage:
        $ref: "#/definitions/message"
        description: Custom message when \`pattern\` does not match (also used by VS Code / Red Hat YAML).
      x-errorMessages:
        type: object
        description: |
          Custom message templates per keyword (\`type\`, \`required\`, \`additionalProperties\`,
          \`pattern\`, \`minimum\`, ...). Overrides \`errorMessage\`.
        additionalProperties: false
        properties:
${kindProps('#/definitions/message', '          ')}
      x-severity:
        description: Severity of problems found by this schema, for all problems or per keyword.
        anyOf:
          - $ref: "#/definitions/severity"
          - type: object
            additionalProperties: false
            properties:
${kindProps('#/definitions/severity', '              ')}
      x-see:
        description: |
          Related files (e.g. documentation) attached to every problem of this schema
          as clickable locations.
        anyOf:
          - $ref: "#/definitions/seeEntry"
          - type: array
            items:
              $ref: "#/definitions/seeEntry"
      defaultSnippets:
        type: array
        description: Snippets offered by completion (Red Hat YAML convention).
        items:
          type: object
          properties:
            label:
              type: string
            description:
              type: string
            body:
              description: Value inserted after the key.
            bodyText:
              type: string
              description: Snippet text inserted after the key.
`;
