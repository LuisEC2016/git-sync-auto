import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitRemoteOps } from '../src/git-remote-ops';
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

function makeRunner() {
	const runGitResult = vi.fn<Parameters<GitRunner['runGitResult']>, ReturnType<GitRunner['runGitResult']>>();
	const runGit = vi.fn<Parameters<GitRunner['runGit']>, ReturnType<GitRunner['runGit']>>();
	return {
		mock: { runGitResult, runGit } as unknown as GitRunner,
		runGitResult,
		runGit,
	};
}

function makePlugin(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): GitSyncHost {
	return {
		settings: { ...DEFAULT_SETTINGS, ...overrides },
		manifest: { id: 'git-sync-auto', name: 'Git Sync Auto', version: '1.0.0', minAppVersion: '1.0.0' },
		app: {} as never,
	} as unknown as GitSyncHost;
}

function makeOps(runnerMock: ReturnType<typeof makeRunner>, settingsOverrides?: Partial<typeof DEFAULT_SETTINGS>): GitRemoteOps {
	return new GitRemoteOps(makePlugin(settingsOverrides), runnerMock.mock);
}

// ---------------------------------------------------------------------------
// isNetworkBackoffActive / resetNetworkBackoff / incrementNetworkBackoff
// ---------------------------------------------------------------------------
describe('GitRemoteOps: network backoff', () => {
	it('backoff is inactive initially', () => {
		const runner = makeRunner();
		const ops = makeOps(runner);
		const status = ops.isNetworkBackoffActive();
		expect(status.active).toBe(false);
		expect(status.waitSec).toBe(0);
	});

	it('backoff activates after increment', () => {
		const runner = makeRunner();
		const ops = makeOps(runner, { networkBackoffMaxMinutes: 30 });
		ops.incrementNetworkBackoff();
		const status = ops.isNetworkBackoffActive();
		expect(status.active).toBe(true);
		expect(status.waitSec).toBeGreaterThan(0);
	});

	it('reset clears active backoff', () => {
		const runner = makeRunner();
		const ops = makeOps(runner, { networkBackoffMaxMinutes: 30 });
		ops.incrementNetworkBackoff();
		ops.resetNetworkBackoff();
		expect(ops.isNetworkBackoffActive().active).toBe(false);
	});

	it('backoff grows exponentially with each increment', () => {
		const runner = makeRunner();
		const ops = makeOps(runner, { networkBackoffMaxMinutes: 60 });
		ops.incrementNetworkBackoff(); // fail 1 → 2^1 * 60s = 2 min
		const wait1 = ops.isNetworkBackoffActive().waitSec;
		ops.resetNetworkBackoff();
		ops.incrementNetworkBackoff(); // fail 1 again
		ops.incrementNetworkBackoff(); // fail 2 → 2^2 * 60s = 4 min
		const wait2 = ops.isNetworkBackoffActive().waitSec;
		expect(wait2).toBeGreaterThan(wait1);
	});

	it('backoff is capped at networkBackoffMaxMinutes', () => {
		const runner = makeRunner();
		const ops = makeOps(runner, { networkBackoffMaxMinutes: 1 });
		// Increment many times to hit the cap
		for (let i = 0; i < 20; i++) ops.incrementNetworkBackoff();
		const { waitSec } = ops.isNetworkBackoffActive();
		expect(waitSec).toBeLessThanOrEqual(60 + 2); // 1 min + 2s tolerance
	});
});

// ---------------------------------------------------------------------------
// isNetworkError
// ---------------------------------------------------------------------------
describe('GitRemoteOps.isNetworkError', () => {
	let ops: GitRemoteOps;

	beforeEach(() => {
		const runner = makeRunner();
		ops = makeOps(runner);
	});

	it.each([
		['could not resolve host: github.com'],
		['connection refused'],
		['connection timed out'],
		['network is unreachable'],
		['no route to host'],
		['SSL certificate problem'],
		['curl error 28'],
		['unable to connect to server'],
	])('detects network error: %s', (msg) => {
		expect(ops.isNetworkError(new Error(msg))).toBe(true);
	});

	it('returns false for non-network error', () => {
		expect(ops.isNetworkError(new Error('fatal: not a git repository'))).toBe(false);
	});

	it('returns false for permission error', () => {
		expect(ops.isNetworkError(new Error('remote: Permission denied'))).toBe(false);
	});

	it('handles non-Error values', () => {
		expect(ops.isNetworkError('connection refused')).toBe(true);
		expect(ops.isNetworkError(42)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getPrimaryRemote
// ---------------------------------------------------------------------------
describe('GitRemoteOps.getPrimaryRemote', () => {
	it('returns undefined when no remotes configured', () => {
		const runner = makeRunner();
		const ops = makeOps(runner, { remotes: [] });
		expect(ops.getPrimaryRemote()).toBeUndefined();
	});

	it('returns primary remote when set', () => {
		const primary = { id: '1', name: 'origin', url: 'https://github.com/x/y', username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase' as const };
		const runner = makeRunner();
		const ops = makeOps(runner, { remotes: [primary] });
		expect(ops.getPrimaryRemote()?.id).toBe('1');
	});

	it('skips disabled remotes', () => {
		const disabled = { id: '1', name: 'origin', url: 'https://github.com/x/y', username: '', token: '', isPrimary: true, enabled: false, pullStrategy: 'rebase' as const };
		const runner = makeRunner();
		const ops = makeOps(runner, { remotes: [disabled] });
		expect(ops.getPrimaryRemote()).toBeUndefined();
	});

	it('skips remotes with empty url', () => {
		const noUrl = { id: '1', name: 'origin', url: '', username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase' as const };
		const runner = makeRunner();
		const ops = makeOps(runner, { remotes: [noUrl] });
		expect(ops.getPrimaryRemote()).toBeUndefined();
	});

	it('falls back to first enabled remote when none is primary', () => {
		const r1 = { id: '1', name: 'backup', url: 'https://github.com/x/y', username: '', token: '', isPrimary: false, enabled: true, pullStrategy: 'rebase' as const };
		const runner = makeRunner();
		const ops = makeOps(runner, { remotes: [r1] });
		expect(ops.getPrimaryRemote()?.id).toBe('1');
	});

	it('prefers primary over non-primary when both enabled', () => {
		const r1 = { id: '1', name: 'backup', url: 'https://x.com/a', username: '', token: '', isPrimary: false, enabled: true, pullStrategy: 'rebase' as const };
		const r2 = { id: '2', name: 'main', url: 'https://x.com/b', username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase' as const };
		const runner = makeRunner();
		const ops = makeOps(runner, { remotes: [r1, r2] });
		expect(ops.getPrimaryRemote()?.id).toBe('2');
	});
});

// ---------------------------------------------------------------------------
// getHead
// ---------------------------------------------------------------------------
describe('GitRemoteOps.getHead', () => {
	it('returns SHA on success', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: 'abc123\n' }));
		const ops = makeOps(runner);
		expect(await ops.getHead()).toBe('abc123');
	});

	it('returns null when no HEAD', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 1, stdout: '' }));
		const ops = makeOps(runner);
		expect(await ops.getHead()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// refExists
// ---------------------------------------------------------------------------
describe('GitRemoteOps.refExists', () => {
	it('returns true when ref exists', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0 }));
		const ops = makeOps(runner);
		expect(await ops.refExists('origin/main')).toBe(true);
	});

	it('returns false when ref does not exist', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 1 }));
		const ops = makeOps(runner);
		expect(await ops.refExists('nonexistent')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// compareRefs
// ---------------------------------------------------------------------------
describe('GitRemoteOps.compareRefs', () => {
	it('parses ahead and behind counts', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: '3\t1\n' }));
		const ops = makeOps(runner);
		const rel = await ops.compareRefs('HEAD', 'origin/main');
		expect(rel.ahead).toBe(3);
		expect(rel.behind).toBe(1);
	});

	it('returns zeros for equal refs', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: '0\t0\n' }));
		const ops = makeOps(runner);
		const rel = await ops.compareRefs('HEAD', 'origin/main');
		expect(rel.ahead).toBe(0);
		expect(rel.behind).toBe(0);
	});

	it('throws on non-zero exit', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 128, output: 'fatal error' }));
		const ops = makeOps(runner);
		await expect(ops.compareRefs('HEAD', 'bad-ref')).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// getTrackingBranch
// ---------------------------------------------------------------------------
describe('GitRemoteOps.getTrackingBranch', () => {
	it('returns null when no tracking configured', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 1 }));
		const ops = makeOps(runner);
		expect(await ops.getTrackingBranch('main')).toBeNull();
	});

	it('returns tracking info when configured', async () => {
		const runner = makeRunner();
		runner.runGitResult
			.mockResolvedValueOnce(makeResult({ code: 0, stdout: 'origin\n' }))  // branch.main.remote
			.mockResolvedValueOnce(makeResult({ code: 0, stdout: 'refs/heads/main\n' })); // branch.main.merge
		const ops = makeOps(runner);
		const tracking = await ops.getTrackingBranch('main');
		expect(tracking?.remote).toBe('origin');
		expect(tracking?.branch).toBe('main');
		expect(tracking?.ref).toBe('origin/main');
	});

	it('returns null when merge ref does not start with refs/heads/', async () => {
		const runner = makeRunner();
		runner.runGitResult
			.mockResolvedValueOnce(makeResult({ code: 0, stdout: 'origin\n' }))
			.mockResolvedValueOnce(makeResult({ code: 0, stdout: 'refs/tags/v1\n' }));
		const ops = makeOps(runner);
		expect(await ops.getTrackingBranch('main')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// listRemotes
// ---------------------------------------------------------------------------
describe('GitRemoteOps.listRemotes', () => {
	it('returns list of remote names', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0, stdout: 'origin\nbackup\n' }));
		const ops = makeOps(runner);
		const remotes = await ops.listRemotes();
		expect(remotes).toContain('origin');
		expect(remotes).toContain('backup');
	});

	it('returns empty array on error', async () => {
		const runner = makeRunner();
		runner.runGitResult.mockResolvedValue(makeResult({ code: 128 }));
		const ops = makeOps(runner);
		expect(await ops.listRemotes()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// pushAllRemotesWithBackoff — increments backoff on network error
// ---------------------------------------------------------------------------
describe('GitRemoteOps.pushAllRemotesWithBackoff', () => {
	it('increments backoff on network error', async () => {
		const runner = makeRunner();
		// Simulate a network error from runGit during push
		runner.runGit.mockRejectedValue(new Error('could not resolve host: github.com'));
		runner.runGitResult.mockResolvedValue(makeResult({ code: 0 })); // remote add/remove succeed

		const remote = { id: '1', name: 'origin', url: 'https://github.com/x/y', username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase' as const };
		const ops = makeOps(runner, { remotes: [remote] });

		await expect(ops.pushAllRemotesWithBackoff('main')).rejects.toThrow();
		expect(ops.isNetworkBackoffActive().active).toBe(true);
	});

	it('resets backoff on success', async () => {
		const runner = makeRunner();
		// runGitResult for: remote remove, remote add, fetch, rev-parse (HEAD), rev-parse (remoteRef), rev-list (compareRefs), push, remote remove
		runner.runGitResult
			.mockResolvedValue(makeResult({ code: 0, stdout: '0\t0\n' })); // compareRefs: already up to date
		runner.runGit.mockResolvedValue(''); // push (not called if up to date, but just in case)

		const remote = { id: '1', name: 'origin', url: 'https://github.com/x/y', username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase' as const };
		const ops = makeOps(runner, { remotes: [remote] });

		// Pre-activate backoff
		ops.incrementNetworkBackoff();
		expect(ops.isNetworkBackoffActive().active).toBe(true);

		// Successful push resets it
		await ops.pushAllRemotesWithBackoff('main');
		expect(ops.isNetworkBackoffActive().active).toBe(false);
	});
});
