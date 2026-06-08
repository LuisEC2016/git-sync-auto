export const VIEW_TYPE_GIT_SYNC_AUTO = 'git-sync-auto-view';

export interface ChangedFileStatus {
	path: string;
	index: string;
	working: string;
}

export interface RecentCommit {
	hash: string;
	message: string;
	author: string;
	date: string;
}

export interface RepoStatusSnapshot {
	branch: string;
	ahead: number;
	behind: number;
	changed: ChangedFileStatus[];
	conflicted: string[];
	recent: RecentCommit[];
	error?: string;
}
