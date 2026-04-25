import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'zjffun.vscode-npm-scripts-focus';

const EXPECTED_COMMANDS = [
	'npmScriptFocus.search',
	'npmScriptFocus.refresh',
	'npmScriptFocus.addToFocus',
	'npmScriptFocus.removeFromFocus',
	'npmScriptFocus.moveUp',
	'npmScriptFocus.moveDown',
	'npmScriptFocus.run',
	'npmScriptFocus.rerun',
	'npmScriptFocus.debug',
	'npmScriptFocus.openScript'
];

suite('npm Scripts Focus extension', () => {
	test('extension is present', () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `extension ${EXTENSION_ID} should be installed in the test host`);
	});

	test('activates without throwing', async () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
		await ext.activate();
		assert.equal(ext.isActive, true);
	});

	test('registers all contributed commands', async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const expected of EXPECTED_COMMANDS) {
			assert.ok(commands.includes(expected), `missing command: ${expected}`);
		}
	});

	test('search command opens a quick pick without throwing', async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		const result = vscode.commands.executeCommand('npmScriptFocus.search');
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
		await result;
	});
});
