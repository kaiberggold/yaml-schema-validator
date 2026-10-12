import * as path from 'path';

const SCHEME_RE = /\.scheme\.ya?ml$/i;
const YAML_RE = /\.ya?ml$/i;

export function isYamlFile(file: string): boolean {
    return YAML_RE.test(file);
}

export function isSchemeFile(file: string): boolean {
    return SCHEME_RE.test(file);
}

/**
 * Candidate scheme files for a config file, most preferred first:
 * `dir/name.yml` -> `dir/name.scheme.yml`, `dir/name.scheme.yaml`.
 */
export function schemeCandidates(configFile: string): string[] {
    const ext = path.extname(configFile);
    const base = configFile.slice(0, configFile.length - ext.length);
    const other = ext.toLowerCase() === '.yml' ? '.yaml' : '.yml';
    return [`${base}.scheme${ext}`, `${base}.scheme${other}`];
}

/** Candidate config files for a scheme file: `name.scheme.yml` -> `name.yml`, `name.yaml`. */
export function configCandidates(schemeFile: string): string[] {
    const m = /\.scheme(\.ya?ml)$/i.exec(schemeFile);
    if (!m) {
        return [];
    }
    const base = schemeFile.slice(0, m.index);
    const other = m[1].toLowerCase() === '.yml' ? '.yaml' : '.yml';
    return [`${base}${m[1]}`, `${base}${other}`];
}

/** Normalised key for maps of file paths (case-insensitive on Windows / macOS default fs). */
export function fileKey(file: string): string {
    const n = path.normalize(file);
    return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

/** Resolves the path written in an `extend` entry relative to the including file. */
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
