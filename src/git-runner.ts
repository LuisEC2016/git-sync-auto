import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';
import { promisify } from 'util';
import { formatError } from './settings';
import type { GitCommandResult } from './git-types';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
export const GIT_REBASE_TIMEOUT_MS = 300_000;

export class GitRunner {
	constructor(
		private readonly getVaultPath: () => string,
		private readonly sanitize: (msg: string) => string,
	) {}

	async runGit(args: string[], options: { timeout?: number } = {}): Promise<string> {
		const result = await this.runGitResult(args, options);
		if (result.code !== 0) {
			throw new Error(this.describeGitFailure(result));
		}
		return result.output;
	}

	async runGitResult(args: string[], options: { timeout?: number } = {}): Promise<GitCommandResult> {
		const cwd = this.getVaultPath();

		try {
			const { stdout, stderr } = await execFileAsync('git', args, {
				cwd,
				timeout: options.timeout ?? GIT_TIMEOUT_MS,
				windowsHide: true,
			});
			return this.commandResult(0, stdout, stderr);
		} catch (error) {
			const err = error as ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer };
			if (typeof err.code === 'number') {
				return this.commandResult(err.code, err.stdout ?? '', err.stderr ?? '');
			}
			throw new Error(this.sanitize(formatError(error)));
		}
	}

	private commandResult(code: number, stdout: string | Buffer, stderr: string | Buffer): GitCommandResult {
		const stdoutText = this.sanitize(stdout.toString());
		const stderrText = this.sanitize(stderr.toString());
		return {
			code,
			stdout: stdoutText,
			stderr: stderrText,
			output: [stdoutText, stderrText].filter(Boolean).join('\n').trim(),
		};
	}

	private describeGitFailure(result: GitCommandResult): string {
		return result.output || `Git command exited with status ${result.code}.`;
	}
}
