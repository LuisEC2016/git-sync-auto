import { Notice } from 'obsidian';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GitSyncHost } from './git-types';
import type { CommitOutcome, WorkingTreeState } from './git-types';
import type { GitRunner } from './git-runner';

export class GitWorkingTree {
	private _cachedExcludePatterns: string | null = null;
	private _cachedExcludeRegexes: RegExp[] = [];
	private _cachedProtectedPaths: string[] | null = null;
	private _cachedWorkspacePaths: string[] | null = null;
	private _hasHead: boolean | null = null;
	private _gitignoreVerified = false;

	constructor(
		private readonly plugin: GitSyncHost,
		private readonly runner: GitRunner,
		private readonly getVaultPath: () => string,
	) {}

	async inspectWorkingTree(): Promise<WorkingTreeState> {
		const statusResult = await this.runner.runGitResult(['status', '--porcelain=v1']);
		const status = statusResult.code === 0 ? statusResult.stdout : '';
		const entries = status.split('\n').map(line => line.trimEnd()).filter(Boolean);
		const conflicts = entries.filter(line => this.isConflictStatus(line)).map(line => this.statusPath(line));
		const nonProtectedEntries = this.plugin.settings.protectPluginData
			? entries.filter(line => !this.isProtectedStatusLine(line))
			: entries;
		const committableEntries = nonProtectedEntries.filter(line => !this.isExcludedStatusLine(line));

		return {
			entries,
			conflicts,
			hasConflicts: conflicts.length > 0,
			hasCommittableChanges: committableEntries.length > 0,
			hasOnlyProtectedChanges: entries.length > 0 && nonProtectedEntries.length === 0,
			hasOnlyExcludedChanges: entries.length > 0 && nonProtectedEntries.length > 0 && committableEntries.length === 0,
		};
	}

	async hasStagedChanges(): Promise<boolean> {
		const result = await this.runner.runGitResult(['diff', '--cached', '--quiet', '--exit-code']);
		if (result.code === 0) return false;
		if (result.code === 1) return true;
		throw new Error(result.output || `Git command exited with status ${result.code}.`);
	}

	async getStagedPaths(): Promise<{ path: string; status: string }[]> {
		const result = await this.runner.runGitResult(['diff', '--cached', '--name-status', '-z']);
		if (result.code !== 0 || !result.stdout) return [];
		const tokens = result.stdout.split('\0').map(t => t.trim()).filter(Boolean);
		const entries: { path: string; status: string }[] = [];
		let i = 0;
		while (i < tokens.length) {
			const status = tokens[i] ?? '';
			const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
			// For renames/copies git emits: status\0old_path\0new_path — use new_path (destination)
			const filePath = isRenameOrCopy ? (tokens[i + 2] ?? '') : (tokens[i + 1] ?? '');
			if (status && filePath) entries.push({ path: filePath, status: status[0] ?? 'M' });
			i += isRenameOrCopy ? 3 : 2;
		}
		return entries;
	}

	async hasHead(): Promise<boolean> {
		// Once HEAD exists it stays; only null→true transition matters.
		// False is not cached — first commit creates HEAD and must re-check.
		if (this._hasHead === true) return true;
		const result = await this.runner.runGitResult(['rev-parse', '--verify', '--quiet', 'HEAD']);
		if (result.code === 0) this._hasHead = true;
		return result.code === 0;
	}

	async commitChanges(preInspected?: WorkingTreeState): Promise<CommitOutcome> {
		const state = preInspected ?? await this.inspectWorkingTree();

		if (state.hasConflicts) {
			throw new Error(`Resolve Git conflicts before syncing: ${state.conflicts.join(', ')}`);
		}

		if (!state.hasCommittableChanges) {
			return {
				committed: false,
				protectedOnly: state.hasOnlyProtectedChanges,
				excludedOnly: state.hasOnlyExcludedChanges,
				excludedPaths: [],
			};
		}

		const hasHead = await this.hasHead();
		// Untrack protected paths before staging so git add -A never touches them
		if (this.plugin.settings.protectPluginData) {
			for (const p of this.protectedPaths()) {
				await this.runner.runGitResult(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', p]);
			}
		}
		await this.runner.runGit(['add', '-A']);
		await this.unstageProtectedPaths(hasHead);
		const excludedPaths = await this.unstageExcludedPaths(hasHead);

		if (excludedPaths.length > 0) {
			new Notice(this.formatExcludedNotice(excludedPaths), 12000);
		}

		if (!await this.hasStagedChanges()) {
			const afterAdd = await this.inspectWorkingTree();
			return {
				committed: false,
				protectedOnly: afterAdd.hasOnlyProtectedChanges,
				excludedOnly: afterAdd.hasOnlyExcludedChanges || excludedPaths.length > 0,
				excludedPaths,
			};
		}

		const stagedPaths = await this.getStagedPaths();
		await this.runner.runGit([...this.identityArgs(), 'commit', '-m', this.buildCommitMessage(stagedPaths)]);
		return { committed: true, protectedOnly: false, excludedOnly: false, excludedPaths };
	}

	buildCommitMessage(staged?: { path: string; status: string }[]): string {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

		const summary = staged ? this.buildSmartSummary(staged) : '';

		if (this.plugin.settings.commitMessageMode === 'smart' && summary) {
			const template = this.plugin.settings.commitMessage;
			if (template.includes('{summary}')) {
				return template
					.replace(/\{host\}/g, os.hostname())
					.replace(/\{date\}/g, date)
					.replace(/\{time\}/g, time)
					.replace(/\{summary\}/g, summary);
			}
			return summary;
		}

		return this.plugin.settings.commitMessage
			.replace(/\{host\}/g, os.hostname())
			.replace(/\{date\}/g, date)
			.replace(/\{time\}/g, time)
			.replace(/\{summary\}/g, summary);
	}

	identityArgs(): string[] {
		const args: string[] = [];
		if (this.plugin.settings.commitAuthorName) {
			args.push('-c', `user.name=${this.plugin.settings.commitAuthorName}`);
		}
		if (this.plugin.settings.commitAuthorEmail) {
			args.push('-c', `user.email=${this.plugin.settings.commitAuthorEmail}`);
		}
		return args;
	}

	isExcludedPath(file: string, includeWorkspace: boolean): boolean {
		if (includeWorkspace && this.plugin.settings.excludeWorkspace && this.workspacePaths().includes(file)) {
			return true;
		}
		return this.excludeRegexes().some(regex => regex.test(file));
	}

	protectedPaths(): string[] {
		if (!this._cachedProtectedPaths) {
			this._cachedProtectedPaths = [`.obsidian/plugins/${this.plugin.manifest.id}/data.json`];
		}
		return this._cachedProtectedPaths;
	}

	workspacePaths(): string[] {
		if (!this._cachedWorkspacePaths) {
			this._cachedWorkspacePaths = ['.obsidian/workspace.json', '.obsidian/workspace'];
		}
		return this._cachedWorkspacePaths;
	}

	async ensureGitignore(): Promise<void> {
		if (!this.plugin.settings.manageGitignore) return;
		// Skip after successful verification — gitignore entries don't disappear on their own.
		// Invalidated only when settings change (plugin reload or settings tab save).
		if (this._gitignoreVerified) return;

		const required = [
			...(this.plugin.settings.protectPluginData ? this.protectedPaths() : []),
			...(this.plugin.settings.excludeWorkspace ? this.workspacePaths() : []),
		];
		if (required.length === 0) { this._gitignoreVerified = true; return; }

		const gitignorePath = path.join(this.getVaultPath(), '.gitignore');

		let existing = '';
		try {
			existing = await fs.readFile(gitignorePath, 'utf8');
		} catch {
			// Missing .gitignore is fine; will be created below.
		}

		const existingLines = new Set(existing.split(/\r?\n/).map(line => line.trim()));
		const missing = required.filter(file => !existingLines.has(file));
		if (missing.length === 0) { this._gitignoreVerified = true; return; }

		const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
		const block = `${prefix}\n# Git Sync Auto managed ignores\n${missing.join('\n')}\n`;
		await fs.appendFile(gitignorePath, block, 'utf8');
		this._gitignoreVerified = true;
	}

	invalidateGitignoreCache(): void {
		this._gitignoreVerified = false;
	}

	async autoStashBefore(): Promise<string | null> {
		if (!this.plugin.settings.autoStashOnPull) return null;
		const workingTree = await this.inspectWorkingTree();
		if (!workingTree.entries.length) return null;

		const label = `gsa-autostash-${Date.now()}`;
		await this.runner.runGit(['stash', 'push', '--include-untracked', '-m', label]);
		return label;
	}

	async autoStashAfter(stashLabel: string | null): Promise<void> {
		if (!stashLabel) return;

		const listResult = await this.runner.runGitResult(['stash', 'list', '--format=%gd %s']);
		const match = listResult.stdout.split('\n').find(line => line.includes(stashLabel));
		if (!match) {
			new Notice('Auto-stash entry not found after pull — changes may have been applied automatically.', 8000);
			return;
		}

		const stashRef = match.split(' ')[0] ?? 'stash@{0}';
		const result = await this.runner.runGitResult(['stash', 'pop', stashRef]);
		if (result.code !== 0) {
			new Notice(`Auto-stash pop had conflicts. Stash ref: ${stashRef}. Resolve manually.`, 12000);
		}
	}

	private isConflictStatus(line: string): boolean {
		const status = line.slice(0, 2);
		return status.includes('U') || status === 'AA' || status === 'DD';
	}

	private isProtectedStatusLine(line: string): boolean {
		const p = this.statusPath(line);
		return this.protectedPaths().some(protectedPath => p === protectedPath);
	}

	private isExcludedStatusLine(line: string): boolean {
		return this.isExcludedPath(this.statusPath(line), false);
	}

	statusPath(line: string): string {
		let p = line.slice(3);
		const renameSeparator = ' -> ';
		if (p.includes(renameSeparator)) {
			p = p.slice(p.lastIndexOf(renameSeparator) + renameSeparator.length);
		}
		if (p.startsWith('"') && p.endsWith('"')) {
			p = decodeGitQuotedPath(p.slice(1, -1));
		}
		return p;
	}

	private addPathspecs(): string[] {
		if (!this.plugin.settings.protectPluginData) return [];
		return ['--', '.', ...this.protectedPaths().map(p => `:(exclude)${p}`)];
	}

	private async unstageProtectedPaths(hasHead: boolean): Promise<void> {
		if (!this.plugin.settings.protectPluginData) return;

		for (const p of this.protectedPaths()) {
			await (hasHead
				? this.runner.runGitResult(['reset', '--quiet', 'HEAD', '--', p])
				: this.runner.runGitResult(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', p]));
		}
	}

	private async unstageExcludedPaths(hasHead: boolean): Promise<string[]> {
		const stagedResult = await this.runner.runGitResult(['diff', '--cached', '--name-only', '-z']);
		const files = (stagedResult.code === 0 ? stagedResult.stdout : '')
			.split('\0').map(file => file.trim()).filter(Boolean);
		const excluded: string[] = [];

		for (const file of files) {
			if (await this.shouldUnstageExcludedFile(file)) {
				const result = hasHead
					? await this.runner.runGitResult(['reset', '--quiet', 'HEAD', '--', file])
					: await this.runner.runGitResult(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', file]);

				if (result.code === 0) excluded.push(file);
			}
		}

		return excluded;
	}

	private async shouldUnstageExcludedFile(file: string): Promise<boolean> {
		if (this.isExcludedPath(file, true)) return true;

		const maxSize = this.plugin.settings.maxFileSizeMB;
		if (maxSize <= 0) return false;

		try {
			const stat = await fs.stat(path.join(this.getVaultPath(), file));
			return stat.isFile() && stat.size > maxSize * 1024 * 1024;
		} catch {
			return false;
		}
	}

	private excludeRegexes(): RegExp[] {
		const current = this.plugin.settings.excludePatterns;
		if (this._cachedExcludePatterns !== current) {
			this._cachedExcludePatterns = current;
			this._cachedExcludeRegexes = current
				.split(/\r?\n/)
				.map(pattern => pattern.trim())
				.filter(Boolean)
				.map(pattern => this.globToRegExp(pattern));
		}
		return this._cachedExcludeRegexes;
	}

	private globToRegExp(glob: string): RegExp {
		const globstar = '__GIT_SYNC_GLOBSTAR__';
		const escaped = glob
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\?/g, '[^/]')
			.replace(/\*\*/g, globstar)
			.replace(/\*/g, '[^/]*')
			.replace(new RegExp(globstar, 'g'), '.*');
		return new RegExp(`^${escaped}$`);
	}

	private buildSmartSummary(staged: { path: string; status: string }[]): string {
		let notes = 0, attachments = 0, deleted = 0, renamed = 0, configs = 0;

		for (const { path: p, status } of staged) {
			if (status === 'D') { deleted++; continue; }
			if (status === 'R') { renamed++; continue; }
			const lower = p.toLowerCase();
			if (lower.endsWith('.md')) {
				notes++;
			} else if (lower.startsWith('.obsidian/') || lower.endsWith('.json') || lower.endsWith('.css')) {
				configs++;
			} else {
				attachments++;
			}
		}

		const parts: string[] = [];
		if (notes > 0) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
		if (attachments > 0) parts.push(`${attachments} attachment${attachments === 1 ? '' : 's'}`);
		if (configs > 0) parts.push(`${configs} config${configs === 1 ? '' : 's'}`);
		if (deleted > 0) parts.push(`${deleted} deleted`);
		if (renamed > 0) parts.push(`${renamed} renamed`);

		return parts.length > 0 ? `Update ${parts.join(', ')}` : 'Vault sync';
	}

	private formatExcludedNotice(paths: string[]): string {
		const preview = paths.slice(0, 5).join(', ');
		const suffix = paths.length > 5 ? `, and ${paths.length - 5} more` : '';
		return `Git sync skipped ${paths.length} excluded file${paths.length === 1 ? '' : 's'}: ${preview}${suffix}`;
	}

}

// Git quotes non-ASCII paths as octal escape sequences inside double-quotes.
// Decode them byte-by-byte then re-interpret as UTF-8 so the path matches the
// actual filename (required for exclude patterns and protected-path comparisons).
function decodeGitQuotedPath(s: string): string {
	const bytes: number[] = [];
	let i = 0;
	while (i < s.length) {
		if (s[i] === '\\' && i + 1 < s.length) {
			const next = s[i + 1]!;
			if (next >= '0' && next <= '7' && i + 3 < s.length) {
				bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
				i += 4;
			} else {
				const escapes: Record<string, number> = { '\\': 92, '"': 34, n: 10, t: 9, r: 13, b: 8 };
				bytes.push(escapes[next] ?? next.charCodeAt(0));
				i += 2;
			}
		} else {
			bytes.push(s.charCodeAt(i));
			i++;
		}
	}
	return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}
