/**
 * Compiles scheme files into schema nodes. Scheme files are JSON Schema
 * (draft-07) documents written in YAML. Besides the standard keywords a few
 * extensions are understood that other JSON Schema tools simply ignore:
 * `x-errorMessages`, `x-severity`, `x-see`, and the keywords also known to
 * VS Code / Red Hat YAML: `errorMessage`, `patternErrorMessage`,
 * `markdownDescription`, `deprecationMessage` and `defaultSnippets`.
 */
import * as path from 'path';
import { EEntry, ENode, toJs } from './effective';
import { fileKey } from './paths';
import { ProblemKind, Severity } from './types';

export type TypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export const TYPE_NAMES: TypeName[] = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

export function normalizeType(v: unknown): TypeName | undefined {
    if (v === null) {
        return 'null';
    }
    return typeof v === 'string' && (TYPE_NAMES as string[]).includes(v) ? (v as TypeName) : undefined;
}

export interface SeeRef {
    file: string;
    /** 1-based line, 0 = no specific line. */
    line: number;
    label: string;
}

export interface Snippet {
    label?: string;
    description?: string;
    body?: unknown;
    bodyText?: string;
}

export interface PatternProperty {
    source: string;
    re: RegExp;
    node: SchemaNode;
}

export interface SchemaNode {
    id: number;
    scheme: CompiledScheme;
    /** Location of the node definition. */
    file: string;
    start: number;
    end: number;
    /** Location of the property key in the scheme (for named properties / definitions). */
    keyFile?: string;
    keyStart?: number;
    keyEnd?: number;
    name?: string;

    /** Boolean schema: `true` accepts everything, `false` nothing. */
    bool?: boolean;

    types?: TypeName[];
    title?: string;
    description?: string;
    markdownDescription?: string;
    hasDefault?: boolean;
    default?: unknown;
    examples?: unknown[];
    enum?: unknown[];
    hasConst?: boolean;
    const?: unknown;

    multipleOf?: number;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;

    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    format?: string;

    /** Schemas for the first items (`prefixItems`, or a draft-07 `items` list). */
    prefixItems?: SchemaNode[];
    /** Schema for the items after `prefixItems` (`items`, or draft-07 `additionalItems` after an `items` list). */
    items?: SchemaNode;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    contains?: SchemaNode;
    minContains?: number;
    maxContains?: number;
    unevaluatedItems?: SchemaNode;

    properties?: Map<string, SchemaNode>;
    patternProperties?: PatternProperty[];
    additionalProperties?: SchemaNode;
    required?: string[];
    minProperties?: number;
    maxProperties?: number;
    propertyNames?: SchemaNode;
    /** `dependentRequired` (and the list form of draft-07 `dependencies`). */
    dependentRequired?: Map<string, string[]>;
    /** `dependentSchemas` (and the schema form of draft-07 `dependencies`). */
    dependentSchemas?: Map<string, SchemaNode>;
    unevaluatedProperties?: SchemaNode;

    allOf?: SchemaNode[];
    anyOf?: SchemaNode[];
    oneOf?: SchemaNode[];
    not?: SchemaNode;
    if?: SchemaNode;
    then?: SchemaNode;
    else?: SchemaNode;

    /** `$ref` as written and the node it resolves to. */
    ref?: string;
    refTarget?: SchemaNode;

    deprecated?: boolean;
    deprecationMessage?: string;
    severity?: Severity | Partial<Record<ProblemKind, Severity>>;
    errorMessage?: string;
    errorMessages?: Partial<Record<ProblemKind, string>>;
    see?: SeeRef[];
    snippets?: Snippet[];
}

export interface SchemeProblem {
    file: string;
    start: number;
    end: number;
    message: string;
}

/** JSON Schema version of a scheme, from its `$schema` (default: the latest, 2020-12). */
export type Dialect = 'draft-07' | '2019-09' | '2020-12';

export function dialectOf(schemaUri: unknown): Dialect {
    if (typeof schemaUri !== 'string') {
        return '2020-12';
    }
    if (/draft-0[3-7]\b/.test(schemaUri)) {
        return 'draft-07';
    }
    return /2019-09/.test(schemaUri) ? '2019-09' : '2020-12';
}

/** Keywords that only annotate; `$ref` next to other keywords is evaluated alongside them since 2019-09. */
const ANNOTATION_KEYWORDS = new Set([
    '$schema',
    '$id',
    '$anchor',
    '$dynamicAnchor',
    '$recursiveAnchor',
    '$comment',
    '$defs',
    'definitions',
    'title',
    'description',
    'markdownDescription',
    'default',
    'examples',
    'readOnly',
    'writeOnly',
    'deprecated',
    'deprecationMessage',
    'errorMessage',
    'patternErrorMessage',
    'defaultSnippets',
]);

export interface CompiledScheme {
    file: string;
    dialect: Dialect;
    root: SchemaNode;
    /** Entries of `$defs` / `definitions` (for navigation). */
    definitions: Map<string, SchemaNode>;
    problems: SchemeProblem[];
    /** File keys of other scheme files referenced with `$ref` (transitively). */
    deps: Set<string>;
    /** Schema node at a JSON pointer (`/$defs/x`) or `$anchor` name of this document. */
    nodeAt(pointer: string): SchemaNode | undefined;
}

/** Loads (compiles) another scheme file for a cross-file `$ref`. */
export type SchemeLoader = (file: string) => CompiledScheme | undefined;

let nextId = 1;

/**
 * Compiles the effective tree of a scheme file into schema nodes. Never throws.
 * `register` is called before references are resolved, so that a loader cache
 * can hand out this scheme for cyclic cross-file references.
 */
export function compileScheme(root: ENode, file: string, loader?: SchemeLoader, register?: (s: CompiledScheme) => void): CompiledScheme {
    const cache = new Map<ENode, SchemaNode>();
    const refs: { node: SchemaNode; v: ENode }[] = [];
    const anchors = new Map<string, ENode>();
    const schemaUri = root.kind === 'map' ? root.entries.find((e) => e.key === '$schema')?.value : undefined;
    const scheme: CompiledScheme = {
        file,
        dialect: dialectOf(schemaUri?.kind === 'scalar' ? schemaUri.value : undefined),
        root: undefined as unknown as SchemaNode,
        definitions: new Map(),
        problems: [],
        deps: new Set(),
        nodeAt: (pointer) => {
            const e = pointer && !pointer.startsWith('/') ? anchors.get(decodeURIComponent(pointer)) : resolvePointer(root, pointer);
            if (!e) {
                return undefined;
            }
            const n = compile(e);
            resolvePending();
            return n;
        },
    };

    const str = (n: ENode): string | undefined => (n.kind === 'scalar' && typeof n.value === 'string' ? n.value : undefined);
    const num = (n: ENode): number | undefined => (n.kind === 'scalar' && typeof n.value === 'number' ? n.value : undefined);
    const bool = (n: ENode): boolean | undefined => (n.kind === 'scalar' && typeof n.value === 'boolean' ? n.value : undefined);
    const regex = (src: string, at: ENode): RegExp | undefined => {
        try {
            return new RegExp(src, 'u');
        } catch (err) {
            scheme.problems.push({ file: at.file, start: at.start, end: at.end, message: `Invalid regular expression: ${(err as Error).message}` });
            return undefined;
        }
    };
    const list = (n: ENode): SchemaNode[] | undefined => (n.kind === 'seq' ? n.items.map((i) => compile(i)) : undefined);

    function compile(e: ENode, key?: EEntry): SchemaNode {
        const cached = cache.get(e);
        if (cached) {
            return cached;
        }
        const node: SchemaNode = { id: nextId++, scheme, file: e.file, start: e.start, end: e.end };
        cache.set(e, node);
        if (key) {
            node.keyFile = key.file;
            node.keyStart = key.start;
            node.keyEnd = key.end;
            node.name = key.key;
        }
        if (e.kind !== 'map') {
            // boolean schema (anything else is reported by the meta scheme and accepts all)
            node.bool = e.kind === 'scalar' && e.value === false ? false : true;
            return node;
        }
        let refValue: ENode | undefined;
        let legacyTuple: SchemaNode[] | undefined;
        let additionalItems: SchemaNode | undefined;
        let constraints = false;
        for (const entry of e.entries) {
            const v = entry.value;
            if (!ANNOTATION_KEYWORDS.has(entry.key) && !entry.key.startsWith('x-') && !entry.key.startsWith('$')) {
                constraints = true;
            }
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
                case 'description':
                case 'markdownDescription':
                case 'format':
                case 'deprecationMessage':
                    node[entry.key] = str(v);
                    break;
                case '$ref':
                case '$dynamicRef': // resolved statically, like $ref
                case '$recursiveRef':
                    if (str(v) !== undefined) {
                        refValue = v;
                    }
                    break;
                case '$anchor':
                case '$dynamicAnchor': {
                    const a = str(v);
                    if (a !== undefined && !anchors.has(a)) {
                        anchors.set(a, e);
                    }
                    break;
                }
                case 'uniqueItems':
                case 'deprecated':
                    node[entry.key] = bool(v);
                    break;
                case 'default':
                    node.hasDefault = true;
                    node.default = toJs(v);
                    break;
                case 'const':
                    node.hasConst = true;
                    node.const = toJs(v);
                    break;
                case 'enum':
                    if (v.kind === 'seq') {
                        node.enum = v.items.map(toJs);
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
                        node.pattern = regex(p, v);
                    }
                    break;
                }
                case 'multipleOf':
                case 'minimum':
                case 'maximum':
                case 'exclusiveMinimum':
                case 'exclusiveMaximum':
                case 'minLength':
                case 'maxLength':
                case 'minItems':
                case 'maxItems':
                case 'minContains':
                case 'maxContains':
                case 'minProperties':
                case 'maxProperties':
                    node[entry.key] = num(v);
                    break;
                case 'required':
                    if (v.kind === 'seq') {
                        node.required = v.items.map((i) => (i.kind === 'scalar' ? String(i.value) : '')).filter((x) => x);
                    }
                    break;
                case 'properties':
                    if (v.kind === 'map') {
                        node.properties = new Map();
                        for (const p of v.entries) {
                            node.properties.set(p.key, compile(p.value, p));
                        }
                    }
                    break;
                case 'patternProperties':
                    if (v.kind === 'map') {
                        node.patternProperties = [];
                        for (const p of v.entries) {
                            const re = regex(p.key, v);
                            if (re) {
                                node.patternProperties.push({ source: p.key, re, node: compile(p.value, p) });
                            }
                        }
                    }
                    break;
                case 'dependencies':
                case 'dependentRequired':
                case 'dependentSchemas':
                    if (v.kind === 'map') {
                        for (const d of v.entries) {
                            if (d.value.kind === 'seq') {
                                node.dependentRequired ??= new Map();
                                node.dependentRequired.set(
                                    d.key,
                                    d.value.items.map((i) => String(i.kind === 'scalar' ? i.value : '')),
                                );
                            } else {
                                node.dependentSchemas ??= new Map();
                                node.dependentSchemas.set(d.key, compile(d.value, d));
                            }
                        }
                    }
                    break;
                case 'items':
                    if (v.kind === 'seq') {
                        legacyTuple = list(v); // draft-07 tuple form
                    } else {
                        node.items = compile(v);
                    }
                    break;
                case 'prefixItems':
                    node.prefixItems = list(v);
                    break;
                case 'additionalItems':
                    additionalItems = compile(v);
                    break;
                case 'unevaluatedItems':
                case 'unevaluatedProperties':
                case 'additionalProperties':
                case 'contains':
                case 'propertyNames':
                case 'not':
                case 'if':
                case 'then':
                case 'else':
                    node[entry.key] = compile(v);
                    break;
                case 'allOf':
                case 'anyOf':
                case 'oneOf':
                    node[entry.key] = list(v);
                    break;
                case '$defs':
                case 'definitions':
                    if (v.kind === 'map') {
                        for (const d of v.entries) {
                            const def = compile(d.value, d);
                            if (e === root) {
                                scheme.definitions.set(d.key, def);
                            }
                        }
                    }
                    break;
                case 'x-severity':
                    node.severity = v.kind === 'map' ? (toJs(v) as Partial<Record<ProblemKind, Severity>>) : (str(v) as Severity | undefined);
                    break;
                case 'errorMessage':
                    node.errorMessage = str(v);
                    break;
                case 'patternErrorMessage': {
                    const s = str(v);
                    if (s !== undefined) {
                        node.errorMessages = { pattern: s, ...node.errorMessages };
                    }
                    break;
                }
                case 'x-errorMessages':
                    if (v.kind === 'map') {
                        node.errorMessages = { ...node.errorMessages };
                        for (const m of v.entries) {
                            const s = str(m.value);
                            if (s !== undefined) {
                                node.errorMessages[m.key as ProblemKind] = s;
                            }
                        }
                    }
                    break;
                case 'x-see':
                    node.see = compileSee(v);
                    break;
                case 'defaultSnippets':
                    if (v.kind === 'seq') {
                        node.snippets = v.items.filter((i) => i.kind === 'map').map((i) => toJs(i) as Snippet);
                    }
                    break;
            }
        }
        if (legacyTuple) {
            // draft-07: `items: [a, b]` + `additionalItems` = 2020-12 `prefixItems` + `items`
            node.prefixItems ??= legacyTuple;
            node.items = additionalItems;
        }
        if (refValue) {
            const ref = str(refValue)!;
            if (constraints && scheme.dialect !== 'draft-07') {
                // since 2019-09 $ref is applied together with the other keywords
                const refNode: SchemaNode = { id: nextId++, scheme, file: refValue.file, start: refValue.start, end: refValue.end, ref };
                node.allOf = [...(node.allOf ?? []), refNode];
                refs.push({ node: refNode, v: refValue });
            } else {
                // draft-07: siblings of $ref only annotate
                node.ref = ref;
                refs.push({ node, v: refValue });
            }
        }
        return node;
    }

    // resolves references; may compile further nodes (also when called later through nodeAt)
    let resolved = 0;
    function resolvePending(): void {
        while (resolved < refs.length) {
            const { node, v } = refs[resolved++];
            const target = resolveRef(node.ref!, scheme, loader);
            if (target) {
                node.refTarget = target;
            } else {
                scheme.problems.push({ file: v.file, start: v.start, end: v.end, message: `Cannot resolve $ref '${node.ref}'` });
            }
        }
    }

    register?.(scheme);
    scheme.root = compile(root);
    resolvePending();
    return scheme;
}

/** Resolves `#`, `#/json/pointer`, `other.schema.yml` and `other.schema.yml#/pointer`. */
function resolveRef(ref: string, scheme: CompiledScheme, loader?: SchemeLoader): SchemaNode | undefined {
    const hash = ref.indexOf('#');
    const filePart = hash >= 0 ? ref.slice(0, hash) : ref;
    const pointer = hash >= 0 ? ref.slice(hash + 1) : '';
    let target = scheme;
    if (filePart) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePart) || !loader) {
            return undefined; // remote references are not supported
        }
        const file = path.resolve(path.dirname(scheme.file), decodeURIComponent(filePart));
        if (fileKey(file) !== fileKey(scheme.file)) {
            const other = loader(file);
            if (!other) {
                return undefined;
            }
            scheme.deps.add(fileKey(other.file));
            other.deps.forEach((d) => scheme.deps.add(d));
            target = other;
        }
    }
    return target.nodeAt(pointer);
}

function resolvePointer(root: ENode, pointer: string): ENode | undefined {
    if (pointer === '' || pointer === '/') {
        return root;
    }
    if (!pointer.startsWith('/')) {
        return undefined;
    }
    let cur: ENode | undefined = root;
    for (const raw of pointer.slice(1).split('/')) {
        const seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
        if (!cur) {
            return undefined;
        }
        if (cur.kind === 'map') {
            cur = cur.entries.find((e) => e.key === seg)?.value;
        } else if (cur.kind === 'seq' && /^\d+$/.test(seg)) {
            cur = cur.items[Number(seg)];
        } else {
            return undefined;
        }
    }
    return cur;
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
            const o = toJs(it) as { file?: unknown; line?: unknown; label?: unknown };
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

/**
 * Keywords that are taken from the node containing `$ref` (in draft-07 these
 * siblings do not affect validation; they only annotate).
 */
const ANNOTATIONS: (keyof SchemaNode)[] = [
    'file',
    'start',
    'end',
    'keyFile',
    'keyStart',
    'keyEnd',
    'name',
    'title',
    'description',
    'markdownDescription',
    'hasDefault',
    'default',
    'examples',
    'deprecated',
    'deprecationMessage',
    'severity',
    'errorMessage',
    'errorMessages',
    'see',
    'snippets',
];

const derefCache = new WeakMap<SchemaNode, SchemaNode>();

/** Follows `$ref` chains, keeping annotations written next to the `$ref`. */
export function deref(node: SchemaNode): SchemaNode {
    if (!node.refTarget) {
        return node;
    }
    const cached = derefCache.get(node);
    if (cached) {
        return cached;
    }
    const seen = new Set<SchemaNode>();
    let target = node;
    while (target.refTarget && !seen.has(target)) {
        seen.add(target);
        target = target.refTarget;
    }
    const merged: SchemaNode = { ...target, ref: undefined, refTarget: target === node ? undefined : target };
    for (const k of ANNOTATIONS) {
        if (node[k] !== undefined) {
            (merged as unknown as Record<string, unknown>)[k] = node[k];
        }
    }
    derefCache.set(node, merged);
    return merged;
}

/**
 * Alternatives / parts of a node for editor assistance: `$ref` is followed,
 * `anyOf` / `oneOf` give alternatives, `allOf` and `if`/`then`/`else` add parts.
 */
export function expand(node: SchemaNode, depth = 0): SchemaNode[] {
    const d = deref(node);
    if (depth > 16) {
        return [d];
    }
    const alts = d.anyOf ?? d.oneOf;
    if (alts) {
        return alts.flatMap((a) => expand(a, depth + 1));
    }
    const parts = [d];
    for (const p of [...(d.allOf ?? []), ...(d.then ? [d.then] : []), ...(d.else ? [d.else] : [])]) {
        parts.push(...expand(p, depth + 1));
    }
    return parts;
}

/** Type names the node accepts, inferred from its keywords when `type` is missing (for display / completion). */
export function likelyTypes(node: SchemaNode): TypeName[] {
    const d = deref(node);
    if (d.types) {
        return d.types;
    }
    if (d.properties || d.patternProperties || d.required || (d.additionalProperties && !d.additionalProperties.bool)) {
        return ['object'];
    }
    if (d.items || d.prefixItems || d.contains) {
        return ['array'];
    }
    const values = d.enum ?? (d.hasConst ? [d.const] : undefined);
    if (values) {
        return [...new Set(values.map(jsonType))];
    }
    return [];
}

export function jsonType(v: unknown): TypeName {
    if (v === null || v === undefined) {
        return 'null';
    }
    if (Array.isArray(v)) {
        return 'array';
    }
    if (typeof v === 'number') {
        return Number.isInteger(v) ? 'integer' : 'number';
    }
    if (typeof v === 'object') {
        return 'object';
    }
    return typeof v === 'boolean' ? 'boolean' : 'string';
}

/** Short human readable description of a schema node's type. */
export function describeType(node: SchemaNode, depth = 0): string {
    const d = deref(node);
    if (d.bool === false) {
        return 'never';
    }
    const alts = d.anyOf ?? d.oneOf;
    if (alts && depth <= 3) {
        return [...new Set(alts.map((a) => describeType(a, depth + 1)))].join(' | ');
    }
    if (d.hasConst) {
        return JSON.stringify(d.const);
    }
    if (d.enum) {
        const shown = d.enum.slice(0, 6).map((e) => JSON.stringify(e));
        return shown.join(' | ') + (d.enum.length > 6 ? ' | …' : '');
    }
    const types = likelyTypes(d);
    if (!types.length) {
        return 'any';
    }
    return types
        .map((t) => (t === 'array' && d.items && depth <= 3 ? `array of ${describeType(d.items, depth + 1)}` : t))
        .join(' | ');
}
