import * as path from 'path';
import { Engine, EngineOptions, DEFAULT_OPTIONS, RootResult } from '../core/engine';
import { FileHost, Problem } from '../core/types';

export const ROOT = path.resolve('/workspace');

export function p(rel: string): string {
    return path.join(ROOT, rel);
}

/** In-memory file system. */
export class MemHost implements FileHost {
    readonly files = new Map<string, string>();

    constructor(files: Record<string, string> = {}) {
        for (const [k, v] of Object.entries(files)) {
            this.files.set(p(k), v);
        }
    }

    read(file: string): string | undefined {
        return this.files.get(path.normalize(file));
    }

    exists(file: string): boolean {
        return this.files.has(path.normalize(file));
    }
}

export function run(files: Record<string, string>, root: string, options: Partial<EngineOptions> = {}): RootResult {
    const engine = new Engine(new MemHost(files), { ...DEFAULT_OPTIONS, ...options });
    return engine.run([p(root)]).get(p(root))!;
}

/** "file:line message" strings of all problems, for compact assertions. */
export function summary(problems: Problem[]): string[] {
    return problems.map((x) => `${path.relative(ROOT, x.file)}:${x.range.start.line + 1} ${x.severity} ${x.message}`);
}
