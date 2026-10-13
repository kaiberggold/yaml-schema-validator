import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Annotation } from './core/validator';
import { DEFAULT_OPTIONS, Engine, EngineOptions, RootResult, dedupe } from './core/engine';
import { META_FILE } from './core/meta';
import { DEFAULT_SCHEME_INFIX, configCandidates, fileKey, isSchemeFile, isYamlFile, schemeDeclaration, schemeInfix } from './core/paths';
import { SchemaNode } from './core/scheme';
import { FileHost, Problem, severityRank } from './core/types';

export interface SchemaInfo {
    root: SchemaNode;
    /** Scheme file providing the schema (META_FILE for scheme files). */
    scheme: string;
    /** Set when the schema comes from the file that includes this one. */
    includedBy?: string;
}

const SEVERITY: Record<Problem['severity'], vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
};

export function readOptions(): EngineOptions & { debounceMs: number; exclude: string } {
    const c = vscode.workspace.getConfiguration('yamlScheme');
    return {
        extendKeyword: c.get('extendKeyword', DEFAULT_OPTIONS.extendKeyword) || DEFAULT_OPTIONS.extendKeyword,
        schemeInfix: c.get('schemeInfix', DEFAULT_SCHEME_INFIX) || DEFAULT_SCHEME_INFIX,
        unknownKeySeverity: c.get('unknownKeySeverity', DEFAULT_OPTIONS.unknownKeySeverity),
        includeSummary: c.get('includeSummary', DEFAULT_OPTIONS.includeSummary),
        unusedAnchors: c.get('unusedAnchors', DEFAULT_OPTIONS.unusedAnchors),
        debounceMs: c.get('debounceMs', 250),
        exclude: c.get('exclude', '**/{node_modules,.git}/**'),
    };
}

/** Reads open editors first, so unsaved changes are validated. */
class VsCodeHost implements FileHost {
    private openDoc(file: string): vscode.TextDocument | undefined {
        const k = fileKey(file);
        return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && !d.isClosed && fileKey(d.uri.fsPath) === k);
    }

    read(file: string): string | undefined {
        const doc = this.openDoc(file);
        if (doc) {
            return doc.getText();
        }
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return undefined;
        }
    }

    exists(file: string): boolean {
        if (this.openDoc(file)) {
            return true;
        }
        try {
            return fs.statSync(file).isFile();
        } catch {
            return false;
        }
    }
}

/**
 * Keeps track of root files (configs with a sibling scheme and scheme files),
 * their dependencies, and republishes diagnostics whenever a file that a root
 * depends on changes - similar to CMake re-configuring when a CMakeLists.txt
 * or an included file changes.
 */
export class Manager implements vscode.Disposable {
    readonly engine: Engine;
    private options = readOptions();
    private readonly roots = new Map<string, string>();
    private readonly results = new Map<string, RootResult>();
    private readonly byFile = new Map<string, Map<string, Problem[]>>();
    private readonly pending = new Set<string>();
    private timer: NodeJS.Timeout | undefined;
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('yaml-scheme');
    private readonly externalWatchers = new Map<string, vscode.Disposable>();
    private readonly updated = new vscode.EventEmitter<void>();
    readonly onDidUpdate = this.updated.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly log: vscode.OutputChannel) {
        this.engine = new Engine(new VsCodeHost(), this.options);
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yml,yaml}');
        this.disposables.push(
            watcher,
            watcher.onDidCreate((u) => this.onFileEvent(u.fsPath, 'create')),
            watcher.onDidChange((u) => this.onFileEvent(u.fsPath, 'change')),
            watcher.onDidDelete((u) => this.onFileEvent(u.fsPath, 'delete')),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.contentChanges.length && e.document.uri.scheme === 'file') {
                    this.onFileEvent(e.document.uri.fsPath, 'change');
                }
            }),
            vscode.workspace.onDidOpenTextDocument((d) => this.considerDocument(d)),
            vscode.workspace.onDidCloseTextDocument((d) => {
                // the file content falls back to the version on disk
                if (d.uri.scheme === 'file') {
                    this.onFileEvent(d.uri.fsPath, 'change');
                }
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('yamlScheme')) {
                    const before = schemeInfix();
                    this.options = readOptions();
                    this.engine.options = this.options;
                    if (schemeInfix() !== before) {
                        // different file naming: start over with discovery
                        [...this.roots.keys()].forEach((k) => this.removeRoot(k));
                    }
                    void this.revalidateAll();
                }
            }),
            this.diagnostics,
            this.updated,
        );
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.externalWatchers.forEach((w) => w.dispose());
        this.disposables.forEach((d) => d.dispose());
    }

    // ------------------------------------------------------------------ roots

    private addRoot(file: string): boolean {
        const k = fileKey(file);
        if (this.roots.has(k)) {
            return false;
        }
        this.roots.set(k, file);
        return true;
    }

    private removeRoot(k: string): void {
        this.roots.delete(k);
        const old = this.results.get(k);
        this.results.delete(k);
        const files = new Set(this.byFile.get(k)?.keys() ?? []);
        this.byFile.delete(k);
        if (old) {
            this.publish(files);
        }
    }

    /** Scans the workspace for scheme files and scheme declarations and validates everything. */
    async revalidateAll(): Promise<void> {
        const exclude = this.options.exclude || undefined;
        const schemes = await vscode.workspace.findFiles(`**/*.${schemeInfix()}.{yml,yaml}`, exclude);
        for (const u of schemes) {
            this.addRoot(u.fsPath);
            for (const c of configCandidates(u.fsPath)) {
                if (this.engine.exists(c)) {
                    this.addRoot(c);
                }
            }
        }
        // files that declare their scheme in the first line
        for (const u of await vscode.workspace.findFiles('**/*.{yml,yaml}', exclude, 20000)) {
            if (!isSchemeFile(u.fsPath) && !this.roots.has(fileKey(u.fsPath)) && schemeDeclaration(readHead(u.fsPath))) {
                this.addRoot(u.fsPath);
            }
        }
        vscode.workspace.textDocuments.forEach((d) => this.considerDocument(d, false));
        // drop roots whose scheme disappeared
        for (const [k, f] of [...this.roots]) {
            if (!this.engine.exists(f) || !this.engine.findScheme(f)) {
                this.removeRoot(k);
            }
        }
        this.roots.forEach((_, k) => this.pending.add(k));
        this.flush();
    }

    private considerDocument(doc: vscode.TextDocument, schedule = true): void {
        if (doc.uri.scheme !== 'file' || !isYamlFile(doc.uri.fsPath)) {
            return;
        }
        const f = doc.uri.fsPath;
        if ((isSchemeFile(f) || this.engine.findScheme(f)) && this.addRoot(f) && schedule) {
            this.schedule([fileKey(f)]);
        }
    }

    private onFileEvent(file: string, type: 'create' | 'change' | 'delete'): void {
        if (!isYamlFile(file)) {
            return;
        }
        const k = fileKey(file);
        if (type === 'create') {
            if (isSchemeFile(file)) {
                this.addRoot(file);
                configCandidates(file)
                    .filter((c) => this.engine.exists(c))
                    .forEach((c) => {
                        this.addRoot(c);
                        this.pending.add(fileKey(c));
                    });
            } else if (this.engine.findScheme(file)) {
                this.addRoot(file);
            }
        } else if (type === 'change' && !isSchemeFile(file)) {
            // a scheme declaration in the first line may have been added or removed
            if (this.engine.findScheme(file)) {
                this.addRoot(file);
            } else if (this.roots.has(k)) {
                this.removeRoot(k);
            }
        } else if (type === 'delete') {
            this.engine.forget(file);
            if (this.roots.has(k)) {
                this.removeRoot(k);
            }
            if (isSchemeFile(file)) {
                for (const c of configCandidates(file)) {
                    const ck = fileKey(c);
                    if (this.roots.has(ck) && !this.engine.findScheme(c)) {
                        this.removeRoot(ck);
                    }
                }
            }
        }
        const affected = [...this.results].filter(([, r]) => r.deps.has(k)).map(([rk]) => rk);
        if (this.roots.has(k)) {
            affected.push(k);
        }
        this.schedule(affected);
    }

    private schedule(keys: string[]): void {
        if (!keys.length) {
            return;
        }
        keys.forEach((k) => this.pending.add(k));
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.options.debounceMs);
    }

    // ------------------------------------------------------------- validation

    private flush(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const keys = [...this.pending].filter((k) => this.roots.has(k));
        this.pending.clear();
        if (!keys.length) {
            return;
        }
        const t0 = Date.now();
        let res: Map<string, RootResult>;
        try {
            res = this.engine.run(keys.map((k) => this.roots.get(k)!));
        } catch (e) {
            this.log.appendLine(`Validation failed: ${(e as Error).stack ?? e}`);
            return;
        }
        const touched = new Set<string>();
        for (const k of keys) {
            this.byFile.get(k)?.forEach((_, f) => touched.add(f));
            const r = res.get(k);
            if (!r) {
                this.results.delete(k);
                this.byFile.delete(k);
                continue;
            }
            this.results.set(k, r);
            const m = new Map<string, Problem[]>();
            for (const p of r.problems) {
                const fk = fileKey(p.file);
                let list = m.get(fk);
                if (!list) {
                    m.set(fk, (list = []));
                }
                list.push(p);
                touched.add(fk);
            }
            this.byFile.set(k, m);
        }
        this.publish(touched);
        this.updateExternalWatchers();
        this.log.appendLine(`Validated ${keys.length} file(s) in ${Date.now() - t0} ms: ${keys.map((k) => path.basename(this.roots.get(k)!)).join(', ')}`);
        this.updated.fire();
    }

    private publish(files: Set<string>): void {
        for (const fk of files) {
            let problems: Problem[] = [];
            let file: string | undefined;
            for (const m of this.byFile.values()) {
                const list = m.get(fk);
                if (list) {
                    problems.push(...list);
                    file ??= list[0].file;
                }
            }
            problems = collapseSummaries(dedupe(problems));
            file ??= this.knownPath(fk);
            if (!file) {
                continue;
            }
            this.diagnostics.set(vscode.Uri.file(file), problems.map(toDiagnostic));
        }
    }

    private knownPath(fk: string): string | undefined {
        let found: string | undefined;
        this.diagnostics.forEach((uri) => {
            if (!found && fileKey(uri.fsPath) === fk) {
                found = uri.fsPath;
            }
        });
        return found;
    }

    /** Watches directories of dependencies that are outside the workspace. */
    private updateExternalWatchers(): void {
        const dirs = new Map<string, string>();
        for (const r of this.results.values()) {
            for (const d of r.deps) {
                const uri = vscode.Uri.file(d);
                if (d !== fileKey(META_FILE) && !vscode.workspace.getWorkspaceFolder(uri)) {
                    const dir = path.dirname(d);
                    dirs.set(fileKey(dir), dir);
                }
            }
        }
        for (const [k, w] of this.externalWatchers) {
            if (!dirs.has(k)) {
                w.dispose();
                this.externalWatchers.delete(k);
            }
        }
        for (const [k, dir] of dirs) {
            if (this.externalWatchers.has(k)) {
                continue;
            }
            const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.{yml,yaml}'));
            const subs = [
                w,
                w.onDidCreate((u) => this.onFileEvent(u.fsPath, 'create')),
                w.onDidChange((u) => this.onFileEvent(u.fsPath, 'change')),
                w.onDidDelete((u) => this.onFileEvent(u.fsPath, 'delete')),
            ];
            this.externalWatchers.set(k, vscode.Disposable.from(...subs));
        }
    }

    // ----------------------------------------------------------- queries

    /** The scheme that applies to a file: its own, the meta scheme, or the one of the including file. */
    schemaFor(file: string): SchemaInfo | undefined {
        const k = fileKey(file);
        if (isSchemeFile(file)) {
            return { root: this.engine.metaScheme().root, scheme: META_FILE };
        }
        const own = this.results.get(k);
        if (own?.schema && own.scheme) {
            return { root: own.schema, scheme: own.scheme };
        }
        for (const r of this.results.values()) {
            const n = r.mounts.get(k);
            if (n) {
                return { root: n, scheme: r.scheme ?? '', includedBy: r.root };
            }
        }
        return undefined;
    }

    /** Annotations computed for exactly the given text of a file. */
    annotationsFor(file: string, text: string): Annotation[] | undefined {
        const k = fileKey(file);
        const own = this.results.get(k)?.annotations.get(k);
        if (own && own.text === text) {
            return own.items;
        }
        for (const r of this.results.values()) {
            const a = r.annotations.get(k);
            if (a && a.text === text) {
                return a.items;
            }
        }
        return undefined;
    }

    isManaged(file: string): boolean {
        const k = fileKey(file);
        if (this.roots.has(k)) {
            return true;
        }
        for (const r of this.results.values()) {
            if (r.deps.has(k)) {
                return true;
            }
        }
        return false;
    }

    get extendKeyword(): string {
        return this.options.extendKeyword;
    }
}

/** First bytes of a file (enough for a scheme declaration in the first line). */
function readHead(file: string): string {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.toString('utf8', 0, n);
    } catch {
        return '';
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

/** Several roots may summarise the same include line; keep the most informative summary. */
function collapseSummaries(problems: Problem[]): Problem[] {
    const best = new Map<string, Problem>();
    const rest: Problem[] = [];
    for (const p of problems) {
        if (!p.summary) {
            rest.push(p);
            continue;
        }
        const k = `${p.range.start.line}:${p.range.start.character}`;
        const prev = best.get(k);
        if (
            !prev ||
            severityRank(p.severity) < severityRank(prev.severity) ||
            (p.severity === prev.severity && p.related.length > prev.related.length)
        ) {
            best.set(k, p);
        }
    }
    return [...rest, ...best.values()];
}

export function toRange(r: Problem['range']): vscode.Range {
    return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function toDiagnostic(p: Problem): vscode.Diagnostic {
    const d = new vscode.Diagnostic(toRange(p.range), p.message, SEVERITY[p.severity]);
    d.source = 'yaml-scheme';
    if (p.rule) {
        const { line, character } = p.rule.range.start;
        d.code = { value: p.kind, target: vscode.Uri.file(p.rule.file).with({ fragment: `L${line + 1},${character + 1}` }) };
    } else {
        d.code = p.kind;
    }
    if (p.related.length) {
        d.relatedInformation = p.related.map(
            (r) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(r.location.file), toRange(r.location.range)), r.message),
        );
    }
    if (p.deprecated) {
        d.tags = [vscode.DiagnosticTag.Deprecated];
    } else if (p.kind === 'anchor') {
        // shown faded, like unused variables
        d.tags = [vscode.DiagnosticTag.Unnecessary];
    }
    return d;
}
