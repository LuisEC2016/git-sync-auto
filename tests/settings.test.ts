import { describe, it, expect } from 'vitest';
import {
	normalizeSettings,
	normalizeRemote,
	normalizePullStrategy,
	normalizeCommitMessageMode,
	normalizeNoticeLevel,
	clampInteger,
	clampNumber,
	buildAuthenticatedUrl,
	maskRemoteUrl,
	formatError,
	DEFAULT_SETTINGS,
} from '../src/settings';
import type { RemoteConfig } from '../src/settings';

// ---------------------------------------------------------------------------
// normalizeSettings
// ---------------------------------------------------------------------------
describe('normalizeSettings', () => {
	it('returns defaults when called with null', () => {
		const s = normalizeSettings(null);
		expect(s).toMatchObject(DEFAULT_SETTINGS);
	});

	it('returns defaults when called with undefined', () => {
		expect(normalizeSettings(undefined)).toMatchObject(DEFAULT_SETTINGS);
	});

	it('returns defaults when called with empty object', () => {
		expect(normalizeSettings({})).toMatchObject(DEFAULT_SETTINGS);
	});

	it('preserves valid provided values', () => {
		const s = normalizeSettings({ autoSync: true, debounceSeconds: 60 });
		expect(s.autoSync).toBe(true);
		expect(s.debounceSeconds).toBe(60);
	});

	it('clamps debounceSeconds below minimum to 5', () => {
		expect(normalizeSettings({ debounceSeconds: 1 }).debounceSeconds).toBe(5);
	});

	it('clamps debounceSeconds above maximum to 3600', () => {
		expect(normalizeSettings({ debounceSeconds: 9999 }).debounceSeconds).toBe(3600);
	});

	it('clamps nonMarkdownDebounceSeconds', () => {
		expect(normalizeSettings({ nonMarkdownDebounceSeconds: 2 }).nonMarkdownDebounceSeconds).toBe(5);
		expect(normalizeSettings({ nonMarkdownDebounceSeconds: 5000 }).nonMarkdownDebounceSeconds).toBe(3600);
	});

	it('falls back to default commitMessage when empty string provided', () => {
		const s = normalizeSettings({ commitMessage: '   ' });
		expect(s.commitMessage).toBe(DEFAULT_SETTINGS.commitMessage);
	});

	it('trims commitMessage whitespace', () => {
		const s = normalizeSettings({ commitMessage: '  hello  ' });
		expect(s.commitMessage).toBe('hello');
	});

	it('normalizes remotes array', () => {
		const remote = { id: 'abc', name: 'origin', url: 'https://github.com/x/y', username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase' as const };
		const s = normalizeSettings({ remotes: [remote] });
		expect(s.remotes).toHaveLength(1);
		expect(s.remotes[0]!.id).toBe('abc');
	});

	it('replaces non-array remotes with empty array', () => {
		const s = normalizeSettings({ remotes: 'bad' as unknown as [] });
		expect(s.remotes).toEqual([]);
	});

	it('sets protectPluginData to true when undefined', () => {
		expect(normalizeSettings({}).protectPluginData).toBe(true);
	});

	it('respects protectPluginData: false', () => {
		expect(normalizeSettings({ protectPluginData: false }).protectPluginData).toBe(false);
	});

	it('normalizes language to en for unknown values', () => {
		expect(normalizeSettings({ language: 'fr' as 'en' }).language).toBe('en');
	});

	it('accepts language es', () => {
		expect(normalizeSettings({ language: 'es' }).language).toBe('es');
	});

	it('clamps maxFileSizeMB', () => {
		expect(normalizeSettings({ maxFileSizeMB: -5 }).maxFileSizeMB).toBe(0);
		expect(normalizeSettings({ maxFileSizeMB: 99999 }).maxFileSizeMB).toBe(10240);
	});

	it('clamps networkBackoffMaxMinutes', () => {
		expect(normalizeSettings({ networkBackoffMaxMinutes: 0 }).networkBackoffMaxMinutes).toBe(1);
		expect(normalizeSettings({ networkBackoffMaxMinutes: 99999 }).networkBackoffMaxMinutes).toBe(1440);
	});
});

// ---------------------------------------------------------------------------
// normalizeRemote
// ---------------------------------------------------------------------------
describe('normalizeRemote', () => {
	it('generates a random id when id is missing', () => {
		const r = normalizeRemote({});
		expect(typeof r.id).toBe('string');
		expect(r.id.length).toBeGreaterThan(0);
	});

	it('preserves a valid id', () => {
		expect(normalizeRemote({ id: 'myid' }).id).toBe('myid');
	});

	it('trims name and url', () => {
		const r = normalizeRemote({ name: '  origin  ', url: '  https://x.com  ' });
		expect(r.name).toBe('origin');
		expect(r.url).toBe('https://x.com');
	});

	it('defaults enabled to true when not specified', () => {
		expect(normalizeRemote({}).enabled).toBe(true);
	});

	it('respects enabled: false', () => {
		expect(normalizeRemote({ enabled: false }).enabled).toBe(false);
	});

	it('defaults isPrimary to false', () => {
		expect(normalizeRemote({}).isPrimary).toBe(false);
	});

	it('defaults pullStrategy to rebase', () => {
		expect(normalizeRemote({}).pullStrategy).toBe('rebase');
	});

	it('handles null input', () => {
		const r = normalizeRemote(null);
		expect(r.enabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// normalizePullStrategy
// ---------------------------------------------------------------------------
describe('normalizePullStrategy', () => {
	it('returns rebase for unknown value', () => {
		expect(normalizePullStrategy('bad')).toBe('rebase');
		expect(normalizePullStrategy(null)).toBe('rebase');
		expect(normalizePullStrategy(undefined)).toBe('rebase');
	});

	it('accepts merge', () => {
		expect(normalizePullStrategy('merge')).toBe('merge');
	});

	it('accepts ff-only', () => {
		expect(normalizePullStrategy('ff-only')).toBe('ff-only');
	});

	it('accepts rebase', () => {
		expect(normalizePullStrategy('rebase')).toBe('rebase');
	});
});

// ---------------------------------------------------------------------------
// normalizeCommitMessageMode
// ---------------------------------------------------------------------------
describe('normalizeCommitMessageMode', () => {
	it('returns smart for unknown value', () => {
		expect(normalizeCommitMessageMode('bad')).toBe('smart');
		expect(normalizeCommitMessageMode(null)).toBe('smart');
	});

	it('accepts template', () => {
		expect(normalizeCommitMessageMode('template')).toBe('template');
	});

	it('accepts smart', () => {
		expect(normalizeCommitMessageMode('smart')).toBe('smart');
	});
});

// ---------------------------------------------------------------------------
// normalizeNoticeLevel
// ---------------------------------------------------------------------------
describe('normalizeNoticeLevel', () => {
	it('returns all for unknown value', () => {
		expect(normalizeNoticeLevel('bad')).toBe('all');
		expect(normalizeNoticeLevel(null)).toBe('all');
	});

	it('normalizes warning variations to warnings', () => {
		expect(normalizeNoticeLevel('warning')).toBe('warnings');
		expect(normalizeNoticeLevel('warnings')).toBe('warnings');
		expect(normalizeNoticeLevel('WARNING')).toBe('warnings');
		expect(normalizeNoticeLevel('WARNINGS')).toBe('warnings');
	});

	it('normalizes error variations to errors', () => {
		expect(normalizeNoticeLevel('error')).toBe('errors');
		expect(normalizeNoticeLevel('errors')).toBe('errors');
		expect(normalizeNoticeLevel('ERROR')).toBe('errors');
	});

	it('accepts all', () => {
		expect(normalizeNoticeLevel('all')).toBe('all');
	});
});

// ---------------------------------------------------------------------------
// clampInteger
// ---------------------------------------------------------------------------
describe('clampInteger', () => {
	it('clamps below min', () => {
		expect(clampInteger(0, 5, 100, 30)).toBe(5);
	});

	it('clamps above max', () => {
		expect(clampInteger(200, 5, 100, 30)).toBe(100);
	});

	it('returns value within range', () => {
		expect(clampInteger(50, 5, 100, 30)).toBe(50);
	});

	it('truncates decimals', () => {
		expect(clampInteger(7.9, 5, 100, 30)).toBe(7);
	});

	it('returns fallback for NaN', () => {
		expect(clampInteger(NaN, 5, 100, 30)).toBe(30);
	});

	it('returns fallback for non-numeric string', () => {
		expect(clampInteger('abc', 5, 100, 30)).toBe(30);
	});

	it('parses numeric string', () => {
		expect(clampInteger('42', 5, 100, 30)).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// clampNumber
// ---------------------------------------------------------------------------
describe('clampNumber', () => {
	it('clamps below min', () => {
		expect(clampNumber(-1, 0, 100, 25)).toBe(0);
	});

	it('clamps above max', () => {
		expect(clampNumber(200, 0, 100, 25)).toBe(100);
	});

	it('preserves decimal within range', () => {
		expect(clampNumber(12.5, 0, 100, 25)).toBe(12.5);
	});

	it('returns fallback for NaN', () => {
		expect(clampNumber(NaN, 0, 100, 25)).toBe(25);
	});
});

// ---------------------------------------------------------------------------
// buildAuthenticatedUrl
// ---------------------------------------------------------------------------
describe('buildAuthenticatedUrl', () => {
	const base: RemoteConfig = {
		id: '1', name: 'origin', url: 'https://github.com/user/repo',
		username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase',
	};

	it('returns url unchanged when no credentials', () => {
		expect(buildAuthenticatedUrl(base)).toBe('https://github.com/user/repo');
	});

	it('embeds username and token', () => {
		const r = { ...base, username: 'alice', token: 'tok123' };
		const url = buildAuthenticatedUrl(r);
		expect(url).toContain('alice');
		expect(url).toContain('tok123');
		expect(url).toContain('github.com');
	});

	it('returns http url unchanged even with credentials', () => {
		const r = { ...base, url: 'http://example.com/repo', username: 'u', token: 't' };
		expect(buildAuthenticatedUrl(r)).toBe('http://example.com/repo');
	});

	it('returns original url if malformed', () => {
		const r = { ...base, url: 'not-a-url', username: 'u', token: 't' };
		expect(buildAuthenticatedUrl(r)).toBe('not-a-url');
	});

	it('embeds only token when username is empty', () => {
		const r = { ...base, token: 'ghp_abc' };
		const url = buildAuthenticatedUrl(r);
		expect(url).toContain('ghp_abc');
	});
});

// ---------------------------------------------------------------------------
// maskRemoteUrl
// ---------------------------------------------------------------------------
describe('maskRemoteUrl', () => {
	const base: RemoteConfig = {
		id: '1', name: 'origin', url: 'https://github.com/user/repo',
		username: '', token: '', isPrimary: true, enabled: true, pullStrategy: 'rebase',
	};

	it('returns url unchanged when no credentials', () => {
		expect(maskRemoteUrl(base)).toBe('https://github.com/user/repo');
	});

	it('masks username and password with ***', () => {
		const r = { ...base, username: 'alice', token: 'secret' };
		const masked = maskRemoteUrl(r);
		expect(masked).not.toContain('alice');
		expect(masked).not.toContain('secret');
		expect(masked).toContain('***');
		expect(masked).toContain('github.com');
	});

	it('returns original url for malformed url (no protocol)', () => {
		const r = { ...base, url: 'bad-url', username: 'u', token: 't', name: 'myremote' };
		// buildAuthenticatedUrl returns 'bad-url' as-is; maskRemoteUrl then also fails to parse it
		// and falls back to remote.url || remote.name
		const masked = maskRemoteUrl(r);
		expect(masked === 'bad-url' || masked === 'myremote').toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------
describe('formatError', () => {
	it('extracts message from Error', () => {
		expect(formatError(new Error('oops'))).toBe('oops');
	});

	it('converts string to string', () => {
		expect(formatError('fail')).toBe('fail');
	});

	it('converts number to string', () => {
		expect(formatError(42)).toBe('42');
	});

	it('handles null', () => {
		expect(formatError(null)).toBe('null');
	});
});
