import * as path from 'path';
import { LineIndex } from './lineIndex';
import { fileKey, isSchemeFile, resolveIncludePath } from './paths';
import { ProblemKind, RelatedInfo, Severity } from './types';
import { Scalar, ScalarType, YDocument, YNode, YScalar } from './yaml';

/** A parsed file as seen by the engine. */
export interface ParsedFile {
    file: string;
    text: string;
    lines: LineIndex;
    yaml: YDocument;
}

export interface DocProvider {
    get(file: string): ParsedFile | undefined;
    exists(file: string): boolean;
}

/** One `extends` hop: the location of the include in `file` that pulled in `target`. */
export interface IncludeStep {
    file: string;
    start: number;
    end: number;
    target: string;
}

interface EBase {
    file: string;
    start: number;
    end: number;
    /** Chain of includes through which this node was reached from the root file. */
    via: IncludeStep[];
    /** Files whose root node was included (mounted) at this node. */
    mounted?: string[];
}

export interface EScalar extends EBase {
    kind: 'scalar';
    value: Scalar;
    type: ScalarType;
}

export interface ESeq extends EBase {
    kind: 'seq';
    items: ENode[];
}

export interface EEntry {
    key: string;
    file: string;
    start: number;
    end: number;
    value: ENode;
}

export interface EMap extends EBase {
    kind: 'map';
    entries: EEntry[];
}

/** A node of the effective tree, i.e. after all includes, merges and aliases are resolved. */
export type ENode = EScalar | ESeq | EMap;

export interface IncludeSite {
    /** File containing the include. */
    file: string;
    start: number;
    end: number;
    raw: string;
    target: string;
    exists: boolean;
    /** File keys of the target and everything it includes. */
    closure: Set<string>;
}

export type ReportFn = (
    file: string,
    start: number,
    end: number,
    severity: Severity,
    kind: ProblemKind,
    message: string,
    related?: RelatedInfo[],
) => void;

/** Tag form of the include keyword: `key: !extends file.yml`. */
export function includeTag(keyword: string): string {
    return `!${keyword}`;
}

/** Finds include sites in a single parsed document (no recursion), used for links and hover. */
export function findIncludeSites(
    doc: YDocument,
    file: string,
    keyword: string,
    exists: (f: string) => boolean,
): { start: number; end: number; raw: string; target: string; keyStart?: number }[] {
    const out: { start: number; end: number; raw: string; target: string; keyStart?: number }[] = [];
    if (isSchemeFile(file)) {
        // scheme files are JSON Schema documents: they reference each other with $ref
        return out;
    }
    const addPaths = (n: YNode, keyStart?: number) => {
        const items = n.kind === 'seq' ? n.items : [n];
        for (const it of items) {
            if (it.kind === 'scalar' && typeof it.value === 'string' && it.value.trim()) {
                out.push({
                    start: it.start,
                    end: it.end,
                    raw: it.value,
                    target: resolveIncludePath(it.value, file, exists),
                    keyStart,
                });
            }
        }
    };
    const walk = (n: YNode | undefined) => {
        if (!n) {
            return;
        }
        if (n.tag === includeTag(keyword)) {
            addPaths(n);
            return;
        }
        if (n.kind === 'map') {
            for (const p of n.pairs) {
                if (p.key.value === keyword && p.key.style === 'plain') {
                    addPaths(p.value, p.key.start);
                } else {
                    walk(p.value);
                }
            }
        } else if (n.kind === 'seq') {
            n.items.forEach((i) => walk(i));
        }
    };
    walk(doc.root);
    return out;
}

/**
 * Builds the effective tree of a file. `extends` keys (or `!extends` tags) are
 * replaced by the content of the referenced files, recursively. Problems
 * (syntax errors, missing files, cycles) are passed to `report`.
 */
export class Resolver {
    readonly sites: IncludeSite[] = [];
    /** File keys of every file that was read or attempted (dependencies). */
    readonly files = new Set<string>();
    /** Actual paths of the files in visiting order. */
    readonly visited: string[] = [];

    constructor(
        private readonly docs: DocProvider,
        private readonly keyword: string,
        private readonly report: ReportFn,
    ) {}

    buildFile(file: string, stack: string[] = [], via: IncludeStep[] = []): ENode | undefined {
        this.touch(file);
        const doc = this.docs.get(file);
        if (!doc) {
            return undefined;
        }
        for (const e of doc.yaml.errors) {
            this.report(file, e.start, e.end, e.severity, 'syntax', e.message);
        }
        const nextStack = [...stack, fileKey(file)];
        if (!doc.yaml.root) {
            return { kind: 'map', entries: [], file, start: 0, end: 0, via };
        }
        return this.conv(doc.yaml.root, file, nextStack, via, true, 0);
    }

    private touch(file: string): void {
        const k = fileKey(file);
        if (!this.files.has(k)) {
            this.files.add(k);
            this.visited.push(file);
        }
    }

    private conv(node: YNode, file: string, stack: string[], via: IncludeStep[], rootLevel: boolean, depth: number): ENode {
        if (node.kind === 'alias') {
            if (!node.target || depth > 64) {
                return { kind: 'scalar', value: null, type: 'null', file, start: node.start, end: node.end, via };
            }
            return this.conv(node.target, file, stack, via, false, depth + 1);
        }
        const scheme = isSchemeFile(file);
        if (node.tag === includeTag(this.keyword) && !scheme) {
            return this.includeValue(node, file, stack, via);
        }
        if (node.kind === 'scalar') {
            return { kind: 'scalar', value: node.value, type: node.type, file, start: node.start, end: node.end, via };
        }
        if (node.kind === 'seq') {
            return {
                kind: 'seq',
                items: node.items.map((i) => this.conv(i, file, stack, via, false, depth)),
                file,
                start: node.start,
                end: node.end,
                via,
            };
        }
        const locals: EEntry[] = [];
        const bases: EMap[] = [];
        for (const pair of node.pairs) {
            const key = pair.key.value === null ? '' : String(pair.key.value);
            if (key === this.keyword && pair.key.style === 'plain' && !scheme) {
                bases.push(...this.includeMaps(pair.value, pair.key, file, stack, via));
                continue;
            }
            if (key === '<<' && pair.key.style === 'plain') {
                const sources = pair.value.kind === 'seq' ? [...pair.value.items].reverse() : [pair.value];
                for (const src of sources) {
                    const e = this.conv(src, file, stack, via, false, depth);
                    if (e.kind === 'map') {
                        bases.push(e);
                    } else {
                        this.report(file, src.start, src.end, 'error', 'syntax', "The merge key '<<' expects a mapping or an alias of a mapping");
                    }
                }
                continue;
            }
            locals.push({
                key,
                file,
                start: pair.key.start,
                end: pair.key.end,
                value: this.conv(pair.value, file, stack, via, false, depth),
            });
        }
        let entries: EEntry[] = [];
        const mounted: string[] = [];
        for (const b of bases) {
            entries = mergeEntries(entries, b.entries);
            mounted.push(...(b.mounted ?? []));
        }
        entries = mergeEntries(entries, locals);
        return {
            kind: 'map',
            entries,
            file,
            start: node.start,
            end: node.end,
            via,
            mounted: mounted.length ? mounted : undefined,
        };
    }

    /** Value of an `extends` key: one path or a list of paths, each must contain a mapping. */
    private includeMaps(value: YNode, keyNode: YScalar, file: string, stack: string[], via: IncludeStep[]): EMap[] {
        const out: EMap[] = [];
        const paths: YScalar[] = [];
        if (value.kind === 'scalar' && typeof value.value === 'string') {
            paths.push(value);
        } else if (value.kind === 'seq') {
            for (const it of value.items) {
                if (it.kind === 'scalar' && typeof it.value === 'string') {
                    paths.push(it);
                } else {
                    this.report(file, it.start, it.end, 'error', 'include', 'Expected a file path');
                }
            }
        } else {
            const s = value.start === value.end ? keyNode.start : value.start;
            const e = value.start === value.end ? keyNode.end : value.end;
            this.report(file, s, e, 'error', 'include', `'${this.keyword}' expects a file path or a list of file paths`);
        }
        for (const p of paths) {
            const child = this.include(p, file, stack, via);
            if (!child) {
                continue;
            }
            if (child.kind !== 'map') {
                this.report(
                    file,
                    p.start,
                    p.end,
                    'error',
                    'include',
                    `Included file '${p.value}' must contain a mapping to be merged here (found a ${child.kind === 'seq' ? 'list' : 'scalar'})`,
                );
                continue;
            }
            out.push(child);
        }
        return out;
    }

    /** `!extends path` (value replaced by the file content) or `!extends [a, b]` (merged mappings). */
    private includeValue(node: YNode, file: string, stack: string[], via: IncludeStep[]): ENode {
        const empty: EScalar = { kind: 'scalar', value: null, type: 'null', file, start: node.start, end: node.end, via };
        if (node.kind === 'scalar' && typeof node.value === 'string') {
            return this.include(node, file, stack, via) ?? empty;
        }
        if (node.kind === 'seq') {
            const maps = this.includeMaps(node, node as unknown as YScalar, file, stack, via);
            let entries: EEntry[] = [];
            const mounted: string[] = [];
            for (const m of maps) {
                entries = mergeEntries(entries, m.entries);
                mounted.push(...(m.mounted ?? []));
            }
            return { kind: 'map', entries, file, start: node.start, end: node.end, via, mounted };
        }
        this.report(file, node.start, node.end, 'error', 'include', `'${includeTag(this.keyword)}' expects a file path or a list of file paths`);
        return empty;
    }

    private include(pathNode: YScalar, file: string, stack: string[], via: IncludeStep[]): ENode | undefined {
        const raw = String(pathNode.value);
        if (!raw.trim()) {
            this.report(file, pathNode.start, pathNode.end, 'error', 'include', 'Empty include path');
            return undefined;
        }
        const target = resolveIncludePath(raw, file, (f) => this.docs.exists(f));
        const exists = this.docs.exists(target);
        const site: IncludeSite = {
            file,
            start: pathNode.start,
            end: pathNode.end,
            raw,
            target,
            exists,
            closure: new Set([fileKey(target)]),
        };
        this.sites.push(site);
        this.touch(target);
        if (!exists) {
            this.report(file, pathNode.start, pathNode.end, 'error', 'include', `Cannot find included file '${raw}' (resolved to ${target})`);
            return undefined;
        }
        const tk = fileKey(target);
        const idx = stack.indexOf(tk);
        if (idx >= 0) {
            const chain = [...via.slice(Math.max(0, via.length - (stack.length - idx - 1))).map((s) => s.file), file, target];
            const related: RelatedInfo[] = [];
            for (const step of via.slice(Math.max(0, via.length - (stack.length - idx - 1)))) {
                const d = this.docs.get(step.file);
                if (d) {
                    related.push({
                        location: { file: step.file, range: d.lines.range(step.start, step.end) },
                        message: `includes ${path.basename(step.target)}`,
                    });
                }
            }
            this.report(
                file,
                pathNode.start,
                pathNode.end,
                'error',
                'include',
                `Circular include: ${chain.map((f) => path.basename(f)).join(' → ')}`,
                related,
            );
            return undefined;
        }
        if (via.length >= 64) {
            this.report(file, pathNode.start, pathNode.end, 'error', 'include', 'Includes are nested too deeply (more than 64 levels)');
            return undefined;
        }
        const before = this.visited.length;
        const child = this.buildFile(target, stack, [...via, { file, start: pathNode.start, end: pathNode.end, target }]);
        for (const f of this.visited.slice(before)) {
            site.closure.add(fileKey(f));
        }
        if (child) {
            child.mounted = [...(child.mounted ?? []), target];
        }
        return child;
    }
}

/** Deep merge of mapping entries: entries in `over` win, nested mappings are merged. */
export function mergeEntries(base: EEntry[], over: EEntry[]): EEntry[] {
    const out = base.slice();
    const idx = new Map(out.map((e, i) => [e.key, i]));
    for (const e of over) {
        const i = idx.get(e.key);
        if (i === undefined) {
            idx.set(e.key, out.length);
            out.push(e);
            continue;
        }
        const prev = out[i];
        if (prev.value.kind === 'map' && e.value.kind === 'map') {
            const mounted = [...(prev.value.mounted ?? []), ...(e.value.mounted ?? [])];
            out[i] = {
                ...e,
                value: {
                    ...e.value,
                    entries: mergeEntries(prev.value.entries, e.value.entries),
                    mounted: mounted.length ? mounted : undefined,
                },
            };
        } else {
            out[i] = e;
        }
    }
    return out;
}

/** Converts an effective node to a plain JavaScript value. */
export function toJs(n: ENode): unknown {
    if (n.kind === 'scalar') {
        return n.value;
    }
    if (n.kind === 'seq') {
        return n.items.map(toJs);
    }
    const o: Record<string, unknown> = {};
    for (const e of n.entries) {
        o[e.key] = toJs(e.value);
    }
    return o;
}
