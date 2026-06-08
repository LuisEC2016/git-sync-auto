import { describe, it, expect, vi, beforeEach } from 'vitest';

// execFileAsync = promisify(execFile) is created at module load time.
// Use vi.hoisted so the mock variable is available before vi.mock runs.
const { execFileMock } = vi.hoisted(() => ({
	execFileMock: vi.fn<() => Promise<{ stdout: string; stderr: string }>>(),
}));

vi.mock('util', async (importOriginal) => {
	const actual = await importOriginal<typeof import('util')>();
	return {
		...actual,
		promisify: (fn: unknown) => {
			// Only intercept execFile promisification; pass everything else through
			if (typeof fn === 'function' && fn.name === 'execFile') {
				return execFileMock;
			}
			return actual.promisify(fn as never);
		},
	};
});

import { GitRunner } from '../src/git-runner';

function makeRunner(sanitize?: (msg: string) => string): GitRunner {
	return new GitRunner(
		() => '/vault',
		sanitize ?? ((msg) => msg),
	);
}

function mockSuccess(stdout: string, stderr = ''): void {
	execFileMock.mockResolvedValue({ stdout, stderr });
}

function mockFailureCode(code: number, stdout = '', stderr = ''): void {
	const err = Object.assign(new Error('git exit'), { code, stdout, stderr });
	execFileMock.mockRejectedValue(err);
}

function mockThrow(message: string): void {
	// No .code → treated as non-exit error by GitRunner
	execFileMock.mockRejectedValue(new Error(message));
}

describe('GitRunner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('runGitResult', () => {
		it('returns code 0 and stdout on success', async () => {
			mockSuccess('output\n');
			const runner = makeRunner();
			const result = await runner.runGitResult(['status']);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('output');
		});

		it('returns non-zero code on git failure', async () => {
			mockFailureCode(128, '', 'fatal: not a git repo');
			const runner = makeRunner();
			const result = await runner.runGitResult(['status']);
			expect(result.code).toBe(128);
			expect(result.stderr).toContain('fatal');
		});

		it('includes stderr in output when stdout is empty', async () => {
			mockFailureCode(1, '', 'error message');
			const runner = makeRunner();
			const result = await runner.runGitResult(['diff']);
			expect(result.output).toContain('error message');
		});

		it('joins stdout and stderr in output', async () => {
			mockSuccess('out', 'err');
			const runner = makeRunner();
			const result = await runner.runGitResult(['log']);
			expect(result.output).toContain('out');
			expect(result.output).toContain('err');
		});

		it('applies sanitize to stdout', async () => {
			mockSuccess('token=secret123');
			const runner = makeRunner(msg => msg.replace('secret123', '***'));
			const result = await runner.runGitResult(['remote', '-v']);
			expect(result.stdout).not.toContain('secret123');
			expect(result.stdout).toContain('***');
		});

		it('throws when execFile throws a non-exit error (e.g. timeout)', async () => {
			mockThrow('ETIMEDOUT');
			const runner = makeRunner();
			await expect(runner.runGitResult(['push'])).rejects.toThrow();
		});
	});

	describe('runGit', () => {
		it('returns output string on success', async () => {
			mockSuccess('abc123\n');
			const runner = makeRunner();
			const out = await runner.runGit(['rev-parse', 'HEAD']);
			expect(out).toContain('abc123');
		});

		it('throws when git exits with non-zero code', async () => {
			mockFailureCode(1, '', 'nothing to commit');
			const runner = makeRunner();
			await expect(runner.runGit(['commit', '-m', 'test'])).rejects.toThrow();
		});

		it('error message contains git output', async () => {
			mockFailureCode(1, 'conflict in file.md', '');
			const runner = makeRunner();
			await expect(runner.runGit(['merge', 'origin/main'])).rejects.toThrow('conflict in file.md');
		});

		it('falls back to status code message when output is empty', async () => {
			mockFailureCode(2, '', '');
			const runner = makeRunner();
			await expect(runner.runGit(['diff'])).rejects.toThrow('status 2');
		});
	});
});
