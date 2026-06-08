import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitWorkingTree } from '../src/git-working-tree';
import type { GitRunner } from '../src/git-runner';
import type { GitSyncHost } from '../src/git-types';
import type { GitCommandResult } from '../src/git-types';
import { DEFAULT_SETTINGS } from '../src/settings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
	return { code: 0, stdout: '', stderr: '', output: '', ...overrides };
}

function makeRunner(): { mock: GitRunner; runGitResult: ReturnType<typeof vi.fn>; runGit: ReturnType<typeof vi.fn> } {
	const runGitResult = vi.fn<Parameters<GitRunner['runGitResult']>, ReturnType<GitRunner['runGitResult']>>();
	const runGit = vi.fn<Parameters<GitRunner['runGit']>, ReturnType<GitRunner['runGit']>>();
	return {
		mock: { runGitResult, runGit } as unknown as GitRunner,
		runGitResult,
		runGit,
	};
}

function makePlugin(settingsOverrides: Partial<typeof DEFAULT_SETTINGS> = {}): GitSyncHost {
	return {
		settings: { ...DEFAULT_SETTINGS, ...settingsOverrides },
		manifest: { id: 'git-sync-auto', name: 'Git Sync Auto', version: '1.0.0', minAppVersion: '1.0.0' },
		app: {} as never,
	} as unknown as GitSyncHost;
}

function makeTree(runnerMock: ReturnType<typeof makeRunner>, pluginOverrides?: Partial<typeof DEFAULT_SETTINGS>): GitWorkingTree {
	return new GitWorkingTree(
		makePlugin(pluginOverrides),
		runnerMock.mock,
		() => '/vault',
	);
}

// ---------------------------------------------------------------------------
// inspectWorkingTree
// ---------------------------------------------------------------------------
describe('GitWorkingTree.inspectWorkingTree', () => {
	let runner: ReturnType<typeof makeRunner>;
	let tree: GitWorkingTree;

	beforeEach(() => {
		runner = makeRunner();
		tree = makeTree(runner);
	});

	it('returns empty state for clean working tree', async () => {
		runner.runGitResult.mockResolvedValue(makeResult({ stdout: '' }));
		const state = await tree.inspectWorkingTree();
		expect(state.hasCommittableChanges).toBe(false);
		expect(state.hasConflicts).toBe(false);
		expect(state.conflicts).toEqual([]);
	});

	it('detects committable changes', async () => {
		runner.runGitResult.mockResolvedValue(makeResult({ stdout: ' M notes/test.md\n' }));
		const state = await tree.inspectWorkingTree();
		expect(state.hasCommittableChanges).toBe(true);
	});

	it('detects conflicts (UU status)', async () => {
		runner.runGitResult.mockResolvedValue(makeResult({ stdout: 'UU conflict.md\n' }));
		const state = await tree.inspectWorkingTree();
		expect(state.hasConflicts).toBe(true);
		expect(state.conflicts).toContain('conflict.md');
	});

	it('detects conflicts (AA status)', async () => {
		runner.runGitResult.mockResolvedValue(makeResult({ stdout: 'AA both-added.md\n' }));
		const state = await tree.inspectWorkingTree();
		expect(state.hasConflicts).toBe(true);
	});

	it('filters protected paths from committable entries when protectPluginData is true', async () => {
		const runner2 = makeRunner();
		const tree2 = makeTree(runner2, { protectPluginData: true });
		runner2.runGitResult.mockResolvedValue(makeResult({
			stdout: ' M .obsidian/plugins/git-sync-auto/data.json\n',
		}));
		const state = await tree2.inspectWorkingTree();
		expect(state.hasOnlyProtectedChanges).toBe(true);
		expect(state.hasCommittableChanges).toBe(false);
	});

	it('falls back to empty status on non-zero git result', async () => {
		runner.runGitResult.mockResolvedValue(makeResult({ code: 128, stdout: '', stderr: 'not a repo' }));
		const state = await tree.inspectWorkingTree();
		expect(state.hasCommittableChanges).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// hasStagedChanges
// ---------------------------------------------------------------------------
describe('GitWorkingTree.hasStagedChanges', () => {
	it('returns false when exit code 0 (no staged changes)', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0 }));
		const tree = makeTree(runner);
		expect(await tree.hasStagedChanges()).toBe(false);
	});

	it('returns true when exit code 1 (staged changes exist)', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 1 }));
		const tree = makeTree(runner);
		expect(await tree.hasStagedChanges()).toBe(true);
	});

	it('throws on unexpected exit code', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 128, output: 'fatal error' }));
		const tree = makeTree(runner);
		await expect(tree.hasStagedChanges()).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// hasHead
// ---------------------------------------------------------------------------
describe('GitWorkingTree.hasHead', () => {
	it('returns false when no HEAD', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 1 }));
		const tree = makeTree(runner);
		expect(await tree.hasHead()).toBe(false);
	});

	it('returns true when HEAD exists', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0 }));
		const tree = makeTree(runner);
		expect(await tree.hasHead()).toBe(true);
	});

	it('caches true result — only calls git once after success', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0 }));
		const tree = makeTree(runner);
		await tree.hasHead();
		await tree.hasHead();
		expect(runner.runGitResult).toHaveBeenCalledTimes(1);
	});

	it('does not cache false — re-checks on each call', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 1 }));
		const tree = makeTree(runner);
		await tree.hasHead();
		await tree.hasHead();
		expect(runner.runGitResult).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// getStagedPaths
// ---------------------------------------------------------------------------
describe('GitWorkingTree.getStagedPaths', () => {
	it('returns empty array when no staged files', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: '' }));
		const tree = makeTree(runner);
		expect(await tree.getStagedPaths()).toEqual([]);
	});

	it('parses modified file', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: 'M\0notes/test.md\0' }));
		const tree = makeTree(runner);
		const paths = await tree.getStagedPaths();
		expect(paths).toContainEqual({ path: 'notes/test.md', status: 'M' });
	});

	it('parses deleted file', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: 'D\0old.md\0' }));
		const tree = makeTree(runner);
		const paths = await tree.getStagedPaths();
		expect(paths).toContainEqual({ path: 'old.md', status: 'D' });
	});

	it('uses destination path for renames', async () => {
		const runner = makeRunner();
		// Rename: R100\0old.md\0new.md\0
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: 'R100\0old.md\0new.md\0' }));
		const tree = makeTree(runner);
		const paths = await tree.getStagedPaths();
		expect(paths).toContainEqual({ path: 'new.md', status: 'R' });
		expect(paths.find(p => p.path === 'old.md')).toBeUndefined();
	});

	it('returns empty array on non-zero exit', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 1, stdout: '' }));
		const tree = makeTree(runner);
		expect(await tree.getStagedPaths()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// statusPath
// ---------------------------------------------------------------------------
describe('GitWorkingTree.statusPath', () => {
	it('extracts path from standard status line', () => {
		const runner = makeRunner();
		const tree = makeTree(runner);
		expect(tree.statusPath(' M notes/test.md')).toBe('notes/test.md');
	});

	it('extracts destination from rename status line', () => {
		const runner = makeRunner();
		const tree = makeTree(runner);
		expect(tree.statusPath('R  old.md -> new.md')).toBe('new.md');
	});

	it('decodes git-quoted octal path', () => {
		const runner = makeRunner();
		const tree = makeTree(runner);
		// "notas/ñoño.md" encoded as octal
		const encoded = ' M "notas/\\303\\261o\\303\\261o.md"';
		const result = tree.statusPath(encoded);
		expect(result).toContain('ñ');
	});
});

// ---------------------------------------------------------------------------
// isExcludedPath
// ---------------------------------------------------------------------------
describe('GitWorkingTree.isExcludedPath', () => {
	it('returns false when no exclude patterns', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { excludePatterns: '' });
		expect(tree.isExcludedPath('notes/test.md', false)).toBe(false);
	});

	it('excludes file matching exact pattern', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { excludePatterns: 'private.md' });
		expect(tree.isExcludedPath('private.md', false)).toBe(true);
	});

	it('excludes file matching glob pattern', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { excludePatterns: '*.tmp' });
		expect(tree.isExcludedPath('backup.tmp', false)).toBe(true);
	});

	it('excludes file matching ** glob', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { excludePatterns: 'private/**' });
		expect(tree.isExcludedPath('private/secret.md', false)).toBe(true);
	});

	it('does not exclude non-matching file', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { excludePatterns: '*.tmp' });
		expect(tree.isExcludedPath('notes/test.md', false)).toBe(false);
	});

	it('excludes workspace.json when includeWorkspace is true', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { excludeWorkspace: true });
		expect(tree.isExcludedPath('.obsidian/workspace.json', true)).toBe(true);
	});

	it('does not exclude workspace.json when includeWorkspace is false', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { excludeWorkspace: true });
		expect(tree.isExcludedPath('.obsidian/workspace.json', false)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// protectedPaths / workspacePaths
// ---------------------------------------------------------------------------
describe('GitWorkingTree.protectedPaths', () => {
	it('includes data.json for plugin id', () => {
		const runner = makeRunner();
		const tree = makeTree(runner);
		expect(tree.protectedPaths()).toContain('.obsidian/plugins/git-sync-auto/data.json');
	});
});

describe('GitWorkingTree.workspacePaths', () => {
	it('includes workspace.json and workspace', () => {
		const runner = makeRunner();
		const tree = makeTree(runner);
		expect(tree.workspacePaths()).toContain('.obsidian/workspace.json');
		expect(tree.workspacePaths()).toContain('.obsidian/workspace');
	});
});

// ---------------------------------------------------------------------------
// identityArgs
// ---------------------------------------------------------------------------
describe('GitWorkingTree.identityArgs', () => {
	it('returns empty array when no author configured', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitAuthorName: '', commitAuthorEmail: '' });
		expect(tree.identityArgs()).toEqual([]);
	});

	it('includes name -c arg when name is set', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitAuthorName: 'Alice', commitAuthorEmail: '' });
		const args = tree.identityArgs();
		expect(args).toContain('-c');
		expect(args.join(' ')).toContain('user.name=Alice');
	});

	it('includes email -c arg when email is set', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitAuthorName: '', commitAuthorEmail: 'a@b.com' });
		const args = tree.identityArgs();
		expect(args.join(' ')).toContain('user.email=a@b.com');
	});

	it('includes both name and email args', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitAuthorName: 'Alice', commitAuthorEmail: 'a@b.com' });
		const args = tree.identityArgs();
		expect(args.join(' ')).toContain('user.name=Alice');
		expect(args.join(' ')).toContain('user.email=a@b.com');
	});
});

// ---------------------------------------------------------------------------
// buildCommitMessage
// ---------------------------------------------------------------------------
describe('GitWorkingTree.buildCommitMessage', () => {
	it('uses template mode with placeholders', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, {
			commitMessageMode: 'template',
			commitMessage: 'Sync {date} {time}',
		});
		const msg = tree.buildCommitMessage();
		expect(msg).toMatch(/Sync \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	it('uses smart summary when mode is smart and staged files provided', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitMessageMode: 'smart', commitMessage: 'Vault sync from {host} at {date} {time}' });
		const staged = [
			{ path: 'notes/a.md', status: 'M' },
			{ path: 'notes/b.md', status: 'A' },
		];
		const msg = tree.buildCommitMessage(staged);
		expect(msg).toContain('note');
	});

	it('counts deleted files', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitMessageMode: 'smart', commitMessage: 'Vault sync' });
		const staged = [{ path: 'old.md', status: 'D' }];
		const msg = tree.buildCommitMessage(staged);
		expect(msg).toContain('deleted');
	});

	it('counts renamed files', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitMessageMode: 'smart', commitMessage: 'Vault sync' });
		const staged = [{ path: 'new.md', status: 'R' }];
		const msg = tree.buildCommitMessage(staged);
		expect(msg).toContain('renamed');
	});

	it('counts attachments (non-md, non-config)', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitMessageMode: 'smart', commitMessage: 'Vault sync' });
		const staged = [{ path: 'image.png', status: 'A' }];
		const msg = tree.buildCommitMessage(staged);
		expect(msg).toContain('attachment');
	});

	it('counts configs (.obsidian/ path)', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitMessageMode: 'smart', commitMessage: 'Vault sync' });
		const staged = [{ path: '.obsidian/app.json', status: 'M' }];
		const msg = tree.buildCommitMessage(staged);
		expect(msg).toContain('config');
	});

	it('replaces {summary} in template when smart mode', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, {
			commitMessageMode: 'smart',
			commitMessage: 'Sync: {summary}',
		});
		const staged = [{ path: 'notes/a.md', status: 'M' }];
		const msg = tree.buildCommitMessage(staged);
		expect(msg).toContain('Sync:');
		expect(msg).toContain('note');
	});

	it('falls back to Vault sync when no staged files classified', () => {
		const runner = makeRunner();
		const tree = makeTree(runner, { commitMessageMode: 'smart', commitMessage: 'Vault sync' });
		// Empty staged array → no classifications
		const msg = tree.buildCommitMessage([]);
		expect(msg).toBe('Vault sync');
	});
});

// ---------------------------------------------------------------------------
// commitChanges — high level flow
// ---------------------------------------------------------------------------
describe('GitWorkingTree.commitChanges', () => {
	it('returns committed:false when no committable changes', async () => {
		const runner = makeRunner();
		// inspectWorkingTree returns empty status
		runner.runGitResult.mockResolvedValue(makeResult({ stdout: '' }));
		const tree = makeTree(runner);
		const outcome = await tree.commitChanges();
		expect(outcome.committed).toBe(false);
	});

	it('throws when conflicts exist', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ stdout: 'UU conflict.md\n' }));
		const tree = makeTree(runner);
		await expect(tree.commitChanges()).rejects.toThrow(/conflict/i);
	});
});
