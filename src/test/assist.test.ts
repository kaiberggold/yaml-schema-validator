import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ITEM, getCursorContext, keyAt, keyCompletions, keySnippet, valueCompletions, walk, hoverMarkdown, inferScheme, isRequired } from '../core/assist';
import { Resolver } from '../core/effective';
import { Engine, DEFAULT_OPTIONS } from '../core/engine';
import { compileScheme } from '../core/scheme';
import { MemHost, p } from './helpers';

const env = { lineOf: () => 1, link: () => 'file:///x' };

function scheme(text: string) {
    const engine = new Engine(new MemHost({ 's.schema.yml': text }), DEFAULT_OPTIONS);
    const root = new Resolver(engine.docs, 'extends', () => undefined).buildFile(p('s.schema.yml'))!;
    return compileScheme(root, p('s.schema.yml')).root;
}

const S = scheme(`
properties:
  server:
    description: Server settings
    required: [port]
    properties:
      host: {type: string, default: localhost}
      port: {type: integer}
      mode: {enum: [a, b], default: b}
      tls: {type: boolean}
  items:
    type: array
    items:
      properties:
        name: {type: string}
        kind: {enum: [x, y]}
  tags:
    type: array
    items: {enum: [red, green]}
  env:
    patternProperties:
      "^[A-Z_]+$": {type: string, description: Environment variable}
`);

test('cursor context: nested key position and siblings', () => {
    const lines = ['server:', '  host: a', '  ', '  tls: true'];
    const c = getCursorContext(lines, 2, 2);
    assert.equal(c.kind, 'key');
    assert.deepEqual(c.path, ['server']);
    assert.deepEqual([...c.siblings].sort(), ['host', 'tls']);
    const names = keyCompletions(walk(S, c.path), c.siblings, env, 'extends').map((e) => e.label);
    assert.deepEqual(names, ['port', 'mode', 'extends']);
});

test('cursor context: list items', () => {
    const lines = ['items:', '  - name: a', '    ', '  - k'];
    const inItem = getCursorContext(lines, 2, 4);
    assert.deepEqual(inItem.path, ['items', ITEM]);
    assert.deepEqual([...inItem.siblings], ['name']);
    const newItem = getCursorContext(lines, 3, 5);
    assert.equal(newItem.kind, 'key');
    assert.equal(newItem.prefix, 'k');
    assert.deepEqual(newItem.path, ['items', ITEM]);
    assert.deepEqual([...newItem.siblings], []);
    const same = getCursorContext(['tags:', '- r'], 1, 3);
    assert.deepEqual(same.path, ['tags', ITEM]);
    assert.deepEqual(valueCompletions(walk(S, same.path)).map((e) => e.label), ['red', 'green']);
});

test('cursor context: value position', () => {
    const c = getCursorContext(['server:', '  mode: '], 1, 8);
    assert.equal(c.kind, 'value');
    assert.equal(c.key, 'mode');
    assert.deepEqual(c.path, ['server']);
    assert.deepEqual(valueCompletions(walk(S, [...c.path, c.key!])).map((e) => e.label), ['b', 'a']);
    const tag = getCursorContext(['x: !extends sub/'], 0, 16);
    assert.equal(tag.extendTag, true);
    assert.equal(tag.prefix, 'sub/');
});

test('snippets', () => {
    const server = walk(S, ['server'])[0];
    assert.equal(keySnippet('mode', server.properties!.get('mode')!).text, 'mode: ${1|b,a|}');
    assert.equal(keySnippet('tls', server.properties!.get('tls')!).text, 'tls: ${1|false,true|}');
    assert.equal(keySnippet('host', server.properties!.get('host')!).text, 'host: ${1:localhost}');
    assert.equal(keySnippet('server', S.properties!.get('server')!).text, 'server:\n\t$0');
    assert.equal(keySnippet('items', S.properties!.get('items')!).text, 'items:\n\t- $0');
});

test('key at position and hover text', () => {
    const lines = ['items:', '  - name: a', '    kind: x'];
    const k = keyAt(lines, 2, 5)!;
    assert.deepEqual(k.path, ['items', ITEM, 'kind']);
    const md = hoverMarkdown(walk(S, ['server'])[0], 'server', env);
    assert.match(md, /\*\*server\*\* · `object`/);
    assert.match(md, /Server settings/);
    assert.match(md, /Keys: `host`, `port`\*, `mode`, `tls`/);
});

test('inferScheme produces a valid scheme', () => {
    const text = inferScheme({ a: 1, b: [{ c: 'x' }], d: true });
    const root = scheme(text);
    assert.deepEqual([...root.properties!.keys()], ['a', 'b', 'd']);
});

test('walking through patternProperties, required flags and hover facts', () => {
    const nodes = walk(S, ['env', 'HOME']);
    assert.equal(nodes.length, 1);
    assert.match(hoverMarkdown(nodes[0], 'HOME', env), /Environment variable/);
    assert.equal(isRequired(walk(S, ['server']), 'port'), true);
    assert.equal(isRequired(walk(S, ['server']), 'host'), false);
    assert.match(hoverMarkdown(walk(S, ['server', 'port'])[0], 'port', env, true), /\*required\*/);
});
