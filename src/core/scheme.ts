import * as path from 'path';
import { EEntry, EMap, ENode, toJs } from './effective';
import { ProblemKind, Severity } from './types';
import { Scalar } from './yaml';

export type TypeName = 'string' | 'number' | 'integer' | 'boolean' | 'map' | 'list' | 'null' | 'any';

const TYPE_ALIASES: Record<string, TypeName> = {
    string: 'string',
    str: 'string',
    number: 'number',
    float: 'number',
    integer: 'integer',
    int: 'integer',
    boolean: 'boolean',
    bool: 'boolean',
    map: 'map',
    object: 'map',
    dict: 'map',
    list: 'list',
    array: 'list',
    seq: 'list',
    null: 'null',
    any: 'any',
};

export function normalizeType(v: unknown): TypeName | undefined {
    if (v === null) {
        return 'null';
    }
    return typeof v === 'string' ? TYPE_ALIASES[v] : undefined;
}

export interface SeeRef {
    file: string;
    /** 1-based line, 0 = no specific line. */
    line: number;
    label: string;
}

export interface SchemaNode {
    id: number;
    scheme: CompiledScheme;
    /** Location of the node definition. */
    file: string;
    start: number;
    end: number;
    /** Location of the property key in the scheme (for named properties). */
    keyFile?: string;
    keyStart?: number;
    keyEnd?: number;
    name?: string;

    types?: TypeName[];
    title?: string;
    description?: string;
    required?: boolean;
    hasDefault?: boolean;
    default?: unknown;
    enum?: Scalar[];
    examples?: unknown[];
    pattern?: RegExp;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    minItems?: number;
    maxItems?: number;
    properties?: Map<string, SchemaNode>;
    additionalProperties?: boolean | SchemaNode;
    items?: SchemaNode;
    uniqueItems?: boolean;
    ref?: string;
    anyOf?: SchemaNode[];
    deprecated?: string | boolean;
    severity?: Severity | Partial<Record<ProblemKind, Severity>>;
    message?: string;
    messages?: Partial<Record<ProblemKind, string>>;
    see?: SeeRef[];
    snippet?: string;

    /** For a node produced by `deref`: the definition that was referenced. */
    refTarget?: SchemaNode;
}

export interface SchemeProblem {
    file: string;
    start: number;
    end: number;
    message: string;
}

export interface CompiledScheme {
    file: string;
    root: SchemaNode;
    definitions: Map<string, SchemaNode>;
    problems: SchemeProblem[];
}

let nextId = 1;

/** Compiles the effective tree of a scheme file into schema nodes. Never throws. */
export function compileScheme(root: ENode, file: string): CompiledScheme {
    const scheme: CompiledScheme = {
        file,
        root: undefined as unknown as SchemaNode,
        definitions: new Map(),
        problems: [],
    };
    const refs: { node: SchemaNode; v: ENode }[] = [];

    const str = (n: ENode): string | undefined => (n.kind === 'scalar' && typeof n.value === 'string' ? n.value : undefined);
    const num = (n: ENode): number | undefined => (n.kind === 'scalar' && typeof n.value === 'number' ? n.value : undefined);
    const bool = (n: ENode): boolean | undefined => (n.kind === 'scalar' && typeof n.value === 'boolean' ? n.value : undefined);

    const compile = (e: ENode, key?: EEntry): SchemaNode => {
        const node: SchemaNode = { id: nextId++, scheme, file: e.file, start: e.start, end: e.end };
        if (key) {
            node.keyFile = key.file;
            node.keyStart = key.start;
            node.keyEnd = key.end;
            node.name = key.key;
        }
        if (e.kind === 'scalar') {
            // shorthand: `port: integer`
            const t = normalizeType(e.value);
            if (t) {
                node.types = [t];
            }
            return node;
        }
        if (e.kind !== 'map') {
            return node;
        }
        for (const entry of e.entries) {
            const v = entry.value;
            switch (entry.key) {
                case 'type': {
                    const raw = v.kind === 'seq' ? v.items.map((i) => (i.kind === 'scalar' ? i.value : undefined)) : [v.kind === 'scalar' ? v.value : undefined];
                    const types = raw.map(normalizeType).filter((t): t is TypeName => !!t);
                    if (types.length) {
                        node.types = types;
                    }
                    break;
                }
                case 'title':
                    node.title = str(v);
                    break;
                case 'description':
                    node.description = str(v);
                    break;
                case 'message':
                    node.message = str(v);
                    break;
                case 'snippet':
                    node.snippet = str(v);
                    break;
                case 'ref':
                    node.ref = str(v);
                    if (node.ref !== undefined) {
                        refs.push({ node, v });
                    }
                    break;
                case 'required':
                    node.required = bool(v);
                    break;
                case 'uniqueItems':
                    node.uniqueItems = bool(v);
                    break;
                case 'default':
                    node.hasDefault = true;
                    node.default = toJs(v);
                    break;
                case 'enum':
                    if (v.kind === 'seq') {
                        node.enum = v.items.filter((i) => i.kind === 'scalar').map((i) => (i as { value: Scalar }).value);
                    }
                    break;
                case 'examples':
                    if (v.kind === 'seq') {
                        node.examples = v.items.map(toJs);
                    }
                    break;
                case 'pattern': {
                    const p = str(v);
                    if (p !== undefined) {
                        try {
                            node.pattern = new RegExp(p, 'u');
                        } catch (err) {
                            scheme.problems.push({ file: v.file, start: v.start, end: v.end, message: `Invalid regular expression: ${(err as Error).message}` });
                        }
                    }
                    break;
                }
                case 'min':
                case 'max':
                case 'minLength':
                case 'maxLength':
                case 'minItems':
                case 'maxItems':
                    node[entry.key] = num(v);
                    break;
                case 'properties':
                    if (v.kind === 'map') {
                        node.properties = new Map();
                        for (const p of v.entries) {
                            node.properties.set(p.key, compile(p.value, p));
                        }
                    }
                    break;
                case 'additionalProperties': {
                    const b = bool(v);
                    node.additionalProperties = b !== undefined ? b : compile(v);
                    break;
                }
                case 'items':
                    node.items = compile(v);
                    break;
                case 'anyOf':
                    if (v.kind === 'seq') {
                        node.anyOf = v.items.map((i) => compile(i));
                    }
                    break;
                case 'deprecated':
                    node.deprecated = bool(v) ?? str(v);
                    break;
                case 'severity':
                    if (v.kind === 'map') {
                        node.severity = toJs(v) as Partial<Record<ProblemKind, Severity>>;
                    } else {
                        node.severity = str(v) as Severity | undefined;
                    }
                    break;
                case 'messages':
                    if (v.kind === 'map') {
                        node.messages = {};
                        for (const m of v.entries) {
                            const s = str(m.value);
                            if (s !== undefined) {
                                node.messages[m.key as ProblemKind] = s;
                            }
                        }
                    }
                    break;
                case 'see':
                    node.see = compileSee(v);
                    break;
                case 'definitions':
                    if (v.kind === 'map') {
                        for (const d of v.entries) {
                            scheme.definitions.set(d.key, compile(d.value, d));
                        }
                    }
                    break;
            }
        }
        if (!node.types) {
            if (node.properties || typeof node.additionalProperties === 'object') {
                node.types = ['map'];
            } else if (node.items) {
                node.types = ['list'];
            }
        }
        return node;
    };

    scheme.root = compile(root);
    for (const { node, v } of refs) {
        if (!scheme.definitions.has(node.ref!)) {
            const known = [...scheme.definitions.keys()];
            scheme.problems.push({
                file: v.file,
                start: v.start,
                end: v.end,
                message: `Unknown definition '${node.ref}'.` + (known.length ? ` Known definitions: ${known.join(', ')}` : ' No definitions are declared.'),
            });
        }
    }
    return scheme;
}

function compileSee(v: ENode): SeeRef[] {
    const items = v.kind === 'seq' ? v.items : [v];
    const out: SeeRef[] = [];
    for (const it of items) {
        const dir = path.dirname(it.file);
        if (it.kind === 'scalar' && typeof it.value === 'string') {
            const m = /^(.*?)(?:#L(\d+)|:(\d+))?$/.exec(it.value.trim())!;
            const line = Number(m[2] ?? m[3] ?? 0);
            out.push({ file: path.resolve(dir, m[1]), line, label: it.value });
        } else if (it.kind === 'map') {
            const o = toJs(it as EMap) as { file?: unknown; line?: unknown; label?: unknown };
            if (typeof o.file === 'string') {
                const line = typeof o.line === 'number' ? o.line : 0;
                out.push({
                    file: path.resolve(dir, o.file),
                    line,
                    label: typeof o.label === 'string' ? o.label : `${o.file}${line ? ':' + line : ''}`,
                });
            }
        }
    }
    return out;
}

const OVERRIDABLE: (keyof SchemaNode)[] = [
    'file',
    'start',
    'end',
    'keyFile',
    'keyStart',
    'keyEnd',
    'name',
    'title',
    'description',
    'required',
    'hasDefault',
    'default',
    'deprecated',
    'severity',
    'message',
    'messages',
    'see',
    'snippet',
    'examples',
];

const derefCache = new WeakMap<SchemaNode, SchemaNode>();

/**
 * Follows `ref` chains. The result combines the referenced definition with
 * annotations (description, required, messages, ...) given next to the `ref`.
 */
export function deref(node: SchemaNode): SchemaNode {
    if (!node.ref) {
        return node;
    }
    const cached = derefCache.get(node);
    if (cached) {
        return cached;
    }
    const seen = new Set<SchemaNode>();
    let target = node;
    while (target.ref && !seen.has(target)) {
        seen.add(target);
        const t = target.scheme.definitions.get(target.ref);
        if (!t) {
            break;
        }
        target = t;
    }
    const merged: SchemaNode = { ...target, ref: undefined, refTarget: target === node ? undefined : target };
    for (const k of OVERRIDABLE) {
        if (node[k] !== undefined) {
            (merged as unknown as Record<string, unknown>)[k] = node[k];
        }
    }
    derefCache.set(node, merged);
    return merged;
}

/** Expands `ref` and `anyOf` into the list of concrete alternatives. */
export function expand(node: SchemaNode, depth = 0): SchemaNode[] {
    const d = deref(node);
    if (d.anyOf && depth < 16) {
        return d.anyOf.flatMap((a) => expand(a, depth + 1));
    }
    return [d];
}

export function effectiveTypes(node: SchemaNode): TypeName[] {
    return node.types && node.types.length ? node.types : ['any'];
}

/** Short human readable description of a schema node's type. */
export function describeType(node: SchemaNode, depth = 0): string {
    const d = deref(node);
    if (depth > 3) {
        return effectiveTypes(d).join(' | ');
    }
    if (d.anyOf) {
        return [...new Set(d.anyOf.map((a) => describeType(a, depth + 1)))].join(' | ');
    }
    if (d.enum) {
        const shown = d.enum.slice(0, 6).map((e) => JSON.stringify(e));
        return shown.join(' | ') + (d.enum.length > 6 ? ' | …' : '');
    }
    return effectiveTypes(d)
        .map((t) => (t === 'list' && d.items ? `list of ${describeType(d.items, depth + 1)}` : t))
        .join(' | ');
}
