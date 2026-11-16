import { YDocument, YNode } from './yaml';

export interface TextRange {
    start: number;
    end: number;
}

/**
 * Ranges to colour for `yamlSchema.highlightChildren`: below a key named in
 * `names`, the keys of its mapping or the scalar items of its list (direct
 * children only), wherever the key appears in the document. Grouped by name.
 */
export function childHighlights(doc: YDocument, names: Set<string>): Map<string, TextRange[]> {
    const out = new Map<string, TextRange[]>();
    if (!names.size || !doc.root) {
        return out;
    }
    const add = (name: string, r: TextRange) => {
        if (r.end > r.start) {
            let list = out.get(name);
            if (!list) {
                out.set(name, (list = []));
            }
            list.push(r);
        }
    };
    const walk = (n: YNode) => {
        if (n.kind === 'map') {
            for (const p of n.pairs) {
                const key = typeof p.key.value === 'string' ? p.key.value : String(p.key.value);
                if (names.has(key)) {
                    const v = p.value;
                    if (v.kind === 'map') {
                        v.pairs.forEach((c) => add(key, { start: c.key.start, end: c.key.end }));
                    } else if (v.kind === 'seq') {
                        v.items.filter((i) => i.kind === 'scalar').forEach((i) => add(key, { start: i.start, end: i.end }));
                    }
                }
                walk(p.value);
            }
        } else if (n.kind === 'seq') {
            n.items.forEach(walk);
        }
    };
    walk(doc.root);
    return out;
}
