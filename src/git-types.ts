import type { Plugin } from 'obsidian';
import type { GitSyncAutoSettings } from './settings';

export type SyncReason = 'manual' | 'automatic';
export type NoticeSeverity = 'info' | 'warning' | 'error';

export interface GitSyncHost extends Plugin {
	settings: GitSyncAutoSettings;
	activateGitSyncView(): Promise<void>;
	openConflictModal(files: string[]): void;
	openBranchSwitcher(): Promise<void>;
	invalidateGutterCache?(): void;
}

export interface GitCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	output: string;
}

export interface WorkingTreeState {
	entries: string[];
	conflicts: string[];
	hasConflicts: boolean;
	hasCommittableChanges: boolean;
	hasOnlyProtectedChanges: boolean;
	hasOnlyExcludedChanges: boolean;
}

export interface CommitOutcome {
	committed: boolean;
	protectedOnly: boolean;
	excludedOnly: boolean;
	excludedPaths: string[];
}

export interface TrackingBranch {
	remote: string;
	branch: string;
	ref: string;
	displayName: string;
}

export interface RefRelation {
	ahead: number;
	behind: number;
}

export interface PullOutcome {
	pulled: boolean;
	target?: string;
	relation?: RefRelation;
	skippedReason?: string;
}

export interface PushOutcome {
	remote: string;
	pushed: boolean;
	skippedReason?: string;
}

export interface SyncOutcome {
	committed: boolean;
	pulled: boolean;
	pushes: PushOutcome[];
	protectedOnly: boolean;
	excludedOnly: boolean;
	excludedPaths: string[];
}
