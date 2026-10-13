import * as path from 'path';

/** Virtual path of the built-in meta scheme that validates scheme files. */
export const META_FILE = path.join(path.sep, '__yaml_scheme_builtin__', 'meta.schema.yml');

/** Problem kinds that can be used as keys of `x-errorMessages` / `x-severity` maps. */
const KINDS: [string, string][] = [
    ['type', 'The value has the wrong type.'],
    ['required', 'A required key is missing.'],
    ['additionalProperties', 'A key is not allowed (`additionalProperties: false`).'],
    ['additionalItems', 'The array has more items than allowed (`items: false` after `prefixItems`).'],
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
    ['contains', 'Fewer array items than `minContains` (default 1) match `contains`.'],
    ['maxContains', 'More array items than `maxContains` match `contains`.'],
    ['unevaluatedProperties', 'A key is not allowed (`unevaluatedProperties: false`).'],
    ['unevaluatedItems', 'An array item is not allowed (`unevaluatedItems: false`).'],
    ['minProperties', 'The object has fewer than `minProperties` keys.'],
    ['maxProperties', 'The object has more than `maxProperties` keys.'],
    ['propertyNames', 'A key does not match `propertyNames`.'],
    ['dependentRequired', 'A key required by `dependentRequired` is missing.'],
    ['anyOf', 'The value matches none of the `anyOf` alternatives.'],
    ['oneOf', 'The value does not match exactly one `oneOf` alternative.'],
    ['not', 'The value matches the `not` schema.'],
    ['false', 'The value is forbidden by a `false` schema.'],
    ['deprecated', 'The key is deprecated.'],
];

const kindProps = (valueRef: string, indent: string) =>
    KINDS.map(([k, d]) => `${indent}${k}:\n${indent}  $ref: "${valueRef}"\n${indent}  description: ${JSON.stringify(d)}`).join('\n');

const schemaRef = '"#/$defs/schema"';

export const META_TEXT = `
$schema: "https://json-schema.org/draft/2020-12/schema"
description: |
  **Scheme file** (a JSON Schema document written in YAML, version 2020-12 unless
  \`$schema\` names draft-07 or 2019-09). It validates
  the YAML file with the same base name in the same folder (\`app.schema.yml\`
  validates \`app.yml\`) and files that declare it in their first line
  (\`# yaml-language-server: $schema=app.schema.yml\` or \`# schema: app.schema.yml\`).
$ref: ${schemaRef}
$defs:
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
        description: |
          JSON Schema version: \`https://json-schema.org/draft/2020-12/schema\` (the default),
          \`https://json-schema.org/draft/2019-09/schema\` or \`http://json-schema.org/draft-07/schema#\`.
        examples:
          - "https://json-schema.org/draft/2020-12/schema"
          - "http://json-schema.org/draft-07/schema#"
      $id:
        type: string
        description: Identifier of the schema (not used for validation).
      $ref:
        type: string
        description: |
          Reference to another schema: \`#/$defs/name\` in this file, an anchor (\`#name\`),
          \`other.schema.yml\` or \`other.schema.yml#/$defs/name\` (relative to this file).
          Since 2019-09 keywords next to \`$ref\` apply as well; in draft-07 they only annotate.
      $anchor:
        type: string
        pattern: "^[A-Za-z_][-A-Za-z0-9._]*$"
        description: |
          Name of this schema, referenced with \`$ref: "#name"\`.
      $dynamicAnchor:
        type: string
        description: Dynamic anchor (resolved like \`$anchor\`).
      $dynamicRef:
        type: string
        description: Dynamic reference (resolved like \`$ref\`).
      $recursiveRef:
        type: string
        description: 2019-09 recursive reference (resolved like \`$ref\`).
      $recursiveAnchor:
        type: boolean
      $vocabulary:
        type: object
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
          - $ref: "#/$defs/typeName"
          - type: array
            minItems: 1
            uniqueItems: true
            items:
              $ref: "#/$defs/typeName"
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
        $ref: "#/$defs/nonNegativeInteger"
        description: Minimal string length.
      maxLength:
        $ref: "#/$defs/nonNegativeInteger"
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
      prefixItems:
        $ref: "#/$defs/schemaArray"
        description: Schemas for the first array items, by position.
      items:
        description: |
          Schema for every array item after those in \`prefixItems\` (\`false\`: no more items).
          A list of schemas is the draft-07 form of \`prefixItems\`.
        anyOf:
          - $ref: ${schemaRef}
          - $ref: "#/$defs/schemaArray"
      additionalItems:
        $ref: ${schemaRef}
        description: "draft-07: schema for items after an \`items\` list (use \`prefixItems\` + \`items\` in 2020-12)."
      unevaluatedItems:
        $ref: ${schemaRef}
        description: Schema for items no other keyword evaluated (also through \`allOf\`, \`$ref\`, ...); \`false\` forbids them.
      minItems:
        $ref: "#/$defs/nonNegativeInteger"
        description: Minimal number of array items.
      maxItems:
        $ref: "#/$defs/nonNegativeInteger"
        description: Maximal number of array items.
      uniqueItems:
        type: boolean
        description: Array items must be unique.
      contains:
        $ref: ${schemaRef}
        description: At least one array item (or \`minContains\` items) must match this schema.
      minContains:
        $ref: "#/$defs/nonNegativeInteger"
        description: Minimal number of items matching \`contains\` (default 1).
      maxContains:
        $ref: "#/$defs/nonNegativeInteger"
        description: Maximal number of items matching \`contains\`.
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
      unevaluatedProperties:
        $ref: ${schemaRef}
        description: |
          Schema for keys no other keyword evaluated, also through \`allOf\`, \`anyOf\`, \`oneOf\`,
          \`if\`/\`then\`/\`else\` and \`$ref\`. \`false\` reports them as unknown (unlike
          \`additionalProperties\`, this works together with combined schemas).
      required:
        $ref: "#/$defs/stringArray"
        description: Keys that must be present, e.g. \`[name, port]\`.
        x-errorMessages:
          type: "In JSON Schema 'required' is a list of keys on the enclosing object, e.g. 'required: [name]'"
      minProperties:
        $ref: "#/$defs/nonNegativeInteger"
        description: Minimal number of keys.
      maxProperties:
        $ref: "#/$defs/nonNegativeInteger"
        description: Maximal number of keys.
      propertyNames:
        $ref: ${schemaRef}
        description: |
          Schema every key must match, e.g. \`{pattern: "^[a-z]+$"}\`.
      dependentRequired:
        type: object
        description: "When a key is present, these other keys must be present too, e.g. \`{user: [password]}\`."
        additionalProperties:
          $ref: "#/$defs/stringArray"
      dependentSchemas:
        type: object
        description: When a key is present, the object must also match this schema.
        additionalProperties:
          $ref: ${schemaRef}
      dependencies:
        type: object
        description: "draft-07 form of \`dependentRequired\` (list) and \`dependentSchemas\` (schema)."
        additionalProperties:
          anyOf:
            - $ref: ${schemaRef}
            - $ref: "#/$defs/stringArray"
      $defs:
        type: object
        description: |
          Reusable schemas. Reference them with \`$ref: "#/$defs/<name>"\`.
        additionalProperties:
          $ref: ${schemaRef}
      definitions:
        type: object
        description: |
          draft-07 name of \`$defs\`. Reference them with \`$ref: "#/definitions/<name>"\`.
        additionalProperties:
          $ref: ${schemaRef}
      allOf:
        $ref: "#/$defs/schemaArray"
        description: The value must match all schemas.
      anyOf:
        $ref: "#/$defs/schemaArray"
        description: The value must match at least one schema.
      oneOf:
        $ref: "#/$defs/schemaArray"
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
      contentSchema:
        $ref: ${schemaRef}
      deprecated:
        type: boolean
        description: Marks the key as deprecated (reported as a warning).
      deprecationMessage:
        type: string
        description: Marks the key as deprecated, with this text as the reason.
      errorMessage:
        $ref: "#/$defs/message"
        description: |
          Custom message for every problem of this schema (also used by VS Code / Red Hat YAML).
          Use \`x-errorMessages\` for messages per keyword.
        x-errorMessages:
          type: "'errorMessage' must be a single text; use 'x-errorMessages' for messages per keyword"
      patternErrorMessage:
        $ref: "#/$defs/message"
        description: Custom message when \`pattern\` does not match (also used by VS Code / Red Hat YAML).
      x-errorMessages:
        type: object
        description: |
          Custom message templates per keyword (\`type\`, \`required\`, \`additionalProperties\`,
          \`pattern\`, \`minimum\`, ...). Overrides \`errorMessage\`.
        additionalProperties: false
        properties:
${kindProps('#/$defs/message', '          ')}
      x-severity:
        description: Severity of problems found by this schema, for all problems or per keyword.
        anyOf:
          - $ref: "#/$defs/severity"
          - type: object
            additionalProperties: false
            properties:
${kindProps('#/$defs/severity', '              ')}
      x-see:
        description: |
          Related files (e.g. documentation) attached to every problem of this schema
          as clickable locations.
        anyOf:
          - $ref: "#/$defs/seeEntry"
          - type: array
            items:
              $ref: "#/$defs/seeEntry"
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
