import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function findTestFiles(dir, files = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			findTestFiles(p, files);
		} else if (entry.name.endsWith('.test.js')) {
			files.push(p);
		}
	}
	return files;
}

const files = findTestFiles('out/test/unit');
if (files.length === 0) {
	console.error('No unit test files found under out/test/unit');
	process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
