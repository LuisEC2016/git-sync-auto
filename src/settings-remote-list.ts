import { Setting } from 'obsidian';
import type GitSyncAutoPlugin from './main';
import { normalizeRemote, normalizePullStrategy } from './settings';
import { t } from './i18n';
import type { I18nKey } from './i18n';

export function renderRemoteList(
	containerEl: HTMLElement,
	plugin: GitSyncAutoPlugin,
	onRefresh: () => void,
): void {
	const { remotes } = plugin.settings;
	const lang = plugin.settings.language;
	const tr = (key: I18nKey) => t(key, lang);

	for (const [i, remote] of remotes.entries()) {
		const remoteId = remote.id;
		const section = containerEl.createDiv({ cls: 'git-sync-remote-card' });
		section.createEl('h3', { text: `${tr('remote.heading')}${i + 1}` });

		new Setting(section)
			.setName(tr('remote.name.name'))
			.setDesc(tr('remote.name.desc'))
			.addText(t => t.setValue(remote.name).setPlaceholder('GitHub').onChange(async v => {
				remote.name = v.trim();
				await plugin.saveSettings();
			}));

		new Setting(section)
			.setName(tr('remote.url.name'))
			.setDesc(tr('remote.url.desc'))
			.addText(t => t.setValue(remote.url).setPlaceholder('https://github.com/user/vault.git').onChange(async v => {
				remote.url = v.trim();
				await plugin.saveSettings();
			}));

		new Setting(section)
			.setName(tr('remote.username.name'))
			.setDesc(tr('remote.username.desc'))
			.addText(t => t.setValue(remote.username).setPlaceholder('user').onChange(async v => {
				remote.username = v;
				await plugin.saveSettings();
			}));

		new Setting(section)
			.setName(tr('remote.token.name'))
			.setDesc(tr('remote.token.desc'))
			.addText(t => {
				t.inputEl.type = 'password';
				t.setValue(remote.token).setPlaceholder('ghp_...').onChange(async v => {
					remote.token = v;
					await plugin.saveSettings();
				});
			});

		new Setting(section)
			.setName(tr('remote.isPrimary.name'))
			.setDesc(tr('remote.isPrimary.desc'))
			.addToggle(tog => tog.setValue(remote.isPrimary).onChange(async v => {
				if (v) remotes.forEach(r => (r.isPrimary = false));
				remote.isPrimary = v;
				await plugin.saveSettings();
				onRefresh();
			}));

		new Setting(section)
			.setName(tr('remote.pullStrategy.name'))
			.setDesc(tr('remote.pullStrategy.desc'))
			.addDropdown(d =>
				d
					.addOption('rebase', tr('remote.pullStrategy.rebase'))
					.addOption('merge', tr('remote.pullStrategy.merge'))
					.addOption('ff-only', tr('remote.pullStrategy.ffOnly'))
					.setValue(remote.pullStrategy)
					.onChange(async v => {
						remote.pullStrategy = normalizePullStrategy(v);
						await plugin.saveSettings();
					}),
			);

		new Setting(section)
			.setName(tr('remote.enabled.name'))
			.setDesc(tr('remote.enabled.desc'))
			.addToggle(tog => tog.setValue(remote.enabled).onChange(async v => {
				remote.enabled = v;
				await plugin.saveSettings();
			}));

		new Setting(section).addButton(btn =>
			btn.setButtonText(tr('remote.removeBtn')).setWarning().onClick(async () => {
				// Use stable id instead of loop index — index i is captured by
				// reference and becomes stale if the list is mutated before click.
				const idx = plugin.settings.remotes.findIndex(r => r.id === remoteId);
				if (idx !== -1) plugin.settings.remotes.splice(idx, 1);
				await plugin.saveSettings();
				onRefresh();
			}),
		);
	}

	new Setting(containerEl).addButton(btn =>
		btn.setButtonText(tr('remote.addBtn')).onClick(async () => {
			plugin.settings.remotes.push(
				normalizeRemote({ name: '', url: '', isPrimary: plugin.settings.remotes.length === 0 }),
			);
			await plugin.saveSettings();
			onRefresh();
		}),
	);
}
