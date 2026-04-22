import * as vscode from 'vscode';

interface FocusedScript {
	folderUri: string;
	packageUri: string;
	taskPath: string;
	script: string;
	label: string;
}

const STORAGE_KEY = 'npmScriptFocus.items';

function focusedKey(f: FocusedScript): string {
	return `${f.packageUri}|${f.script}`;
}

function getTaskFromMaybeItem(item: any): vscode.Task | undefined {
	return item && item.task instanceof vscode.Task ? (item.task as vscode.Task) : undefined;
}

function toFocusedScript(item: any): FocusedScript | undefined {
	const task = getTaskFromMaybeItem(item);
	if (!task) {
		return undefined;
	}
	const def = task.definition as { type: string; script?: string; path?: string };
	if (def.type !== 'npm' || !def.script) {
		return undefined;
	}
	const scope = task.scope as vscode.WorkspaceFolder | undefined;
	if (!scope || typeof scope !== 'object' || !scope.uri) {
		return undefined;
	}
	const packageUri = vscode.Uri.joinPath(scope.uri, def.path ?? '', 'package.json');
	return {
		folderUri: scope.uri.toString(),
		packageUri: packageUri.toString(),
		taskPath: def.path ?? '',
		script: def.script,
		label: task.name
	};
}

async function findNpmTask(f: FocusedScript): Promise<vscode.Task | undefined> {
	const tasks = await vscode.tasks.fetchTasks({ type: 'npm' });
	return tasks.find(t => {
		const def = t.definition as { type: string; script?: string; path?: string };
		if (def.script !== f.script) {
			return false;
		}
		if ((def.path ?? '') !== f.taskPath) {
			return false;
		}
		const scope = t.scope as vscode.WorkspaceFolder | undefined;
		return !!scope && typeof scope === 'object' && !!scope.uri && scope.uri.toString() === f.folderUri;
	});
}

function terminateMatching(task: vscode.Task): void {
	for (const execution of vscode.tasks.taskExecutions) {
		const a = execution.task;
		if (a.name === task.name && a.source === task.source && JSON.stringify(a.definition) === JSON.stringify(task.definition)) {
			execution.terminate();
		}
	}
}

function getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.find(f => f.uri.toString() === uri.toString());
}

async function findScriptPositionInDocument(doc: vscode.TextDocument, script: string): Promise<vscode.Position> {
	const text = doc.getText();
	const scriptsMatch = /"scripts"\s*:\s*\{/.exec(text);
	const startIdx = scriptsMatch ? scriptsMatch.index + scriptsMatch[0].length : 0;
	const needle = new RegExp(`"${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
	const m = needle.exec(text.slice(startIdx));
	if (!m) {
		return new vscode.Position(0, 0);
	}
	return doc.positionAt(startIdx + m.index);
}

class FocusedPackageItem extends vscode.TreeItem {
	constructor(public readonly packageUri: vscode.Uri, public readonly folderUri: vscode.Uri, public readonly taskPath: string) {
		super(vscode.workspace.asRelativePath(packageUri, true), vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = 'focusedPackageJSON';
		this.iconPath = new vscode.ThemeIcon('json');
		this.resourceUri = packageUri;
		this.tooltip = packageUri.fsPath;
	}
}

class FocusedScriptItem extends vscode.TreeItem {
	constructor(public readonly focused: FocusedScript) {
		super(focused.script, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'focusedScript';
		this.iconPath = new vscode.ThemeIcon('wrench');
		this.tooltip = focused.label;
		this.command = {
			title: 'Open Script',
			command: 'npmScriptFocus.openScript',
			arguments: [this]
		};
	}
}

class FocusStore {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	list(): FocusedScript[] {
		const raw = this.context.workspaceState.get<FocusedScript[]>(STORAGE_KEY, []);
		const clean = raw.filter(f => f
			&& typeof f.folderUri === 'string' && f.folderUri && f.folderUri !== 'undefined'
			&& typeof f.packageUri === 'string' && f.packageUri && f.packageUri !== 'undefined'
			&& typeof f.script === 'string' && f.script);
		if (clean.length !== raw.length) {
			void this.context.workspaceState.update(STORAGE_KEY, clean);
		}
		return clean;
	}

	async add(f: FocusedScript): Promise<void> {
		const items = this.list();
		if (items.some(i => focusedKey(i) === focusedKey(f))) {
			return;
		}
		items.push(f);
		await this.context.workspaceState.update(STORAGE_KEY, items);
		this._onDidChange.fire();
	}

	async remove(f: FocusedScript): Promise<void> {
		const key = focusedKey(f);
		await this.context.workspaceState.update(STORAGE_KEY, this.list().filter(i => focusedKey(i) !== key));
		this._onDidChange.fire();
	}

	refresh(): void {
		this._onDidChange.fire();
	}
}

class FocusedScriptsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly store: FocusStore) {
		store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	private currentFolders(): Set<string> {
		return new Set((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()));
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		const folders = this.currentFolders();
		const inWorkspace = (f: FocusedScript) => folders.has(f.folderUri);
		if (!element) {
			const groups = new Map<string, FocusedScript[]>();
			for (const f of this.store.list()) {
				if (!inWorkspace(f)) {
					continue;
				}
				const arr = groups.get(f.packageUri) ?? [];
				arr.push(f);
				groups.set(f.packageUri, arr);
			}
			return Array.from(groups.entries()).map(([pkgUri, items]) => {
				const first = items[0];
				return new FocusedPackageItem(vscode.Uri.parse(pkgUri), vscode.Uri.parse(first.folderUri), first.taskPath);
			});
		}
		if (element instanceof FocusedPackageItem) {
			return this.store.list()
				.filter(f => inWorkspace(f) && f.packageUri === element.packageUri.toString())
				.map(f => new FocusedScriptItem(f));
		}
		return [];
	}
}

async function openScriptAt(packageUri: vscode.Uri, script?: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(packageUri);
	const pos = script ? await findScriptPositionInDocument(doc, script) : new vscode.Position(0, 0);
	await vscode.window.showTextDocument(doc, { preserveFocus: true, selection: new vscode.Selection(pos, pos) });
}

function buildDebugDuckItem(task: vscode.Task, packageUri: vscode.Uri, folder: vscode.WorkspaceFolder) {
	return {
		task,
		package: { resourceUri: packageUri, folder: { workspaceFolder: folder } },
		getFolder: () => folder
	};
}

export function activate(context: vscode.ExtensionContext): void {
	const store = new FocusStore(context);
	const provider = new FocusedScriptsProvider(store);

	context.subscriptions.push(
		vscode.window.createTreeView('npmScriptFocus', { treeDataProvider: provider, showCollapseAll: true })
	);
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => store.refresh()));

	const resolveScript = async (item: unknown): Promise<{ task: vscode.Task; focused: FocusedScript } | undefined> => {
		if (item instanceof FocusedScriptItem) {
			const task = await findNpmTask(item.focused);
			if (!task) {
				vscode.window.showWarningMessage(`Could not find npm script "${item.focused.script}".`);
				return undefined;
			}
			return { task, focused: item.focused };
		}
		const task = getTaskFromMaybeItem(item);
		const focused = toFocusedScript(item);
		if (task && focused) {
			return { task, focused };
		}
		return undefined;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.rerun', async (item: unknown) => {
			const resolved = await resolveScript(item);
			if (!resolved) {
				return;
			}
			terminateMatching(resolved.task);
			await vscode.tasks.executeTask(resolved.task);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.run', async (item: unknown) => {
			const resolved = await resolveScript(item);
			if (!resolved) {
				return;
			}
			await vscode.tasks.executeTask(resolved.task);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.debug', async (item: unknown) => {
			const resolved = await resolveScript(item);
			if (!resolved) {
				return;
			}
			const folder = getWorkspaceFolder(vscode.Uri.parse(resolved.focused.folderUri));
			if (!folder) {
				return;
			}
			const packageUri = vscode.Uri.parse(resolved.focused.packageUri);
			await vscode.commands.executeCommand('npm.debugScript', buildDebugDuckItem(resolved.task, packageUri, folder));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.openScript', async (item: unknown) => {
			if (item instanceof FocusedScriptItem) {
				await openScriptAt(vscode.Uri.parse(item.focused.packageUri), item.focused.script);
				return;
			}
			if (item instanceof FocusedPackageItem) {
				await openScriptAt(item.packageUri);
				return;
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.addToFocus', async (item: unknown) => {
			const focused = toFocusedScript(item);
			if (!focused) {
				vscode.window.showWarningMessage('Cannot add this item: not an npm script.');
				return;
			}
			await store.add(focused);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.removeFromFocus', async (item: unknown) => {
			if (!(item instanceof FocusedScriptItem)) {
				return;
			}
			await store.remove(item.focused);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.refresh', () => store.refresh())
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.search', async () => {
			const runBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('run'), tooltip: 'Run' };
			const debugBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug'), tooltip: 'Debug' };
			const focusBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-empty'), tooltip: 'Add to Focus' };

			type ScriptPick = vscode.QuickPickItem & { task: vscode.Task; focused: FocusedScript };

			const quickPick = vscode.window.createQuickPick<ScriptPick>();
			quickPick.placeholder = 'Search npm scripts';
			quickPick.matchOnDescription = true;
			quickPick.matchOnDetail = true;
			quickPick.busy = true;
			quickPick.show();

			try {
				const tasks = await vscode.tasks.fetchTasks({ type: 'npm' });
				const items: ScriptPick[] = [];
				for (const task of tasks) {
					const focused = toFocusedScript({ task });
					if (!focused) {
						continue;
					}
					const pkgDir = vscode.workspace.asRelativePath(vscode.Uri.parse(focused.packageUri), true);
					items.push({
						label: focused.script,
						description: pkgDir,
						detail: task.detail,
						buttons: [runBtn, debugBtn, focusBtn],
						task,
						focused
					});
				}
				quickPick.items = items;
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to fetch npm scripts: ${err instanceof Error ? err.message : String(err)}`);
				quickPick.hide();
				return;
			} finally {
				quickPick.busy = false;
			}

			quickPick.onDidTriggerItemButton(async e => {
				const { task, focused } = e.item;
				if (e.button === runBtn) {
					quickPick.hide();
					await vscode.tasks.executeTask(task);
				} else if (e.button === debugBtn) {
					quickPick.hide();
					const folder = getWorkspaceFolder(vscode.Uri.parse(focused.folderUri));
					if (!folder) {
						return;
					}
					await vscode.commands.executeCommand(
						'npm.debugScript',
						buildDebugDuckItem(task, vscode.Uri.parse(focused.packageUri), folder)
					);
				} else if (e.button === focusBtn) {
					await store.add(focused);
					vscode.window.setStatusBarMessage(`Added "${focused.script}" to Focus`, 2000);
				}
			});

			quickPick.onDidAccept(async () => {
				const picked = quickPick.selectedItems[0];
				if (!picked) {
					return;
				}
				quickPick.hide();
				await vscode.tasks.executeTask(picked.task);
			});

			quickPick.onDidHide(() => quickPick.dispose());
		})
	);
}

export function deactivate(): void {}
