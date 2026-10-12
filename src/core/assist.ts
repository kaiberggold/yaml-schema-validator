/**
 * Editor assistance that does not depend on the VS Code API: finding the YAML
 * key path at the cursor (works on incomplete text), walking the scheme along
 * that path, and building completion entries and hover text.
 */
import * as path from 'path';
import { SchemaNode, deref, describeType, effectiveTypes, expand } from './scheme';
import { resolvePlain } from './yaml';

/** Path segment that stands for "an item of a list". */
export const ITEM = '[]';

export interface LineToken {
    col: number;
    kind: 'dash' | 'key';
    key?: string;
    /** For keys: end column of the key text. */
    keyEnd?: number;
}

export interface LineInfo {
    indent: number;
    blank: boolean;
    docMarker: boolean;
    tokens: LineToken[];
}

const isWs = (c: string | undefined) => c === ' ' || c === '\t';

/** Index of the ':' ending a `key:` that starts at `from`, or -1. */
export function keyColon(s: string, from: number): number {
    const c = s[from];
    if (c === '"' || c === "'") {
        let i = from + 1;
        while (i < s.length) {
            if (c === '"' && s[i] === '\\') {
                i += 2;
                continue;
            }
            if (s[i] === c) {
                if (c === "'" && s[i + 1] === "'") {
                    i += 2;
                    continue;
                }
                break;
            }
            i++;
        }
        if (i >= s.length) {
            return -1;
        }
        i++;
        while (isWs(s[i])) {
            i++;
        }
        return s[i] === ':' && (i + 1 >= s.length || isWs(s[i + 1])) ? i : -1;
    }
    if (c === undefined || '#|>@`%{}[],&*!'.includes(c)) {
        return -1;
    }
    for (let i = from; i < s.length; i++) {
        if (s[i] === ':' && (i + 1 >= s.length || isWs(s[i + 1]))) {
            return i;
        }
        if (s[i] === '#' && i > from && isWs(s[i - 1])) {
            return -1;
        }
    }
    return -1;
}

export function unquote(k: string): string {
    if (k.length >= 2 && k[0] === '"' && k[k.length - 1] === '"') {
        try {
            return JSON.parse(k);
        } catch {
            return k.slice(1, -1);
        }
    }
    if (k.length >= 2 && k[0] === "'" && k[k.length - 1] === "'") {
        return k.slice(1, -1).replace(/''/g, "'");
    }
    return k;
}

export function lineInfo(s: string): LineInfo {
    let i = 0;
    while (s[i] === ' ') {
        i++;
    }
    const info: LineInfo = { indent: i, blank: false, docMarker: false, tokens: [] };
    if (i >= s.length || s[i] === '#' || s.trim() === '') {
        info.blank = true;
        return info;
    }
    if (i === 0 && /^(---|\.\.\.)(\s|$)/.test(s)) {
        info.docMarker = true;
        return info;
    }
    for (;;) {
        if (s[i] === '-' && (i + 1 >= s.length || isWs(s[i + 1]))) {
            info.tokens.push({ col: i, kind: 'dash' });
            i++;
            while (isWs(s[i])) {
                i++;
            }
            continue;
        }
        break;
    }
    const colon = keyColon(s, i);
    if (colon >= 0) {
        const raw = s.slice(i, colon).trimEnd();
        info.tokens.push({ col: i, kind: 'key', key: unquote(raw), keyEnd: i + raw.length });
    }
    return info;
}

/**
 * Key path of the parents of a token at column `col` on line `from + 1`,
 * determined by indentation of the lines above.
 */
export function ancestors(lines: string[], from: number, col: number, isDash: boolean): string[] {
    const segs: string[] = [];
    let target = col;
    let allowEqualKey = isDash;
    for (let l = from; l >= 0; l--) {
        if (target <= 0 && !allowEqualKey) {
            break;
        }
        const info = lineInfo(lines[l]);
        if (info.docMarker) {
            break;
        }
        if (info.blank) {
            continue;
        }
        if (!info.tokens.length) {
            // plain text line (e.g. a multi-line scalar): not a parent
            continue;
        }
        for (let t = info.tokens.length - 1; t >= 0; t--) {
            const tok = info.tokens[t];
            if (tok.col < target || (allowEqualKey && tok.kind === 'key' && tok.col === target)) {
                if (tok.kind === 'key') {
                    segs.unshift(tok.key!);
                    allowEqualKey = false;
                } else {
                    segs.unshift(ITEM);
                    allowEqualKey = true;
                }
                target = tok.col;
            }
        }
    }
    return segs;
}

export interface CursorContext {
    kind: 'key' | 'value' | 'none';
    /** Path of the mapping (or list) that contains the cursor position. */
    path: string[];
    /** For `value`: the key whose value is being edited. */
    key?: string;
    /** Column where the text being completed starts. */
    startCol: number;
    /** Text between `startCol` and the cursor. */
    prefix: string;
    /** Keys already present in the mapping at the cursor. */
    siblings: Set<string>;
    /** Number of `- ` markers on the cursor line before the key. */
    dashes: number;
    /** The value is prefixed with the `!extend` tag. */
    extendTag?: boolean;
}

export function getCursorContext(lines: string[], line: number, character: number): CursorContext {
    const before = (lines[line] ?? '').slice(0, character);
    let i = 0;
    while (before[i] === ' ') {
        i++;
    }
    const dashCols: number[] = [];
    while (before[i] === '-' && isWs(before[i + 1])) {
        dashCols.push(i);
        i++;
        while (isWs(before[i])) {
            i++;
        }
    }
    const keyCol = i;
    const none: CursorContext = { kind: 'none', path: [], startCol: character, prefix: '', siblings: new Set(), dashes: 0 };
    if (before[i] === '#' || /\s#/.test(before.slice(i))) {
        return none;
    }
    const firstCol = dashCols.length ? dashCols[0] : keyCol;
    const parents = ancestors(lines, line - 1, firstCol, dashCols.length > 0);
    const basePath = [...parents, ...dashCols.map(() => ITEM)];
    const colon = keyColon(before, keyCol);
    if (colon >= 0) {
        const key = unquote(before.slice(keyCol, colon).trim());
        let vs = colon + 1;
        while (isWs(before[vs])) {
            vs++;
        }
        let extendTag = false;
        if (before.startsWith('!extend', vs) && isWs(before[vs + 7])) {
            extendTag = true;
            vs += 7;
            while (isWs(before[vs])) {
                vs++;
            }
        }
        return {
            kind: 'value',
            path: basePath,
            key,
            startCol: vs,
            prefix: before.slice(vs),
            siblings: new Set(),
            dashes: dashCols.length,
            extendTag,
        };
    }
    return {
        kind: 'key',
        path: basePath,
        startCol: keyCol,
        prefix: before.slice(keyCol),
        siblings: siblingKeys(lines, line, keyCol, dashCols.length > 0),
        dashes: dashCols.length,
    };
}

/** Keys of the mapping that has its keys at column `col` around `line`. */
export function siblingKeys(lines: string[], line: number, col: number, startsItem: boolean): Set<string> {
    const keys = new Set<string>();
    const scan = (l: number, dir: number) => {
        for (; l >= 0 && l < lines.length; l += dir) {
            const info = lineInfo(lines[l]);
            if (info.docMarker) {
                return;
            }
            if (info.blank) {
                continue;
            }
            const first = info.tokens.length ? info.tokens[0].col : info.indent;
            const key = info.tokens.find((t) => t.kind === 'key' && t.col === col);
            if (dir < 0) {
                if (key) {
                    keys.add(key.key!);
                }
                if (first < col) {
                    return;
                }
            } else {
                if (first < col) {
                    return;
                }
                if (key) {
                    keys.add(key.key!);
                }
            }
        }
    };
    if (!startsItem) {
        scan(line - 1, -1);
    }
    scan(line + 1, 1);
    return keys;
}

/** Path to the key at the given position (for hover / definition fallback). */
export function keyAt(lines: string[], line: number, character: number): { path: string[]; key: string; start: number; end: number } | undefined {
    const info = lineInfo(lines[line] ?? '');
    const idx = info.tokens.findIndex((t) => t.kind === 'key' && character >= t.col && character <= t.keyEnd!);
    if (idx < 0) {
        return undefined;
    }
    const tok = info.tokens[idx];
    const first = info.tokens[0];
    const parents = ancestors(lines, line - 1, first.col, first.kind === 'dash');
    const dashes = info.tokens.slice(0, idx).filter((t) => t.kind === 'dash').map(() => ITEM);
    return { path: [...parents, ...dashes, tok.key!], key: tok.key!, start: tok.col, end: tok.keyEnd! };
}

/** Walks the scheme along a key path. Returns all candidate nodes (several with `anyOf`). */
export function walk(root: SchemaNode, segs: string[]): SchemaNode[] {
    let cur: SchemaNode[] = [deref(root)];
    for (const seg of segs) {
        const next: SchemaNode[] = [];
        for (const n of cur.flatMap((c) => expand(c))) {
            if (seg === ITEM) {
                if (n.items) {
                    next.push(deref(n.items));
                }
                continue;
            }
            const p = n.properties?.get(seg);
            if (p) {
                next.push(deref(p));
            } else if (n.additionalProperties && typeof n.additionalProperties === 'object') {
                next.push(deref(n.additionalProperties));
            }
        }
        cur = next;
        if (!cur.length) {
            break;
        }
    }
    return cur;
}

// ---------------------------------------------------------------- completion

export interface CompletionEntry {
    label: string;
    kind: 'property' | 'value' | 'keyword' | 'file' | 'folder';
    insertText: string;
    isSnippet: boolean;
    detail?: string;
    documentation?: string;
    sortText?: string;
    /** Open the suggestion widget again after inserting. */
    retrigger?: boolean;
    preselect?: boolean;
}

export interface HoverEnv {
    /** 1-based line of an offset in a file, if known. */
    lineOf(file: string, offset: number): number | undefined;
    /** Link target for a file location (or undefined to omit the link). */
    link(file: string, line: number): string | undefined;
}

const escapeSnippet = (s: string) => s.replace(/[$}\\]/g, '\\$&');
const escapeChoice = (s: string) => s.replace(/[$}\\,|]/g, '\\$&');

/** Formats a value as YAML scalar text, quoting where needed. */
export function yamlScalar(v: unknown): string {
    if (v === null || v === undefined) {
        return 'null';
    }
    if (typeof v === 'string') {
        if (v === '' || resolvePlain(v).type !== 'str' || /^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|: |\s#/.test(v)) {
            return JSON.stringify(v);
        }
        return v;
    }
    if (typeof v === 'object') {
        return JSON.stringify(v);
    }
    return String(v);
}

function yamlKey(k: string): string {
    return /^[A-Za-z0-9_][\w.\-/]*$/.test(k) ? k : JSON.stringify(k);
}

function unionTypes(nodes: SchemaNode[]): Set<string> {
    const s = new Set<string>();
    for (const n of nodes.flatMap((x) => expand(x))) {
        effectiveTypes(n).forEach((t) => s.add(t));
    }
    return s;
}

export function keySnippet(key: string, prop: SchemaNode): { text: string; retrigger: boolean } {
    const d = deref(prop);
    const k = yamlKey(key);
    if (d.snippet !== undefined) {
        return { text: `${k}: ${d.snippet}`, retrigger: false };
    }
    const alts = expand(prop);
    const types = unionTypes([prop]);
    const only = (t: string) => types.size === 1 && types.has(t);
    if (only('map')) {
        return { text: `${k}:\n\t$0`, retrigger: alts.some((a) => !!a.properties) };
    }
    if (only('list')) {
        const item = alts.find((a) => a.items)?.items;
        const itemAlts = item ? expand(item) : [];
        return { text: `${k}:\n\t- $0`, retrigger: itemAlts.some((a) => !!a.properties || !!a.enum) };
    }
    const enumValues = alts.flatMap((a) => a.enum ?? []);
    if (enumValues.length) {
        const vals = [...new Set(enumValues.map(yamlScalar))];
        if (d.hasDefault) {
            const def = yamlScalar(d.default);
            const i = vals.indexOf(def);
            if (i > 0) {
                vals.splice(i, 1);
                vals.unshift(def);
            }
        }
        return { text: `${k}: \${1|${vals.map(escapeChoice).join(',')}|}`, retrigger: false };
    }
    if (only('boolean')) {
        const vals = d.default === true ? ['true', 'false'] : ['false', 'true'];
        return { text: `${k}: \${1|${vals.join(',')}|}`, retrigger: false };
    }
    if (d.hasDefault && (d.default === null || typeof d.default !== 'object')) {
        return { text: `${k}: \${1:${escapeSnippet(yamlScalar(d.default))}}`, retrigger: false };
    }
    if (d.examples?.length) {
        return { text: `${k}: \${1:${escapeSnippet(yamlScalar(d.examples[0]))}}`, retrigger: false };
    }
    return { text: `${k}: $0`, retrigger: false };
}

export function keyCompletions(
    nodes: SchemaNode[],
    existing: Set<string>,
    env: HoverEnv,
    extendKeyword?: string,
): CompletionEntry[] {
    const props = new Map<string, SchemaNode>();
    let isMap = false;
    for (const n of nodes.flatMap((x) => expand(x))) {
        const types = effectiveTypes(n);
        if (types.includes('map') || types.includes('any')) {
            isMap = true;
        }
        for (const [k, p] of n.properties ?? []) {
            if (!props.has(k)) {
                props.set(k, p);
            }
        }
    }
    const out: CompletionEntry[] = [];
    for (const [k, p] of props) {
        if (existing.has(k)) {
            continue;
        }
        const d = deref(p);
        const snip = keySnippet(k, p);
        out.push({
            label: k,
            kind: 'property',
            insertText: snip.text,
            isSnippet: true,
            detail: describeType(p) + (d.required ? ' (required)' : '') + (d.deprecated ? ' (deprecated)' : ''),
            documentation: hoverMarkdown(p, k, env),
            sortText: `${d.deprecated ? 2 : d.required ? 0 : 1}_${k}`,
            retrigger: snip.retrigger,
        });
    }
    if (extendKeyword && (isMap || props.size || !nodes.length) && !existing.has(extendKeyword)) {
        out.push({
            label: extendKeyword,
            kind: 'keyword',
            insertText: `${extendKeyword}: `,
            isSnippet: false,
            detail: 'Include other YAML file(s)',
            documentation:
                `Merges the mapping of another YAML file into this mapping (recursively). ` +
                `Local keys override included ones.\n\n\`\`\`yaml\n${extendKeyword}: base.yml\n${extendKeyword}: [a.yml, b.yml]\nkey: !extend part.yml\n\`\`\``,
            sortText: `3_${extendKeyword}`,
            retrigger: true,
        });
    }
    return out;
}

export function valueCompletions(nodes: SchemaNode[]): CompletionEntry[] {
    const out: CompletionEntry[] = [];
    const seen = new Set<string>();
    const add = (v: unknown, detail: string, preselect = false) => {
        const text = yamlScalar(v);
        if (seen.has(text)) {
            return;
        }
        seen.add(text);
        out.push({ label: text, kind: 'value', insertText: text, isSnippet: false, detail, preselect, sortText: `${preselect ? 0 : 1}_${out.length.toString().padStart(4, '0')}` });
    };
    for (const n of nodes) {
        const d = deref(n);
        if (d.hasDefault && (d.default === null || typeof d.default !== 'object')) {
            add(d.default, 'default', true);
        }
        for (const a of expand(n)) {
            for (const e of a.enum ?? []) {
                add(e, 'allowed value');
            }
            if (effectiveTypes(a).includes('boolean')) {
                add(true, 'boolean');
                add(false, 'boolean');
            }
            for (const e of a.examples ?? []) {
                if (e === null || typeof e !== 'object') {
                    add(e, 'example');
                }
            }
            if (effectiveTypes(a).includes('null') && !a.enum) {
                add(null, 'null');
            }
        }
    }
    return out;
}

// --------------------------------------------------------------------- hover

export function hoverMarkdown(node: SchemaNode, key: string | undefined, env: HoverEnv): string {
    const d = deref(node);
    const out: string[] = [];
    let head = key !== undefined ? `**${key}**` : d.title ? `**${d.title}**` : '';
    head += `${head ? ' · ' : ''}\`${describeType(node)}\``;
    if (d.required) {
        head += ' · *required*';
    }
    out.push(head);
    if (d.title && key !== undefined && d.title !== key) {
        out.push(`*${d.title}*`);
    }
    if (d.deprecated) {
        out.push(`⚠️ **Deprecated**${typeof d.deprecated === 'string' ? `: ${d.deprecated}` : ''}`);
    }
    if (d.description) {
        out.push(d.description.trim());
    }
    const facts: string[] = [];
    if (d.hasDefault) {
        facts.push(`Default: \`${yamlScalar(d.default)}\``);
    }
    if (d.enum) {
        facts.push(`Allowed: ${d.enum.map((e) => `\`${yamlScalar(e)}\``).join(', ')}`);
    }
    if (d.pattern) {
        facts.push(`Pattern: \`/${d.pattern.source}/\``);
    }
    if (d.min !== undefined || d.max !== undefined) {
        facts.push(`Range: ${d.min ?? '−∞'} … ${d.max ?? '∞'}`);
    }
    if (d.minLength !== undefined || d.maxLength !== undefined) {
        facts.push(`Length: ${d.minLength ?? 0} … ${d.maxLength ?? '∞'}`);
    }
    if (d.minItems !== undefined || d.maxItems !== undefined) {
        facts.push(`Items: ${d.minItems ?? 0} … ${d.maxItems ?? '∞'}`);
    }
    if (d.uniqueItems) {
        facts.push('Items must be unique');
    }
    if (d.examples?.length) {
        facts.push(`Examples: ${d.examples.map((e) => `\`${yamlScalar(e)}\``).join(', ')}`);
    }
    if (d.properties?.size) {
        const keys = [...d.properties.entries()].map(([k, p]) => (deref(p).required ? `\`${k}\`*` : `\`${k}\``));
        facts.push(`Keys: ${keys.slice(0, 25).join(', ')}${keys.length > 25 ? ', …' : ''}`);
    }
    if (d.anyOf) {
        facts.push(`One of: ${d.anyOf.map((a) => `\`${describeType(a)}\``).join(', ')}`);
    }
    if (facts.length) {
        out.push(facts.map((f) => `- ${f}`).join('\n'));
    }
    const links: string[] = [];
    const where = (file: string | undefined, offset: number | undefined, label: string) => {
        if (file === undefined || offset === undefined) {
            return;
        }
        const line = env.lineOf(file, offset);
        const target = line !== undefined ? env.link(file, line) : undefined;
        if (line !== undefined && target) {
            links.push(`${label} [${path.basename(file)}:${line}](${target})`);
        }
    };
    if (d.keyFile !== undefined) {
        where(d.keyFile, d.keyStart, 'Defined in');
    } else {
        where(d.file, d.start, 'Defined in');
    }
    if (d.refTarget) {
        where(d.refTarget.keyFile ?? d.refTarget.file, d.refTarget.keyStart ?? d.refTarget.start, `Type \`${d.refTarget.name ?? ''}\` in`);
    }
    for (const s of d.see ?? []) {
        const target = env.link(s.file, s.line || 1);
        if (target) {
            links.push(`See [${s.label}](${target})`);
        }
    }
    if (links.length) {
        out.push(links.join(' · '));
    }
    return out.join('\n\n');
}

/** Builds a starter scheme (as YAML text) from a value, used when creating a missing scheme. */
export function inferScheme(value: unknown, indent = ''): string {
    const lines: string[] = [];
    const emit = (v: unknown, ind: string) => {
        if (Array.isArray(v)) {
            lines.push(`${ind}type: list`);
            if (v.length) {
                lines.push(`${ind}items:`);
                emit(v[0], ind + '  ');
            }
        } else if (v !== null && typeof v === 'object') {
            lines.push(`${ind}type: map`);
            const entries = Object.entries(v as Record<string, unknown>);
            if (entries.length) {
                lines.push(`${ind}properties:`);
                for (const [k, c] of entries) {
                    lines.push(`${ind}  ${yamlKey(k)}:`);
                    emit(c, ind + '    ');
                    lines.push(`${ind}    description: ""`);
                }
            }
        } else {
            const t = v === null ? 'any' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v === 'boolean' ? 'boolean' : 'string';
            lines.push(`${ind}type: ${t}`);
        }
    };
    emit(value, indent);
    return lines.join('\n') + '\n';
}
