import { FileSystemAdapter, Notice } from 'obsidian';
import { promises as fs } from 'fs';
import * as path from 'path';
import type GitSyncAutoPlugin from './main';
import { t } from './i18n';
import { appendSectionIcon } from './view-changed-files';

export function renderVersionCard(root: HTMLElement, plugin: GitSyncAutoPlugin): void {
	const lang = plugin.settings.language;
	const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

	const manifest = plugin.manifest;
	const card = root.createDiv({ cls: 'git-sync-section' });

	const heading = card.createDiv({ cls: 'git-sync-section-heading' });
	appendSectionIcon(heading, [
		{ tag: 'path', d: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z' },
		{ tag: 'circle', cx: '7', cy: '7', r: '1' },
	]);
	heading.createSpan({ text: tr('view.version.heading') });
	heading.createSpan({ text: `v${manifest.version}`, cls: 'git-sync-version-badge' });

}

export async function bumpVersion(type: 'patch' | 'minor' | 'major', plugin: GitSyncAutoPlugin): Promise<void> {
	const lang = plugin.settings.language;
	const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

	const manifest = plugin.manifest;
	const [major, minor, patch] = manifest.version.split('.').map(Number);
	let next: string;
	if (type === 'major') next = `${(major || 0) + 1}.0.0`;
	else if (type === 'minor') next = `${major || 0}.${(minor || 0) + 1}.0`;
	else next = `${major || 0}.${minor || 0}.${(patch || 0) + 1}`;

	try {
		const { adapter } = plugin.app.vault;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice('Version bump requires desktop Obsidian.', 5000);
			return;
		}

		// Plugin dir: <vault>/.obsidian/plugins/<plugin-id>/
		const pluginDir = path.join(
			adapter.getBasePath(),
			'.obsidian', 'plugins', plugin.manifest.id,
		);

		// Update manifest.json
		const manifestPath = path.join(pluginDir, 'manifest.json');
		const manifestData = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
		manifestData['version'] = next;
		await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, '\t') + '\n', 'utf8');

		// Update versions.json (append new version pointing to minAppVersion)
		const versionsPath = path.join(pluginDir, 'versions.json');
		let versionsExists = false;
		try { await fs.access(versionsPath); versionsExists = true; } catch { /* not present */ }
		if (versionsExists) {
			const versionsData = JSON.parse(await fs.readFile(versionsPath, 'utf8')) as Record<string, string>;
			const minApp = (manifestData['minAppVersion'] as string | undefined) ?? '1.0.0';
			versionsData[next] = minApp;
			await fs.writeFile(versionsPath, JSON.stringify(versionsData, null, '\t') + '\n', 'utf8');
		}

		// Stage + commit the version files
		await plugin.gitSync.stageFile('.obsidian/plugins/' + plugin.manifest.id + '/manifest.json');
		if (versionsExists) {
			await plugin.gitSync.stageFile('.obsidian/plugins/' + plugin.manifest.id + '/versions.json');
		}
		await plugin.gitSync.commitStaged(`chore: bump version to ${next}`);

		// Refresh plugin manifest in memory
		(plugin.manifest as unknown as Record<string, unknown>)['version'] = next;

		new Notice(tr('view.version.bumpNotice').replace('{next}', next), 6000);
	} catch (error) {
		new Notice(`${tr('view.version.bumpFailed')}${error instanceof Error ? error.message : String(error)}`, 10000);
	}
}
