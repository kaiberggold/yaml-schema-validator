import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fileKey, setSchemeInfix } from '../core/paths';
import { DEFAULT_OPTIONS, Engine } from '../core/engine';
import { META_FILE } from '../core/meta';
import { MemHost, p, run, summary } from './helpers';

const SCHEME = `
$schema: "http://json-schema.org/draft-07/schema#"
type: object
required: [name]
additionalProperties: false
properties:
  name:
    type: string
    pattern: "^[a-z]+$"
  port:
    type: integer
    minimum: 1
    maximum: 65535
    errorMessage: "Port \${value} out of range \${minimum}..\${maximum}"
  mode:
    enum: [dev, prod]
  tags:
    type: array
    items:
      type: string
    uniqueItems: true
  server:
    $ref: "#/definitions/server"
  old:
    deprecated: true
    deprecationMessage: use new
definitions:
  server:
    type: object
    required: [host]
    properties:
      host:
        type: string
      tls:
        type: boolean
`;

test('the built-in meta scheme parses and validates itself without problems', () => {
    const engine = new Engine(new MemHost(), DEFAULT_OPTIONS);
    assert.deepEqual(engine.getDoc(META_FILE)!.yaml.errors, []);
    assert.deepEqual(engine.run([META_FILE]).get(fileKey(META_FILE))!.problems, []);
});

test('valid file has no problems', () => {
    const r = run({ 'app.schema.yml': SCHEME, 'app.yml': 'name: demo\nport: 80\nmode: dev\ntags: [a, b]\nserver:\n  host: x\n  tls: false\n' }, 'app.yml');
    assert.deepEqual(summary(r.problems), []);
});

test('type, enum, pattern, range, unique, required, unknown and deprecated', () => {
    const r = run(
        {
            'app.schema.yml': SCHEME,
            'app.yml': 'name: Demo\nport: 70000\nmode: test\ntags: [a, a]\nserver:\n  tls: yes\nprot: 1\nold: 1\n',
        },
        'app.yml',
    );
    assert.deepEqual(summary(r.problems), [
        "app.yml:1 error 'Demo' does not match the pattern /^[a-z]+$/ required for 'name'",
        'app.yml:2 error Port 70000 out of range 1..65535',
        "app.yml:3 error 'test' is not allowed for 'mode'. Allowed values: dev, prod",
        "app.yml:4 error Duplicate item a in 'tags'",
        "app.yml:6 error 'tls' must be boolean, found string 'yes'",
        "app.yml:5 error Missing required key 'host'",
        "app.yml:7 warning Unknown key 'prot'. Did you mean 'port'?",
        "app.yml:8 warning 'old' is deprecated: use new",
    ]);
    const dep = r.problems.find((x) => x.kind === 'deprecated')!;
    assert.equal(dep.deprecated, true);
    // the rule location points into the scheme
    const port = r.problems.find((x) => x.kind === 'maximum')!;
    assert.equal(port.rule?.file, p('app.schema.yml'));
    assert.equal(port.rule?.range.start.line, 9); // `port:` in the scheme (0-based)
});

test('additionalProperties defaults to true as in JSON Schema', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  x:\n    type: integer\n', 'a.yml': 'x: 1\nother: 2\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), []);
});

test('missing required keys at the root, custom messages and severities', () => {
    const r = run(
        {
            'a.schema.yml':
                'required: [x]\nadditionalProperties: false\nproperties:\n  x:\n    x-errorMessages:\n      required: "Please set ${key} (${path})"\n    x-severity:\n      required: info\n',
            'a.yml': 'y: 1\n',
        },
        'a.yml',
        { unknownKeySeverity: 'error' },
    );
    assert.deepEqual(summary(r.problems), ["a.yml:1 error Unknown key 'y'. Allowed keys: x", 'a.yml:1 info Please set x (x)']);
});

test('x-see entries become related locations', () => {
    const r = run(
        {
            'a.schema.yml': 'properties:\n  x:\n    type: integer\n    x-see:\n      - docs/x.md:12\n      - {file: other.txt, label: Other}\n',
            'a.yml': 'x: no\n',
        },
        'a.yml',
    );
    const rel = r.problems[0].related;
    assert.equal(rel[0].message, 'Rule in a.schema.yml:2');
    assert.equal(rel[1].location.file, p('docs/x.md'));
    assert.equal(rel[1].location.range.start.line, 11);
    assert.equal(rel[2].message, 'Other');
});

test('draft-07 keywords: const, format, exclusive bounds, multipleOf, lengths, properties count', () => {
    const scheme = [
        'properties:',
        '  c: {const: fixed}',
        '  d: {type: string, format: date}',
        '  e: {type: string, format: email}',
        '  n: {type: number, exclusiveMinimum: 0, exclusiveMaximum: 1}',
        '  m: {type: integer, multipleOf: 5}',
        '  s: {type: string, minLength: 2, maxLength: 3}',
        '  o: {type: object, minProperties: 1, maxProperties: 1}',
        '  i: {type: integer}',
        '',
    ].join('\n');
    const r = run(
        { 'a.schema.yml': scheme, 'a.yml': 'c: other\nd: 2024-13-45\ne: nope\nn: 1\nm: 12\ns: abcd\no: {}\ni: 1.0\n' },
        'a.yml',
    );
    assert.deepEqual(summary(r.problems), [
        "a.yml:1 error 'c' must be fixed, found other",
        "a.yml:2 error '2024-13-45' is not a valid date ('d')",
        "a.yml:3 error 'nope' is not a valid email ('e')",
        "a.yml:4 error 'n' must be less than 1, found 1",
        "a.yml:5 error 'm' must be a multiple of 5, found 12",
        "a.yml:6 error 's' must have at most 3 characters",
        "a.yml:7 error 'o' must have at least 1 key(s), found 0",
    ]);
});

test('patternProperties, propertyNames and dependencies', () => {
    const scheme = [
        'type: object',
        'propertyNames:',
        '  pattern: "^[a-z_]+$"',
        'patternProperties:',
        '  "^env_":',
        '    type: string',
        'additionalProperties:',
        '  type: integer',
        'dependencies:',
        '  user: [password]',
        '',
    ].join('\n');
    const r = run({ 'a.schema.yml': scheme, 'a.yml': 'env_a: x\nenv_b: 1\ncount: 2\nother: no\nBad: 1\nuser: u\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), [
        "a.yml:2 error 'env_b' must be string, found integer '1'",
        "a.yml:4 error 'other' must be integer, found string 'no'",
        "a.yml:5 error Key 'Bad' is not allowed in '<root>' (keys must match /^[a-z_]+$/)",
        "a.yml:6 error 'user' must be integer, found string 'u'",
        "a.yml:6 error 'user' requires 'password' to be present",
    ]);
});

test('arrays: tuple items, additionalItems, contains', () => {
    const scheme = [
        'properties:',
        '  pair:',
        '    type: array',
        '    items: [{type: string}, {type: integer}]',
        '    additionalItems: false',
        '  list:',
        '    type: array',
        '    contains: {const: main}',
        '',
    ].join('\n');
    const r = run({ 'a.schema.yml': scheme, 'a.yml': 'pair: [a, b, c]\nlist: [x, y]\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), [
        "a.yml:1 error 'pair[1]' must be integer, found string 'b'",
        "a.yml:1 error 'pair' allows at most 2 item(s)",
        `a.yml:2 error 'list' must contain at least 1 item(s) of the form "main", found 0`,
    ]);
});

test('allOf, oneOf, not and if/then/else', () => {
    const scheme = [
        'properties:',
        '  a:',
        '    allOf: [{type: integer}, {minimum: 10}]',
        '  b:',
        '    oneOf: [{type: integer}, {type: number}]',
        '  c:',
        '    not: {type: string}',
        '  d:',
        '    type: object',
        '    if: {properties: {kind: {const: file}}}',
        '    then: {required: [path]}',
        '    else: {required: [url]}',
        '',
    ].join('\n');
    const r = run({ 'a.schema.yml': scheme, 'a.yml': 'a: 5\nb: 3\nc: text\nd:\n  kind: file\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), [
        "a.yml:1 error 'a' must be at least 10, found 5",
        "a.yml:2 error 'b' must match exactly one of: integer | number (it matches 2 of them)",
        "a.yml:3 error 'c' must not be string",
        "a.yml:4 error Missing required key 'path'",
    ]);
    const ok = run({ 'a.schema.yml': scheme, 'a.yml': 'b: 1.5\nd:\n  kind: web\n  url: x\n' }, 'a.yml');
    assert.deepEqual(summary(ok.problems), []);
});

test('$ref to another scheme file and boolean schemas', () => {
    const r = run(
        {
            'a.schema.yml': 'properties:\n  db:\n    $ref: "common.schema.yml#/definitions/db"\n  legacy: false\n',
            'common.schema.yml': 'definitions:\n  db:\n    type: object\n    properties:\n      port:\n        type: integer\n',
            'a.yml': 'db:\n  port: x\nlegacy: 1\n',
        },
        'a.yml',
    );
    assert.deepEqual(summary(r.problems), ["a.yml:2 error 'port' must be integer, found string 'x'", "a.yml:3 error 'legacy' is not allowed here"]);
    assert.ok(r.deps.has(fileKey(p('common.schema.yml'))));
});

test('extend merges recursively, local keys win', () => {
    const r = run(
        {
            'app.schema.yml':
                'properties:\n  a: {type: integer}\n  b: {type: integer}\n  c:\n    additionalProperties: false\n    properties:\n      x: {type: integer}\n      y: {type: integer}\n',
            'app.yml': 'extends: base.yml\nb: 2\nc:\n  y: 3\n',
            'base.yml': 'extends: [deeper.yml]\na: 1\nb: one\nc:\n  x: 1\n',
            'deeper.yml': 'c:\n  y: wrong\n  z: unknown\n',
        },
        'app.yml',
    );
    // b and c.y are overridden in app.yml, so only c.z remains
    assert.deepEqual(summary(r.problems), [
        "deeper.yml:3 warning Unknown key 'z'. Allowed keys: x, y",
        "app.yml:1 warning Included file 'base.yml' has 1 warning",
        "base.yml:1 warning Included file 'deeper.yml' has 1 warning",
    ]);
    const z = r.problems[0];
    assert.deepEqual(
        z.related.filter((x) => x.message.startsWith('Included')).map((x) => x.message),
        ['Included from base.yml:1', 'Included from app.yml:1'],
    );
    for (const f of ['app.yml', 'base.yml', 'deeper.yml', 'app.schema.yml', 'base.schema.yml', 'deeper.schema.yaml']) {
        assert.ok(r.deps.has(fileKey(p(f))), f);
    }
});

test('!extends tag mounts a file at a key; its own scheme validates it', () => {
    const r = run(
        {
            'app.schema.yml': 'properties:\n  db:\n    type: object\n',
            'app.yml': 'db: !extends sub/db.yml\n',
            'sub/db.yml': 'port: x\ndriver: oracle\n',
            'sub/db.schema.yml': 'properties:\n  port: {type: integer}\n  driver:\n    enum: [pg]\n',
        },
        'app.yml',
    );
    assert.deepEqual(summary(r.problems), [
        "sub/db.yml:1 error 'port' must be integer, found string 'x'",
        "sub/db.yml:2 error 'oracle' is not allowed for 'driver'. Allowed values: pg",
        "app.yml:1 error Included file 'sub/db.yml' has 2 errors",
    ]);
    assert.ok(r.mounts.has(fileKey(p('sub/db.yml'))));
});

test('include errors: missing, cycle, wrong type, bad value', () => {
    const r = run(
        {
            'a.schema.yml': 'type: object\n',
            'a.yml': 'extends: [missing.yml, b.yml, list.yml]\nx: !extends {a: 1}\n',
            'b.yml': 'extends: a.yml\n',
            'list.yml': '- 1\n',
        },
        'a.yml',
    );
    const msgs = summary(r.problems);
    assert.ok(msgs.some((m) => m.startsWith("a.yml:1 error Cannot find included file 'missing.yml'")), msgs.join('\n'));
    assert.ok(msgs.includes('b.yml:1 error Circular include: a.yml → b.yml → a.yml'), msgs.join('\n'));
    assert.ok(msgs.includes("a.yml:1 error Included file 'list.yml' must contain a mapping to be merged here (found a list)"));
    assert.ok(msgs.includes("a.yml:2 error '!extends' expects a file path or a list of file paths"));
});

test('include paths may omit the extension', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  x: {type: integer}\n', 'a.yml': 'extends: part\n', 'part.yaml': 'x: 1\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), []);
});

test('scheme files are validated against the meta scheme', () => {
    const r = run(
        {
            'a.schema.yml': 'type: map\nproperties:\n  x:\n    $ref: "#/definitions/nope"\n    requird: [a]\n    required: true\n  y:\n    pattern: "("\n',
        },
        'a.schema.yml',
    );
    const msgs = summary(r.problems);
    const has = (m: string) => assert.ok(msgs.includes(m), `${m}\n--- got:\n${msgs.join('\n')}`);
    has(
        "a.schema.yml:1 error 'map' is not a JSON Schema type. Use one of: string, number, integer, boolean, object, array, null (object instead of map, array instead of list)",
    );
    has("a.schema.yml:5 warning Unknown keyword 'requird'. Did you mean 'required'?");
    has("a.schema.yml:6 error In JSON Schema 'required' is a list of keys on the enclosing object, e.g. 'required: [name]'");
    has("a.schema.yml:4 error Cannot resolve $ref '#/definitions/nope'");
    assert.ok(msgs.some((m) => m.startsWith('a.schema.yml:8 error Invalid regular expression')), msgs.join('\n'));
});

test('a broken scheme is reported in the validated file', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  x:\n    type: [\n', 'a.yml': 'x: 1\n' }, 'a.yml');
    assert.ok(summary(r.problems).some((m) => /^a\.yml:1 warning The schema 'a\.schema\.yml' has \d+ error\(s\)/.test(m)));
});

test('anyOf picks the matching alternative or reports all forms', () => {
    const scheme = 'properties:\n  v:\n    anyOf:\n      - type: integer\n        minimum: 0\n      - type: object\n        properties:\n          n: {type: integer}\n';
    assert.deepEqual(summary(run({ 'a.schema.yml': scheme, 'a.yml': 'v: 3\n' }, 'a.yml').problems), []);
    assert.deepEqual(summary(run({ 'a.schema.yml': scheme, 'a.yml': 'v:\n  n: x\n' }, 'a.yml').problems), [
        "a.yml:2 error 'n' must be integer, found string 'x'",
    ]);
    assert.deepEqual(summary(run({ 'a.schema.yml': scheme, 'a.yml': 'v: abc\n' }, 'a.yml').problems), [
        "a.yml:1 error 'v' does not match any of the allowed forms: integer | object",
    ]);
});

test('enum rejects mappings and lists', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  m:\n    enum: [a, b]\n', 'a.yml': 'm:\n  x: 1\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), ["a.yml:1 error '{...}' is not allowed for 'm'. Allowed values: a, b"]);
});

test('invalid type name inside a scheme property is reported', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  t:\n    type: integr\n' }, 'a.schema.yml');
    assert.ok(summary(r.problems).some((m) => m.startsWith("a.schema.yml:3 error 'integr' is not a JSON Schema type. Did you mean 'integer'?")), summary(r.problems).join('\n'));
});

test('merge key and aliases', () => {
    const r = run(
        {
            'a.schema.yml': 'properties:\n  srv:\n    additionalProperties: false\n    properties:\n      host: {type: string}\n      port: {type: integer}\n',
            'a.yml': 'base: &b {host: h}\nsrv:\n  <<: *b\n  port: 1\n',
        },
        'a.yml',
    );
    assert.deepEqual(summary(r.problems), []);
});

test('scheme declared in the first line', () => {
    const files = {
        'schemas/app.schema.yml': 'properties:\n  port: {type: integer}\n',
        'config/prod.yml': '# schema: ../schemas/app.schema.yml\nport: x\n',
    };
    const r = run(files, 'config/prod.yml');
    assert.equal(r.scheme, p('schemas/app.schema.yml'));
    assert.deepEqual(summary(r.problems), ["config/prod.yml:2 error 'port' must be integer, found string 'x'"]);
    assert.ok(r.deps.has(fileKey(p('schemas/app.schema.yml'))));
});

test('the Red Hat YAML modeline declares the scheme as well', () => {
    const files = {
        'schemas/app.schema.yml': 'properties:\n  port: {type: integer}\n',
        'app.yml': '# yaml-language-server: $schema=schemas/app.schema.yml\nport: x\n',
    };
    const r = run(files, 'app.yml');
    assert.equal(r.scheme, p('schemas/app.schema.yml'));
    assert.equal(r.problems.length, 1);
});

test('the declaration wins over the sibling scheme; other spellings work', () => {
    const files = {
        'a.schema.yml': 'properties:\n  x: {type: string}\n',
        'other.schema.yml': 'properties:\n  x: {type: integer}\n',
        'a.yml': '#$schema = "other.schema"\nx: 1\n',
    };
    assert.deepEqual(summary(run(files, 'a.yml').problems), []);
});

test('declared scheme problems: missing file, unconventional name', () => {
    assert.deepEqual(summary(run({ 'a.yml': '# scheme: nope.schema.yml\nx: 1\n' }, 'a.yml').problems), [
        `a.yml:1 error Cannot find schema file 'nope.schema.yml' (resolved to ${p('nope.schema.yml')})`,
    ]);
    const r = run({ 'rules.yml': 'properties:\n  x: {type: integer}\n', 'a.yml': '# schema: rules.yml\nx: y\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), [
        "a.yml:2 error 'x' must be integer, found string 'y'",
        "a.yml:1 warning Name schema files '*.schema.yml' so that they are checked against the schema definition themselves",
    ]);
});

test('included files may declare their own scheme', () => {
    const r = run(
        {
            'app.schema.yml': 'type: object\n',
            'app.yml': 'db: !extends parts/db.yml\n',
            'parts/db.yml': '# schema: ../schemas/db.schema.yml\nport: x\n',
            'schemas/db.schema.yml': 'properties:\n  port: {type: integer}\n',
        },
        'app.yml',
    );
    assert.deepEqual(summary(r.problems), [
        "parts/db.yml:2 error 'port' must be integer, found string 'x'",
        "app.yml:1 error Included file 'parts/db.yml' has 1 error",
    ]);
});

test('scheme file infix and include keyword are configurable', () => {
    const files = { 'a.rules.yaml': 'properties:\n  x: {type: integer}\n', 'a.yaml': 'use: b.yaml\n', 'b.yaml': 'x: q\n' };
    try {
        const r = run(files, 'a.yaml', { schemeInfix: 'rules', extendKeyword: 'use' });
        assert.equal(r.scheme, p('a.rules.yaml'));
        assert.deepEqual(summary(r.problems), [
            "b.yaml:1 error 'x' must be integer, found string 'q'",
            "a.yaml:1 error Included file 'b.yaml' has 1 error",
        ]);
    } finally {
        setSchemeInfix(undefined);
    }
});

test('content from an included file with its own scheme is only validated by that scheme', () => {
    const files = {
        'app.schema.yml':
            'required: [name]\nproperties:\n  map:\n    required: [first]\n    additionalProperties: false\n    properties:\n      first: true\n  name: {type: string}\n',
        'app.yml': 'extends: [part.yml, plain.yml]\nmap:\n  first: 1\n',
        // part.yml has its own scheme which allows more map entries
        'part.yml': 'name: from-part\nmap:\n  second: 2\n',
        'part.schema.yml': 'properties:\n  name: {type: string}\n  map:\n    properties:\n      second: {type: integer}\n',
        // plain.yml has no scheme: it is still checked through app.schema.yml
        'plain.yml': 'map:\n  third: 3\n',
    };
    const r = run(files, 'app.yml');
    assert.deepEqual(summary(r.problems), [
        "plain.yml:2 warning Unknown key 'third'. Allowed keys: first",
        "app.yml:1 warning Included file 'plain.yml' has 1 warning",
    ]);
    // ... but its own scheme still applies
    const own = run({ ...files, 'part.yml': 'name: 5\nmap:\n  second: x\n' }, 'app.yml');
    assert.deepEqual(summary(own.problems).filter((m) => m.startsWith('part.yml')), [
        "part.yml:1 error 'name' must be string, found integer '5'",
        "part.yml:3 error 'second' must be integer, found string 'x'",
    ]);
});

test('a value mounted with the tag from a file with its own scheme is not checked by the including scheme', () => {
    const r = run(
        {
            'app.schema.yml': 'properties:\n  db: {type: string}\n',
            'app.yml': 'db: !extends db.yml\n',
            'db.yml': 'port: 1\n',
            'db.schema.yml': 'properties:\n  port: {type: integer}\n',
        },
        'app.yml',
    );
    assert.deepEqual(summary(r.problems), []);
});

test('unused anchors are reported as hints', () => {
    const files = { 'a.schema.yml': 'type: object\n', 'a.yml': 'x: &used 1\ny: *used\nz: &unused 2\n' };
    assert.deepEqual(summary(run(files, 'a.yml').problems), ["a.yml:3 hint Anchor '&unused' is never used"]);
    const p0 = run(files, 'a.yml').problems[0];
    assert.equal(p0.kind, 'anchor');
    assert.deepEqual(p0.range, { start: { line: 2, character: 3 }, end: { line: 2, character: 10 } });
    assert.deepEqual(summary(run(files, 'a.yml', { unusedAnchors: false }).problems), []);
});

test('2020-12: prefixItems, items false, minContains / maxContains, unevaluatedItems', () => {
    const scheme = [
        '$schema: "https://json-schema.org/draft/2020-12/schema"',
        'properties:',
        '  pair:',
        '    prefixItems: [{type: string}, {type: integer}]',
        '    items: false',
        '  tags:',
        '    contains: {const: main}',
        '    minContains: 2',
        '    maxContains: 3',
        '  list:',
        '    prefixItems: [{type: string}]',
        '    unevaluatedItems: false',
        '',
    ].join('\n');
    const r = run({ 'a.schema.yml': scheme, 'a.yml': 'pair: [a, 1, x]\ntags: [main, other]\nlist: [a, b]\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), [
        "a.yml:1 error 'pair' allows at most 2 item(s)",
        `a.yml:2 error 'tags' must contain at least 2 item(s) of the form "main", found 1`,
        "a.yml:3 error 'list' allows at most 1 item(s)",
    ]);
});

test('2020-12: $defs, $anchor, dependentRequired and dependentSchemas', () => {
    const scheme = [
        'properties:',
        '  port: {$ref: "#/$defs/port"}',
        '  host: {$ref: "#hostname"}',
        'dependentRequired:',
        '  user: [password]',
        'dependentSchemas:',
        '  tls:',
        '    required: [cert]',
        '$defs:',
        '  port: {type: integer}',
        '  host:',
        '    $anchor: hostname',
        '    type: string',
        '',
    ].join('\n');
    const r = run({ 'a.schema.yml': scheme, 'a.yml': 'port: x\nhost: 1\nuser: u\ntls: true\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), [
        "a.yml:1 error 'port' must be integer, found string 'x'",
        "a.yml:2 error 'host' must be string, found integer '1'",
        "a.yml:3 error 'user' requires 'password' to be present",
        "a.yml:1 error Missing required key 'cert'",
    ]);
});

test('unevaluatedProperties sees keys evaluated in allOf, $ref and if/then', () => {
    const scheme = [
        '$defs:',
        '  base:',
        '    properties:',
        '      name: {type: string}',
        'allOf:',
        '  - $ref: "#/$defs/base"',
        'properties:',
        '  kind: {enum: [file, url]}',
        'if: {properties: {kind: {const: file}}}',
        'then: {properties: {path: {type: string}}}',
        'unevaluatedProperties: false',
        '',
    ].join('\n');
    const ok = run({ 'a.schema.yml': scheme, 'a.yml': 'name: n\nkind: file\npath: p\n' }, 'a.yml');
    assert.deepEqual(summary(ok.problems), []);
    const bad = run({ 'a.schema.yml': scheme, 'a.yml': 'name: n\nkind: url\npath: p\nnmae: x\n' }, 'a.yml');
    assert.deepEqual(summary(bad.problems), [
        "a.yml:3 warning Unknown key 'path'. Allowed keys: kind",
        "a.yml:4 warning Unknown key 'nmae'. Allowed keys: kind",
    ]);
});

test('$ref next to other keywords: applied since 2019-09, only annotating in draft-07', () => {
    const body = 'properties:\n  n:\n    $ref: "#/$defs/int"\n    minimum: 10\n$defs:\n  int: {type: integer}\n';
    const modern = run({ 'a.schema.yml': body, 'a.yml': 'n: 5\n' }, 'a.yml');
    assert.deepEqual(summary(modern.problems), ["a.yml:1 error 'n' must be at least 10, found 5"]);
    const legacy = run({ 'a.schema.yml': '$schema: "http://json-schema.org/draft-07/schema#"\n' + body.replace(/\$defs/g, 'definitions'), 'a.yml': 'n: 5\n' }, 'a.yml');
    assert.deepEqual(summary(legacy.problems), []);
});
