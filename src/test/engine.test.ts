import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fileKey, setSchemeInfix } from '../core/paths';
import { p, run, summary } from './helpers';

const SCHEME = `
type: map
properties:
  name:
    type: string
    required: true
    pattern: "^[a-z]+$"
  port:
    type: integer
    min: 1
    max: 65535
    message: "Port \${value} out of range \${min}..\${max}"
  mode:
    enum: [dev, prod]
  tags:
    type: list
    items: string
    uniqueItems: true
  server:
    ref: server
  old:
    deprecated: use new
definitions:
  server:
    type: map
    properties:
      host:
        type: string
        required: true
      tls: boolean
`;

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
    const port = r.problems.find((x) => x.kind === 'max')!;
    assert.equal(port.rule?.file, p('app.schema.yml'));
    assert.equal(port.rule?.range.start.line, 7); // `port:` in the scheme (0-based)
});

test('missing required keys at the root and custom severities', () => {
    const r = run(
        {
            'a.schema.yml': 'properties:\n  x:\n    required: true\n    messages:\n      required: "Please set ${key} (${path})"\n    severity: info\n',
            'a.yml': 'y: 1\n',
        },
        'a.yml',
        { unknownKeySeverity: 'error' },
    );
    assert.deepEqual(summary(r.problems), ["a.yml:1 error Unknown key 'y'. Allowed keys: x", 'a.yml:1 info Please set x (x)']);
});

test('see entries become related locations', () => {
    const r = run(
        {
            'a.schema.yml': 'properties:\n  x:\n    type: integer\n    see:\n      - docs/x.md:12\n      - {file: other.txt, label: Other}\n',
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

test('extend merges recursively, local keys win', () => {
    const r = run(
        {
            'app.schema.yml': 'properties:\n  a: integer\n  b: integer\n  c:\n    properties:\n      x: integer\n      y: integer\n',
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

test('!extends tag mounts a file at a key; its own scheme validates it too', () => {
    const r = run(
        {
            'app.schema.yml': 'properties:\n  db:\n    properties:\n      port: integer\n    additionalProperties: true\n',
            'app.yml': 'db: !extends sub/db.yml\n',
            'sub/db.yml': 'port: x\ndriver: oracle\n',
            'sub/db.schema.yml': 'properties:\n  port: integer\n  driver:\n    enum: [pg]\n',
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
            'a.schema.yml': 'type: map\nadditionalProperties: true\n',
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
    const r = run({ 'a.schema.yml': 'properties:\n  x: integer\n', 'a.yml': 'extends: part\n', 'part.yaml': 'x: 1\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), []);
});

test('scheme files are validated against the meta scheme', () => {
    const r = run(
        {
            'a.schema.yml': 'type: mapp\nproperties:\n  x:\n    ref: nope\n    requird: true\n  y:\n    pattern: "("\n',
        },
        'a.schema.yml',
    );
    const msgs = summary(r.problems);
    assert.ok(msgs.some((m) => m.startsWith("a.schema.yml:1 error 'mapp' is not allowed for 'type'") || m.includes("'type' does not match")), msgs.join('\n'));
    assert.ok(msgs.includes("a.schema.yml:5 warning Unknown key 'requird'. Did you mean 'required'?"), msgs.join('\n'));
    assert.ok(msgs.includes("a.schema.yml:4 error Unknown definition 'nope'. No definitions are declared."), msgs.join('\n'));
    assert.ok(msgs.some((m) => m.startsWith('a.schema.yml:7 error Invalid regular expression')), msgs.join('\n'));
});

test('a broken scheme is reported in the validated file', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  x:\n    type: [\n', 'a.yml': 'x: 1\n' }, 'a.yml');
    assert.ok(summary(r.problems).some((m) => m.startsWith("a.yml:1 warning The scheme 'a.schema.yml' has 1 error(s)")));
});

test('anyOf picks the matching alternative or reports all forms', () => {
    const scheme = 'properties:\n  v:\n    anyOf:\n      - type: integer\n        min: 0\n      - type: map\n        properties:\n          n: integer\n';
    assert.deepEqual(summary(run({ 'a.schema.yml': scheme, 'a.yml': 'v: 3\n' }, 'a.yml').problems), []);
    assert.deepEqual(summary(run({ 'a.schema.yml': scheme, 'a.yml': 'v:\n  n: x\n' }, 'a.yml').problems), [
        "a.yml:2 error 'n' must be integer, found string 'x'",
    ]);
    assert.deepEqual(summary(run({ 'a.schema.yml': scheme, 'a.yml': 'v: abc\n' }, 'a.yml').problems), [
        "a.yml:1 error 'v' does not match any of the allowed forms: integer | map",
    ]);
});

test('enum rejects mappings and lists', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  m:\n    enum: [a, b]\n', 'a.yml': 'm:\n  x: 1\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), ["a.yml:1 error '{...}' is not allowed for 'm'. Allowed values: a, b"]);
});

test('invalid type name inside a scheme property is reported', () => {
    const r = run({ 'a.schema.yml': 'properties:\n  t:\n    type: integr\n' }, 'a.schema.yml');
    assert.ok(summary(r.problems).some((m) => m.startsWith("a.schema.yml:3 error 'integr' is not allowed for 'type'")), summary(r.problems).join('\n'));
});

test('merge key and aliases', () => {
    const r = run(
        {
            'a.schema.yml': 'properties:\n  base: {additionalProperties: true}\n  srv:\n    properties:\n      host: string\n      port: integer\n',
            'a.yml': 'base: &b {host: h}\nsrv:\n  <<: *b\n  port: 1\n',
        },
        'a.yml',
    );
    assert.deepEqual(summary(r.problems), []);
});

test('scheme declared in the first line', () => {
    const files = {
        'schemas/app.schema.yml': 'properties:\n  port: integer\n',
        'config/prod.yml': '# schema: ../schemas/app.schema.yml\nport: x\n',
    };
    const r = run(files, 'config/prod.yml');
    assert.equal(r.scheme, p('schemas/app.schema.yml'));
    assert.deepEqual(summary(r.problems), ["config/prod.yml:2 error 'port' must be integer, found string 'x'"]);
    assert.ok(r.deps.has(fileKey(p('schemas/app.schema.yml'))));
});

test('the declaration wins over the sibling scheme; other spellings work', () => {
    const files = {
        'a.schema.yml': 'properties:\n  x: string\n',
        'other.schema.yml': 'properties:\n  x: integer\n',
        'a.yml': '#$schema = "other.schema"\nx: 1\n',
    };
    assert.deepEqual(summary(run(files, 'a.yml').problems), []);
});

test('declared scheme problems: missing file, unconventional name', () => {
    assert.deepEqual(summary(run({ 'a.yml': '# scheme: nope.schema.yml\nx: 1\n' }, 'a.yml').problems), [
        `a.yml:1 error Cannot find scheme file 'nope.schema.yml' (resolved to ${p('nope.schema.yml')})`,
    ]);
    const r = run({ 'rules.yml': 'properties:\n  x: integer\n', 'a.yml': '# schema: rules.yml\nx: y\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), [
        "a.yml:2 error 'x' must be integer, found string 'y'",
        "a.yml:1 warning Name scheme files '*.schema.yml' so that they are checked against the scheme definition themselves",
    ]);
});

test('included files may declare their own scheme', () => {
    const r = run(
        {
            'app.schema.yml': 'type: map\nadditionalProperties: true\n',
            'app.yml': 'db: !extends parts/db.yml\n',
            'parts/db.yml': '# schema: ../schemas/db.schema.yml\nport: x\n',
            'schemas/db.schema.yml': 'properties:\n  port: integer\n',
        },
        'app.yml',
    );
    assert.deepEqual(summary(r.problems), [
        "parts/db.yml:2 error 'port' must be integer, found string 'x'",
        "app.yml:1 error Included file 'parts/db.yml' has 1 error",
    ]);
});

test('scheme file infix and include keyword are configurable', () => {
    const files = { 'a.rules.yaml': 'properties:\n  x: integer\n', 'a.yaml': 'use: b.yaml\n', 'b.yaml': 'x: q\n' };
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
        'app.schema.yml': 'properties:\n  map:\n    properties:\n      first: {required: true}\n  name: {type: string, required: true}\n',
        'app.yml': 'extends: [part.yml, plain.yml]\nmap:\n  first: 1\n',
        // part.yml has its own scheme which allows more map entries
        'part.yml': 'name: from-part\nmap:\n  second: 2\n',
        'part.schema.yml': 'properties:\n  name: string\n  map:\n    properties:\n      second: {type: integer}\n',
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
            'db.schema.yml': 'properties:\n  port: integer\n',
        },
        'app.yml',
    );
    assert.deepEqual(summary(r.problems), []);
});
