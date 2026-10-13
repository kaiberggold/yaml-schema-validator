import { isIP } from 'net';
import * as path from 'path';
import { DocProvider, EEntry, EMap, ENode, EScalar, ESeq, toJs } from './effective';
import { META_FILE } from './meta';
import { fileKey } from './paths';
import { SchemaNode, TypeName, deref, describeType, likelyTypes } from './scheme';
import { Location, Problem, ProblemKind, RelatedInfo, Severity } from './types';

/** Records which schema node applies to a key or value range (used for hover). */
export interface Annotation {
    start: number;
    end: number;
    kind: 'key' | 'value';
    schema: SchemaNode;
    key?: string;
    path: string;
    /** For keys: listed in the `required` of the enclosing object. */
    required?: boolean;
}

export interface ValidatorOptions {
    unknownKeySeverity: Severity | 'ignore';
    /**
     * Files that are validated by a scheme of their own. Content coming from
     * them (through `extends`) is only checked against that scheme: here it
     * merely counts as present for `required`.
     */
    hasOwnScheme?: (file: string) => boolean;
}

const DEFAULT_MESSAGES: Record<ProblemKind, string> = {
    syntax: '${message}',
    include: '${message}',
    scheme: '${message}',
    type: "'${key}' must be ${expected}, found ${actual}",
    required: "Missing required key '${key}'",
    additionalProperties: "Unknown key '${key}'.${hint}",
    additionalItems: "'${key}' allows at most ${count} item(s)",
    enum: "'${value}' is not allowed for '${key}'.${hint} Allowed values: ${allowed}",
    const: "'${key}' must be ${const}, found ${value}",
    pattern: "'${value}' does not match the pattern ${pattern} required for '${key}'",
    format: "'${value}' is not a valid ${format} ('${key}')",
    minimum: "'${key}' must be at least ${minimum}, found ${value}",
    maximum: "'${key}' must be at most ${maximum}, found ${value}",
    exclusiveMinimum: "'${key}' must be greater than ${exclusiveMinimum}, found ${value}",
    exclusiveMaximum: "'${key}' must be less than ${exclusiveMaximum}, found ${value}",
    multipleOf: "'${key}' must be a multiple of ${multipleOf}, found ${value}",
    minLength: "'${key}' must have at least ${minLength} characters",
    maxLength: "'${key}' must have at most ${maxLength} characters",
    minItems: "'${key}' must have at least ${minItems} item(s), found ${count}",
    maxItems: "'${key}' must have at most ${maxItems} item(s), found ${count}",
    uniqueItems: "Duplicate item ${value} in '${key}'",
    contains: "'${key}' must contain at least one item of the form ${expected}",
    minProperties: "'${key}' must have at least ${minProperties} key(s), found ${count}",
    maxProperties: "'${key}' must have at most ${maxProperties} key(s), found ${count}",
    propertyNames: "Key '${value}' is not allowed in '${key}'${detail}",
    dependencies: "'${dependency}' requires '${missing}' to be present",
    anyOf: "'${key}' does not match any of the allowed forms: ${expected}",
    oneOf: "'${key}' must match exactly one of: ${expected}${detail}",
    not: "'${key}' must not be ${expected}",
    false: "'${key}' is not allowed here",
    deprecated: "'${key}' is deprecated${reason}",
};

const DEFAULT_SEVERITY: Partial<Record<ProblemKind, Severity>> = {
    deprecated: 'warning',
};

const FORMATS: Record<string, (s: string) => boolean> = {
    'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
    date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
    time: (s) => /^([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(s),
    email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    hostname: (s) => /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s),
    ipv4: (s) => isIP(s) === 4,
    ipv6: (s) => isIP(s) === 6,
    uri: (s) => /^[a-z][a-z0-9+.-]*:[^\s]*$/i.test(s),
    'uri-reference': (s) => !/\s/.test(s),
    'json-pointer': (s) => /^(\/([^~/]|~[01])*)*$/.test(s),
    regex: (s) => {
        try {
            new RegExp(s, 'u');
            return true;
        } catch {
            return false;
        }
    },
};

export function formatTemplate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\$\{(\w+)\}/g, (m, name: string) => (name in vars && vars[name] !== undefined ? String(vars[name]) : m));
}

interface Ctx {
    path: string;
    key: string;
    entry?: EEntry;
}

type At = { file: string; start: number; end: number };

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
    private anchor(node: ENode, entry?: EEntry): At {
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

    private ruleLocation(schema: SchemaNode): Location | undefined {
        return schema.keyFile !== undefined
            ? this.loc(schema.keyFile, schema.keyStart!, schema.keyEnd!)
            : this.loc(schema.file, schema.start, Math.min(schema.end, schema.start + 1));
    }

    /**
     * Reports a problem. Message and severity come from `schema` (`errorMessage`,
     * `x-severity`); `rule` is the scheme location linked from the problem.
     */
    private report(
        kind: ProblemKind,
        schema: SchemaNode,
        at: At,
        vars: Record<string, unknown>,
        node?: ENode,
        defaultSeverity?: Severity,
        ruleNode: SchemaNode = schema,
    ): void {
        const sev = typeof schema.severity === 'string' ? schema.severity : schema.severity?.[kind];
        const severity = sev ?? defaultSeverity ?? DEFAULT_SEVERITY[kind] ?? 'error';
        if (this.dry) {
            this.problems.push({ file: at.file, range: zeroRange(), severity, message: '', kind, related: [] });
            return;
        }
        const d = this.docs.get(at.file);
        const range = d ? d.lines.range(at.start, at.end) : zeroRange();
        const rule = this.ruleLocation(ruleNode);
        const allVars: Record<string, unknown> = {
            file: path.basename(at.file),
            line: range.start.line + 1,
            scheme: path.basename(schema.scheme.file),
            ruleLine: rule ? rule.range.start.line + 1 : undefined,
            title: schema.title,
            description: schema.description,
            minimum: schema.minimum,
            maximum: schema.maximum,
            exclusiveMinimum: schema.exclusiveMinimum,
            exclusiveMaximum: schema.exclusiveMaximum,
            multipleOf: schema.multipleOf,
            minLength: schema.minLength,
            maxLength: schema.maxLength,
            minItems: schema.minItems,
            maxItems: schema.maxItems,
            minProperties: schema.minProperties,
            maxProperties: schema.maxProperties,
            pattern: schema.pattern ? `/${schema.pattern.source}/` : undefined,
            format: schema.format,
            allowed: schema.enum?.map(fmt).join(', '),
            const: schema.hasConst ? fmt(schema.const) : undefined,
            default: schema.hasDefault ? fmt(schema.default) : undefined,
            ...vars,
        };
        const template = schema.errorMessages?.[kind] ?? schema.errorMessage ?? DEFAULT_MESSAGES[kind];
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

    /** Validates without reporting; true when no errors would be reported. */
    private passes(node: ENode, schema: SchemaNode, ctx: Ctx): boolean {
        const saved = this.problems;
        this.problems = [];
        this.dry++;
        try {
            this.validate(node, schema, ctx);
            return !this.problems.some((p) => p.severity === 'error');
        } finally {
            this.dry--;
            this.problems = saved;
        }
    }

    // ----------------------------------------------------------- validation

    private ownedElsewhere(file: string): boolean {
        return !!this.options.hasOwnScheme?.(file);
    }

    private validate(node: ENode, raw: SchemaNode, ctx: Ctx): void {
        const s = deref(raw);
        if (!this.dry) {
            for (const f of node.mounted ?? []) {
                const k = fileKey(f);
                if (!this.mounts.has(k)) {
                    this.mounts.set(k, raw);
                }
            }
        }
        if (this.ownedElsewhere(node.file)) {
            // e.g. `key: !extends part.yml` where part.yml has its own scheme
            return;
        }
        this.annotate(node.file, { start: node.start, end: node.end, kind: 'value', schema: s, key: ctx.key, path: ctx.path });
        if (s.bool === true) {
            return;
        }
        const base = { key: ctx.key, path: ctx.path, value: valueText(node), actual: describeValue(node) };
        if (s.bool === false) {
            this.report('false', s, this.anchor(node, ctx.entry), base, node);
            return;
        }
        if ((s.deprecated || s.deprecationMessage) && ctx.entry) {
            const reason = s.deprecationMessage ? `: ${s.deprecationMessage}` : '';
            this.report('deprecated', s, ctx.entry, { ...base, reason }, node);
        }
        const at = this.anchor(node, ctx.entry);
        if (s.types && !accepts(s.types, node)) {
            this.report('type', s, at, { ...base, expected: s.types.join(' or ') }, node);
            return;
        }
        if (s.enum || s.hasConst) {
            const v = toJs(node);
            if (s.enum && !s.enum.some((e) => deepEqual(e, v))) {
                const close = typeof v === 'string' ? closest(v, s.enum.filter((e): e is string => typeof e === 'string')) : undefined;
                this.report('enum', s, at, { ...base, hint: close ? ` Did you mean '${close}'?` : '' }, node);
            }
            if (s.hasConst && !deepEqual(s.const, v)) {
                this.report('const', s, at, base, node);
            }
        }
        if (node.kind === 'scalar') {
            const v = node.value;
            if (typeof v === 'string') {
                const len = [...v].length;
                if (s.minLength !== undefined && len < s.minLength) {
                    this.report('minLength', s, at, { ...base, length: len }, node);
                }
                if (s.maxLength !== undefined && len > s.maxLength) {
                    this.report('maxLength', s, at, { ...base, length: len }, node);
                }
                if (s.pattern && !s.pattern.test(v)) {
                    this.report('pattern', s, at, base, node);
                }
                const check = s.format ? FORMATS[s.format] : undefined;
                if (check && !check(v)) {
                    this.report('format', s, at, base, node);
                }
            } else if (typeof v === 'number') {
                if (s.multipleOf !== undefined && s.multipleOf > 0) {
                    const q = v / s.multipleOf;
                    if (Math.abs(q - Math.round(q)) > 1e-9) {
                        this.report('multipleOf', s, at, base, node);
                    }
                }
                if (s.minimum !== undefined && v < s.minimum) {
                    this.report('minimum', s, at, base, node);
                }
                if (s.maximum !== undefined && v > s.maximum) {
                    this.report('maximum', s, at, base, node);
                }
                if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) {
                    this.report('exclusiveMinimum', s, at, base, node);
                }
                if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) {
                    this.report('exclusiveMaximum', s, at, base, node);
                }
            }
        } else if (node.kind === 'seq') {
            this.validateArray(node, s, ctx);
        } else {
            this.validateObject(node, s, ctx);
        }
        for (const part of s.allOf ?? []) {
            this.validate(node, part, ctx);
        }
        if (s.anyOf?.length) {
            this.validateAlternatives('anyOf', s.anyOf, node, s, ctx);
        }
        if (s.oneOf?.length) {
            this.validateAlternatives('oneOf', s.oneOf, node, s, ctx);
        }
        if (s.not && this.passes(node, s.not, ctx)) {
            this.report('not', s, at, { ...base, expected: describeType(s.not) }, node);
        }
        if (s.if) {
            const branch = this.passes(node, s.if, ctx) ? s.then : s.else;
            if (branch) {
                this.validate(node, branch, ctx);
            }
        }
    }

    private validateArray(node: ESeq, s: SchemaNode, ctx: Ctx): void {
        const count = node.items.length;
        const at = this.anchor(node, ctx.entry);
        const v = { key: ctx.key, path: ctx.path, count, value: valueText(node), actual: 'an array' };
        if (s.minItems !== undefined && count < s.minItems) {
            this.report('minItems', s, at, v, node);
        }
        if (s.maxItems !== undefined && count > s.maxItems) {
            this.report('maxItems', s, at, v, node);
        }
        if (s.uniqueItems) {
            const seen: unknown[] = [];
            for (const item of node.items) {
                const js = toJs(item);
                if (seen.some((x) => deepEqual(x, js))) {
                    this.report('uniqueItems', s, this.anchor(item), { ...v, value: valueText(item) }, item);
                }
                seen.push(js);
            }
        }
        const itemCtx = (i: number): Ctx => ({ path: `${ctx.path}[${i}]`, key: `${ctx.key}[${i}]` });
        if (Array.isArray(s.items)) {
            const tuple = s.items;
            node.items.forEach((item, i) => {
                if (i < tuple.length) {
                    this.validate(item, tuple[i], itemCtx(i));
                } else if (s.additionalItems) {
                    if (deref(s.additionalItems).bool === false) {
                        if (i === tuple.length) {
                            this.report('additionalItems', s, this.anchor(item), { ...v, count: tuple.length }, item);
                        }
                    } else {
                        this.validate(item, s.additionalItems, itemCtx(i));
                    }
                }
            });
        } else if (s.items) {
            node.items.forEach((item, i) => this.validate(item, s.items as SchemaNode, itemCtx(i)));
        }
        if (s.contains && !node.items.some((item, i) => this.passes(item, s.contains!, itemCtx(i)))) {
            this.report('contains', s, at, { ...v, expected: describeType(s.contains) }, node);
        }
    }

    private validateObject(node: EMap, s: SchemaNode, ctx: Ctx): void {
        const present = new Set(node.entries.map((e) => e.key));
        const required = new Set(s.required ?? []);
        for (const entry of node.entries) {
            if (this.ownedElsewhere(entry.file)) {
                // merged in from a file with its own scheme: validated there
                continue;
            }
            const childPath = ctx.path ? `${ctx.path}.${entry.key}` : entry.key;
            if (s.propertyNames) {
                const keyNode: EScalar = { kind: 'scalar', value: entry.key, type: 'str', file: entry.file, start: entry.start, end: entry.end, via: entry.value.via };
                if (!this.passes(keyNode, s.propertyNames, { path: childPath, key: entry.key })) {
                    const pn = deref(s.propertyNames);
                    const detail = pn.pattern ? ` (keys must match /${pn.pattern.source}/)` : pn.enum ? ` (allowed: ${pn.enum.map(fmt).join(', ')})` : '';
                    this.report('propertyNames', s, entry, { key: ctx.key, path: childPath, value: entry.key, detail }, entry.value);
                }
            }
            const targets: SchemaNode[] = [];
            const prop = s.properties?.get(entry.key);
            if (prop) {
                targets.push(prop);
            }
            for (const pp of s.patternProperties ?? []) {
                if (pp.re.test(entry.key)) {
                    targets.push(pp.node);
                }
            }
            if (!targets.length && s.additionalProperties) {
                const ap = deref(s.additionalProperties);
                if (ap.bool === false) {
                    const sev = typeof s.severity === 'string' ? s.severity : s.severity?.additionalProperties;
                    if (sev || this.options.unknownKeySeverity !== 'ignore') {
                        const names = [...(s.properties?.keys() ?? [])];
                        const close = closest(entry.key, names);
                        const patterns = (s.patternProperties ?? []).map((p) => `/${p.source}/`);
                        const allowed = [...names, ...patterns].join(', ');
                        const hint = close ? ` Did you mean '${close}'?` : allowed ? ` Allowed keys: ${allowed}` : '';
                        const defaultSev = this.options.unknownKeySeverity === 'ignore' ? undefined : this.options.unknownKeySeverity;
                        this.report(
                            'additionalProperties',
                            s,
                            entry,
                            { key: entry.key, path: childPath, allowed, hint, value: valueText(entry.value), parent: ctx.key },
                            entry.value,
                            defaultSev,
                        );
                    }
                    continue;
                }
                if (ap.bool !== true) {
                    targets.push(s.additionalProperties);
                }
            }
            if (targets.length) {
                this.annotate(entry.file, {
                    start: entry.start,
                    end: entry.end,
                    kind: 'key',
                    schema: deref(targets[0]),
                    key: entry.key,
                    path: childPath,
                    required: required.has(entry.key),
                });
            }
            for (const t of targets) {
                this.validate(entry.value, t, { path: childPath, key: entry.key, entry });
            }
        }
        const at = this.anchor(node, ctx.entry);
        for (const name of required) {
            if (present.has(name)) {
                continue;
            }
            // a message / severity for `required` may be given on the property itself
            const prop = s.properties?.get(name);
            const d = prop ? deref(prop) : undefined;
            const source = d && (d.errorMessages?.required || (typeof d.severity === 'object' && d.severity.required)) ? d : s;
            this.report(
                'required',
                source,
                at,
                { key: name, path: ctx.path ? `${ctx.path}.${name}` : name, parent: ctx.key, description: d?.description },
                node,
                undefined,
                d ?? s,
            );
        }
        const count = node.entries.length;
        const v = { key: ctx.key, path: ctx.path, count, value: valueText(node), actual: 'an object' };
        if (s.minProperties !== undefined && count < s.minProperties) {
            this.report('minProperties', s, at, v, node);
        }
        if (s.maxProperties !== undefined && count > s.maxProperties) {
            this.report('maxProperties', s, at, v, node);
        }
        for (const [dependency, dep] of s.dependencies ?? []) {
            if (!present.has(dependency)) {
                continue;
            }
            if (Array.isArray(dep)) {
                const missing = dep.filter((d) => !present.has(d));
                if (missing.length) {
                    const e = node.entries.find((x) => x.key === dependency);
                    this.report('dependencies', s, e ?? at, { ...v, dependency, missing: missing.join("', '") }, node);
                }
            } else {
                this.validate(node, dep, ctx);
            }
        }
    }

    private validateAlternatives(kind: 'anyOf' | 'oneOf', alts: SchemaNode[], node: ENode, s: SchemaNode, ctx: Ctx): void {
        const passing = alts.map((a, i) => (this.passes(node, a, ctx) ? i : -1)).filter((i) => i >= 0);
        if (passing.length && (kind === 'anyOf' || passing.length === 1)) {
            this.validate(node, alts[passing[0]], ctx); // for annotations and warnings
            return;
        }
        const vars = { key: ctx.key, path: ctx.path, expected: alts.map((a) => describeType(a)).join(' | '), actual: describeValue(node), value: valueText(node) };
        const at = this.anchor(node, ctx.entry);
        if (passing.length > 1) {
            this.report('oneOf', s, at, { ...vars, detail: ` (it matches ${passing.length} of them)` }, node);
            return;
        }
        // nothing matches: if only one alternative is plausible, show its specific problems
        const plausible = alts.map((a, i) => (isPlausible(a, node) ? i : -1)).filter((i) => i >= 0);
        if (plausible.length === 1) {
            this.validate(node, alts[plausible[0]], ctx);
            return;
        }
        this.report(kind, s, at, { ...vars, detail: '' }, node);
    }
}

function zeroRange() {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

/** JSON type of a YAML value (integers are numbers without fraction, as in JSON Schema). */
export function typeOf(node: ENode): TypeName {
    if (node.kind === 'map') {
        return 'object';
    }
    if (node.kind === 'seq') {
        return 'array';
    }
    const v = node.value;
    if (v === null) {
        return 'null';
    }
    if (typeof v === 'boolean') {
        return 'boolean';
    }
    if (typeof v === 'number') {
        return Number.isInteger(v) ? 'integer' : 'number';
    }
    return 'string';
}

function accepts(types: TypeName[], node: ENode): boolean {
    const actual = typeOf(node);
    return types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

/** Whether an alternative of anyOf / oneOf is meant for this kind of value. */
function isPlausible(alt: SchemaNode, node: ENode): boolean {
    const d = deref(alt);
    if (d.anyOf || d.oneOf || d.bool !== undefined) {
        return false;
    }
    const types = likelyTypes(d);
    if (!types.length) {
        return true;
    }
    return accepts(types, node) && !((d.enum || d.hasConst) && node.kind !== 'scalar');
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a === 'number' && typeof b === 'number') {
        return Number.isNaN(a) && Number.isNaN(b);
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a)) {
        const bb = b as unknown[];
        return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
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
        return t === 'object' ? 'an object' : t === 'array' ? 'an array' : 'an empty value';
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
