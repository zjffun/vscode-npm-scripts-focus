export interface FocusedScript {
	folderUri: string;
	packageUri: string;
	taskPath: string;
	script: string;
	label: string;
}

export function focusedKey(f: FocusedScript): string {
	return `${f.packageUri}|${f.script}`;
}

export function fuzzySubsequenceScore(needle: string, haystack: string): number | undefined {
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

export function fuzzyMultiTokenScore(query: string, haystack: string): number | undefined {
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

export function reorderListByPackages<T extends { packageUri: string }>(list: T[], order: string[]): T[] {
	const groups = new Map<string, T[]>();
	for (const f of list) {
		const arr = groups.get(f.packageUri) ?? [];
		arr.push(f);
		groups.set(f.packageUri, arr);
	}
	const result: T[] = [];
	for (const p of order) {
		result.push(...(groups.get(p) ?? []));
	}
	return result;
}
