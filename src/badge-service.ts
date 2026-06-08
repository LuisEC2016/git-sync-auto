import type { App, TFile } from 'obsidian';
import type { RemoteConfig } from './settings';
import { maskRemoteUrl } from './settings';
import { t } from './i18n';
import type { LanguageCode } from './i18n';

export function buildGitHubBadgeMarkdown(remote: RemoteConfig, repoUrl: string): string {
	const label = remote.name || 'GitHub';
	const encodedLabel = encodeURIComponent(label);
	const badgeUrl = `https://img.shields.io/badge/${encodedLabel}-sync-brightgreen?logo=github`;
	return `[![${label}](${badgeUrl})](${repoUrl})`;
}

export function extractRepoUrl(remoteUrl: string): string {
	// Convert SSH → HTTPS and strip .git suffix
	let url = remoteUrl.trim();
	if (url.startsWith('git@')) {
		// git@github.com:user/repo.git → https://github.com/user/repo
		url = url.replace(/^git@([^:]+):(.+)$/, 'https://$1/$2');
	}
	if (url.endsWith('.git')) {
		url = url.slice(0, -4);
	}
	// Strip embedded credentials (https://user:token@host → https://host)
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		return parsed.toString();
	} catch {
		return url;
	}
}

export function badgeAlreadyPresent(content: string, repoUrl: string): boolean {
	return content.includes(repoUrl);
}

export async function insertBadgeIntoFile(
	app: App,
	file: TFile,
	remote: RemoteConfig,
	lang: LanguageCode,
): Promise<{ inserted: boolean; message: string }> {
	const tr = (key: Parameters<typeof t>[0]) => t(key, lang);
	const repoUrl = extractRepoUrl(remote.url);
	const content = await app.vault.read(file);

	if (badgeAlreadyPresent(content, repoUrl)) {
		return { inserted: false, message: tr('badge.alreadyPresent') };
	}

	const badge = buildGitHubBadgeMarkdown(remote, repoUrl);
	const newContent = badge + '\n\n' + content;
	await app.vault.modify(file, newContent);
	return { inserted: true, message: tr('badge.inserted').replace('{remote}', remote.name || maskRemoteUrl(remote)) };
}
