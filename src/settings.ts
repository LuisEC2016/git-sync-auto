import type { LanguageCode } from './i18n';

export type PullStrategy = 'rebase' | 'merge' | 'ff-only';

export interface RemoteConfig {
	id: string;
	name: string;
	url: string;
	username: string;
	token: string;
	isPrimary: boolean;
	enabled: boolean;
	pullStrategy: PullStrategy;
}

export type NoticeLevel = 'all' | 'warnings' | 'errors';
export type CommitMessageMode = 'smart' | 'template';

export interface GitSyncAutoSettings {
	autoSync: boolean;
	syncOnStartup: boolean;
	checkStatusOnStartup: boolean;
	debounceSeconds: number;
	nonMarkdownDebounceSeconds: number;
	commitMessage: string;
	commitMessageMode: CommitMessageMode;
	commitAuthorName: string;
	commitAuthorEmail: string;
	protectPluginData: boolean;
	excludeWorkspace: boolean;
	manageGitignore: boolean;
	maxFileSizeMB: number;
	excludePatterns: string;
	periodicSyncMinutes: number;
	periodicPullMinutes: number;
	syncOnClose: boolean;
	noticeLevel: NoticeLevel;
	showSuccessNotice: boolean;
	verboseLog: boolean;
	remotes: RemoteConfig[];
	networkBackoffMaxMinutes: number;
	autoStashOnPull: boolean;
	showGutterIndicators: boolean;
	language: LanguageCode;
}

export const DEFAULT_SETTINGS: GitSyncAutoSettings = {
	autoSync: false,
	syncOnStartup: false,
	checkStatusOnStartup: false,
	debounceSeconds: 30,
	nonMarkdownDebounceSeconds: 120,
	commitMessage: 'Vault sync from {host} at {date} {time}',
	commitMessageMode: 'smart',
	commitAuthorName: '',
	commitAuthorEmail: '',
	protectPluginData: true,
	excludeWorkspace: true,
	manageGitignore: true,
	maxFileSizeMB: 25,
	excludePatterns: '',
	periodicSyncMinutes: 0,
	periodicPullMinutes: 0,
	syncOnClose: false,
	noticeLevel: 'all',
	showSuccessNotice: true,
	verboseLog: false,
	remotes: [],
	networkBackoffMaxMinutes: 30,
	autoStashOnPull: false,
	showGutterIndicators: false,
	language: 'en',
};

export function normalizeSettings(data: Partial<GitSyncAutoSettings> | null | undefined): GitSyncAutoSettings {
	const settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	const commitMessage = typeof settings.commitMessage === 'string' ? settings.commitMessage.trim() : '';
	const remotes: RemoteConfig[] = Array.isArray(settings.remotes) ? settings.remotes.map(normalizeRemote) : [];

	return {
		autoSync: Boolean(settings.autoSync),
		syncOnStartup: Boolean(settings.syncOnStartup),
		checkStatusOnStartup: Boolean(settings.checkStatusOnStartup),
		debounceSeconds: clampInteger(settings.debounceSeconds, 5, 3600, DEFAULT_SETTINGS.debounceSeconds),
		nonMarkdownDebounceSeconds: clampInteger(settings.nonMarkdownDebounceSeconds, 5, 3600, DEFAULT_SETTINGS.nonMarkdownDebounceSeconds),
		commitMessage: commitMessage || DEFAULT_SETTINGS.commitMessage,
		commitMessageMode: normalizeCommitMessageMode(settings.commitMessageMode),
		commitAuthorName: typeof settings.commitAuthorName === 'string' ? settings.commitAuthorName.trim() : '',
		commitAuthorEmail: typeof settings.commitAuthorEmail === 'string' ? settings.commitAuthorEmail.trim() : '',
		protectPluginData: settings.protectPluginData !== false,
		excludeWorkspace: settings.excludeWorkspace !== false,
		manageGitignore: settings.manageGitignore !== false,
		maxFileSizeMB: clampNumber(settings.maxFileSizeMB, 0, 10240, DEFAULT_SETTINGS.maxFileSizeMB),
		excludePatterns: typeof settings.excludePatterns === 'string' ? settings.excludePatterns : '',
		periodicSyncMinutes: clampInteger(settings.periodicSyncMinutes, 0, 1440, 0),
		periodicPullMinutes: clampInteger(settings.periodicPullMinutes, 0, 1440, 0),
		syncOnClose: Boolean(settings.syncOnClose),
		noticeLevel: normalizeNoticeLevel(settings.noticeLevel),
		showSuccessNotice: settings.showSuccessNotice !== false,
		verboseLog: Boolean(settings.verboseLog),
		remotes,
		networkBackoffMaxMinutes: clampInteger(settings.networkBackoffMaxMinutes, 1, 1440, DEFAULT_SETTINGS.networkBackoffMaxMinutes),
		autoStashOnPull: Boolean(settings.autoStashOnPull),
		showGutterIndicators: Boolean(settings.showGutterIndicators),
		language: settings.language === 'es' ? 'es' : 'en',
	};
}

export function normalizeRemote(r: unknown): RemoteConfig {
	const raw = (r ?? {}) as Partial<RemoteConfig>;
	return {
		id: typeof raw.id === 'string' && raw.id ? raw.id : Math.random().toString(36).slice(2, 10),
		name: typeof raw.name === 'string' ? raw.name.trim() : '',
		url: typeof raw.url === 'string' ? raw.url.trim() : '',
		username: typeof raw.username === 'string' ? raw.username : '',
		token: typeof raw.token === 'string' ? raw.token : '',
		isPrimary: Boolean(raw.isPrimary),
		enabled: raw.enabled !== false,
		pullStrategy: normalizePullStrategy(raw.pullStrategy),
	};
}

export function normalizePullStrategy(value: unknown): PullStrategy {
	if (value === 'merge' || value === 'ff-only') return value;
	return 'rebase';
}

export function normalizeCommitMessageMode(value: unknown): CommitMessageMode {
	if (value === 'template') return 'template';
	return 'smart';
}

export function clampInteger(value: unknown, min: number, max: number, fallback = DEFAULT_SETTINGS.debounceSeconds): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, min), max);
}

export function normalizeNoticeLevel(value: unknown): NoticeLevel {
	if (value === 'warning' || value === 'warnings' || value === 'WARNING' || value === 'WARNINGS') return 'warnings';
	if (value === 'error' || value === 'errors' || value === 'ERROR') return 'errors';
	return 'all';
}

export function buildAuthenticatedUrl(remote: RemoteConfig): string {
	const { url, username, token } = remote;
	if (!username && !token) return url;

	try {
		const parsed = new URL(url);
		if (parsed.protocol === 'http:') return url;
		if (username) parsed.username = username;
		if (token) parsed.password = token;
		return parsed.toString();
	} catch {
		return url;
	}
}

export function maskRemoteUrl(remote: RemoteConfig): string {
	const authenticatedUrl = buildAuthenticatedUrl(remote);

	try {
		const parsed = new URL(authenticatedUrl);
		if (parsed.username) parsed.username = '***';
		if (parsed.password) parsed.password = '***';
		return parsed.toString();
	} catch {
		return remote.url || remote.name || 'remote';
	}
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
