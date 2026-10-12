import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fileKey } from '../core/paths';
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
    const r = run({ 'app.scheme.yml': SCHEME, 'app.yml': 'name: demo\nport: 80\nmode: dev\ntags: [a, b]\nserver:\n  host: x\n  tls: false\n' }, 'app.yml');
    assert.deepEqual(summary(r.problems), []);
});

test('type, enum, pattern, range, unique, required, unknown and deprecated', () => {
    const r = run(
        {
            'app.scheme.yml': SCHEME,
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
    assert.equal(port.rule?.file, p('app.scheme.yml'));
    assert.equal(port.rule?.range.start.line, 7); // `port:` in the scheme (0-based)
});

test('missing required keys at the root and custom severities', () => {
    const r = run(
        {
            'a.scheme.yml': 'properties:\n  x:\n    required: true\n    messages:\n      required: "Please set ${key} (${path})"\n    severity: info\n',
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
            'a.scheme.yml': 'properties:\n  x:\n    type: integer\n    see:\n      - docs/x.md:12\n      - {file: other.txt, label: Other}\n',
            'a.yml': 'x: no\n',
        },
        'a.yml',
    );
    const rel = r.problems[0].related;
    assert.equal(rel[0].message, 'Rule in a.scheme.yml:2');
    assert.equal(rel[1].location.file, p('docs/x.md'));
    assert.equal(rel[1].location.range.start.line, 11);
    assert.equal(rel[2].message, 'Other');
});

test('extend merges recursively, local keys win', () => {
    const r = run(
        {
            'app.scheme.yml': 'properties:\n  a: integer\n  b: integer\n  c:\n    properties:\n      x: integer\n      y: integer\n',
            'app.yml': 'extend: base.yml\nb: 2\nc:\n  y: 3\n',
            'base.yml': 'extend: [deeper.yml]\na: 1\nb: one\nc:\n  x: 1\n',
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
    for (const f of ['app.yml', 'base.yml', 'deeper.yml', 'app.scheme.yml', 'base.scheme.yml', 'deeper.scheme.yaml']) {
        assert.ok(r.deps.has(fileKey(p(f))), f);
    }
});

test('!extend tag mounts a file at a key; its own scheme validates it too', () => {
    const r = run(
        {
            'app.scheme.yml': 'properties:\n  db:\n    properties:\n      port: integer\n    additionalProperties: true\n',
            'app.yml': 'db: !extend sub/db.yml\n',
            'sub/db.yml': 'port: x\ndriver: oracle\n',
            'sub/db.scheme.yml': 'properties:\n  port: integer\n  driver:\n    enum: [pg]\n',
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
            'a.scheme.yml': 'type: map\nadditionalProperties: true\n',
            'a.yml': 'extend: [missing.yml, b.yml, list.yml]\nx: !extend 5\n',
            'b.yml': 'extend: a.yml\n',
            'list.yml': '- 1\n',
        },
        'a.yml',
    );
    const msgs = summary(r.problems);
    assert.ok(msgs.some((m) => m.startsWith("a.yml:1 error Cannot find included file 'missing.yml'")), msgs.join('\n'));
    assert.ok(msgs.includes('b.yml:1 error Circular include: a.yml → b.yml → a.yml'), msgs.join('\n'));
    assert.ok(msgs.includes("a.yml:1 error Included file 'list.yml' must contain a mapping to be merged here (found a list)"));
    assert.ok(msgs.includes("a.yml:2 error '!extend' expects a file path or a list of file paths"));
});

test('include paths may omit the extension', () => {
    const r = run({ 'a.scheme.yml': 'properties:\n  x: integer\n', 'a.yml': 'extend: part\n', 'part.yaml': 'x: 1\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), []);
});

test('scheme files are validated against the meta scheme', () => {
    const r = run(
        {
            'a.scheme.yml': 'type: mapp\nproperties:\n  x:\n    ref: nope\n    requird: true\n  y:\n    pattern: "("\n',
        },
        'a.scheme.yml',
    );
    const msgs = summary(r.problems);
    assert.ok(msgs.some((m) => m.startsWith("a.scheme.yml:1 error 'mapp' is not allowed for 'type'") || m.includes("'type' does not match")), msgs.join('\n'));
    assert.ok(msgs.includes("a.scheme.yml:5 warning Unknown key 'requird'. Did you mean 'required'?"), msgs.join('\n'));
    assert.ok(msgs.includes("a.scheme.yml:4 error Unknown definition 'nope'. No definitions are declared."), msgs.join('\n'));
    assert.ok(msgs.some((m) => m.startsWith('a.scheme.yml:7 error Invalid regular expression')), msgs.join('\n'));
});

test('a broken scheme is reported in the validated file', () => {
    const r = run({ 'a.scheme.yml': 'properties:\n  x:\n    type: [\n', 'a.yml': 'x: 1\n' }, 'a.yml');
    assert.ok(summary(r.problems).some((m) => m.startsWith("a.yml:1 warning The scheme 'a.scheme.yml' has 1 error(s)")));
});

test('anyOf picks the matching alternative or reports all forms', () => {
    const scheme = 'properties:\n  v:\n    anyOf:\n      - type: integer\n        min: 0\n      - type: map\n        properties:\n          n: integer\n';
    assert.deepEqual(summary(run({ 'a.scheme.yml': scheme, 'a.yml': 'v: 3\n' }, 'a.yml').problems), []);
    assert.deepEqual(summary(run({ 'a.scheme.yml': scheme, 'a.yml': 'v:\n  n: x\n' }, 'a.yml').problems), [
        "a.yml:2 error 'n' must be integer, found string 'x'",
    ]);
    assert.deepEqual(summary(run({ 'a.scheme.yml': scheme, 'a.yml': 'v: abc\n' }, 'a.yml').problems), [
        "a.yml:1 error 'v' does not match any of the allowed forms: integer | map",
    ]);
});

test('enum rejects mappings and lists', () => {
    const r = run({ 'a.scheme.yml': 'properties:\n  m:\n    enum: [a, b]\n', 'a.yml': 'm:\n  x: 1\n' }, 'a.yml');
    assert.deepEqual(summary(r.problems), ["a.yml:1 error '{...}' is not allowed for 'm'. Allowed values: a, b"]);
});

test('invalid type name inside a scheme property is reported', () => {
    const r = run({ 'a.scheme.yml': 'properties:\n  t:\n    type: integr\n' }, 'a.scheme.yml');
    assert.ok(summary(r.problems).some((m) => m.startsWith("a.scheme.yml:3 error 'integr' is not allowed for 'type'")), summary(r.problems).join('\n'));
});

test('merge key and aliases', () => {
    const r = run(
        {
            'a.scheme.yml': 'properties:\n  base: {additionalProperties: true}\n  srv:\n    properties:\n      host: string\n      port: integer\n',
            'a.yml': 'base: &b {host: h}\nsrv:\n  <<: *b\n  port: 1\n',
        },
        'a.yml',
    );
    assert.deepEqual(summary(r.problems), []);
});
