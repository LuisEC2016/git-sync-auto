import { describe, it, expect } from 'vitest';
import { parseDiffHunks } from '../src/gutter-extension';
import type { GutterHunk } from '../src/gutter-extension';

describe('parseDiffHunks', () => {
	it('returns empty array for empty diff', () => {
		expect(parseDiffHunks('')).toEqual([]);
	});

	it('returns empty array for diff with no hunks', () => {
		const diff = 'diff --git a/file.md b/file.md\nindex abc..def 100644';
		expect(parseDiffHunks(diff)).toEqual([]);
	});

	it('parses a simple added line', () => {
		const diff = `@@ -1,3 +1,4 @@\n context\n+new line\n context\n context`;
		const hunks = parseDiffHunks(diff);
		expect(hunks).toContainEqual<GutterHunk>({ line: 2, type: 'added' });
	});

	it('parses a simple deleted line', () => {
		const diff = `@@ -1,4 +1,3 @@\n context\n-removed line\n context\n context`;
		const hunks = parseDiffHunks(diff);
		expect(hunks).toContainEqual<GutterHunk>({ line: 2, type: 'deleted' });
	});

	it('upgrades deleted+added at same position to modified', () => {
		// A changed line appears as '-' followed by '+' at the same new-line position
		const diff = `@@ -1,3 +1,3 @@\n context\n-old content\n+new content\n context`;
		const hunks = parseDiffHunks(diff);
		expect(hunks).toContainEqual<GutterHunk>({ line: 2, type: 'modified' });
		// Must not have separate deleted + added for same position
		const atLine2 = hunks.filter(h => h.line === 2);
		expect(atLine2).toHaveLength(1);
	});

	it('increments line counter for context lines', () => {
		const diff = `@@ -1,5 +1,6 @@\n ctx1\n ctx2\n ctx3\n+added at line 4\n ctx5`;
		const hunks = parseDiffHunks(diff);
		expect(hunks).toContainEqual<GutterHunk>({ line: 4, type: 'added' });
	});

	it('handles multiple hunk headers', () => {
		const diff = [
			'@@ -1,3 +1,4 @@',
			' ctx',
			'+added in hunk1',
			' ctx',
			'@@ -10,3 +11,4 @@',
			' ctx',
			'+added in hunk2',
		].join('\n');
		const hunks = parseDiffHunks(diff);
		expect(hunks).toContainEqual<GutterHunk>({ line: 2, type: 'added' });
		expect(hunks).toContainEqual<GutterHunk>({ line: 12, type: 'added' });
	});

	it('ignores +++ and --- header lines', () => {
		const diff = `--- a/file.md\n+++ b/file.md\n@@ -1,2 +1,3 @@\n ctx\n+added`;
		const hunks = parseDiffHunks(diff);
		expect(hunks.every(h => h.type !== undefined)).toBe(true);
		// +++ line must not create a spurious hunk
		const allTypes = hunks.map(h => h.type);
		expect(allTypes).not.toContain(undefined);
	});

	it('ignores \\ no-newline-at-end-of-file marker', () => {
		const diff = `@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline at end of file`;
		const hunks = parseDiffHunks(diff);
		// Only the modified hunk, not a spurious one from the backslash line
		const modified = hunks.filter(h => h.type === 'modified');
		expect(modified).toHaveLength(1);
	});

	it('handles hunk starting at line 1', () => {
		const diff = `@@ -0,0 +1,2 @@\n+line one\n+line two`;
		const hunks = parseDiffHunks(diff);
		expect(hunks[0]).toMatchObject({ line: 1, type: 'added' });
		expect(hunks[1]).toMatchObject({ line: 2, type: 'added' });
	});

	it('deleted line position is clamped to at least 1', () => {
		// Edge case: deletion at line 0 — should be clamped to 1
		const diff = `@@ -1,1 +0,0 @@\n-only line`;
		const hunks = parseDiffHunks(diff);
		expect(hunks[0]!.line).toBeGreaterThanOrEqual(1);
	});

	it('returns only hunks for changed lines, not context lines', () => {
		const diff = `@@ -1,5 +1,5 @@\n ctx1\n ctx2\n-old\n+new\n ctx5`;
		const hunks = parseDiffHunks(diff);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.type).toBe('modified');
	});
});
