/**
 * Adapter around the `yaml` package. It converts the library's document model
 * into the small node model used by the rest of the extension, keeping source
 * offsets for every node. Only the first document of a stream is used.
 */
import { Alias, Document, Node as LibNode, Pair, Scalar as LibScalar, isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';

export type Scalar = string | number | boolean | null;
export type ScalarType = 'null' | 'bool' | 'int' | 'float' | 'str';

interface YBase {
    start: number;
    end: number;
    tag?: string;
    anchor?: string;
}

export interface YScalar extends YBase {
    kind: 'scalar';
    value: Scalar;
    type: ScalarType;
    style: 'plain' | 'single' | 'double' | 'literal' | 'folded';
}

export interface YPair {
    key: YScalar;
    value: YNode;
}

export interface YMap extends YBase {
    kind: 'map';
    pairs: YPair[];
}

export interface YSeq extends YBase {
    kind: 'seq';
    items: YNode[];
}

export interface YAlias extends YBase {
    kind: 'alias';
    name: string;
    target?: YNode;
}

export type YNode = YScalar | YMap | YSeq | YAlias;

export interface YError {
    start: number;
    end: number;
    message: string;
    severity: 'error' | 'warning';
    /** Error code of the `yaml` package, e.g. `DUPLICATE_KEY`. */
    code?: string;
}

export interface YDocument {
    root: YNode | undefined;
    errors: YError[];
}

const STYLES: Record<string, YScalar['style']> = {
    PLAIN: 'plain',
    QUOTE_SINGLE: 'single',
    QUOTE_DOUBLE: 'double',
    BLOCK_LITERAL: 'literal',
    BLOCK_FOLDED: 'folded',
};

export function parseYaml(text: string): YDocument {
    const docs = parseAllDocuments(text, { prettyErrors: false, uniqueKeys: true, merge: false, version: '1.2' });
    const errors: YError[] = [];
    if ('empty' in docs && docs.empty) {
        // an empty stream (only comments / whitespace) may still carry errors
        for (const e of docs.errors) {
            errors.push(toError(e, 'error'));
        }
        return { root: undefined, errors };
    }
    const list = docs as Document.Parsed[];
    const doc = list[0];
    if (!doc) {
        return { root: undefined, errors };
    }
    for (const e of doc.errors) {
        const err = toError(e, 'error');
        if (e.code === 'DUPLICATE_KEY') {
            const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^:#\n]*?))\s*:/.exec(text.slice(err.start));
            const key = m ? (m[1] ?? m[2]?.replace(/''/g, "'") ?? m[3]) : undefined;
            if (key !== undefined) {
                err.message = `Duplicate key '${key}'`;
            }
        }
        errors.push(err);
    }
    for (const w of doc.warnings) {
        // custom tags such as `!extends` are valid YAML; they are interpreted by the extension
        if (w.code !== 'TAG_RESOLVE_FAILED') {
            errors.push(toError(w, 'warning'));
        }
    }
    if (list.length > 1) {
        const r = list[1].range;
        errors.push({ start: r[0], end: Math.max(r[0] + 3, r[1]), message: 'Only the first YAML document is validated', severity: 'warning' });
    }
    const conv = new Converter(doc, text.length, errors);
    return { root: doc.contents ? conv.node(doc.contents as LibNode) : undefined, errors };
}

function toError(e: { pos: [number, number]; message: string; code: string }, severity: 'error' | 'warning'): YError {
    const [start, end] = e.pos;
    return { start, end: Math.max(end, start + 1), message: e.message, severity, code: e.code };
}

class Converter {
    private readonly anchors = new Map<LibNode, YNode>();

    constructor(
        private readonly doc: Document.Parsed,
        private readonly length: number,
        private readonly errors: YError[],
    ) {}

    private range(n: LibNode | null | undefined, fallback: number): [number, number] {
        const r = n?.range;
        return r ? [r[0], r[1]] : [fallback, fallback];
    }

    node(n: LibNode | null | undefined, fallback = 0): YNode {
        if (!n) {
            return { kind: 'scalar', value: null, type: 'null', style: 'plain', start: fallback, end: fallback };
        }
        const [start, end] = this.range(n, fallback);
        let out: YNode;
        if (isAlias(n)) {
            const target = (n as Alias).resolve(this.doc);
            if (!target) {
                this.errors.push({ start, end: Math.max(end, start + 1), message: `Unknown anchor '${(n as Alias).source}'`, severity: 'error' });
            }
            out = { kind: 'alias', name: (n as Alias).source, target: target ? this.anchors.get(target as LibNode) : undefined, start, end };
        } else if (isScalar(n)) {
            out = this.scalar(n, start, end);
        } else if (isMap(n)) {
            out = { kind: 'map', pairs: [], start, end };
            this.register(n, out);
            for (const item of n.items as Pair<LibNode | null, LibNode | null>[]) {
                const key = this.key(item.key, start);
                out.pairs.push({ key, value: this.node(item.value, key.end) });
            }
        } else if (isSeq(n)) {
            out = { kind: 'seq', items: [], start, end };
            this.register(n, out);
            for (const item of n.items as (LibNode | null)[]) {
                out.items.push(this.node(item, end));
            }
        } else {
            out = { kind: 'scalar', value: null, type: 'null', style: 'plain', start, end };
        }
        if (n.tag && !isAlias(n)) {
            out.tag = n.tag;
        }
        if (n.anchor) {
            out.anchor = n.anchor;
        }
        this.register(n, out);
        return out;
    }

    private register(n: LibNode, y: YNode): void {
        if (n.anchor) {
            this.anchors.set(n, y);
        }
    }

    private key(k: LibNode | null, fallback: number): YScalar {
        if (k && isScalar(k)) {
            const [s, e] = this.range(k, fallback);
            const y = this.scalar(k, s, e);
            // keys are matched as strings
            y.value = y.value === null ? '' : String(y.value);
            y.type = 'str';
            return y;
        }
        // complex keys (maps / lists as keys) are not supported; the validator sees an empty key
        const [s, e] = this.range(k, fallback);
        return { kind: 'scalar', value: '', type: 'str', style: 'plain', start: s, end: Math.min(e, this.length) };
    }

    private scalar(n: LibScalar, start: number, end: number): YScalar {
        const style = STYLES[n.type ?? 'PLAIN'] ?? 'plain';
        const v = n.value;
        let value: Scalar;
        let type: ScalarType;
        if (v === null || v === undefined) {
            value = null;
            type = 'null';
        } else if (typeof v === 'boolean') {
            value = v;
            type = 'bool';
        } else if (typeof v === 'number' || typeof v === 'bigint') {
            value = Number(v);
            const src = typeof n.source === 'string' ? n.source : String(v);
            type = /^[-+]?[0-9]+$|^0x[0-9a-fA-F]+$|^0o[0-7]+$/.test(src) ? 'int' : 'float';
        } else {
            value = String(v);
            type = 'str';
        }
        return { kind: 'scalar', value, type, style, start, end };
    }
}

/** Resolves a plain scalar according to the YAML 1.2 core schema (used to decide on quoting). */
export function resolvePlain(s: string): { value: Scalar; type: ScalarType } {
    if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') {
        return { value: null, type: 'null' };
    }
    if (s === 'true' || s === 'True' || s === 'TRUE') {
        return { value: true, type: 'bool' };
    }
    if (s === 'false' || s === 'False' || s === 'FALSE') {
        return { value: false, type: 'bool' };
    }
    if (/^[-+]?[0-9]+$|^0x[0-9a-fA-F]+$|^0o[0-7]+$/.test(s)) {
        return { value: Number(s), type: 'int' };
    }
    if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s) || /^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(s)) {
        return { value: Number(s.replace(/\.(inf|Inf|INF)$/, 'Infinity').replace(/^\.(nan|NaN|NAN)$/, 'NaN')), type: 'float' };
    }
    return { value: s, type: 'str' };
}
