/**
 * A small, dependency free YAML parser that keeps source offsets for every
 * node. It supports the subset of YAML that is used for configuration files:
 * block mappings and sequences, flow collections, plain / quoted / block
 * scalars, comments, anchors, aliases and tags. Only the first document of a
 * stream is parsed. The parser never throws; problems are collected in
 * `errors` and parsing recovers at the next line.
 */

export type Scalar = string | number | boolean | null;
export type ScalarType = 'null' | 'bool' | 'int' | 'float' | 'str';

interface YBase {
    start: number;
    end: number;
    tag?: string;
    tagStart?: number;
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
}

export interface YDocument {
    root: YNode | undefined;
    errors: YError[];
}

export function parseYaml(text: string): YDocument {
    return new Parser(text).parseDocument();
}

/** Resolves a plain scalar according to the YAML 1.2 core schema. */
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
    if (/^[-+]?[0-9]+$/.test(s)) {
        return { value: parseInt(s, 10), type: 'int' };
    }
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
        return { value: parseInt(s.slice(2), 16), type: 'int' };
    }
    if (/^0o[0-7]+$/.test(s)) {
        return { value: parseInt(s.slice(2), 8), type: 'int' };
    }
    if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) {
        return { value: parseFloat(s), type: 'float' };
    }
    if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) {
        return { value: s.startsWith('-') ? -Infinity : Infinity, type: 'float' };
    }
    if (/^\.(nan|NaN|NAN)$/.test(s)) {
        return { value: NaN, type: 'float' };
    }
    return { value: s, type: 'str' };
}

type Ctx = 'doc' | 'mapValue' | 'seqItem';

const FLOW_INDICATORS = ',[]{}';

class Parser {
    private pos = 0;
    private readonly errors: YError[] = [];
    private readonly anchors = new Map<string, YNode>();

    constructor(private readonly t: string) {
        if (t.charCodeAt(0) === 0xfeff) {
            this.pos = 1;
        }
    }

    // ---------------------------------------------------------------- helpers

    private get ch(): string | undefined {
        return this.t[this.pos];
    }

    private eof(p = this.pos): boolean {
        return p >= this.t.length;
    }

    private isBreak(c: string | undefined): boolean {
        return c === '\n' || c === '\r';
    }

    private isWsOrEnd(p: number): boolean {
        const c = this.t[p];
        return c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r';
    }

    private lineStart(p: number): number {
        let i = p;
        while (i > 0 && this.t[i - 1] !== '\n') {
            i--;
        }
        return i;
    }

    private col(p = this.pos): number {
        return p - this.lineStart(p);
    }

    private lineEnd(p: number): number {
        let i = p;
        while (i < this.t.length && !this.isBreak(this.t[i])) {
            i++;
        }
        return i;
    }

    private error(start: number, end: number, message: string, severity: 'error' | 'warning' = 'error'): void {
        this.errors.push({ start, end: Math.max(end, start + 1), message, severity });
    }

    private skipInline(): void {
        while (this.ch === ' ' || this.ch === '\t') {
            this.pos++;
        }
    }

    private skipToEol(): void {
        this.pos = this.lineEnd(this.pos);
    }

    private skipBreak(): void {
        if (this.ch === '\r') {
            this.pos++;
        }
        if (this.ch === '\n') {
            this.pos++;
        }
    }

    private atCommentOrBreak(): boolean {
        const c = this.ch;
        return c === undefined || c === '#' || this.isBreak(c);
    }

    /** Skips spaces, comments and line breaks. Returns true if a line break was crossed. */
    private skipBlank(): boolean {
        let crossed = false;
        for (;;) {
            this.skipInline();
            const c = this.ch;
            if (c === '#') {
                this.skipToEol();
                continue;
            }
            if (this.isBreak(c)) {
                this.skipBreak();
                crossed = true;
                this.checkIndentTabs();
                continue;
            }
            return crossed;
        }
    }

    private checkIndentTabs(): void {
        let i = this.pos;
        while (this.t[i] === ' ') {
            i++;
        }
        if (this.t[i] !== '\t') {
            return;
        }
        let j = i;
        while (this.t[j] === ' ' || this.t[j] === '\t') {
            j++;
        }
        if (j < this.t.length && !this.isBreak(this.t[j]) && this.t[j] !== '#') {
            this.error(i, j, 'Tab characters must not be used for indentation');
        }
    }

    private isDocMarker(p: number, marker?: string): boolean {
        if (this.col(p) !== 0) {
            return false;
        }
        const m = this.t.slice(p, p + 3);
        if (marker ? m !== marker : m !== '---' && m !== '...') {
            return false;
        }
        return this.isWsOrEnd(p + 3);
    }

    private isSeqStart(p: number): boolean {
        return this.t[p] === '-' && this.isWsOrEnd(p + 1);
    }

    /** Makes sure nothing but a comment follows on the current line. Does not move `pos`. */
    private checkLineEnd(): void {
        const save = this.pos;
        this.skipInline();
        if (!this.atCommentOrBreak()) {
            const end = this.lineEnd(this.pos);
            this.error(this.pos, end, 'Unexpected content');
            this.pos = end;
            return;
        }
        this.pos = save;
    }

    /**
     * Returns the index of the ':' that terminates an implicit key starting at
     * `p`, or -1 when the line at `p` is not a `key: value` line.
     */
    findKeyColon(p: number): number {
        const t = this.t;
        let i = p;
        const c = t[i];
        if (c === '"' || c === "'") {
            const end = this.scanQuotedEnd(i);
            if (end < 0) {
                return -1;
            }
            i = end;
            while (t[i] === ' ' || t[i] === '\t') {
                i++;
            }
            return t[i] === ':' && this.isWsOrEnd(i + 1) ? i : -1;
        }
        if (c === undefined || '#|>@`%{}[],&*!'.includes(c)) {
            return -1;
        }
        while (i < t.length && !this.isBreak(t[i])) {
            if (t[i] === ':' && this.isWsOrEnd(i + 1)) {
                return i;
            }
            if (t[i] === '#' && (t[i - 1] === ' ' || t[i - 1] === '\t')) {
                return -1;
            }
            i++;
        }
        return -1;
    }

    /** End (exclusive) of a quoted scalar on a single line, or -1. */
    private scanQuotedEnd(p: number): number {
        const q = this.t[p];
        let i = p + 1;
        while (i < this.t.length && !this.isBreak(this.t[i])) {
            const c = this.t[i];
            if (q === '"' && c === '\\') {
                i += 2;
                continue;
            }
            if (c === q) {
                if (q === "'" && this.t[i + 1] === "'") {
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i++;
        }
        return -1;
    }

    // --------------------------------------------------------------- document

    parseDocument(): YDocument {
        this.skipBlank();
        while (this.ch === '%' && this.col() === 0) {
            this.skipToEol();
            this.skipBlank();
        }
        if (this.isDocMarker(this.pos, '---')) {
            this.pos += 3;
        }
        let root: YNode | undefined = this.parseNode(-1, 'doc');
        if (root.kind === 'scalar' && root.type === 'null' && root.start === root.end && !root.tag && !root.anchor) {
            root = undefined;
        }
        this.checkLineEnd();
        this.skipBlank();
        while (!this.eof()) {
            if (this.isDocMarker(this.pos, '...')) {
                this.pos += 3;
                this.skipBlank();
                continue;
            }
            if (this.isDocMarker(this.pos, '---')) {
                this.error(this.pos, this.pos + 3, 'Only the first YAML document is validated', 'warning');
                break;
            }
            const end = this.lineEnd(this.pos);
            this.error(this.pos, end, this.col() > 0 ? 'Bad indentation' : 'Unexpected content');
            this.pos = end;
            this.skipBlank();
        }
        return { root, errors: this.errors };
    }

    // ------------------------------------------------------------ block nodes

    private nullAt(p: number): YScalar {
        return { kind: 'scalar', value: null, type: 'null', style: 'plain', start: p, end: p };
    }

    private parseNode(parentIndent: number, ctx: Ctx): YNode {
        const before = this.pos;
        const crossed = this.skipBlank();
        if (this.eof() || (crossed && this.isDocMarker(this.pos))) {
            this.pos = before;
            return this.nullAt(before);
        }
        const c = this.col();
        if (crossed && c <= parentIndent) {
            if (ctx === 'mapValue' && c === parentIndent && this.isSeqStart(this.pos)) {
                return this.parseBlockSeq(c);
            }
            this.pos = before;
            return this.nullAt(before);
        }

        let tag: string | undefined;
        let tagStart: number | undefined;
        let anchor: string | undefined;
        while (this.ch === '!' || this.ch === '&') {
            const s = this.pos;
            while (!this.isWsOrEnd(this.pos)) {
                this.pos++;
            }
            const tok = this.t.slice(s, this.pos);
            if (tok[0] === '!') {
                tag = tok;
                tagStart = s;
            } else {
                anchor = tok.slice(1);
                if (!anchor) {
                    this.error(s, this.pos, 'Missing anchor name');
                }
            }
            this.skipInline();
        }

        let node: YNode;
        if ((tag !== undefined || anchor !== undefined) && this.atCommentOrBreak()) {
            const afterProps = this.pos;
            node = this.parseNode(parentIndent, ctx);
            if (node.kind === 'scalar' && node.start === node.end) {
                node.start = node.end = afterProps;
            }
        } else {
            node = this.parseContent(parentIndent, ctx, !crossed);
        }
        if (tag !== undefined) {
            node.tag = tag;
            node.tagStart = tagStart;
        }
        if (anchor) {
            node.anchor = anchor;
            this.anchors.set(anchor, node);
        }
        return node;
    }

    private parseContent(parentIndent: number, ctx: Ctx, sameLine: boolean): YNode {
        const c = this.col();
        const ch = this.ch;
        if (ch === '-' && this.isWsOrEnd(this.pos + 1)) {
            if (sameLine && ctx === 'mapValue') {
                this.error(this.pos, this.pos + 1, 'A block sequence may not start on the same line as its key');
            }
            return this.parseBlockSeq(c);
        }
        if (ch === '|' || ch === '>') {
            return this.parseBlockScalar(parentIndent);
        }
        if (ch === '*') {
            return this.parseAlias(false);
        }
        if (ch === '[' || ch === '{') {
            const node = this.parseFlowNode();
            this.skipInline();
            if (this.ch === ':' && this.isWsOrEnd(this.pos + 1)) {
                this.error(node.start, this.pos + 1, 'Complex mapping keys are not supported');
                this.skipToEol();
            }
            return node;
        }
        if (ch === '?' && this.isWsOrEnd(this.pos + 1)) {
            const s = this.pos;
            this.skipToEol();
            this.error(s, this.pos, 'Complex mapping keys are not supported');
            return this.nullAt(s);
        }
        if (this.findKeyColon(this.pos) >= 0) {
            if (sameLine && ctx === 'mapValue') {
                this.error(this.pos, this.lineEnd(this.pos), 'Nested mappings are not allowed on the same line as their key');
            }
            return this.parseBlockMap(c);
        }
        if (ch === '"' || ch === "'") {
            return this.parseQuoted();
        }
        return this.parsePlain(parentIndent, false);
    }

    private parseBlockMap(indent: number): YMap {
        const map: YMap = { kind: 'map', pairs: [], start: this.pos, end: this.pos };
        const seen = new Set<string>();
        for (;;) {
            const key = this.parseKey();
            if (!key) {
                const s = this.pos;
                this.skipToEol();
                this.error(s, this.pos, "Expected a 'key: value' mapping entry");
            } else {
                const k = String(key.value);
                if (seen.has(k)) {
                    this.error(key.start, key.end, `Duplicate key '${k}'`);
                }
                seen.add(k);
                this.pos++; // ':'
                const value = this.parseNode(indent, 'mapValue');
                map.pairs.push({ key, value });
                map.end = Math.max(key.end + 1, value.end);
                this.checkLineEnd();
            }
            if (!this.nextAtIndent(indent, false)) {
                break;
            }
        }
        return map;
    }

    /**
     * Moves to the next entry of a block collection at `indent`. Lines that are
     * indented deeper are reported and skipped. Returns false (and restores the
     * position) when the collection ends.
     */
    private nextAtIndent(indent: number, seq: boolean): boolean {
        for (;;) {
            const save = this.pos;
            this.skipBlank();
            if (this.eof() || this.isDocMarker(this.pos)) {
                this.pos = save;
                return false;
            }
            const c = this.col();
            if (c < indent) {
                this.pos = save;
                return false;
            }
            if (c > indent) {
                const s = this.pos;
                this.skipToEol();
                this.error(s, this.pos, 'Bad indentation');
                // skip the rest of the wrongly indented block
                for (;;) {
                    const save2 = this.pos;
                    this.skipBlank();
                    if (this.eof() || this.col() <= indent) {
                        this.pos = save2;
                        break;
                    }
                    this.skipToEol();
                }
                continue;
            }
            const isItem = this.isSeqStart(this.pos);
            if (seq === isItem) {
                return true;
            }
            if (!seq) {
                // a sequence item at the indentation of mapping keys
                const s = this.pos;
                this.skipToEol();
                this.error(s, this.pos, "Expected a 'key: value' mapping entry, found a sequence item");
                continue;
            }
            this.pos = save;
            return false;
        }
    }

    private parseKey(): YScalar | undefined {
        const colon = this.findKeyColon(this.pos);
        if (colon < 0) {
            return undefined;
        }
        const c = this.ch;
        let key: YScalar;
        if (c === '"' || c === "'") {
            key = this.parseQuoted();
        } else {
            let e = colon;
            while (e > this.pos && (this.t[e - 1] === ' ' || this.t[e - 1] === '\t')) {
                e--;
            }
            const raw = this.t.slice(this.pos, e);
            key = { kind: 'scalar', value: raw, type: 'str', style: 'plain', start: this.pos, end: e };
        }
        this.pos = colon;
        return key;
    }

    private parseBlockSeq(indent: number): YSeq {
        const seq: YSeq = { kind: 'seq', items: [], start: this.pos, end: this.pos };
        for (;;) {
            const dash = this.pos;
            this.pos++;
            const item = this.parseNode(indent, 'seqItem');
            seq.items.push(item);
            seq.end = Math.max(dash + 1, item.end);
            this.checkLineEnd();
            if (!this.nextAtIndent(indent, true)) {
                break;
            }
        }
        return seq;
    }

    private parseAlias(flow: boolean): YAlias {
        const s = this.pos;
        this.pos++;
        while (!this.isWsOrEnd(this.pos) && !(flow && FLOW_INDICATORS.includes(this.ch!))) {
            this.pos++;
        }
        const name = this.t.slice(s + 1, this.pos);
        const target = this.anchors.get(name);
        if (!target) {
            this.error(s, this.pos, `Unknown anchor '${name}'`);
        }
        return { kind: 'alias', name, target, start: s, end: this.pos };
    }

    private parseBlockScalar(parentIndent: number): YScalar {
        const start = this.pos;
        const literal = this.ch === '|';
        this.pos++;
        let chomp: 'clip' | 'strip' | 'keep' = 'clip';
        let explicit = 0;
        for (let k = 0; k < 2; k++) {
            const c = this.ch;
            if (c === '-' || c === '+') {
                chomp = c === '-' ? 'strip' : 'keep';
                this.pos++;
            } else if (c !== undefined && c >= '1' && c <= '9') {
                explicit = Number(c);
                this.pos++;
            }
        }
        this.skipInline();
        if (this.ch === '#') {
            this.skipToEol();
        }
        if (!this.atCommentOrBreak()) {
            const s = this.pos;
            this.skipToEol();
            this.error(s, this.pos, 'Invalid block scalar header');
        }
        let end = this.pos;
        const base = Math.max(parentIndent, 0);
        let indent = explicit ? base + explicit : -1;
        const lines: string[] = [];
        let trailing = 0;
        let p = this.pos;
        while (p < this.t.length) {
            // p is at a line break
            let q = p;
            if (this.t[q] === '\r') {
                q++;
            }
            if (this.t[q] === '\n') {
                q++;
            }
            if (q === p) {
                break;
            }
            const le = this.lineEnd(q);
            const line = this.t.slice(q, le);
            let sp = 0;
            while (line[sp] === ' ') {
                sp++;
            }
            if (sp === line.length || (indent >= 0 && sp >= indent && line.trim() === '')) {
                lines.push('');
                trailing++;
                p = le;
                continue;
            }
            if (indent < 0) {
                if (sp <= parentIndent) {
                    break;
                }
                indent = sp;
            }
            if (sp < indent) {
                break;
            }
            lines.push(line.slice(indent));
            trailing = 0;
            p = le;
            end = le;
        }
        this.pos = end;
        const content = lines.slice(0, lines.length - trailing);
        let value = literal ? content.join('\n') : foldLines(content);
        if (content.length > 0) {
            if (chomp === 'clip') {
                value += '\n';
            } else if (chomp === 'keep') {
                value += '\n' + '\n'.repeat(trailing);
            }
        }
        return { kind: 'scalar', value, type: 'str', style: literal ? 'literal' : 'folded', start, end };
    }

    private parseQuoted(): YScalar {
        const start = this.pos;
        const q = this.ch!;
        this.pos++;
        let out = '';
        for (;;) {
            const c = this.ch;
            if (c === undefined) {
                this.error(start, this.pos, 'Unterminated quoted string');
                break;
            }
            if (c === q) {
                if (q === "'" && this.t[this.pos + 1] === "'") {
                    out += "'";
                    this.pos += 2;
                    continue;
                }
                this.pos++;
                break;
            }
            if (q === '"' && c === '\\') {
                const n = this.t[this.pos + 1];
                if (this.isBreak(n)) {
                    this.pos++;
                    this.skipBreak();
                    this.skipInline();
                    continue;
                }
                const esc = decodeEscape(this.t, this.pos + 1);
                if (!esc) {
                    this.error(this.pos, this.pos + 2, `Invalid escape sequence '\\${n ?? ''}'`);
                    this.pos += 2;
                    continue;
                }
                out += esc.text;
                this.pos += 1 + esc.length;
                continue;
            }
            if (this.isBreak(c)) {
                out = out.replace(/[ \t]+$/, '');
                let breaks = 0;
                while (this.isBreak(this.ch)) {
                    this.skipBreak();
                    breaks++;
                    this.skipInline();
                }
                out += breaks > 1 ? '\n'.repeat(breaks - 1) : ' ';
                continue;
            }
            out += c;
            this.pos++;
        }
        return { kind: 'scalar', value: out, type: 'str', style: q === '"' ? 'double' : 'single', start, end: this.pos };
    }

    /** Plain scalar. In block context it may continue on more indented lines. */
    private parsePlain(parentIndent: number, flow: boolean): YScalar {
        const start = this.pos;
        let text = this.readPlainLine(flow);
        let end = start + text.length;
        if (!flow) {
            for (;;) {
                // the rest of the current line must be blank (a comment ends the scalar)
                const le = this.lineEnd(end);
                if (this.t.slice(end, le).trim() !== '') {
                    break;
                }
                // find the next non-blank line
                let p = le;
                let breaks = 0;
                let next = -1;
                while (p < this.t.length) {
                    let q = p;
                    if (this.t[q] === '\r') {
                        q++;
                    }
                    if (this.t[q] === '\n') {
                        q++;
                    }
                    if (q === p) {
                        break;
                    }
                    breaks++;
                    let s = q;
                    while (this.t[s] === ' ' || this.t[s] === '\t') {
                        s++;
                    }
                    if (s >= this.t.length || this.isBreak(this.t[s])) {
                        p = s;
                        continue;
                    }
                    next = s;
                    break;
                }
                if (next < 0) {
                    break;
                }
                if (
                    this.col(next) <= parentIndent ||
                    this.t[next] === '#' ||
                    this.isDocMarker(next) ||
                    this.isSeqStart(next) ||
                    this.findKeyColon(next) >= 0
                ) {
                    break;
                }
                this.pos = next;
                const more = this.readPlainLine(false);
                if (!more) {
                    break;
                }
                text += breaks > 1 ? '\n'.repeat(breaks - 1) : ' ';
                text += more;
                end = next + more.length;
            }
        }
        this.pos = end;
        const r = resolvePlain(text);
        return { kind: 'scalar', value: r.value, type: r.type, style: 'plain', start, end };
    }

    /** Reads plain scalar text on the current line, trimmed. Leaves `pos` unchanged. */
    private readPlainLine(flow: boolean): string {
        const t = this.t;
        let i = this.pos;
        while (i < t.length && !this.isBreak(t[i])) {
            const c = t[i];
            if (c === ':' && (this.isWsOrEnd(i + 1) || (flow && FLOW_INDICATORS.includes(t[i + 1] ?? '')))) {
                break;
            }
            if (c === '#' && i > this.pos && (t[i - 1] === ' ' || t[i - 1] === '\t')) {
                break;
            }
            if (flow && FLOW_INDICATORS.includes(c)) {
                break;
            }
            i++;
        }
        return t.slice(this.pos, i).replace(/[ \t]+$/, '');
    }

    // ------------------------------------------------------------- flow nodes

    private skipFlowBlank(): void {
        for (;;) {
            this.skipInline();
            const c = this.ch;
            if (c === '#') {
                this.skipToEol();
            } else if (this.isBreak(c)) {
                this.skipBreak();
            } else {
                return;
            }
        }
    }

    private parseFlowNode(): YNode {
        this.skipFlowBlank();
        let tag: string | undefined;
        let tagStart: number | undefined;
        let anchor: string | undefined;
        while (this.ch === '!' || this.ch === '&') {
            const s = this.pos;
            while (!this.isWsOrEnd(this.pos) && !FLOW_INDICATORS.includes(this.ch!)) {
                this.pos++;
            }
            const tok = this.t.slice(s, this.pos);
            if (tok[0] === '!') {
                tag = tok;
                tagStart = s;
            } else {
                anchor = tok.slice(1);
            }
            this.skipFlowBlank();
        }
        let node: YNode;
        const c = this.ch;
        if (c === '[') {
            node = this.parseFlowSeq();
        } else if (c === '{') {
            node = this.parseFlowMap();
        } else if (c === '"' || c === "'") {
            node = this.parseQuoted();
        } else if (c === '*') {
            node = this.parseAlias(true);
        } else if (c === undefined || FLOW_INDICATORS.includes(c) || (c === ':' && this.isWsOrEnd(this.pos + 1))) {
            node = this.nullAt(this.pos);
        } else {
            node = this.parsePlain(-1, true);
        }
        if (tag !== undefined) {
            node.tag = tag;
            node.tagStart = tagStart;
        }
        if (anchor) {
            node.anchor = anchor;
            this.anchors.set(anchor, node);
        }
        return node;
    }

    private parseFlowSeq(): YSeq {
        const seq: YSeq = { kind: 'seq', items: [], start: this.pos, end: this.pos };
        this.pos++;
        for (;;) {
            this.skipFlowBlank();
            if (this.eof()) {
                this.error(seq.start, this.pos, "Unterminated flow sequence, expected ']'");
                break;
            }
            if (this.ch === ']') {
                this.pos++;
                break;
            }
            const item = this.parseFlowNode();
            seq.items.push(item);
            this.skipFlowBlank();
            if (this.ch === ':') {
                this.error(item.start, this.pos + 1, 'Mappings inside flow sequences are not supported');
                this.pos++;
                this.parseFlowNode();
                this.skipFlowBlank();
            }
            if (this.ch === ',') {
                this.pos++;
            } else if (this.ch !== ']') {
                if (this.eof()) {
                    continue;
                }
                this.error(this.pos, this.pos + 1, "Expected ',' or ']'");
                this.pos++;
            }
        }
        seq.end = this.pos;
        return seq;
    }

    private parseFlowMap(): YMap {
        const map: YMap = { kind: 'map', pairs: [], start: this.pos, end: this.pos };
        const seen = new Set<string>();
        this.pos++;
        for (;;) {
            this.skipFlowBlank();
            if (this.eof()) {
                this.error(map.start, this.pos, "Unterminated flow mapping, expected '}'");
                break;
            }
            if (this.ch === '}') {
                this.pos++;
                break;
            }
            const keyNode = this.parseFlowNode();
            let key: YScalar;
            if (keyNode.kind !== 'scalar') {
                this.error(keyNode.start, keyNode.end, 'Only scalar mapping keys are supported');
                key = { kind: 'scalar', value: '', type: 'str', style: 'plain', start: keyNode.start, end: keyNode.end };
            } else {
                key = keyNode;
                if (key.value !== null) {
                    key.value = String(key.value);
                    key.type = 'str';
                }
            }
            const k = String(key.value);
            if (seen.has(k)) {
                this.error(key.start, key.end, `Duplicate key '${k}'`);
            }
            seen.add(k);
            this.skipFlowBlank();
            let value: YNode;
            if (this.ch === ':') {
                this.pos++;
                this.skipFlowBlank();
                const next = this.t[this.pos];
                value = next === ',' || next === '}' ? this.nullAt(this.pos) : this.parseFlowNode();
            } else {
                value = this.nullAt(key.end);
            }
            map.pairs.push({ key, value });
            this.skipFlowBlank();
            if (this.ch === ',') {
                this.pos++;
            } else if (this.ch !== '}') {
                if (this.eof()) {
                    continue;
                }
                this.error(this.pos, this.pos + 1, "Expected ',' or '}'");
                this.pos++;
            }
        }
        map.end = this.pos;
        return map;
    }
}

function foldLines(lines: string[]): string {
    let out = '';
    let prev: 'none' | 'text' | 'more' | 'blank' = 'none';
    let lastNonBlank: 'none' | 'text' | 'more' = 'none';
    for (const line of lines) {
        if (line === '') {
            out += '\n';
            prev = 'blank';
            continue;
        }
        const more = line[0] === ' ' || line[0] === '\t';
        if (prev === 'text' && !more) {
            out += ' ';
        } else if (prev === 'more' || (prev === 'text' && more)) {
            out += '\n';
        } else if (prev === 'blank' && (more || lastNonBlank === 'more')) {
            out += '\n';
        }
        out += line;
        prev = more ? 'more' : 'text';
        lastNonBlank = prev;
    }
    return out;
}

function decodeEscape(t: string, p: number): { text: string; length: number } | undefined {
    const c = t[p];
    const simple: Record<string, string> = {
        '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
        ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ',
    };
    if (c !== undefined && c in simple) {
        return { text: simple[c], length: 1 };
    }
    const hexLen = c === 'x' ? 2 : c === 'u' ? 4 : c === 'U' ? 8 : 0;
    if (hexLen) {
        const hex = t.slice(p + 1, p + 1 + hexLen);
        if (hex.length === hexLen && /^[0-9a-fA-F]+$/.test(hex)) {
            return { text: String.fromCodePoint(parseInt(hex, 16)), length: 1 + hexLen };
        }
    }
    return undefined;
}
