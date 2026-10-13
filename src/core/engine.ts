import * as path from 'path';
import { DocProvider, ParsedFile, Resolver } from './effective';
import { LineIndex } from './lineIndex';
import { META_FILE, META_TEXT } from './meta';
import { DEFAULT_SCHEME_INFIX, fileKey, isSchemeFile, resolveIncludePath, schemeCandidates, schemeDeclaration, schemeInfix, setSchemeInfix } from './paths';
import { CompiledScheme, SchemaNode, compileScheme } from './scheme';
import { FileHost, Problem, ProblemKind, RelatedInfo, Severity, problemKey, severityRank } from './types';
import { Annotation, Validator } from './validator';
import { parseYaml } from './yaml';

export interface EngineOptions {
    extendKeyword: string;
    /** Middle part of scheme file names: `name.<schemeInfix>.yml`. */
    schemeInfix: string;
    unknownKeySeverity: Severity | 'ignore';
    includeSummary: boolean;
}

export const DEFAULT_OPTIONS: EngineOptions = {
    extendKeyword: 'extends',
    schemeInfix: DEFAULT_SCHEME_INFIX,
    unknownKeySeverity: 'warning',
    includeSummary: true,
};

export interface FileAnnotations {
    /** Text the annotations were computed for. */
    text: string;
    items: Annotation[];
}

export interface RootResult {
    root: string;
    /** Scheme file used to validate the root (META_FILE for scheme files), if any. */
    scheme?: string;
    /** Compiled scheme root used for the root file. */
    schema?: SchemaNode;
    problems: Problem[];
    /** File keys this result depends on (includes, schemes, missing files). */
    deps: Set<string>;
    annotations: Map<string, FileAnnotations>;
    /** Schema node applied at the mount point of included files (file key -> node). */
    mounts: Map<string, SchemaNode>;
}

/**
 * Validates "root" files: every YAML file that has a scheme (a sibling
 * `name.schema.yml` or one declared in its first line) and every scheme file.
 */
export class Engine {
    private readonly cache = new Map<string, ParsedFile>();
    private meta?: CompiledScheme;
    readonly docs: DocProvider;
    private opts!: EngineOptions;

    constructor(
        private readonly host: FileHost,
        options: EngineOptions = DEFAULT_OPTIONS,
    ) {
        this.docs = { get: (f) => this.getDoc(f), exists: (f) => this.exists(f) };
        this.options = options;
    }

    get options(): EngineOptions {
        return this.opts;
    }

    /** Scheme file naming is global (see paths.ts), so setting options also updates it. */
    set options(o: EngineOptions) {
        this.opts = { ...o, schemeInfix: setSchemeInfix(o.schemeInfix) };
    }

    exists(file: string): boolean {
        return fileKey(file) === fileKey(META_FILE) || this.host.exists(file);
    }

    getDoc(file: string): ParsedFile | undefined {
        const k = fileKey(file);
        const text = k === fileKey(META_FILE) ? META_TEXT : this.host.read(file);
        if (text === undefined) {
            this.cache.delete(k);
            return undefined;
        }
        const cached = this.cache.get(k);
        if (cached && cached.text === text) {
            return cached;
        }
        const parsed: ParsedFile = { file, text, lines: new LineIndex(text), yaml: parseYaml(text) };
        this.cache.set(k, parsed);
        return parsed;
    }

    /** Drops cached parse results of files that are no longer needed. */
    forget(file: string): void {
        this.cache.delete(fileKey(file));
    }

    /** Scheme declared in the first line (`# schema: path`), resolved relative to the file. */
    declaredScheme(file: string): { path: string; start: number; end: number; raw: string } | undefined {
        const text = this.host.read(file);
        const decl = text === undefined ? undefined : schemeDeclaration(text);
        if (!decl) {
            return undefined;
        }
        return { ...decl, path: resolveIncludePath(decl.raw, file, (f) => this.host.exists(f)) };
    }

    /**
     * Scheme that validates a file: the meta scheme for scheme files, otherwise a
     * scheme declared in the first line (even if missing, so that it is reported)
     * or the sibling `name.schema.yml`.
     */
    findScheme(file: string): string | undefined {
        if (isSchemeFile(file)) {
            return META_FILE;
        }
        const declared = this.declaredScheme(file);
        if (declared) {
            return declared.path;
        }
        return schemeCandidates(file).find((c) => this.host.exists(c));
    }

    metaScheme(): CompiledScheme {
        if (!this.meta) {
            const r = new Resolver(this.docs, '\0', () => undefined);
            const root = r.buildFile(META_FILE)!;
            this.meta = compileScheme(root, META_FILE);
        }
        return this.meta;
    }

    /** Compiles a scheme file on its own (used for navigation inside scheme files). */
    compileSchemeFile(file: string): CompiledScheme | undefined {
        const r = new Resolver(this.docs, this.options.extendKeyword, () => undefined);
        const root = r.buildFile(file);
        return root ? compileScheme(root, file) : undefined;
    }

    /** Validates the given root files. Results are keyed by file key. */
    run(roots: string[]): Map<string, RootResult> {
        const run = new Run(this);
        const out = new Map<string, RootResult>();
        for (const r of roots) {
            const res = run.validateRoot(r);
            if (res) {
                out.set(fileKey(r), res);
            }
        }
        return out;
    }
}

class Sink {
    readonly problems: Problem[] = [];
    constructor(private readonly docs: DocProvider) {}

    add(file: string, start: number, end: number, severity: Severity, kind: ProblemKind, message: string, related: RelatedInfo[] = []): void {
        const d = this.docs.get(file);
        const range = d ? d.lines.range(start, Math.max(end, start)) : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        this.problems.push({ file, range, severity, kind, message, related });
    }
}

class Run {
    private readonly results = new Map<string, RootResult>();
    private readonly inProgress = new Set<string>();
    private readonly schemes = new Map<string, { scheme: CompiledScheme; deps: Set<string> }>();

    constructor(private readonly engine: Engine) {}

    private compileSchemeFile(file: string): { scheme: CompiledScheme; deps: Set<string> } | undefined {
        const k = fileKey(file);
        let c = this.schemes.get(k);
        if (!c) {
            const r = new Resolver(this.engine.docs, this.engine.options.extendKeyword, () => undefined);
            const root = r.buildFile(file);
            if (!root) {
                return undefined;
            }
            c = { scheme: compileScheme(root, file), deps: r.files };
            this.schemes.set(k, c);
        }
        return c;
    }

    validateRoot(file: string): RootResult | undefined {
        const key = fileKey(file);
        const done = this.results.get(key);
        if (done) {
            return done;
        }
        if (this.inProgress.has(key)) {
            return undefined;
        }
        this.inProgress.add(key);
        try {
            const res = this.doValidate(file);
            this.results.set(key, res);
            return res;
        } finally {
            this.inProgress.delete(key);
        }
    }

    private doValidate(file: string): RootResult {
        const { docs, options } = this.engine;
        const sink = new Sink(docs);
        const res: RootResult = {
            root: file,
            problems: [],
            deps: new Set([fileKey(file)]),
            annotations: new Map(),
            mounts: new Map(),
        };
        const resolver = new Resolver(docs, options.extendKeyword, (f, s, e, sev, kind, msg, rel) => sink.add(f, s, e, sev, kind, msg, rel));
        const eroot = resolver.buildFile(file);
        resolver.files.forEach((f) => res.deps.add(f));
        // every visited config file depends on its (possibly not yet existing) scheme
        for (const f of resolver.visited) {
            if (!isSchemeFile(f)) {
                schemeCandidates(f).forEach((c) => res.deps.add(fileKey(c)));
                const declared = this.engine.declaredScheme(f);
                if (declared) {
                    res.deps.add(fileKey(declared.path));
                }
            }
        }
        if (!eroot) {
            res.problems = sink.problems;
            return res;
        }

        let schema: SchemaNode | undefined;
        if (isSchemeFile(file)) {
            res.scheme = META_FILE;
            schema = this.engine.metaScheme().root;
            const own = compileScheme(eroot, file);
            for (const p of own.problems) {
                sink.add(p.file, p.start, p.end, 'error', 'scheme', p.message);
            }
        } else {
            const declared = this.engine.declaredScheme(file);
            let schemeFile = this.engine.findScheme(file);
            if (declared) {
                if (fileKey(declared.path) === fileKey(file)) {
                    sink.add(file, declared.start, declared.end, 'error', 'scheme', 'A file cannot be its own scheme');
                    schemeFile = undefined;
                } else if (!this.engine.exists(declared.path)) {
                    sink.add(file, declared.start, declared.end, 'error', 'scheme', `Cannot find scheme file '${declared.raw}' (resolved to ${declared.path})`);
                    schemeFile = undefined;
                } else if (!isSchemeFile(declared.path)) {
                    sink.add(
                        file,
                        declared.start,
                        declared.end,
                        'warning',
                        'scheme',
                        `Name scheme files '*.${schemeInfix()}.yml' so that they are checked against the scheme definition themselves`,
                    );
                }
            }
            if (schemeFile) {
                const compiled = this.compileSchemeFile(schemeFile);
                if (compiled) {
                    res.scheme = schemeFile;
                    schema = compiled.scheme.root;
                    compiled.deps.forEach((d) => res.deps.add(d));
                    if (isSchemeFile(schemeFile)) {
                        this.reportBrokenScheme(file, schemeFile, sink);
                    }
                }
            }
        }
        res.schema = schema;

        if (schema) {
            const rootKey = fileKey(file);
            const owned = new Map<string, boolean>();
            const hasOwnScheme = (f: string) => {
                const k = fileKey(f);
                if (k === rootKey) {
                    return false;
                }
                let o = owned.get(k);
                if (o === undefined) {
                    const sf = isSchemeFile(f) ? undefined : this.engine.findScheme(f);
                    o = !!sf && this.engine.exists(sf);
                    owned.set(k, o);
                }
                return o;
            };
            const v = new Validator(docs, { unknownKeySeverity: options.unknownKeySeverity, hasOwnScheme });
            v.validateRoot(eroot, schema);
            res.problems.push(...v.problems);
            for (const [k, items] of v.annotations) {
                const d = docs.get(items.length ? annotationFile(resolver.visited, k) ?? file : file);
                if (d) {
                    res.annotations.set(k, { text: d.text, items });
                }
            }
            v.mounts.forEach((n, k) => res.mounts.set(k, n));
        }
        res.problems.push(...sink.problems);

        // included files with their own scheme are validated as roots as well
        for (const site of resolver.sites) {
            if (!site.exists || isSchemeFile(site.target) || !this.engine.findScheme(site.target)) {
                continue;
            }
            const sub = this.validateRoot(site.target);
            if (!sub) {
                continue;
            }
            res.problems.push(...sub.problems.filter((p) => !p.summary));
            sub.deps.forEach((d) => res.deps.add(d));
            for (const [k, a] of sub.annotations) {
                if (!res.annotations.has(k) || k === fileKey(site.target)) {
                    res.annotations.set(k, a);
                }
            }
            sub.mounts.forEach((n, k) => {
                if (!res.mounts.has(k)) {
                    res.mounts.set(k, n);
                }
            });
        }

        res.problems = dedupe(res.problems);

        if (options.includeSummary) {
            res.problems.push(...this.summaries(resolver.sites, res.problems));
        }
        return res;
    }

    /** Warns in a config file when its scheme has errors (validates the scheme as a root). */
    private reportBrokenScheme(file: string, schemeFile: string, sink: Sink): void {
        const sr = this.validateRoot(schemeFile);
        if (!sr) {
            return;
        }
        const errors = sr.problems.filter((p) => p.severity === 'error' && !p.summary);
        if (!errors.length) {
            return;
        }
        const related = errors.slice(0, 20).map((p) => ({
            location: { file: p.file, range: p.range },
            message: `${path.basename(p.file)}:${p.range.start.line + 1}: ${p.message}`,
        }));
        const d = this.engine.docs.get(file);
        const end = d ? d.lines.lineEnd(0) : 0;
        sink.add(
            file,
            0,
            end,
            'warning',
            'scheme',
            `The scheme '${path.basename(schemeFile)}' has ${errors.length} error(s); validation results may be incomplete`,
            related,
        );
    }

    private summaries(sites: { file: string; start: number; end: number; raw: string; closure: Set<string> }[], problems: Problem[]): Problem[] {
        const out: Problem[] = [];
        const docs = this.engine.docs;
        for (const site of sites) {
            const inside = problems.filter((p) => !p.summary && site.closure.has(fileKey(p.file)) && severityRank(p.severity) <= 1);
            if (!inside.length) {
                continue;
            }
            const errors = inside.filter((p) => p.severity === 'error').length;
            const warnings = inside.length - errors;
            const parts = [];
            if (errors) {
                parts.push(`${errors} error${errors > 1 ? 's' : ''}`);
            }
            if (warnings) {
                parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
            }
            const d = docs.get(site.file);
            if (!d) {
                continue;
            }
            out.push({
                file: site.file,
                range: d.lines.range(site.start, site.end),
                severity: errors ? 'error' : 'warning',
                kind: 'include',
                message: `Included file '${site.raw}' has ${parts.join(' and ')}`,
                related: inside
                    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
                    .slice(0, 30)
                    .map((p) => ({
                        location: { file: p.file, range: p.range },
                        message: `${path.basename(p.file)}:${p.range.start.line + 1}: ${p.message}`,
                    })),
                summary: true,
            });
        }
        return out;
    }
}

function annotationFile(visited: string[], key: string): string | undefined {
    return visited.find((f) => fileKey(f) === key);
}

export function dedupe(problems: Problem[]): Problem[] {
    const seen = new Set<string>();
    const out: Problem[] = [];
    for (const p of problems) {
        const k = problemKey(p);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(p);
        }
    }
    return out;
}
