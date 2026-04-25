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
		this.resourceUri = packageUri;
		this.iconPath = vscode.ThemeIcon.File;
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

	async replaceAll(items: FocusedScript[]): Promise<void> {
		await this.context.workspaceState.update(STORAGE_KEY, items);
		this._onDidChange.fire();
	}

	async moveScript(key: string, direction: -1 | 1): Promise<void> {
		const list = this.list();
		const idx = list.findIndex(f => focusedKey(f) === key);
		if (idx < 0) {
			return;
		}
		const pkg = list[idx].packageUri;
		let neighborIdx = -1;
		if (direction === -1) {
			for (let i = idx - 1; i >= 0; i--) {
				if (list[i].packageUri === pkg) { neighborIdx = i; break; }
			}
		} else {
			for (let i = idx + 1; i < list.length; i++) {
				if (list[i].packageUri === pkg) { neighborIdx = i; break; }
			}
		}
		if (neighborIdx < 0) {
			return;
		}
		[list[idx], list[neighborIdx]] = [list[neighborIdx], list[idx]];
		await this.replaceAll(list);
	}

	async movePackage(pkgUri: string, direction: -1 | 1): Promise<void> {
		const list = this.list();
		const order: string[] = [];
		for (const f of list) {
			if (!order.includes(f.packageUri)) {
				order.push(f.packageUri);
			}
		}
		const i = order.indexOf(pkgUri);
		const j = i + direction;
		if (i < 0 || j < 0 || j >= order.length) {
			return;
		}
		[order[i], order[j]] = [order[j], order[i]];
		await this.replaceAll(reorderListByPackages(list, order));
	}

	refresh(): void {
		this._onDidChange.fire();
	}
}

function reorderListByPackages(list: FocusedScript[], order: string[]): FocusedScript[] {
	const groups = new Map<string, FocusedScript[]>();
	for (const f of list) {
		const arr = groups.get(f.packageUri) ?? [];
		arr.push(f);
		groups.set(f.packageUri, arr);
	}
	const result: FocusedScript[] = [];
	for (const p of order) {
		result.push(...(groups.get(p) ?? []));
	}
	return result;
}

const FOCUS_DND_MIME = 'application/vnd.code.tree.npmscriptfocus';

type DndPayload = Array<
	| { kind: 'script'; key: string }
	| { kind: 'package'; pkgUri: string }
>;

class FocusedScriptsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	readonly dragMimeTypes = [FOCUS_DND_MIME];
	readonly dropMimeTypes = [FOCUS_DND_MIME];

	constructor(private readonly store: FocusStore) {
		store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
	}

	handleDrag(source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
		const payload: DndPayload = [];
		for (const item of source) {
			if (item instanceof FocusedScriptItem) {
				payload.push({ kind: 'script', key: focusedKey(item.focused) });
			} else if (item instanceof FocusedPackageItem) {
				payload.push({ kind: 'package', pkgUri: item.packageUri.toString() });
			}
		}
		if (payload.length === 0) {
			return;
		}
		dataTransfer.set(FOCUS_DND_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
	}

	async handleDrop(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const item = dataTransfer.get(FOCUS_DND_MIME);
		if (!item) {
			return;
		}
		const payload = JSON.parse(await item.asString()) as DndPayload;
		const scriptKeys = payload.flatMap(p => p.kind === 'script' ? [p.key] : []);
		const pkgUris = payload.flatMap(p => p.kind === 'package' ? [p.pkgUri] : []);

		if (scriptKeys.length > 0 && pkgUris.length === 0) {
			await this.dropScripts(scriptKeys, target);
		} else if (pkgUris.length > 0 && scriptKeys.length === 0) {
			await this.dropPackages(pkgUris, target);
		}
	}

	private async dropScripts(scriptKeys: string[], target: vscode.TreeItem | undefined): Promise<void> {
		const list = this.store.list();
		const moving = list.filter(f => scriptKeys.includes(focusedKey(f)));
		if (moving.length === 0) {
			return;
		}
		const pkgOfMoving = moving[0].packageUri;
		if (!moving.every(f => f.packageUri === pkgOfMoving)) {
			vscode.window.showWarningMessage('Cannot reorder scripts from different packages together.');
			return;
		}
		const remaining = list.filter(f => !scriptKeys.includes(focusedKey(f)));

		let insertIndex: number;
		if (target instanceof FocusedScriptItem) {
			if (target.focused.packageUri !== pkgOfMoving) {
				vscode.window.showWarningMessage('Cannot move a script to a different package.');
				return;
			}
			insertIndex = remaining.findIndex(f => focusedKey(f) === focusedKey(target.focused));
			if (insertIndex < 0) {
				insertIndex = remaining.length;
			}
		} else if (target instanceof FocusedPackageItem) {
			if (target.packageUri.toString() !== pkgOfMoving) {
				vscode.window.showWarningMessage('Cannot move a script to a different package.');
				return;
			}
			let lastIdx = -1;
			for (let i = 0; i < remaining.length; i++) {
				if (remaining[i].packageUri === pkgOfMoving) { lastIdx = i; }
			}
			insertIndex = lastIdx + 1;
		} else {
			let lastIdx = -1;
			for (let i = 0; i < remaining.length; i++) {
				if (remaining[i].packageUri === pkgOfMoving) { lastIdx = i; }
			}
			insertIndex = lastIdx + 1;
		}
		remaining.splice(insertIndex, 0, ...moving);
		await this.store.replaceAll(remaining);
	}

	private async dropPackages(pkgUris: string[], target: vscode.TreeItem | undefined): Promise<void> {
		const list = this.store.list();
		const order: string[] = [];
		for (const f of list) {
			if (!order.includes(f.packageUri)) {
				order.push(f.packageUri);
			}
		}
		const movingSet = new Set(pkgUris);
		const remaining = order.filter(p => !movingSet.has(p));
		const movingInOrder = order.filter(p => movingSet.has(p));

		let insertIndex: number;
		if (target instanceof FocusedPackageItem) {
			insertIndex = remaining.indexOf(target.packageUri.toString());
			if (insertIndex < 0) { insertIndex = remaining.length; }
		} else if (target instanceof FocusedScriptItem) {
			insertIndex = remaining.indexOf(target.focused.packageUri);
			if (insertIndex < 0) { insertIndex = remaining.length; }
		} else {
			insertIndex = remaining.length;
		}
		const newOrder = [...remaining.slice(0, insertIndex), ...movingInOrder, ...remaining.slice(insertIndex)];
		await this.store.replaceAll(reorderListByPackages(list, newOrder));
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

function fuzzySubsequenceScore(needle: string, haystack: string): number | undefined {
	if (!needle) {
		return 0;
	}
	let hi = 0;
	let score = 0;
	let lastMatch = -1;
	for (let ni = 0; ni < needle.length; ni++) {
		const ch = needle.charCodeAt(ni);
		while (hi < haystack.length && haystack.charCodeAt(hi) !== ch) {
			hi++;
		}
		if (hi >= haystack.length) {
			return undefined;
		}
		score += lastMatch === -1 ? hi : (hi - lastMatch);
		lastMatch = hi;
		hi++;
	}
	return score;
}

function fuzzyMultiTokenScore(query: string, haystack: string): number | undefined {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return 0;
	}
	const lowerHay = haystack.toLowerCase();
	let total = 0;
	for (const tok of tokens) {
		const s = fuzzySubsequenceScore(tok, lowerHay);
		if (s === undefined) {
			return undefined;
		}
		total += s;
	}
	return total;
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
		vscode.window.createTreeView('npmScriptFocus', { treeDataProvider: provider, dragAndDropController: provider, canSelectMany: true, showCollapseAll: true })
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

	const moveItem = async (item: unknown, direction: -1 | 1) => {
		if (item instanceof FocusedScriptItem) {
			await store.moveScript(focusedKey(item.focused), direction);
		} else if (item instanceof FocusedPackageItem) {
			await store.movePackage(item.packageUri.toString(), direction);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.moveUp', (item: unknown) => moveItem(item, -1))
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.moveDown', (item: unknown) => moveItem(item, 1))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('npmScriptFocus.search', async () => {
			const runBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('run'), tooltip: 'Run' };
			const debugBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug'), tooltip: 'Debug' };
			const focusBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-empty'), tooltip: 'Add to Focus' };
			const unfocusBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-full'), tooltip: 'Remove from Focus' };

			type ScriptPick = vscode.QuickPickItem & { task: vscode.Task; focused: FocusedScript; haystack: string; isFocused: boolean };

			const quickPick = vscode.window.createQuickPick<ScriptPick>();
			quickPick.title = 'Search npm Scripts';
			quickPick.placeholder = 'Type to filter npm scripts; Enter to run, or use the buttons to debug or add to Focus';
			quickPick.matchOnDescription = true;
			quickPick.matchOnDetail = true;
			quickPick.busy = true;
			quickPick.show();

			let allItems: ScriptPick[] = [];

			const decorateItem = (item: ScriptPick): ScriptPick => {
				const focusedSet = new Set(store.list().map(focusedKey));
				const isFocused = focusedSet.has(focusedKey(item.focused));
				item.isFocused = isFocused;
				item.iconPath = isFocused ? new vscode.ThemeIcon('star-full') : undefined;
				item.buttons = [runBtn, debugBtn, isFocused ? unfocusBtn : focusBtn];
				return item;
			};

			const sortFocusedFirst = (items: ScriptPick[]): ScriptPick[] => {
				return items.slice().sort((a, b) => Number(b.isFocused) - Number(a.isFocused));
			};

			const applyFilter = (value: string) => {
				if (!value.trim()) {
					quickPick.items = sortFocusedFirst(allItems);
					return;
				}
				const scored: { item: ScriptPick; score: number }[] = [];
				for (const item of allItems) {
					const score = fuzzyMultiTokenScore(value, item.haystack);
					if (score !== undefined) {
						scored.push({ item, score });
					}
				}
				scored.sort((a, b) => {
					if (a.item.isFocused !== b.item.isFocused) {
						return Number(b.item.isFocused) - Number(a.item.isFocused);
					}
					return a.score - b.score;
				});
				quickPick.items = scored.map(s => s.item);
			};
			quickPick.onDidChangeValue(applyFilter);

			const refreshDecorations = () => {
				for (const item of allItems) {
					decorateItem(item);
				}
				applyFilter(quickPick.value);
			};

			const storeSub = store.onDidChange(refreshDecorations);
			quickPick.onDidHide(() => storeSub.dispose());

			try {
				const tasks = await vscode.tasks.fetchTasks({ type: 'npm' });
				const items: ScriptPick[] = [];
				for (const task of tasks) {
					const focused = toFocusedScript({ task });
					if (!focused) {
						continue;
					}
					const pkgDir = vscode.workspace.asRelativePath(vscode.Uri.parse(focused.packageUri), true);
					const detail = task.detail ?? '';
					const pick: ScriptPick = {
						label: focused.script,
						description: pkgDir,
						detail,
						alwaysShow: true,
						task,
						focused,
						haystack: `${focused.script} ${pkgDir} ${detail}`,
						isFocused: false
					};
					items.push(decorateItem(pick));
				}
				allItems = items;
				applyFilter(quickPick.value);
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
				} else if (e.button === unfocusBtn) {
					await store.remove(focused);
					vscode.window.setStatusBarMessage(`Removed "${focused.script}" from Focus`, 2000);
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
