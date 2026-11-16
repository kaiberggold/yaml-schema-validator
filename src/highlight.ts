import * as vscode from 'vscode';
import { TextRange, childHighlights } from './core/highlight';
import { isYamlFile } from './core/paths';
import { parseYaml } from './core/yaml';

const SETTING = 'highlightChildren';

/**
 * Colours the entries below configured keys (`yamlSchema.highlightChildren`)
 * with editor decorations, drawn on top of the syntax colours of any grammar
 * (built-in or Red Hat YAML).
 */
export class ChildHighlighter implements vscode.Disposable {
    private names = new Map<string, vscode.TextEditorDecorationType>();
    private timer: NodeJS.Timeout | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.readSettings();
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
                    this.schedule();
                }
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(`yamlSchema.${SETTING}`)) {
                    this.readSettings();
                    this.refresh();
                }
            }),
        );
        this.refresh();
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.names.forEach((d) => d.dispose());
        this.disposables.forEach((d) => d.dispose());
    }

    private readSettings(): void {
        this.names.forEach((d) => d.dispose());
        this.names = new Map();
        const map = vscode.workspace.getConfiguration('yamlSchema').get<Record<string, unknown>>(SETTING, {});
        for (const [name, color] of Object.entries(map ?? {})) {
            if (typeof color === 'string' && color.trim()) {
                this.names.set(name, vscode.window.createTextEditorDecorationType({ color: toColor(color.trim()) }));
            }
        }
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 150);
    }

    private refresh(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const doc = editor.document;
            if (doc.languageId !== 'yaml' && !isYamlFile(doc.uri.fsPath)) {
                continue;
            }
            const found = this.names.size ? childHighlights(parseYaml(doc.getText()), new Set(this.names.keys())) : new Map<string, TextRange[]>();
            for (const [name, type] of this.names) {
                const ranges = (found.get(name) ?? []).map((r) => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)));
                editor.setDecorations(type, ranges);
            }
        }
    }
}

/** `#hex` / CSS colour names as given; `group.name` ids (e.g. `charts.orange`) as theme colours. */
function toColor(value: string): string | vscode.ThemeColor {
    return /^[a-z]+(\.[a-zA-Z0-9]+)+$/.test(value) ? new vscode.ThemeColor(value) : value;
}
