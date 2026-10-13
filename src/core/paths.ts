import * as path from 'path';

const YAML_RE = /\.ya?ml$/i;
export const DEFAULT_SCHEME_INFIX = 'schema';

let infix = DEFAULT_SCHEME_INFIX;
let schemeRe = buildSchemeRe(infix);

function buildSchemeRe(i: string): RegExp {
    return new RegExp(`\\.${i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.ya?ml)$`, 'i');
}

/**
 * Sets the middle part of scheme file names (`name.<infix>.yml`). Invalid values
 * fall back to the default. Returns the value in effect.
 */
export function setSchemeInfix(value: string | undefined): string {
    const v = (value ?? '').trim().replace(/^\.+|\.+$/g, '');
    infix = /^[\w.-]+$/.test(v) ? v : DEFAULT_SCHEME_INFIX;
    schemeRe = buildSchemeRe(infix);
    return infix;
}

export function schemeInfix(): string {
    return infix;
}

export function isYamlFile(file: string): boolean {
    return YAML_RE.test(file);
}

export function isSchemeFile(file: string): boolean {
    return schemeRe.test(file);
}

/**
 * Candidate scheme files for a config file, most preferred first:
 * `dir/name.yml` -> `dir/name.schema.yml`, `dir/name.schema.yaml`.
 */
export function schemeCandidates(configFile: string): string[] {
    const ext = path.extname(configFile);
    const base = configFile.slice(0, configFile.length - ext.length);
    const other = ext.toLowerCase() === '.yml' ? '.yaml' : '.yml';
    return [`${base}.${infix}${ext}`, `${base}.${infix}${other}`];
}

/** Candidate config files for a scheme file: `name.schema.yml` -> `name.yml`, `name.yaml`. */
export function configCandidates(schemeFile: string): string[] {
    const m = schemeRe.exec(schemeFile);
    if (!m) {
        return [];
    }
    const base = schemeFile.slice(0, m.index);
    const other = m[1].toLowerCase() === '.yml' ? '.yaml' : '.yml';
    return [`${base}${m[1]}`, `${base}${other}`];
}

export interface SchemeDeclaration {
    /** Path as written in the file. */
    raw: string;
    /** Offsets of the path in the file. */
    start: number;
    end: number;
}

const DECLARATION_RE = /^(#\s*\$?(?:schema|scheme)\s*[:=]\s*)(["']?)([^"'\r\n]*?)\2\s*$/i;

/**
 * Scheme declared in the first line of a YAML file:
 * `# schema: path/to/file.schema.yml` (also `# $schema: ...`, `# scheme: ...`, `#schema=...`).
 */
export function schemeDeclaration(text: string): SchemeDeclaration | undefined {
    const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const nl = text.indexOf('\n', bom);
    const line = text.slice(bom, nl < 0 ? text.length : nl).replace(/\r$/, '');
    const m = DECLARATION_RE.exec(line);
    if (!m || !m[3].trim()) {
        return undefined;
    }
    const start = bom + m[1].length + m[2].length;
    return { raw: m[3], start, end: start + m[3].length };
}

/** Normalised key for maps of file paths (case-insensitive on Windows / macOS default fs). */
export function fileKey(file: string): string {
    const n = path.normalize(file);
    return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

/** Resolves the path written in an `extends` entry relative to the including file. */
export function resolveIncludePath(raw: string, fromFile: string, exists: (f: string) => boolean): string {
    let p = raw.trim();
    if (p.startsWith('~/') && process.env.HOME) {
        p = path.join(process.env.HOME, p.slice(2));
    }
    const resolved = path.resolve(path.dirname(fromFile), p);
    if (!isYamlFile(resolved) && !exists(resolved)) {
        for (const ext of ['.yml', '.yaml']) {
            if (exists(resolved + ext)) {
                return resolved + ext;
            }
        }
    }
    return resolved;
}

export function displayPath(file: string, relativeTo?: string): string {
    if (relativeTo) {
        const rel = path.relative(path.dirname(relativeTo), file);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            return rel.split(path.sep).join('/');
        }
    }
    return path.basename(file);
}
