import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    CompletionEntry,
    HoverEnv,
    ITEM,
    getCursorContext,
    hoverMarkdown,
    keyAt,
    keyCompletions,
    lineInfo,
    valueCompletions,
    walk,
    isRequired,
    anchorAt,
    anchorMarkdown,
} from './core/assist';
import { findIncludeSites, includeTag } from './core/effective';
import { META_FILE } from './core/meta';
import { fileKey, isSchemeFile, isYamlFile } from './core/paths';
import { SchemaNode, deref, expand, likelyTypes } from './core/scheme';
import { Manager } from './manager';

const KIND: Record<CompletionEntry['kind'], vscode.CompletionItemKind> = {
    property: vscode.CompletionItemKind.Property,
    value: vscode.CompletionItemKind.Value,
    keyword: vscode.CompletionItemKind.Keyword,
    file: vscode.CompletionItemKind.File,
    folder: vscode.CompletionItemKind.Folder,
};

export const SELECTOR: vscode.DocumentSelector = [
    { scheme: 'file', language: 'yaml' },
    { scheme: 'file', pattern: '**/*.{yml,yaml}' },
];

function hoverEnv(manager: Manager): HoverEnv {
    return {
        lineOf: (file, offset) => {
            if (fileKey(file) === fileKey(META_FILE)) {
                return undefined;
            }
            const d = manager.engine.getDoc(file);
            return d ? d.lines.positionAt(offset).line + 1 : undefined;
        },
        link: (file, line) =>
            fileKey(file) === fileKey(META_FILE) ? undefined : vscode.Uri.file(file).with({ fragment: `L${line}` }).toString(),
    };
}

function markdown(text: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(text);
    md.supportHtml = false;
    return md;
}

/** The `# schema: path` declaration in the first line, if any. */
function declaration(manager: Manager, doc: vscode.TextDocument) {
    if (isSchemeFile(doc.uri.fsPath)) {
        return undefined;
    }
    const d = manager.engine.declaredScheme(doc.uri.fsPath);
    if (!d) {
        return undefined;
    }
    return { ...d, range: new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end)), exists: manager.engine.exists(d.path) };
}

const DECLARATION_PREFIX = /^\uFEFF?#\s*(?:yaml-language-server\s*:\s*\$schema\s*=|\$?(?:schema|scheme)\s*[:=])\s*/i;

function includeSites(manager: Manager, doc: vscode.TextDocument) {
    const parsed = manager.engine.getDoc(doc.uri.fsPath);
    if (!parsed) {
        return [];
    }
    return findIncludeSites(parsed.yaml, doc.uri.fsPath, manager.extendKeyword, (f) => manager.engine.exists(f));
}

/** Schema node at a key position: from validation annotations, or by walking the key path. */
function schemaAtKey(
    manager: Manager,
    doc: vscode.TextDocument,
    pos: vscode.Position,
): { node: SchemaNode; key: string; range: vscode.Range; required?: boolean } | undefined {
    const file = doc.uri.fsPath;
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const anns = manager.annotationsFor(file, text);
    if (anns) {
        let best: (typeof anns)[number] | undefined;
        for (const a of anns) {
            if (offset < a.start || offset > a.end) {
                continue;
            }
            if (a.kind === 'value' && doc.positionAt(a.start).line !== doc.positionAt(a.end).line) {
                continue;
            }
            if (!best || a.end - a.start < best.end - best.start || (a.kind === 'key' && best.kind !== 'key')) {
                best = a;
            }
        }
        if (best) {
            return {
                node: best.schema,
                key: best.key ?? '',
                range: new vscode.Range(doc.positionAt(best.start), doc.positionAt(best.end)),
                required: best.required,
            };
        }
    }
    const info = manager.schemaFor(file);
    if (!info) {
        return undefined;
    }
    const lines = text.split(/\r?\n/);
    const k = keyAt(lines, pos.line, pos.character);
    if (!k) {
        return undefined;
    }
    const nodes = walk(info.root, k.path);
    if (!nodes.length) {
        return undefined;
    }
    return {
        node: nodes[0],
        key: k.key,
        range: new vscode.Range(pos.line, k.start, pos.line, k.end),
        required: isRequired(walk(info.root, k.path.slice(0, -1)), k.key),
    };
}

export class CompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly manager: Manager) {}

    provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
        const file = doc.uri.fsPath;
        const info = this.manager.schemaFor(file);
        if (!info && !this.manager.isManaged(file)) {
            return undefined;
        }
        const lines = doc.getText().split(/\r?\n/);
        const scheme = isSchemeFile(file);
        if (pos.line === 0 && !scheme) {
            const m = DECLARATION_PREFIX.exec(lines[0].slice(0, pos.character));
            if (m) {
                const typed = lines[0].slice(m[0].length, pos.character);
                return this.fileCompletions(file, typed, pos, true);
            }
        }
        const keyword = this.manager.extendKeyword;
        const tag = includeTag(keyword);
        const ctx = getCursorContext(lines, pos.line, pos.character, tag);
        if (ctx.kind === 'none') {
            return undefined;
        }
        const env = hoverEnv(this.manager);
        const range = new vscode.Range(pos.line, ctx.startCol, pos.line, pos.character);
        let entries: CompletionEntry[] = [];

        if (ctx.kind === 'value') {
            const isInclude = ctx.extendTag || (ctx.key === keyword && (!scheme || ctx.path.length === 0));
            if (isInclude) {
                return this.fileCompletions(file, ctx.prefix, pos);
            }
            if (ctx.prefix === '' || !ctx.prefix.startsWith('!')) {
                entries = info ? valueCompletions(walk(info.root, [...ctx.path, ctx.key!])) : [];
            }
            if (!scheme && (!ctx.prefix || tag.startsWith(ctx.prefix))) {
                entries.push({
                    label: tag,
                    kind: 'keyword',
                    insertText: `${tag} `,
                    isSnippet: false,
                    detail: 'Replace this value with the content of another YAML file',
                    sortText: '9',
                    retrigger: true,
                });
            }
        } else {
            const n = ctx.path.length;
            if (ctx.dashes > 0 && ctx.path[n - 1] === ITEM && ctx.path[n - 2] === keyword && (!scheme || n === 2)) {
                // item of an `extends:` list
                return this.fileCompletions(file, ctx.prefix, pos);
            }
            const nodes = info ? walk(info.root, ctx.path) : [];
            entries = keyCompletions(nodes, ctx.siblings, env, !scheme || ctx.path.length === 0 ? keyword : undefined);
            // list of scalars: offer values for the item
            if (ctx.dashes > 0 && ctx.path[ctx.path.length - 1] === ITEM) {
                const scalarItems = nodes.filter((n) => expand(n).some((a) => !likelyTypes(a).includes('object')));
                entries.push(...valueCompletions(scalarItems));
            }
        }
        return entries.map((e) => this.toItem(e, range));
    }

    private toItem(e: CompletionEntry, range: vscode.Range): vscode.CompletionItem {
        const item = new vscode.CompletionItem(e.label, KIND[e.kind]);
        item.insertText = e.isSnippet ? new vscode.SnippetString(e.insertText) : e.insertText;
        item.detail = e.detail;
        if (e.documentation) {
            item.documentation = markdown(e.documentation);
        }
        item.sortText = e.sortText;
        item.preselect = e.preselect;
        item.range = range;
        if (e.retrigger) {
            item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
        }
        return item;
    }

    /** Paths of YAML files (or scheme files for a `# schema:` declaration) relative to `file`. */
    private fileCompletions(file: string, typed: string, pos: vscode.Position, schemes = false): vscode.CompletionItem[] {
        const quote = typed.match(/^["']/)?.[0] ?? '';
        const p = typed.slice(quote.length);
        const slash = p.lastIndexOf('/');
        const dirPart = slash >= 0 ? p.slice(0, slash + 1) : '';
        const dir = path.resolve(path.dirname(file), dirPart || '.');
        const startCol = pos.character - (p.length - dirPart.length);
        const range = new vscode.Range(pos.line, startCol, pos.line, pos.character);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return [];
        }
        const self = fileKey(file);
        const items: vscode.CompletionItem[] = [];
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') {
                continue;
            }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                const it = new vscode.CompletionItem(`${e.name}/`, vscode.CompletionItemKind.Folder);
                it.range = range;
                it.sortText = `1_${e.name}`;
                it.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
                items.push(it);
            } else if (isYamlFile(e.name) && isSchemeFile(e.name) === schemes && fileKey(full) !== self) {
                const it = new vscode.CompletionItem(e.name, vscode.CompletionItemKind.File);
                it.range = range;
                it.sortText = `0_${e.name}`;
                if (!schemes) {
                    const scheme = this.manager.engine.findScheme(full);
                    it.detail = scheme && this.manager.engine.exists(scheme) ? `validated by ${path.basename(scheme)}` : 'no own scheme';
                }
                items.push(it);
            }
        }
        return items;
    }
}

export class HoverProvider implements vscode.HoverProvider {
    constructor(private readonly manager: Manager) {}

    provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
        const file = doc.uri.fsPath;
        if (!this.manager.isManaged(file) && !this.manager.schemaFor(file)) {
            return undefined;
        }
        const offset = doc.offsetAt(pos);
        const parsed = this.manager.engine.getDoc(file);
        const anchor = parsed && anchorAt(parsed.yaml, offset);
        if (parsed && anchor) {
            const md = anchorMarkdown(parsed.text, anchor, (o) => parsed.lines.positionAt(o).line + 1);
            return new vscode.Hover(markdown(md), new vscode.Range(doc.positionAt(anchor.start), doc.positionAt(anchor.end)));
        }
        const decl = declaration(this.manager, doc);
        if (decl && pos.line === 0) {
            const text = decl.exists
                ? `**Scheme** for this file: [${path.basename(decl.path)}](${vscode.Uri.file(decl.path).toString()})\n\n\`${decl.path}\``
                : `**Scheme** \`${decl.raw}\`\n\n❌ File not found: \`${decl.path}\``;
            return new vscode.Hover(markdown(text), decl.range);
        }
        for (const site of includeSites(this.manager, doc)) {
            const start = site.keyStart ?? site.start;
            if (offset >= start && offset <= site.end) {
                return new vscode.Hover(markdown(this.includeHover(site.raw, site.target)), new vscode.Range(doc.positionAt(site.start), doc.positionAt(site.end)));
            }
        }
        const hit = schemaAtKey(this.manager, doc, pos);
        if (hit) {
            return new vscode.Hover(markdown(hoverMarkdown(hit.node, hit.key || undefined, hoverEnv(this.manager), hit.required)), hit.range);
        }
        return undefined;
    }

    private includeHover(raw: string, target: string): string {
        const e = this.manager.engine;
        if (!e.exists(target)) {
            return `**${this.manager.extendKeyword}** \`${raw}\`\n\n❌ File not found: \`${target}\``;
        }
        const link = vscode.Uri.file(target).toString();
        const found = e.findScheme(target);
        const scheme = found && e.exists(found) ? found : undefined;
        const lines = [`**${this.manager.extendKeyword}** → [${path.basename(target)}](${link})`, `\`${target}\``];
        lines.push(
            scheme
                ? `Validated by its own scheme [${path.basename(scheme)}](${vscode.Uri.file(scheme).toString()}) only (not by the scheme of this file).`
                : 'No own scheme: validated by the scheme of this file.',
        );
        return lines.join('\n\n');
    }
}

export class DefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly manager: Manager) {}

    provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Definition | undefined {
        const file = doc.uri.fsPath;
        const offset = doc.offsetAt(pos);
        const parsed = this.manager.engine.getDoc(file);
        const anchor = parsed && anchorAt(parsed.yaml, offset);
        if (anchor?.kind === 'alias') {
            return new vscode.Location(doc.uri, doc.positionAt(anchor.anchor.start));
        }
        const decl = declaration(this.manager, doc);
        if (decl?.exists && decl.range.contains(pos)) {
            return new vscode.Location(vscode.Uri.file(decl.path), new vscode.Position(0, 0));
        }
        for (const site of includeSites(this.manager, doc)) {
            if (offset >= site.start && offset <= site.end && this.manager.engine.exists(site.target)) {
                return new vscode.Location(vscode.Uri.file(site.target), new vscode.Position(0, 0));
            }
        }
        // `$ref: "#/definitions/x"` or `$ref: other.schema.yml#/...` inside a scheme file
        if (isSchemeFile(file)) {
            const line = doc.lineAt(pos.line).text;
            const key = lineInfo(line).tokens.find((t) => t.kind === 'key');
            if (key?.key === '$ref' && pos.character > key.keyEnd!) {
                const ref = line
                    .slice(line.indexOf(':', key.keyEnd!) + 1)
                    .replace(/\s+#.*$/, '')
                    .trim()
                    .replace(/^["']|["']$/g, '');
                const hash = ref.indexOf('#');
                const target = hash > 0 || (hash < 0 && ref) ? path.resolve(path.dirname(file), ref.slice(0, hash < 0 ? undefined : hash)) : file;
                const pointer = hash >= 0 ? ref.slice(hash + 1) : '';
                const node = this.manager.engine.compileSchemeFile(target)?.nodeAt(pointer);
                if (node) {
                    return this.location(node);
                }
            }
        }
        const hit = schemaAtKey(this.manager, doc, pos);
        return hit ? this.location(deref(hit.node)) : undefined;
    }

    private location(n: SchemaNode): vscode.Location | undefined {
        const file = n.keyFile ?? n.file;
        const offset = n.keyFile !== undefined ? n.keyStart! : n.start;
        if (fileKey(file) === fileKey(META_FILE)) {
            return undefined;
        }
        const d = this.manager.engine.getDoc(file);
        if (!d) {
            return undefined;
        }
        const p = d.lines.positionAt(offset);
        return new vscode.Location(vscode.Uri.file(file), new vscode.Position(p.line, p.character));
    }
}

export class LinkProvider implements vscode.DocumentLinkProvider {
    constructor(private readonly manager: Manager) {}

    provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
        if (!this.manager.isManaged(doc.uri.fsPath)) {
            return [];
        }
        const links: vscode.DocumentLink[] = [];
        const decl = declaration(this.manager, doc);
        if (decl?.exists) {
            const link = new vscode.DocumentLink(decl.range, vscode.Uri.file(decl.path));
            link.tooltip = `Open scheme ${path.basename(decl.path)}`;
            links.push(link);
        }
        for (const site of includeSites(this.manager, doc)) {
            if (!this.manager.engine.exists(site.target)) {
                continue;
            }
            const link = new vscode.DocumentLink(new vscode.Range(doc.positionAt(site.start), doc.positionAt(site.end)), vscode.Uri.file(site.target));
            link.tooltip = `Open ${path.basename(site.target)}`;
            links.push(link);
        }
        return links;
    }
}

/** Find All References on an anchor (`&name`) or alias (`*name`): the anchor and all its aliases. */
export class AnchorReferenceProvider implements vscode.ReferenceProvider {
    constructor(private readonly manager: Manager) {}

    provideReferences(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.ReferenceContext): vscode.Location[] | undefined {
        const parsed = this.manager.engine.getDoc(doc.uri.fsPath);
        const hit = parsed && anchorAt(parsed.yaml, doc.offsetAt(pos));
        if (!hit) {
            return undefined;
        }
        const at = (s: number, e: number) => new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(s), doc.positionAt(e)));
        const uses = hit.anchor.uses.map((u) => at(u.start, u.end));
        return ctx.includeDeclaration ? [at(hit.anchor.start, hit.anchor.end), ...uses] : uses;
    }
}
