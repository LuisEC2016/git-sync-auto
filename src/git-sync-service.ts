import { FileSystemAdapter, Notice } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import type { RepoStatusSnapshot } from './repo-status';
import { VIEW_TYPE_GIT_SYNC_AUTO } from './repo-status';
import { formatError, maskRemoteUrl, buildAuthenticatedUrl } from './settings';
import type { GitSyncHost, SyncReason, NoticeSeverity, SyncOutcome, PullOutcome, CommitOutcome } from './git-types';
import { GitRunner } from './git-runner';
import { GitWorkingTree } from './git-working-tree';
import { GitRemoteOps } from './git-remote-ops';

export type { GitSyncHost };

// Snapshot TTL: local-only status (no network) is cheap to re-run;
// remote relation (fetch) is expensive — cache it separately.
const SNAPSHOT_TTL_MS = 10_000;       // 10 s — local status cache
const REMOTE_RELATION_TTL_MS = 120_000; // 2 min — network fetch cache

interface RemoteRelationCache {
	ahead: number;
	behind: number;
	branch: string;
	head: string;
	at: number;
}

export class GitSyncService {
	private timeoutId: number | null = null;
	private periodicIntervalId: number | null = null;
	private isRunning = false;
	private pendingAutoSync = false;
	private lastPeriodicSyncAt = 0;
	private repoVerified = false;
	private cachedBranch: string | null = null;
	private statusBarEl: HTMLElement | null = null;
	private lastSnapshot: RepoStatusSnapshot | null = null;
	private lastSnapshotAt = 0;
	private lastSnapshotHasCommits = false;
	private remoteRelationCache: RemoteRelationCache | null = null;
	private syncDoneCallbacks: Array<() => void> = [];

	private readonly runner: GitRunner;
	private readonly workingTree: GitWorkingTree;
	private readonly remoteOps: GitRemoteOps;

	constructor(private readonly plugin: GitSyncHost) {
		this.runner = new GitRunner(
			() => this.getVaultPath(),
			(msg) => this.sanitizeMessage(msg),
		);
		this.workingTree = new GitWorkingTree(plugin, this.runner, () => this.getVaultPath());
		this.remoteOps = new GitRemoteOps(plugin, this.runner);
	}

	start(): void {
		const scheduleForFile = (file: TAbstractFile) => this.scheduleAutoSyncForFile(file);

		this.plugin.registerEvent(this.plugin.app.vault.on('create', scheduleForFile));
		this.plugin.registerEvent(this.plugin.app.vault.on('delete', scheduleForFile));
		this.plugin.registerEvent(this.plugin.app.vault.on('modify', scheduleForFile));
		this.plugin.registerEvent(this.plugin.app.vault.on('rename', scheduleForFile));
		this.plugin.register(() => this.unload());

		this.setupStatusBar();
		this.updateAutomation();

		if (this.plugin.settings.syncOnStartup) {
			this.scheduleSync(0);
		} else if (this.plugin.settings.checkStatusOnStartup) {
			void this.checkStatusOnStartup();
		} else {
			void this.refreshStatusBarSnapshot(false);
		}
	}

	updateAutoSync(): void {
		if (!this.plugin.settings.autoSync) {
			this.clearScheduledSync();
		}
		this.updateAutomation();
	}

	invalidateSettingsCache(): void {
		this.workingTree.invalidateGitignoreCache();
	}

	unload(): void {
		this.clearScheduledSync();
		this.clearPeriodicIntervals();
	}

	scheduleAutoSync(delaySeconds = this.plugin.settings.debounceSeconds): void {
		if (!this.plugin.settings.autoSync) return;
		if (this.isRunning) {
			this.pendingAutoSync = true;
			return;
		}
		this.scheduleSync(delaySeconds);
	}

	onSyncDone(cb: () => void): void {
		this.syncDoneCallbacks.push(cb);
	}

	async syncNow(reason: SyncReason): Promise<void> {
		if (this.isRunning) {
			if (reason === 'automatic') {
				this.pendingAutoSync = true;
			} else {
				this.showNotice('Git sync already running.', 'warning');
			}
			return;
		}

		this.clearScheduledSync();
		this.isRunning = true;
		// Reset periodic sync clock so a manual sync resets the interval window.
		// Prevents a redundant automatic sync firing seconds after a manual one.
		this.lastPeriodicSyncAt = Date.now();
		if (reason === 'manual') this.showNotice('Git sync started...', 'info');

		try {
			const outcome = await this.syncRepository();
			this.invalidateSnapshotCache();
			if (this.plugin.settings.showSuccessNotice || outcome.excludedPaths.length > 0) {
				this.showNotice(this.formatSyncOutcome(outcome), 'info', 8000);
			}
		} catch (error) {
			// Rebase/merge failures leave HEAD in an interrupted state; drop the
			// cached branch so the next currentBranch() re-reads actual git state.
			this.cachedBranch = null;
			console.error('Git sync failed', error);
			this.showNotice(`Git sync failed: ${formatError(error)}`, 'error', 10000);
		} finally {
			this.isRunning = false;
			this.plugin.invalidateGutterCache?.();
			await this.refreshStatusBarSnapshot(false);
			this.notifySyncDone();
			this.refreshViews();
			if (this.pendingAutoSync) {
				this.pendingAutoSync = false;
				this.scheduleAutoSync();
			}
		}
	}

	async pullNow(reason: SyncReason): Promise<void> {
		if (this.isRunning) {
			if (reason === 'automatic') {
				this.pendingAutoSync = true;
			} else {
				this.showNotice('Git sync already running.', 'warning');
			}
			return;
		}

		// Cancel any pending auto-sync timer — a pull now makes a sync seconds
		// later redundant, and avoids a queued syncNow firing on top of this pull.
		this.clearScheduledSync();
		this.isRunning = true;
		if (reason === 'manual') this.showNotice('Git pull started...', 'info');

		try {
			await this.ensureRepository();
			const branch = await this.currentBranch();
			const stashRef = await this.workingTree.autoStashBefore();
			let pull: PullOutcome;
			try {
				pull = await this.remoteOps.pullPrimaryWithBackoff(branch);
			} finally {
				// Always restore the stash even if pull fails — leaving a dangling
				// stash entry would hide the user's uncommitted work with no notice.
				await this.workingTree.autoStashAfter(stashRef);
			}
			const workingTree = await this.workingTree.inspectWorkingTree();

			if (workingTree.hasConflicts) {
				this.cachedBranch = null;
				this.plugin.openConflictModal(workingTree.conflicts);
				throw new Error(`Resolve Git conflicts before syncing: ${workingTree.conflicts.join(', ')}`);
			}

			this.invalidateSnapshotCache();
			if (this.plugin.settings.showSuccessNotice) {
				this.showNotice(this.formatPullOutcome(pull), 'info', 8000);
			}
		} catch (error) {
			// Rebase/merge conflicts leave HEAD in a detached/interrupted state;
			// invalidate the branch cache so the next currentBranch() call re-reads
			// the actual git state instead of returning the stale cached name.
			this.cachedBranch = null;
			console.error('Git pull failed', error);
			this.showNotice(`Git pull failed: ${formatError(error)}`, 'error', 10000);
		} finally {
			this.isRunning = false;
			this.plugin.invalidateGutterCache?.();
			await this.refreshStatusBarSnapshot(false);
			this.notifySyncDone();
			this.refreshViews();
			if (this.pendingAutoSync) {
				this.pendingAutoSync = false;
				this.scheduleAutoSync();
			}
		}
	}

	async showStatus(): Promise<void> {
		try {
			await this.ensureRepository();
			const statusResult = await this.runner.runGitResult(['status', '--short', '--branch']);
			const status = statusResult.code === 0 ? statusResult.stdout : '';
			const branch = await this.currentBranch();
			const tracking = await this.remoteOps.getTrackingBranch(branch);
			const workingTree = await this.workingTree.inspectWorkingTree();
			const details: string[] = [status.trim() || 'Working tree is clean.'];

			if (tracking && await this.remoteOps.refExists(tracking.ref)) {
				const relation = await this.remoteOps.compareRefs('HEAD', tracking.ref);
				details.push(`${tracking.displayName}: ${this.formatRelation(relation)}.`);
			} else {
				details.push('No upstream tracking branch configured.');
			}

			if (workingTree.hasOnlyProtectedChanges) {
				details.push('Only protected plugin settings are uncommitted.');
			}
			if (workingTree.hasOnlyExcludedChanges) {
				details.push('Only excluded paths are uncommitted.');
			}

			this.showNotice(details.join('\n'), 'info', 10000);
		} catch (error) {
			console.error('Git status failed', error);
			this.showNotice(`Git status failed: ${formatError(error)}`, 'error', 10000);
		}
	}

	async stageFile(filePath: string): Promise<void> {
		await this.ensureRepository();
		await this.runner.runGit(['add', '--', filePath]);
		this.invalidateSnapshotCache();
	}

	async unstageFile(filePath: string): Promise<void> {
		await this.ensureRepository();
		const hasHead = await this.workingTree.hasHead();
		if (hasHead) {
			await this.runner.runGit(['reset', 'HEAD', '--', filePath]);
		} else {
			await this.runner.runGit(['rm', '--cached', '--', filePath]);
		}
		this.invalidateSnapshotCache();
	}

	async resetFile(filePath: string): Promise<void> {
		await this.ensureRepository();
		const hasHead = await this.workingTree.hasHead();
		if (hasHead) {
			await this.runner.runGit(['restore', '--', filePath]);
		} else {
			await this.runner.runGit(['rm', '--cached', '--', filePath]);
		}
		this.invalidateSnapshotCache();
	}

	async discardFile(filePath: string): Promise<void> {
		await this.ensureRepository();
		const hasHead = await this.workingTree.hasHead();
		if (hasHead) {
			// Unstage first (in case staged), then restore working tree to HEAD
			try { await this.runner.runGit(['restore', '--staged', '--', filePath]); } catch { /* not staged, ok */ }
			await this.runner.runGit(['restore', '--', filePath]);
		} else {
			// No commits: untrack new file (removes from index, leaves working copy)
			await this.runner.runGit(['rm', '--cached', '--force', '--', filePath]);
		}
		this.invalidateSnapshotCache();
	}

	async commitStaged(message?: string): Promise<void> {
		await this.ensureRepository();
		if (!await this.workingTree.hasStagedChanges()) {
			throw new Error('No staged changes to commit.');
		}
		const staged = await this.workingTree.getStagedPaths();
		const msg = message?.trim() || this.workingTree.buildCommitMessage(staged);
		await this.runner.runGit([...this.workingTree.identityArgs(), 'commit', '-m', msg]);
		this.invalidateSnapshotCache();
		await this.refreshStatusBarSnapshot(false);
		this.refreshViews();
	}

	async getDiffForFile(filePath: string, staged: boolean): Promise<string> {
		await this.ensureRepository();
		const hasHead = await this.workingTree.hasHead();
		const args = staged || !hasHead
			? ['diff', '--cached', '--', filePath]
			: ['diff', 'HEAD', '--', filePath];
		const result = await this.runner.runGitResult(args);
		return result.code === 0 ? result.stdout : '';
	}

	async getCommitDiff(hash: string): Promise<string> {
		await this.ensureRepository();
		const result = await this.runner.runGitResult(['show', '--stat', '-p', hash]);
		return result.code === 0 ? result.stdout : '';
	}

	async squashCommits(n: number): Promise<void> {
		if (n < 2) throw new Error('Must squash at least 2 commits.');
		await this.ensureRepository();

		const countResult = await this.runner.runGitResult(['rev-list', '--count', 'HEAD']);
		const totalCommits = parseInt(countResult.stdout.trim(), 10);
		if (!Number.isFinite(totalCommits)) {
			throw new Error('Could not determine commit count.');
		}
		if (totalCommits < n) {
			throw new Error(`Only ${totalCommits} commit(s) in history, cannot squash ${n}.`);
		}

		const logResult = await this.runner.runGitResult(['log', `--format=%s`, `-n`, String(n)]);
		const messages = logResult.stdout.split('\n').filter(Boolean).reverse();
		const combined = messages.join('\n');

		await this.runner.runGit(['reset', '--soft', `HEAD~${n}`]);
		try {
			await this.runner.runGit([...this.workingTree.identityArgs(), 'commit', '-m', combined]);
		} catch (err) {
			// reset --soft already moved HEAD; cache and branch are stale regardless
			this.cachedBranch = null;
			this.invalidateSnapshotCache();
			await this.refreshStatusBarSnapshot(false);
			this.refreshViews();
			throw err;
		}
		this.invalidateSnapshotCache();
		await this.refreshStatusBarSnapshot(false);
		this.refreshViews();
		this.showNotice(`Squashed ${n} commits into one.`, 'info', 6000);
	}

	async listBranches(): Promise<string[]> {
		try {
			await this.ensureRepository();
			const result = await this.runner.runGitResult(['branch', '--format=%(refname:short)']);
			if (result.code !== 0) return [];
			return result.stdout.split('\n').map(b => b.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	async switchBranch(branch: string, create: boolean): Promise<void> {
		await this.ensureRepository();
		if (create) {
			await this.runner.runGit(['checkout', '-b', branch]);
		} else {
			await this.runner.runGit(['checkout', branch]);
		}
		this.cachedBranch = branch;
		this.invalidateSnapshotCache();
		await this.refreshStatusBarSnapshot(false);
		this.refreshViews();
	}

	async getIncomingChanges(branch: string): Promise<{ commits: { hash: string; author: string; date: string; message: string }[]; diff: string }> {
		await this.ensureRepository();
		const primary = this.remoteOps.getPrimaryRemote();

		if (primary) {
			const tempName = `_gsa_prev_${Math.random().toString(36).slice(2, 10)}`;
			await this.runner.runGitResult(['remote', 'remove', tempName]);
			await this.runner.runGit(['remote', 'add', tempName, buildAuthenticatedUrl(primary)]);
			try {
				await this.runner.runGit(['fetch', tempName]);
				const remoteRef = `${tempName}/${branch}`;
				if (!await this.remoteOps.refExists(remoteRef)) return { commits: [], diff: '' };
				const relation = await this.remoteOps.compareRefs('HEAD', remoteRef);
				if (relation.behind === 0) return { commits: [], diff: '' };
				const logResult = await this.runner.runGitResult([
					'log', `HEAD..${remoteRef}`, '--date=iso-strict', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s',
				]);
				const commits = (logResult.code === 0 && logResult.stdout)
					? logResult.stdout.split('\n').filter(Boolean).map(line => {
						const [hash = '', author = '', date = '', message = ''] = line.split('\x1f');
						return { hash, author, date, message };
					})
					: [];
				const diffResult = await this.runner.runGitResult(['diff', `HEAD...${remoteRef}`]);
				return { commits, diff: diffResult.code === 0 ? diffResult.stdout : '' };
			} finally {
				await this.runner.runGitResult(['remote', 'remove', tempName]);
			}
		}

		const tracking = await this.remoteOps.getTrackingBranch(branch);
		if (!tracking) return { commits: [], diff: '' };
		await this.runner.runGit(['fetch', tracking.remote]);
		if (!await this.remoteOps.refExists(tracking.ref)) return { commits: [], diff: '' };
		const logResult = await this.runner.runGitResult([
			'log', `HEAD..${tracking.ref}`, '--date=iso-strict', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s',
		]);
		const commits = (logResult.code === 0 && logResult.stdout)
			? logResult.stdout.split('\n').filter(Boolean).map(line => {
				const [hash = '', author = '', date = '', message = ''] = line.split('\x1f');
				return { hash, author, date, message };
			})
			: [];
		const diffResult = await this.runner.runGitResult(['diff', `HEAD...${tracking.ref}`]);
		return { commits, diff: diffResult.code === 0 ? diffResult.stdout : '' };
	}

	getPrimaryRemote() {
		return this.remoteOps.getPrimaryRemote();
	}

	async getCurrentBranch(): Promise<string> {
		return this.currentBranch();
	}

	async getGitUser(): Promise<string> {
		try {
			const result = await this.runner.runGitResult(['config', 'user.name']);
			return result.code === 0 ? result.stdout.trim() || 'unknown' : 'unknown';
		} catch {
			return 'unknown';
		}
	}

	async testConnection(): Promise<void> {
		try {
			await this.ensureRepository();
			const configured = this.plugin.settings.remotes.filter(remote => remote.enabled && remote.url);

			if (configured.length > 0) {
				for (const remote of configured) {
					await this.runner.runGit(['ls-remote', '--heads', buildAuthenticatedUrl(remote)]);
				}
				this.showNotice(`Connection OK for ${configured.length} configured remote${configured.length === 1 ? '' : 's'}.`, 'info', 8000);
				return;
			}

			const remotes = await this.remoteOps.listRemotes();
			if (remotes.length === 0) {
				this.showNotice('No Git remote configured.', 'warning', 8000);
				return;
			}

			for (const remote of remotes) {
				await this.runner.runGit(['ls-remote', '--heads', remote]);
			}
			this.showNotice(`Connection OK for ${remotes.join(', ')}.`, 'info', 8000);
		} catch (error) {
			console.error('Git connection test failed', error);
			this.showNotice(`Git connection test failed: ${formatError(error)}`, 'error', 10000);
		}
	}

	async getRepoStatus(fetchRemote = true, includeRecentCommits = true): Promise<RepoStatusSnapshot> {
		if (this.isRunning) {
			return this.emptySnapshot('__syncing__');
		}

		const now = Date.now();
		if (this.lastSnapshot && !this.lastSnapshot.error && now - this.lastSnapshotAt < SNAPSHOT_TTL_MS) {
			// Snapshot is fresh. For fetchRemote=false, always return cache.
			// For fetchRemote=true, return cache only if remote relation is also fresh —
			// avoids a full rebuild when both local and remote data are already current.
			// If the caller needs commits but the cached snapshot was built without them,
			// fall through to rebuild so the view never shows an empty commit list.
			const commitsMissing = includeRecentCommits && !this.lastSnapshotHasCommits;
			if (!commitsMissing && (!fetchRemote || !this.isRemoteRelationStale())) {
				return this.lastSnapshot;
			}
		}

		try {
			const snapshot = await this.buildRepoStatus(fetchRemote, includeRecentCommits);
			this.lastSnapshot = snapshot;
			this.lastSnapshotAt = Date.now();
			this.lastSnapshotHasCommits = includeRecentCommits;
			this.updateStatusBar();
			return snapshot;
		} catch (error) {
			const snapshot = this.emptySnapshot(formatError(error));
			this.lastSnapshot = snapshot;
			this.lastSnapshotAt = 0;
			this.lastSnapshotHasCommits = false;
			this.updateStatusBar();
			return snapshot;
		}
	}

	private invalidateSnapshotCache(): void {
		this.lastSnapshotAt = 0;
		this.remoteRelationCache = null;
	}

	private notifySyncDone(): void {
		const cbs = this.syncDoneCallbacks.splice(0);
		for (const cb of cbs) {
			try { cb(); } catch { /* ignore */ }
		}
	}

	private async syncRepository(): Promise<SyncOutcome> {
		await this.ensureRepository();
		await this.workingTree.ensureGitignore();
		const branch = await this.currentBranch();

		const backoff = this.remoteOps.isNetworkBackoffActive();
		if (backoff.active) {
			this.log(`Network backoff active, skipping remote operations for ${backoff.waitSec}s`);
			const commit = await this.workingTree.commitChanges();
			return {
				committed: commit.committed,
				pulled: false,
				pushes: [{ remote: 'all remotes', pushed: false, skippedReason: `Network backoff: retry in ${backoff.waitSec}s` }],
				protectedOnly: commit.protectedOnly && !commit.committed,
				excludedOnly: commit.excludedOnly && !commit.committed,
				excludedPaths: commit.excludedPaths,
			};
		}

		const workingTreeState = await this.workingTree.inspectWorkingTree();

		if (workingTreeState.hasConflicts) {
			this.plugin.openConflictModal(workingTreeState.conflicts);
			throw new Error(`Resolve Git conflicts before syncing: ${workingTreeState.conflicts.join(', ')}`);
		}

		if (!workingTreeState.hasCommittableChanges && !workingTreeState.hasConflicts) {
			const stashRef = await this.workingTree.autoStashBefore();
			let pull: PullOutcome;
			try {
				pull = await this.remoteOps.pullPrimaryWithBackoff(branch);
			} finally {
				await this.workingTree.autoStashAfter(stashRef);
			}
			const afterPull = await this.workingTree.inspectWorkingTree();
			if (afterPull.hasConflicts) {
				this.plugin.openConflictModal(afterPull.conflicts);
				throw new Error(`Resolve Git conflicts before syncing: ${afterPull.conflicts.join(', ')}`);
			}
			return {
				committed: false,
				pulled: pull.pulled,
				pushes: [],
				protectedOnly: workingTreeState.hasOnlyProtectedChanges,
				excludedOnly: workingTreeState.hasOnlyExcludedChanges,
				excludedPaths: [],
			};
		}

		// Pass pre-inspected state — avoids a second `git status` inside commitChanges()
		const commit = await this.workingTree.commitChanges(workingTreeState);
		const stashRef = await this.workingTree.autoStashBefore();
		let pull: PullOutcome;
		try {
			pull = await this.remoteOps.pullPrimaryWithBackoff(branch);
		} finally {
			await this.workingTree.autoStashAfter(stashRef);
		}
		const afterPull = await this.workingTree.inspectWorkingTree();

		if (afterPull.hasConflicts) {
			this.plugin.openConflictModal(afterPull.conflicts);
			throw new Error(`Resolve Git conflicts before syncing: ${afterPull.conflicts.join(', ')}`);
		}

		const pushes = await this.remoteOps.pushAllRemotesWithBackoff(branch);

		return {
			committed: commit.committed,
			pulled: pull.pulled,
			pushes,
			protectedOnly: commit.protectedOnly && !commit.committed,
			excludedOnly: commit.excludedOnly && !commit.committed,
			excludedPaths: commit.excludedPaths,
		};
	}

	private async ensureRepository(): Promise<void> {
		// Skip the subprocess after first successful verification — the vault path
		// does not change at runtime, so re-checking on every operation is wasteful.
		if (this.repoVerified) return;
		const repoResult = await this.runner.runGitResult(['rev-parse', '--is-inside-work-tree']);
		if (repoResult.stdout.trim() !== 'true') {
			throw new Error('Vault folder is not inside a Git repository.');
		}
		this.repoVerified = true;
	}

	private async currentBranch(): Promise<string> {
		if (this.cachedBranch) return this.cachedBranch;
		const result = await this.runner.runGitResult(['rev-parse', '--abbrev-ref', 'HEAD']);
		if (result.code !== 0) throw new Error(result.output || 'Failed to determine current branch.');
		// Use stdout only — stderr warnings corrupt the branch name.
		const branch = result.stdout.trim();
		if (!branch || branch === 'HEAD') {
			throw new Error('Cannot sync while Git HEAD is detached.');
		}
		this.cachedBranch = branch;
		return branch;
	}

	private scheduleAutoSyncForFile(file: TAbstractFile): void {
		// Fast path: if a sync is already scheduled, no need to re-evaluate this
		// file's exclusion status — the sync will handle whatever is pending.
		if (this.timeoutId !== null || this.isRunning) return;

		if (this.plugin.settings.protectPluginData && this.workingTree.protectedPaths().includes(file.path)) return;
		if (this.plugin.settings.excludeWorkspace && this.workingTree.workspacePaths().includes(file.path)) return;
		if (this.workingTree.isExcludedPath(file.path, false)) return;
		const isMarkdown = file.path.endsWith('.md');
		const delay = isMarkdown
			? this.plugin.settings.debounceSeconds
			: this.plugin.settings.nonMarkdownDebounceSeconds;
		this.scheduleAutoSync(delay);
	}

	private scheduleSync(delaySeconds: number): void {
		this.clearScheduledSync();
		this.timeoutId = window.setTimeout(() => {
			this.timeoutId = null;
			void this.syncNow('automatic');
		}, delaySeconds * 1000);
	}

	private clearScheduledSync(): void {
		if (this.timeoutId === null) return;
		window.clearTimeout(this.timeoutId);
		this.timeoutId = null;
	}

	private updateAutomation(): void {
		this.clearPeriodicIntervals();

		const syncMs = this.plugin.settings.periodicSyncMinutes * 60_000;
		const pullMs = this.plugin.settings.periodicPullMinutes * 60_000;

		// Single unified interval fires at GCD(syncMs, pullMs) — avoids two
		// independent timers that could wake the process twice at the same tick.
		// If only one is configured, that period is used directly.
		const periodMs = syncMs > 0 && pullMs > 0
			? gcd(syncMs, pullMs)
			: syncMs > 0 ? syncMs : pullMs > 0 ? pullMs : 0;

		if (periodMs > 0) {
			this.periodicIntervalId = this.plugin.registerInterval(
				window.setInterval(() => {
					void this.periodicTickIfNeeded(syncMs, pullMs);
				}, periodMs),
			);
		}
	}

	// Single tick: evaluate both sync and pull conditions. Priority: sync > pull.
	// - syncDue AND (local changes OR remote stale) → full sync (subsumes pull)
	// - pullDue only, no local changes → pull only
	// Parallelizing hasLocalChanges() sub-checks where safe.
	private async periodicTickIfNeeded(syncMs: number, pullMs: number): Promise<void> {
		if (this.isRunning) return;

		const now = Date.now();
		const syncDue = syncMs > 0 && (now - this.lastPeriodicSyncAt >= syncMs);
		const pullDue = pullMs > 0 && this.isRemoteRelationStale();

		if (!syncDue && !pullDue) return;

		if (syncDue) {
			this.lastPeriodicSyncAt = now;
			// Parallel diff checks — both are read-only, independent git processes
			const hasLocal = await this.hasLocalChanges();
			if (hasLocal || pullDue) {
				void this.syncNow('automatic');
				return;
			}
			// syncDue but clean tree and remote fresh — nothing to do
			return;
		}

		// pullDue only: check if local changes exist before choosing operation;
		// local changes → full sync is safer than pull-only (avoids merge conflicts
		// on dirty tree without committing first).
		const hasLocal = await this.hasLocalChanges();
		if (hasLocal) {
			void this.syncNow('automatic');
		} else {
			void this.pullNow('automatic');
		}
	}

	// Two independent read-only diffs run in parallel — no shared git state.
	// Each exits 0 (clean) or 1 (dirty); error exit treated as dirty.
	private async hasLocalChanges(): Promise<boolean> {
		try {
			const [index, working] = await Promise.all([
				this.runner.runGitResult(['diff', '--cached', '--quiet', '--exit-code']),
				this.runner.runGitResult(['diff', '--quiet', '--exit-code']),
			]);
			return index.code === 1 || working.code === 1;
		} catch {
			return true;
		}
	}

	private isRemoteRelationStale(): boolean {
		if (!this.remoteRelationCache) return true;
		return Date.now() - this.remoteRelationCache.at >= REMOTE_RELATION_TTL_MS;
	}

	private clearPeriodicIntervals(): void {
		if (this.periodicIntervalId !== null) {
			window.clearInterval(this.periodicIntervalId);
			this.periodicIntervalId = null;
		}
	}

	private setupStatusBar(): void {
		this.statusBarEl = this.plugin.addStatusBarItem();
		this.statusBarEl.addClass('git-sync-status');
		this.statusBarEl.setAttr('aria-label', 'Open Git sync');
		this.statusBarEl.onClickEvent(() => {
			void this.plugin.activateGitSyncView();
		});
		this.updateStatusBar();
	}

	private async refreshStatusBarSnapshot(fetchRemote: boolean): Promise<void> {
		if (!this.statusBarEl || this.isRunning) return;
		await this.getRepoStatus(fetchRemote, false);
	}

	private updateStatusBar(overrideText?: string): void {
		if (!this.statusBarEl) return;

		if (overrideText) {
			this.statusBarEl.setText(overrideText);
			return;
		}

		const snapshot = this.lastSnapshot;
		if (!snapshot) {
			this.statusBarEl.setText('Git sync');
			return;
		}
		if (snapshot.error) {
			this.statusBarEl.setText('Git sync !');
			return;
		}

		let text = snapshot.branch || 'Git sync';
		if (snapshot.ahead > 0) text += ` +${snapshot.ahead}`;
		if (snapshot.behind > 0) text += ` -${snapshot.behind}`;
		if (snapshot.changed.length > 0) text += ` *${snapshot.changed.length}`;
		if (snapshot.conflicted.length > 0) text += ` !${snapshot.conflicted.length}`;
		this.statusBarEl.setText(text);
	}

	private async checkStatusOnStartup(): Promise<void> {
		const snapshot = await this.getRepoStatus(true, false);
		if (snapshot.error) {
			this.log('Startup status check failed', snapshot.error);
			return;
		}
		if (snapshot.behind > 0) {
			this.showNotice(`Git sync: ${snapshot.behind} remote commit(s) ready to pull.`, 'warning', 10000);
		}
	}

	private async buildRepoStatus(fetchRemote: boolean, includeRecentCommits: boolean): Promise<RepoStatusSnapshot> {
		await this.ensureRepository();
		const branch = await this.currentBranch();
		const [relation, workingTreeState] = await Promise.all([
			this.getDisplayRelation(branch, fetchRemote),
			this.workingTree.inspectWorkingTree(),
		]);
		const recent = includeRecentCommits ? await this.recentCommits() : [];

		return {
			branch,
			ahead: relation?.ahead ?? 0,
			behind: relation?.behind ?? 0,
			changed: workingTreeState.entries.map(line => ({
				path: this.workingTree.statusPath(line),
				index: line.slice(0, 1),
				working: line.slice(1, 2),
			})),
			conflicted: workingTreeState.conflicts,
			recent,
		};
	}

	private async getDisplayRelation(branch: string, fetchRemote: boolean): Promise<{ ahead: number; behind: number } | null> {
		// Fast path: when not fetching remote and cache is within TTL on same branch,
		// skip the `git rev-parse HEAD` subprocess used for HEAD-change detection.
		// HEAD cannot change without an operation that calls invalidateSnapshotCache(),
		// so TTL + branch match is sufficient when no network fetch is requested.
		if (!fetchRemote && this.remoteRelationCache) {
			const age = Date.now() - this.remoteRelationCache.at;
			if (age < REMOTE_RELATION_TTL_MS && this.remoteRelationCache.branch === branch) {
				return { ahead: this.remoteRelationCache.ahead, behind: this.remoteRelationCache.behind };
			}
		}

		const currentHead = await this.remoteOps.getHead();

		// Serve cached remote relation when: TTL not expired AND same branch AND HEAD unchanged.
		// This avoids a git-fetch network call on every status panel render.
		if (this.remoteRelationCache && currentHead) {
			const age = Date.now() - this.remoteRelationCache.at;
			if (
				age < REMOTE_RELATION_TTL_MS &&
				this.remoteRelationCache.branch === branch &&
				this.remoteRelationCache.head === currentHead
			) {
				return { ahead: this.remoteRelationCache.ahead, behind: this.remoteRelationCache.behind };
			}
		}

		const primary = this.remoteOps.getPrimaryRemote();

		let relation: { ahead: number; behind: number } | null = null;

		if (primary && fetchRemote) {
			const tempName = `_gsa_disp_${Math.random().toString(36).slice(2, 10)}`;
			await this.runner.runGitResult(['remote', 'remove', tempName]);
			await this.runner.runGit(['remote', 'add', tempName, buildAuthenticatedUrl(primary)]);
			try {
				await this.runner.runGit(['fetch', tempName]);
				const remoteRef = `${tempName}/${branch}`;
				if (await this.remoteOps.refExists(remoteRef)) {
					relation = await this.remoteOps.compareRefs('HEAD', remoteRef);
				}
			} finally {
				await this.runner.runGitResult(['remote', 'remove', tempName]);
			}
		}

		// When we cannot (or should not) fetch, fall back to the git-configured
		// tracking branch. This lets ahead/behind display work from local FETCH_HEAD
		// data without a network call — useful for status-bar refreshes.
		if (!relation) {
			const tracking = await this.remoteOps.getTrackingBranch(branch);
			if (tracking) {
				if (fetchRemote && !primary) await this.runner.runGit(['fetch', tracking.remote]);
				if (await this.remoteOps.refExists(tracking.ref)) {
					relation = await this.remoteOps.compareRefs('HEAD', tracking.ref);
				}
			}
		}

		if (relation && currentHead) {
			this.remoteRelationCache = { ...relation, branch, head: currentHead, at: Date.now() };
		}

		return relation;
	}

	private async recentCommits(): Promise<RepoStatusSnapshot['recent']> {
		const result = await this.runner.runGitResult([
			'log', '-n', '10', '--date=iso-strict', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s',
		]);

		if (result.code !== 0 || !result.stdout) return [];

		return result.stdout.split('\n').filter(Boolean).map(line => {
			const [hash = '', author = '', date = '', message = ''] = line.split('\x1f');
			return { hash, author, date, message };
		});
	}

	private emptySnapshot(error?: string): RepoStatusSnapshot {
		return { branch: '', ahead: 0, behind: 0, changed: [], conflicted: [], recent: [], error };
	}

	private refreshViews(fetchRemote = false): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC_AUTO)) {
			const view = leaf.view as { render?: (fetchRemote?: boolean) => Promise<void> | void };
			void view.render?.(fetchRemote);
		}
	}

	getVaultPath(): string {
		const { adapter } = this.plugin.app.vault;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('Git sync requires a local desktop vault.');
		}
		return adapter.getBasePath();
	}

	private log(...args: unknown[]): void {
		if (this.plugin.settings.verboseLog) {
			console.log('[Git Sync Auto]', ...args);
		}
	}

	private showNotice(message: string, severity: NoticeSeverity, timeout?: number): void {
		const text = this.sanitizeMessage(message);
		if (severity === 'error') {
			console.error('[Git Sync Auto]', text);
		} else {
			this.log(severity, text);
		}

		if (!this.shouldShowNotice(severity)) return;
		new Notice(text, timeout);
	}

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.plugin.settings.noticeLevel) {
			case 'errors':
				return severity === 'error';
			case 'warnings':
				return severity === 'warning' || severity === 'error';
			case 'all':
			default:
				return true;
		}
	}

	private sanitizeMessage(message: string): string {
		let sanitized = message;

		for (const remote of this.plugin.settings.remotes) {
			const authenticatedUrl = buildAuthenticatedUrl(remote);
			if (authenticatedUrl) sanitized = sanitized.split(authenticatedUrl).join(maskRemoteUrl(remote));
			if (remote.token) sanitized = sanitized.split(remote.token).join('***');
			if (remote.username && remote.token) {
				sanitized = sanitized.split(`${remote.username}:${remote.token}`).join(`${remote.username}:***`);
			}
		}

		return sanitized;
	}

	private formatPullOutcome(outcome: PullOutcome): string {
		if (outcome.pulled) return `Git pull complete: rebased from ${outcome.target}.`;
		if (outcome.skippedReason) return `Git pull complete: ${outcome.skippedReason}`;
		if (outcome.relation) return `Git pull complete: ${this.formatRelation(outcome.relation)}.`;
		return 'Git pull complete: already up to date.';
	}

	private formatSyncOutcome(outcome: SyncOutcome): string {
		const pushed = outcome.pushes.filter(push => push.pushed).length;

		if (!outcome.committed && !outcome.pulled && pushed === 0) {
			if (outcome.protectedOnly) return 'Git sync complete: only protected plugin settings changed.';
			if (outcome.excludedOnly) return 'Git sync complete: only excluded files changed.';
			return 'Git sync complete: already up to date.';
		}

		const parts: string[] = [];
		if (outcome.committed) parts.push('committed local changes');
		if (outcome.pulled) parts.push('rebased remote changes');
		if (pushed > 0) parts.push(`pushed to ${pushed} remote${pushed === 1 ? '' : 's'}`);
		if (outcome.excludedPaths.length > 0) {
			parts.push(`skipped ${outcome.excludedPaths.length} excluded file${outcome.excludedPaths.length === 1 ? '' : 's'}`);
		}

		return `Git sync complete: ${parts.join(', ')}.`;
	}

	private formatRelation(relation: { ahead: number; behind: number }): string {
		if (relation.ahead === 0 && relation.behind === 0) return 'up to date';
		if (relation.ahead > 0 && relation.behind > 0) {
			return `diverged, ahead ${relation.ahead} and behind ${relation.behind}`;
		}
		if (relation.ahead > 0) return `ahead by ${relation.ahead}`;
		return `behind by ${relation.behind}`;
	}
}

function gcd(a: number, b: number): number {
	while (b > 0) { [a, b] = [b, a % b]; }
	return a;
}
