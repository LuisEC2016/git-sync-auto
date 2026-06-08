import { buildAuthenticatedUrl, maskRemoteUrl, formatError } from './settings';
import type { RemoteConfig, PullStrategy } from './settings';
import type { GitSyncHost, PullOutcome, PushOutcome, TrackingBranch, RefRelation } from './git-types';
import type { GitRunner } from './git-runner';
import { GIT_REBASE_TIMEOUT_MS } from './git-runner';

export class GitRemoteOps {
	private _networkFailCount = 0;
	private _networkBackoffUntil = 0;

	constructor(
		private readonly plugin: GitSyncHost,
		private readonly runner: GitRunner,
	) {}

	isNetworkBackoffActive(): { active: boolean; waitSec: number } {
		if (Date.now() < this._networkBackoffUntil) {
			return { active: true, waitSec: Math.ceil((this._networkBackoffUntil - Date.now()) / 1000) };
		}
		return { active: false, waitSec: 0 };
	}

	resetNetworkBackoff(): void {
		this._networkFailCount = 0;
		this._networkBackoffUntil = 0;
	}

	incrementNetworkBackoff(): void {
		this._networkFailCount++;
		const backoffMs = Math.min(
			Math.pow(2, this._networkFailCount) * 60_000,
			this.plugin.settings.networkBackoffMaxMinutes * 60_000,
		);
		this._networkBackoffUntil = Date.now() + backoffMs;
	}

	isNetworkError(err: unknown): boolean {
		const msg = formatError(err).toLowerCase();
		return (
			msg.includes('could not resolve host') ||
			msg.includes('connection refused') ||
			msg.includes('connection timed out') ||
			msg.includes('network is unreachable') ||
			msg.includes('no route to host') ||
			msg.includes('ssl') ||
			msg.includes('curl error') ||
			msg.includes('unable to connect')
		);
	}

	async pullPrimaryWithBackoff(branch: string): Promise<PullOutcome> {
		try {
			const outcome = await this.pullPrimary(branch);
			this.resetNetworkBackoff();
			return outcome;
		} catch (err) {
			if (this.isNetworkError(err)) this.incrementNetworkBackoff();
			throw err;
		}
	}

	async pushAllRemotesWithBackoff(branch: string): Promise<PushOutcome[]> {
		try {
			const outcomes = await this.pushAllRemotes(branch);
			this.resetNetworkBackoff();
			return outcomes;
		} catch (err) {
			if (this.isNetworkError(err)) this.incrementNetworkBackoff();
			throw err;
		}
	}

	async pullPrimary(branch: string): Promise<PullOutcome> {
		const primary = this.getPrimaryRemote();

		if (primary) {
			const tempRemote = this.tempRemoteName(primary);
			return this.withTempRemote(primary, tempRemote, async () => {
				const localHead = await this.getHead();
				await this.runner.runGit(['fetch', tempRemote]);
				const remoteRef = `${tempRemote}/${branch}`;
				const displayName = primary.name || maskRemoteUrl(primary);

				if (!await this.refExists(remoteRef)) {
					return { pulled: false, target: displayName, skippedReason: 'Remote branch does not exist yet.' };
				}

				const remoteHeadResult = await this.runner.runGitResult(['rev-parse', remoteRef]);
				const remoteHead = remoteHeadResult.code === 0 ? remoteHeadResult.stdout.trim() : null;
				if (localHead && remoteHead === localHead) {
					return { pulled: false, target: displayName, skippedReason: 'Already up to date.' };
				}

				return this.integrateRemote(remoteRef, displayName, primary.pullStrategy);
			});
		}

		const tracking = await this.getTrackingBranch(branch);
		if (!tracking) {
			return { pulled: false, skippedReason: 'No upstream tracking branch configured.' };
		}

		await this.runner.runGit(['fetch', tracking.remote]);

		if (await this.refExists(tracking.ref)) {
			const [localHead, trackingHeadResult] = await Promise.all([
				this.getHead(),
				this.runner.runGitResult(['rev-parse', tracking.ref]),
			]);
			if (localHead && trackingHeadResult.code === 0 && trackingHeadResult.stdout.trim() === localHead) {
				return { pulled: false, target: tracking.displayName, skippedReason: 'Already up to date.' };
			}
		}

		return this.integrateRemote(tracking.ref, tracking.displayName, 'rebase');
	}

	async pushAllRemotes(branch: string): Promise<PushOutcome[]> {
		const enabled = this.plugin.settings.remotes.filter(r => r.enabled && r.url);

		if (enabled.length === 0) {
			return [await this.pushDefaultRemote(branch)];
		}

		const pushes: PushOutcome[] = [];
		const errors: string[] = [];

		for (const remote of enabled) {
			try {
				const outcome = await this.pushConfiguredRemote(remote, branch);
				pushes.push(outcome);
			} catch (err) {
				const msg = `${remote.name || maskRemoteUrl(remote)}: ${formatError(err)}`;
				errors.push(msg);
				console.error(`Git sync push failed: ${msg}`, err);
			}
		}

		if (errors.length > 0) {
			throw new Error(`Push failed on ${errors.length} remote(s):\n${errors.join('\n')}`);
		}

		return pushes;
	}

	async getHead(): Promise<string | null> {
		const result = await this.runner.runGitResult(['rev-parse', 'HEAD']);
		// Use stdout only — stderr may contain git hints/warnings that corrupt the SHA.
		return result.code === 0 ? result.stdout.trim() : null;
	}

	async refExists(ref: string): Promise<boolean> {
		const result = await this.runner.runGitResult(['rev-parse', '--verify', '--quiet', ref]);
		return result.code === 0;
	}

	async compareRefs(left: string, right: string): Promise<RefRelation> {
		const result = await this.runner.runGitResult(['rev-list', '--left-right', '--count', `${left}...${right}`]);
		if (result.code !== 0) throw new Error(result.output || `Git rev-list exited with status ${result.code}.`);
		// Use stdout only — stderr warnings corrupt the tab-separated ahead/behind numbers.
		const [aheadRaw, behindRaw] = result.stdout.trim().split(/\s+/);
		return {
			ahead: Number(aheadRaw) || 0,
			behind: Number(behindRaw) || 0,
		};
	}

	async getTrackingBranch(branch: string): Promise<TrackingBranch | null> {
		const [remote, merge] = await Promise.all([
			this.runner.runGitResult(['config', '--get', `branch.${branch}.remote`]),
			this.runner.runGitResult(['config', '--get', `branch.${branch}.merge`]),
		]);

		if (remote.code !== 0 || merge.code !== 0) return null;

		const remoteName = remote.stdout.trim();
		const mergeRef = merge.stdout.trim();
		if (!remoteName || !mergeRef.startsWith('refs/heads/')) return null;

		const remoteBranch = mergeRef.slice('refs/heads/'.length);
		return {
			remote: remoteName,
			branch: remoteBranch,
			ref: `${remoteName}/${remoteBranch}`,
			displayName: `${remoteName}/${remoteBranch}`,
		};
	}

	async listRemotes(): Promise<string[]> {
		const result = await this.runner.runGitResult(['remote']);
		if (result.code !== 0) return [];
		return result.stdout.split('\n').map(remote => remote.trim()).filter(Boolean);
	}

	getPrimaryRemote(): RemoteConfig | undefined {
		const { remotes } = this.plugin.settings;
		return remotes.find(r => r.isPrimary && r.enabled && r.url) ?? remotes.find(r => r.enabled && r.url);
	}

	private async integrateRemote(remoteRef: string, displayName: string, strategy: PullStrategy): Promise<PullOutcome> {
		if (!await this.refExists(remoteRef)) {
			return { pulled: false, target: displayName, skippedReason: 'Remote branch does not exist yet.' };
		}

		const relation = await this.compareRefs('HEAD', remoteRef);
		if (relation.behind === 0) {
			return { pulled: false, target: displayName, relation };
		}

		switch (strategy) {
			case 'merge':
				await this.runner.runGit(['merge', '--no-edit', remoteRef], { timeout: GIT_REBASE_TIMEOUT_MS });
				break;
			case 'ff-only':
				await this.runner.runGit(['merge', '--ff-only', remoteRef]);
				break;
			case 'rebase':
			default:
				await this.runner.runGit(['rebase', '--autostash', remoteRef], { timeout: GIT_REBASE_TIMEOUT_MS });
				break;
		}

		return { pulled: true, target: displayName, relation };
	}

	private async pushConfiguredRemote(remote: RemoteConfig, branch: string): Promise<PushOutcome> {
		const tempRemote = this.tempRemoteName(remote);
		const displayName = remote.name || maskRemoteUrl(remote);

		return this.withTempRemote(remote, tempRemote, async () => {
			await this.runner.runGit(['fetch', tempRemote]);

			const remoteRef = `${tempRemote}/${branch}`;

			// Compare the actual remote SHA against HEAD per-remote. A single
			// shared "last synced head" cannot be used here: with multiple
			// remotes, a remote that failed or lagged in a prior sync would be
			// wrongly skipped as "up to date" while another already matched HEAD.
			if (await this.refExists(remoteRef)) {
				const relation = await this.compareRefs('HEAD', remoteRef);
				if (relation.behind > 0) {
					throw new Error(`${displayName} has ${relation.behind} remote commit(s) not present locally. Make it primary or merge it before pushing.`);
				}
				if (relation.ahead === 0) {
					return { remote: displayName, pushed: false, skippedReason: 'Already up to date.' };
				}
			}

			await this.pushWithRetryOnLock(tempRemote, branch, displayName);
			return { remote: displayName, pushed: true };
		});
	}

	private async pushWithRetryOnLock(tempRemote: string, branch: string, displayName: string, maxAttempts = 3): Promise<void> {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const result = await this.runner.runGitResult(['push', tempRemote, `${branch}:${branch}`]);
			if (result.code === 0) return;

			const isLockError = result.output.includes('cannot lock ref') || result.output.includes('lock');
			if (!isLockError || attempt === maxAttempts) {
				throw new Error(result.output || `Push to ${displayName} failed.`);
			}

			// Remote ref was updated by another client between fetch and push — wait and retry
			await new Promise<void>(resolve => setTimeout(resolve, 1000 * attempt));

			// Re-fetch to confirm we are still ahead (not behind after the concurrent push)
			const fetchResult = await this.runner.runGitResult(['fetch', tempRemote]);
			if (fetchResult.code !== 0) throw new Error(fetchResult.output || `Fetch from ${displayName} failed.`);

			const remoteRef = `${tempRemote}/${branch}`;
			if (await this.refExists(remoteRef)) {
				const relation = await this.compareRefs('HEAD', remoteRef);
				if (relation.behind > 0) throw new Error(`${displayName} advanced while pushing — pull first.`);
				if (relation.ahead === 0) return; // another client already pushed our commits
			}
		}
	}

	private async pushDefaultRemote(branch: string): Promise<PushOutcome> {
		const remoteNames = await this.listRemotes();
		if (remoteNames.length === 0) {
			return { remote: 'default remote', pushed: false, skippedReason: 'No Git remote configured.' };
		}

		const tracking = await this.getTrackingBranch(branch);
		if (tracking && await this.refExists(tracking.ref)) {
			const relation = await this.compareRefs('HEAD', tracking.ref);
			if (relation.behind > 0) {
				throw new Error(`${tracking.displayName} has ${relation.behind} remote commit(s) not present locally. Pull or rebase before pushing.`);
			}
			if (relation.ahead === 0) {
				return { remote: tracking.displayName, pushed: false, skippedReason: 'Already up to date.' };
			}
		}

		await this.runner.runGit(['push']);
		return { remote: tracking?.displayName ?? remoteNames.join(', '), pushed: true };
	}

	private async withTempRemote<T>(remote: RemoteConfig, tempName: string, fn: () => Promise<T>): Promise<T> {
		const authenticatedUrl = buildAuthenticatedUrl(remote);
		await this.runner.runGitResult(['remote', 'remove', tempName]);
		await this.runner.runGit(['remote', 'add', tempName, authenticatedUrl]);

		try {
			return await fn();
		} finally {
			await this.runner.runGitResult(['remote', 'remove', tempName]);
		}
	}

	private tempRemoteName(remote: RemoteConfig): string {
		const safeId = remote.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'remote';
		const nonce = Math.random().toString(36).slice(2, 12);
		return `_gsa_${safeId}_${nonce}`;
	}
}
