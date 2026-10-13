import * as path from 'path';
import * as vscode from 'vscode';
import { inferScheme } from './core/assist';
import { Resolver, toJs } from './core/effective';
import { configCandidates, isSchemeFile, isYamlFile, schemeCandidates } from './core/paths';
import { Manager } from './manager';
import { AnchorReferenceProvider, CompletionProvider, DefinitionProvider, HoverProvider, LinkProvider, SELECTOR } from './providers';

export function activate(context: vscode.ExtensionContext): void {
    const log = vscode.window.createOutputChannel('YAML Scheme Validator');
    const manager = new Manager(log);
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    context.subscriptions.push(
        log,
        manager,
        status,
        vscode.languages.registerCompletionItemProvider(SELECTOR, new CompletionProvider(manager), ':', ' ', '/', '-'),
        vscode.languages.registerHoverProvider(SELECTOR, new HoverProvider(manager)),
        vscode.languages.registerDefinitionProvider(SELECTOR, new DefinitionProvider(manager)),
        vscode.languages.registerDocumentLinkProvider(SELECTOR, new LinkProvider(manager)),
        vscode.languages.registerReferenceProvider(SELECTOR, new AnchorReferenceProvider(manager)),
        vscode.commands.registerCommand('yamlScheme.revalidateAll', () => manager.revalidateAll()),
        vscode.commands.registerCommand('yamlScheme.openScheme', () => openScheme(manager)),
        vscode.commands.registerCommand('yamlScheme.addModeline', () => addModeline(manager)),
        vscode.window.onDidChangeActiveTextEditor(() => updateStatus(manager, status)),
        manager.onDidUpdate(() => updateStatus(manager, status)),
    );

    void manager.revalidateAll().then(() => updateStatus(manager, status));
}

export function deactivate(): void {
    // everything is disposed through the extension context
}

function updateStatus(manager: Manager, status: vscode.StatusBarItem): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file' || !isYamlFile(doc.uri.fsPath)) {
        status.hide();
        return;
    }
    const file = doc.uri.fsPath;
    const info = manager.schemaFor(file);
    if (isSchemeFile(file)) {
        status.text = '$(symbol-ruler) scheme file';
        status.tooltip = 'Validated against the built-in scheme definition. Click to open the validated YAML file.';
    } else if (info?.includedBy) {
        status.text = `$(symbol-ruler) via ${path.basename(info.includedBy)}`;
        status.tooltip = `Included by ${info.includedBy}; validated with ${info.scheme}`;
    } else if (info) {
        const declared = manager.engine.declaredScheme(file);
        status.text = `$(symbol-ruler) ${path.basename(info.scheme)}`;
        status.tooltip = `Validated with ${info.scheme}${declared ? ' (declared in the first line)' : ''}`;
    } else if (manager.isManaged(file)) {
        status.text = '$(symbol-ruler) included';
        status.tooltip = 'Included by a validated file';
    } else {
        status.text = '$(symbol-ruler) no scheme';
        status.tooltip = `No ${path.basename(schemeCandidates(file)[0])} found. Click to create one.`;
    }
    status.command = 'yamlScheme.openScheme';
    status.show();
}

async function openScheme(manager: Manager): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file' || !isYamlFile(doc.uri.fsPath)) {
        void vscode.window.showInformationMessage('Open a YAML file first.');
        return;
    }
    const file = doc.uri.fsPath;
    const engine = manager.engine;
    if (isSchemeFile(file)) {
        const config = configCandidates(file).find((c) => engine.exists(c));
        if (config) {
            await vscode.window.showTextDocument(vscode.Uri.file(config));
        } else {
            void vscode.window.showInformationMessage(`No YAML file found for ${path.basename(file)}.`);
        }
        return;
    }
    const existing = engine.findScheme(file);
    if (existing && engine.exists(existing)) {
        await vscode.window.showTextDocument(vscode.Uri.file(existing));
        return;
    }
    // a declared but missing scheme is created at the declared path
    const target = existing ?? schemeCandidates(file)[0];
    const choice = await vscode.window.showInformationMessage(
        `${path.basename(file)} has no scheme. Create ${path.basename(target)} from its current content?`,
        'Create',
    );
    if (choice !== 'Create') {
        return;
    }
    const root = new Resolver(engine.docs, manager.extendKeyword, () => undefined).buildFile(file);
    const body = inferScheme(root ? toJs(root) : {});
    const text = `# Scheme for ${path.basename(file)}. Generated from its content (JSON Schema 2020-12) - adjust types, add descriptions and \`required: [keys]\` lists.\n${body}`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(text, 'utf8'));
    await vscode.window.showTextDocument(vscode.Uri.file(target));
}

/**
 * Writes `# yaml-language-server: $schema=<scheme>` as the first line of the
 * current file, so that the Red Hat YAML extension (and other tools based on
 * yaml-language-server) use the same scheme. An existing declaration is replaced.
 */
async function addModeline(manager: Manager): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (!editor || !doc || doc.uri.scheme !== 'file' || !isYamlFile(doc.uri.fsPath) || isSchemeFile(doc.uri.fsPath)) {
        void vscode.window.showInformationMessage('Open a YAML file that is validated by a scheme first.');
        return;
    }
    const file = doc.uri.fsPath;
    const scheme = manager.engine.findScheme(file);
    if (!scheme || !manager.engine.exists(scheme)) {
        void vscode.window.showInformationMessage(`${path.basename(file)} has no scheme yet.`);
        return;
    }
    let rel = path.relative(path.dirname(file), scheme).split(path.sep).join('/');
    if (/\s/.test(rel)) {
        rel = JSON.stringify(rel);
    }
    const modeline = `# yaml-language-server: $schema=${rel}`;
    const declared = manager.engine.declaredScheme(file);
    await editor.edit((b) => {
        if (declared) {
            b.replace(doc.lineAt(0).range, modeline);
        } else {
            b.insert(new vscode.Position(0, 0), modeline + (doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
        }
    });
    // let Red Hat YAML accept the include tag
    if (vscode.extensions.getExtension('redhat.vscode-yaml')) {
        const tag = `!${manager.extendKeyword}`;
        const config = vscode.workspace.getConfiguration('yaml');
        const tags = config.get<string[]>('customTags', []);
        const wanted = [`${tag} scalar`, `${tag} sequence`].filter((t) => !tags.includes(t));
        if (wanted.length) {
            try {
                await config.update('customTags', [...tags, ...wanted], vscode.ConfigurationTarget.Workspace);
            } catch {
                // no workspace folder or setting not writable: the modeline still works
            }
        }
    }
}
