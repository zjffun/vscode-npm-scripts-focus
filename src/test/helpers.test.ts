import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	FocusedScript,
	focusedKey,
	fuzzySubsequenceScore,
	fuzzyMultiTokenScore,
	reorderListByPackages
} from '../helpers';

const mkScript = (packageUri: string, script: string): FocusedScript => ({
	folderUri: 'file:///root',
	packageUri,
	taskPath: '',
	script,
	label: script
});

test('focusedKey combines packageUri and script', () => {
	const f = mkScript('file:///root/a/package.json', 'build');
	assert.equal(focusedKey(f), 'file:///root/a/package.json|build');
});

test('focusedKey distinguishes same script across packages', () => {
	const a = focusedKey(mkScript('file:///root/a/package.json', 'build'));
	const b = focusedKey(mkScript('file:///root/b/package.json', 'build'));
	assert.notEqual(a, b);
});

test('fuzzySubsequenceScore returns 0 for empty needle', () => {
	assert.equal(fuzzySubsequenceScore('', 'anything'), 0);
});

test('fuzzySubsequenceScore returns undefined when characters are missing', () => {
	assert.equal(fuzzySubsequenceScore('xyz', 'build'), undefined);
});

test('fuzzySubsequenceScore prefers earlier and contiguous matches', () => {
	const exact = fuzzySubsequenceScore('build', 'build')!;
	const spaced = fuzzySubsequenceScore('build', 'b-u-i-l-d')!;
	const late = fuzzySubsequenceScore('build', 'xxxxbuild')!;
	assert.ok(exact < spaced, 'exact match should score lower than spaced match');
	assert.ok(exact < late, 'exact match should score lower than late match');
});

test('fuzzySubsequenceScore requires order', () => {
	assert.equal(fuzzySubsequenceScore('dliub', 'build'), undefined);
});

test('fuzzyMultiTokenScore matches all tokens regardless of order', () => {
	const score = fuzzyMultiTokenScore('build app', 'app:build');
	assert.ok(typeof score === 'number');
});

test('fuzzyMultiTokenScore returns undefined when any token is missing', () => {
	assert.equal(fuzzyMultiTokenScore('build deploy', 'app:build'), undefined);
});

test('fuzzyMultiTokenScore is case-insensitive', () => {
	const lower = fuzzyMultiTokenScore('build', 'app:build');
	const upper = fuzzyMultiTokenScore('BUILD', 'APP:BUILD');
	assert.equal(lower, upper);
});

test('fuzzyMultiTokenScore with empty query returns 0', () => {
	assert.equal(fuzzyMultiTokenScore('   ', 'anything'), 0);
});

test('reorderListByPackages groups items by package in given order', () => {
	const list = [
		mkScript('pkgA', 'a1'),
		mkScript('pkgB', 'b1'),
		mkScript('pkgA', 'a2'),
		mkScript('pkgB', 'b2')
	];
	const result = reorderListByPackages(list, ['pkgB', 'pkgA']);
	assert.deepEqual(result.map(f => f.script), ['b1', 'b2', 'a1', 'a2']);
});

test('reorderListByPackages preserves intra-package order', () => {
	const list = [
		mkScript('pkgA', 'a1'),
		mkScript('pkgA', 'a2'),
		mkScript('pkgA', 'a3')
	];
	const result = reorderListByPackages(list, ['pkgA']);
	assert.deepEqual(result.map(f => f.script), ['a1', 'a2', 'a3']);
});

test('reorderListByPackages drops packages not in order', () => {
	const list = [mkScript('pkgA', 'a1'), mkScript('pkgB', 'b1')];
	const result = reorderListByPackages(list, ['pkgA']);
	assert.deepEqual(result.map(f => f.script), ['a1']);
});

test('reorderListByPackages tolerates unknown package in order', () => {
	const list = [mkScript('pkgA', 'a1')];
	const result = reorderListByPackages(list, ['pkgGhost', 'pkgA']);
	assert.deepEqual(result.map(f => f.script), ['a1']);
});
