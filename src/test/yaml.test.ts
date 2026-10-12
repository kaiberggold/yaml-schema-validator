import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { YNode, parseYaml } from '../core/yaml';

function js(n: YNode | undefined): unknown {
    if (!n) {
        return undefined;
    }
    switch (n.kind) {
        case 'scalar':
            return n.value;
        case 'seq':
            return n.items.map(js);
        case 'alias':
            return js(n.target);
        case 'map':
            return Object.fromEntries(n.pairs.map((p) => [p.key.value, js(p.value)]));
    }
}

function parse(text: string) {
    const d = parseYaml(text);
    return { value: js(d.root), errors: d.errors.map((e) => e.message) };
}

test('block mappings, sequences and scalars', () => {
    const r = parse(
        [
            '# comment',
            'name: "my app"  # trailing',
            'port: 8080',
            'ratio: 0.5',
            'on: true',
            'off: ~',
            'list:',
            '- a',
            '- b: 1',
            '  c: two words',
            'nested:',
            '  deep:',
            '    - x',
            '    -',
            '      y: 2',
            'empty:',
            '',
        ].join('\n'),
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value, {
        name: 'my app',
        port: 8080,
        ratio: 0.5,
        on: true,
        off: null,
        list: ['a', { b: 1, c: 'two words' }],
        nested: { deep: ['x', { y: 2 }] },
        empty: null,
    });
});

test('flow collections, quoting and escapes', () => {
    const r = parse(`a: [1, "two", 'thr''ee', {x: y, z: [ ]}]\nb: {k: v,\n  n: 2}\nc: "tab\\tnew\\nline \\u00e9"\nurl: http://x.org/a:b\n`);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value, {
        a: [1, 'two', "thr'ee", { x: 'y', z: [] }],
        b: { k: 'v', n: 2 },
        c: 'tab\tnew\nline é',
        url: 'http://x.org/a:b',
    });
});

test('block scalars', () => {
    const r = parse('lit: |\n  a\n   b\n\n  c\nfold: >-\n  one\n  two\n\n  three\nkeep: |+\n  x\n\nnext: 1\n');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value, { lit: 'a\n b\n\nc\n', fold: 'one two\nthree', keep: 'x\n\n', next: 1 });
});

test('multi-line plain scalars', () => {
    const r = parse('text: this is\n  a long\n\n  value\nother: x\n');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value, { text: 'this is a long\nvalue', other: 'x' });
});

test('anchors, aliases and tags', () => {
    const d = parseYaml('base: &b {x: 1}\ncopy: *b\ninc: !extend other.yml\n');
    assert.deepEqual(d.errors, []);
    assert.deepEqual(js(d.root), { base: { x: 1 }, copy: { x: 1 }, inc: 'other.yml' });
    const inc = d.root!.kind === 'map' ? d.root!.pairs[2].value : undefined;
    assert.equal(inc?.tag, '!extend');
});

test('offsets of keys and values', () => {
    const text = 'a: 1\nbb:\n  ccc: hello\n';
    const d = parseYaml(text);
    assert.ok(d.root?.kind === 'map');
    const bb = d.root.pairs[1];
    assert.equal(text.slice(bb.key.start, bb.key.end), 'bb');
    assert.ok(bb.value.kind === 'map');
    const ccc = bb.value.pairs[0];
    assert.equal(text.slice(ccc.key.start, ccc.key.end), 'ccc');
    assert.equal(text.slice(ccc.value.start, ccc.value.end), 'hello');
});

test('syntax errors are reported and parsing recovers', () => {
    assert.deepEqual(parse('a: 1\na: 2\n').errors, ["Duplicate key 'a'"]);
    assert.deepEqual(parse('a:\n  b: 1\n c: 2\n').errors, ['Bad indentation']);
    assert.deepEqual(parse('a:\n\t- x\n').errors.slice(0, 1), ['Tab characters must not be used for indentation']);
    assert.deepEqual(parse('a: b: c\n').errors, ['Nested mappings are not allowed on the same line as their key']);
    assert.deepEqual(parse('x: "open\n').errors, ['Unterminated quoted string']);
    assert.deepEqual(parse('a: [1, 2\n').errors, ["Unterminated flow sequence, expected ']'"]);
    assert.deepEqual(parse('a: *nope\n').errors, ["Unknown anchor 'nope'"]);
    const r = parse('a: 1\n  bad: 2\nc: 3\n');
    assert.deepEqual(r.errors, ['Bad indentation']);
    assert.deepEqual(r.value, { a: 1, c: 3 });
});

test('documents', () => {
    assert.deepEqual(parse('---\na: 1\n...\n').value, { a: 1 });
    assert.deepEqual(parse('a: 1\n---\nb: 2\n').errors, ['Only the first YAML document is validated']);
    assert.equal(parseYaml('# only a comment\n').root, undefined);
});
