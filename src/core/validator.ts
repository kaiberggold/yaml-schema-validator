import * as path from 'path';
import { DocProvider, EEntry, EMap, ENode, ESeq, toJs } from './effective';
import { META_FILE } from './meta';
import { fileKey } from './paths';
import { SchemaNode, TypeName, deref, describeType, effectiveTypes } from './scheme';
import { Location, Problem, ProblemKind, RelatedInfo, Severity } from './types';

/** Records which schema node applies to a key or value range (used for hover). */
export interface Annotation {
    start: number;
    end: number;
    kind: 'key' | 'value';
    schema: SchemaNode;
    key?: string;
    path: string;
}

export interface ValidatorOptions {
    unknownKeySeverity: Severity | 'ignore';
}

const DEFAULT_MESSAGES: Record<ProblemKind, string> = {
    syntax: '${message}',
    include: '${message}',
    scheme: '${message}',
    type: "'${key}' must be ${expected}, found ${actual}",
    required: "Missing required key '${key}'",
    unknownKey: "Unknown key '${key}'.${hint}",
    enum: "'${value}' is not allowed for '${key}'.${hint} Allowed values: ${allowed}",
    pattern: "'${value}' does not match the pattern ${pattern} required for '${key}'",
    min: "'${key}' must be at least ${min}, found ${value}",
    max: "'${key}' must be at most ${max}, found ${value}",
    minLength: "'${key}' must have at least ${minLength} characters",
    maxLength: "'${key}' must have at most ${maxLength} characters",
    minItems: "'${key}' must have at least ${minItems} item(s), found ${count}",
    maxItems: "'${key}' must have at most ${maxItems} item(s), found ${count}",
    uniqueItems: "Duplicate item ${value} in '${key}'",
    anyOf: "'${key}' does not match any of the allowed forms: ${expected}",
    deprecated: "'${key}' is deprecated${reason}",
};

const DEFAULT_SEVERITY: Partial<Record<ProblemKind, Severity>> = {
    deprecated: 'warning',
};

export function formatTemplate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\$\{(\w+)\}/g, (m, name: string) => (name in vars && vars[name] !== undefined ? String(vars[name]) : m));
}

interface Ctx {
    path: string;
    key: string;
    entry?: EEntry;
}

export class Validator {
    problems: Problem[] = [];
    readonly annotations = new Map<string, Annotation[]>();
    /** Schema node at the point where an included file was mounted (file key -> node). */
    readonly mounts = new Map<string, SchemaNode>();
    private dry = 0;

    constructor(
        private readonly docs: DocProvider,
        private readonly options: ValidatorOptions,
    ) {}

    validateRoot(node: ENode, schema: SchemaNode): void {
        this.validate(node, schema, { path: '', key: '<root>' });
    }

    // ------------------------------------------------------------ utilities

    private loc(file: string, start: number, end: number): Location | undefined {
        if (fileKey(file) === fileKey(META_FILE)) {
            return undefined;
        }
        const d = this.docs.get(file);
        return d ? { file, range: d.lines.range(start, end) } : undefined;
    }

    private annotate(file: string, a: Annotation): void {
        if (this.dry) {
            return;
        }
        const k = fileKey(file);
        let list = this.annotations.get(k);
        if (!list) {
            this.annotations.set(k, (list = []));
        }
        list.push(a);
    }

    /** Range used to report a problem about `node` (keeps squiggles short for collections). */
    private anchor(node: ENode, entry?: EEntry): { file: string; start: number; end: number } {
        if (node.kind === 'scalar' && node.end > node.start) {
            return { file: node.file, start: node.start, end: node.end };
        }
        if (entry) {
            return { file: entry.file, start: entry.start, end: entry.end };
        }
        const d = this.docs.get(node.file);
        let end = node.end;
        if (d) {
            const line = d.lines.positionAt(node.start).line;
            end = Math.min(end, d.lines.lineEnd(line));
        }
        return { file: node.file, start: node.start, end: Math.max(end, node.start) };
    }

    private report(
        kind: ProblemKind,
        schema: SchemaNode,
        at: { file: string; start: number; end: number },
        vars: Record<string, unknown>,
        node?: ENode,
        defaultSeverity?: Severity,
    ): void {
        const sev = typeof schema.severity === 'string' ? schema.severity : schema.severity?.[kind];
        const severity = sev ?? defaultSeverity ?? DEFAULT_SEVERITY[kind] ?? 'error';
        if (this.dry) {
            this.problems.push({ file: at.file, range: zeroRange(), severity, message: '', kind, related: [] });
            return;
        }
        const d = this.docs.get(at.file);
        const range = d ? d.lines.range(at.start, at.end) : zeroRange();
        const rule =
            schema.keyFile !== undefined
                ? this.loc(schema.keyFile, schema.keyStart!, schema.keyEnd!)
                : this.loc(schema.file, schema.start, Math.min(schema.end, schema.start + 1));
        const allVars: Record<string, unknown> = {
            file: path.basename(at.file),
            line: range.start.line + 1,
            scheme: path.basename(schema.scheme.file),
            ruleLine: rule ? rule.range.start.line + 1 : undefined,
            title: schema.title,
            description: schema.description,
            min: schema.min,
            max: schema.max,
            minLength: schema.minLength,
            maxLength: schema.maxLength,
            minItems: schema.minItems,
            maxItems: schema.maxItems,
            pattern: schema.pattern ? `/${schema.pattern.source}/` : undefined,
            allowed: schema.enum?.map(fmt).join(', '),
            default: schema.hasDefault ? fmt(schema.default) : undefined,
            ...vars,
        };
        const template = schema.messages?.[kind] ?? schema.message ?? DEFAULT_MESSAGES[kind];
        const message = formatTemplate(template, allVars);

        const related: RelatedInfo[] = [];
        if (rule) {
            related.push({ location: rule, message: `Rule in ${path.basename(rule.file)}:${rule.range.start.line + 1}` });
        }
        for (const s of schema.see ?? []) {
            const line = Math.max(0, s.line - 1);
            related.push({
                location: { file: s.file, range: { start: { line, character: 0 }, end: { line, character: 0 } } },
                message: s.label,
            });
        }
        for (const step of [...(node?.via ?? [])].reverse()) {
            const l = this.loc(step.file, step.start, step.end);
            if (l) {
                related.push({ location: l, message: `Included from ${path.basename(step.file)}:${l.range.start.line + 1}` });
            }
        }
        this.problems.push({
            file: at.file,
            range,
            severity,
            message,
            kind,
            rule,
            related,
            deprecated: kind === 'deprecated' || undefined,
        });
    }

    // ----------------------------------------------------------- validation

    private validate(node: ENode, raw: SchemaNode, ctx: Ctx): void {
        const s = deref(raw);
        if (!this.dry) {
            for (const f of node.mounted ?? []) {
                const k = fileKey(f);
                if (!this.mounts.has(k)) {
                    this.mounts.set(k, raw);
                }
            }
            this.annotate(node.file, { start: node.start, end: node.end, kind: 'value', schema: s, key: ctx.key, path: ctx.path });
        }
        if (s.deprecated !== undefined && s.deprecated !== false && ctx.entry) {
            const reason = typeof s.deprecated === 'string' ? `: ${s.deprecated}` : '';
            this.report('deprecated', s, ctx.entry, { key: ctx.key, path: ctx.path, reason }, node);
        }
        if (s.anyOf && s.anyOf.length) {
            this.validateAnyOf(node, s, ctx);
            return;
        }
        const types = effectiveTypes(s);
        const actual = typeOf(node);
        if (!accepts(types, actual)) {
            this.report(
                'type',
                s,
                this.anchor(node, ctx.entry),
                {
                    key: ctx.key,
                    path: ctx.path,
                    expected: types.join(' or '),
                    actual: describeValue(node),
                    value: valueText(node),
                },
                node,
            );
            return;
        }
        const vars = (extra: Record<string, unknown>) => ({ key: ctx.key, path: ctx.path, value: valueText(node), actual: describeValue(node), ...extra });
        if (node.kind === 'scalar') {
            const v = node.value;
            if (s.enum && !s.enum.some((e) => e === v || (Number.isNaN(e) && Number.isNaN(v)))) {
                const close = typeof v === 'string' ? closest(v, s.enum.filter((e): e is string => typeof e === 'string')) : undefined;
                const hint = close ? ` Did you mean '${close}'?` : '';
                this.report('enum', s, this.anchor(node, ctx.entry), vars({ allowed: s.enum.map(fmt).join(', '), hint }), node);
            }
            if (typeof v === 'string') {
                if (s.pattern && !s.pattern.test(v)) {
                    this.report('pattern', s, this.anchor(node, ctx.entry), vars({ pattern: `/${s.pattern.source}/` }), node);
                }
                const len = [...v].length;
                if (s.minLength !== undefined && len < s.minLength) {
                    this.report('minLength', s, this.anchor(node, ctx.entry), vars({ minLength: s.minLength, length: len }), node);
                }
                if (s.maxLength !== undefined && len > s.maxLength) {
                    this.report('maxLength', s, this.anchor(node, ctx.entry), vars({ maxLength: s.maxLength, length: len }), node);
                }
            }
            if (typeof v === 'number') {
                if (s.min !== undefined && v < s.min) {
                    this.report('min', s, this.anchor(node, ctx.entry), vars({ min: s.min }), node);
                }
                if (s.max !== undefined && v > s.max) {
                    this.report('max', s, this.anchor(node, ctx.entry), vars({ max: s.max }), node);
                }
            }
        } else if (s.enum) {
            this.report('enum', s, this.anchor(node, ctx.entry), vars({ allowed: s.enum.map(fmt).join(', '), hint: '' }), node);
        } else if (node.kind === 'seq') {
            this.validateSeq(node, s, ctx);
        } else {
            this.validateMap(node, s, ctx);
        }
    }

    private validateSeq(node: ESeq, s: SchemaNode, ctx: Ctx): void {
        const count = node.items.length;
        const at = this.anchor(node, ctx.entry);
        const v = { key: ctx.key, path: ctx.path, count, value: valueText(node), actual: 'list' };
        if (s.minItems !== undefined && count < s.minItems) {
            this.report('minItems', s, at, { ...v, minItems: s.minItems }, node);
        }
        if (s.maxItems !== undefined && count > s.maxItems) {
            this.report('maxItems', s, at, { ...v, maxItems: s.maxItems }, node);
        }
        if (s.uniqueItems) {
            const seen = new Set<string>();
            for (const item of node.items) {
                const k = JSON.stringify(toJs(item));
                if (seen.has(k)) {
                    this.report('uniqueItems', s, this.anchor(item), { ...v, value: valueText(item) }, item);
                }
                seen.add(k);
            }
        }
        if (s.items) {
            node.items.forEach((item, i) => {
                this.validate(item, s.items!, { path: `${ctx.path}[${i}]`, key: `${ctx.key}[${i}]` });
            });
        }
    }

    private validateMap(node: EMap, s: SchemaNode, ctx: Ctx): void {
        const props = s.properties;
        const present = new Set(node.entries.map((e) => e.key));
        for (const entry of node.entries) {
            const childPath = ctx.path ? `${ctx.path}.${entry.key}` : entry.key;
            let target = props?.get(entry.key);
            if (!target) {
                const ap = s.additionalProperties;
                if (ap && typeof ap === 'object') {
                    target = ap;
                } else if (ap === false || (ap === undefined && props)) {
                    if (this.options.unknownKeySeverity !== 'ignore') {
                        const names = props ? [...props.keys()] : [];
                        const close = closest(entry.key, names);
                        const hint = close ? ` Did you mean '${close}'?` : names.length ? ` Allowed keys: ${names.join(', ')}` : '';
                        this.report(
                            'unknownKey',
                            s,
                            entry,
                            { key: entry.key, path: childPath, allowed: names.join(', '), hint, value: valueText(entry.value) },
                            entry.value,
                            this.options.unknownKeySeverity,
                        );
                    }
                    continue;
                } else {
                    continue;
                }
            }
            this.annotate(entry.file, { start: entry.start, end: entry.end, kind: 'key', schema: deref(target), key: entry.key, path: childPath });
            this.validate(entry.value, target, { path: childPath, key: entry.key, entry });
        }
        if (props) {
            for (const [name, prop] of props) {
                if (!prop.required || present.has(name)) {
                    continue;
                }
                const d = deref(prop);
                this.report(
                    'required',
                    d,
                    this.anchor(node, ctx.entry),
                    { key: name, path: ctx.path ? `${ctx.path}.${name}` : name, parent: ctx.key, description: d.description },
                    node,
                );
            }
        }
    }

    private validateAnyOf(node: ENode, s: SchemaNode, ctx: Ctx): void {
        const alts = s.anyOf!;
        const saved = this.problems;
        const errorsPerAlt: number[] = [];
        this.dry++;
        for (const alt of alts) {
            this.problems = [];
            this.validate(node, alt, ctx);
            errorsPerAlt.push(this.problems.filter((p) => p.severity === 'error').length);
        }
        this.dry--;
        this.problems = saved;
        let best = errorsPerAlt.indexOf(0);
        if (best < 0) {
            const actual = typeOf(node);
            const compatible = (a: SchemaNode) => {
                const d = deref(a);
                return accepts(effectiveTypes(d), actual) && !d.anyOf && !(d.enum && node.kind !== 'scalar');
            };
            const typeMatches = alts.map((a, i) => (compatible(a) ? i : -1)).filter((i) => i >= 0);
            if (typeMatches.length === 1) {
                best = typeMatches[0];
            }
        }
        if (best >= 0) {
            this.validate(node, alts[best], ctx);
            return;
        }
        this.report(
            'anyOf',
            s,
            this.anchor(node, ctx.entry),
            { key: ctx.key, path: ctx.path, expected: describeType(s), actual: describeValue(node), value: valueText(node) },
            node,
        );
    }
}

function zeroRange() {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

type ActualType = 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'list' | 'map';

export function typeOf(node: ENode): ActualType {
    if (node.kind === 'map') {
        return 'map';
    }
    if (node.kind === 'seq') {
        return 'list';
    }
    switch (node.type) {
        case 'null':
            return 'null';
        case 'bool':
            return 'boolean';
        case 'int':
            return 'integer';
        case 'float':
            return 'number';
        default:
            return 'string';
    }
}

function accepts(types: TypeName[], actual: ActualType): boolean {
    return types.some((t) => t === 'any' || t === actual || (t === 'number' && actual === 'integer'));
}

function fmt(v: unknown): string {
    return typeof v === 'string' ? v : JSON.stringify(v);
}

function valueText(node: ENode): string {
    if (node.kind === 'scalar') {
        return node.value === null ? 'null' : String(node.value);
    }
    return node.kind === 'seq' ? '[...]' : '{...}';
}

function describeValue(node: ENode): string {
    const t = typeOf(node);
    if (node.kind !== 'scalar' || t === 'null') {
        return t === 'map' ? 'a mapping' : t === 'list' ? 'a list' : 'an empty value';
    }
    return `${t} '${valueText(node)}'`;
}

/** Closest candidate by edit distance (for "did you mean" hints). */
export function closest(word: string, candidates: string[]): string | undefined {
    const limit = word.length < 3 ? 0 : Math.max(1, Math.floor(word.length / 3));
    let best: string | undefined;
    let bestD = Infinity;
    for (const c of candidates) {
        const d = editDistance(word.toLowerCase(), c.toLowerCase());
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    return best !== undefined && bestD <= limit ? best : undefined;
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
function editDistance(a: string, b: string): number {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) {
        d[0][j] = j;
    }
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    return d[a.length][b.length];
}
