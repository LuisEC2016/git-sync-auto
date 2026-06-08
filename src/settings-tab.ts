import { App, PluginSettingTab, Setting } from 'obsidian';
import type GitSyncAutoPlugin from './main';
import { clampInteger, clampNumber, DEFAULT_SETTINGS, normalizeNoticeLevel } from './settings';
import { renderRemoteList } from './settings-remote-list';
import { t } from './i18n';
import type { I18nKey } from './i18n';

export class GitSyncAutoSettingTab extends PluginSettingTab {
	plugin: GitSyncAutoPlugin;

	constructor(app: App, plugin: GitSyncAutoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const lang = this.plugin.settings.language;
		const tr = (key: I18nKey) => t(key, lang);

		// Language selector — first section
		new Setting(containerEl).setName(tr('section.language')).setHeading();
		new Setting(containerEl)
			.setName(tr('setting.language.name'))
			.setDesc(tr('setting.language.desc'))
			.addDropdown(dropdown =>
				dropdown
					.addOption('en', tr('setting.language.en'))
					.addOption('es', tr('setting.language.es'))
					.setValue(this.plugin.settings.language)
					.onChange(async (value: string) => {
						this.plugin.settings.language = value === 'es' ? 'es' : 'en';
						await this.plugin.saveSettings();
						this.display();
						this.plugin.rebuildView();
					}),
			);

		new Setting(containerEl).setName(tr('section.general')).setHeading();

		new Setting(containerEl)
			.setName(tr('setting.autoSync.name'))
			.setDesc(tr('setting.autoSync.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.autoSync).onChange(async value => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					this.plugin.gitSync.updateAutoSync();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.syncOnStartup.name'))
			.setDesc(tr('setting.syncOnStartup.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async value => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.checkStatusOnStartup.name'))
			.setDesc(tr('setting.checkStatusOnStartup.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.checkStatusOnStartup).onChange(async value => {
					this.plugin.settings.checkStatusOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.debounce.name'))
			.setDesc(tr('setting.debounce.desc'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.debounceSeconds)).onChange(async value => {
					this.plugin.settings.debounceSeconds = clampInteger(Number(value), 5, 3600);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.nonMarkdownDebounce.name'))
			.setDesc(tr('setting.nonMarkdownDebounce.desc'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.nonMarkdownDebounceSeconds)).onChange(async value => {
					this.plugin.settings.nonMarkdownDebounceSeconds = clampInteger(Number(value), 5, 3600, 120);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.periodicSync.name'))
			.setDesc(tr('setting.periodicSync.desc'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.periodicSyncMinutes)).onChange(async value => {
					this.plugin.settings.periodicSyncMinutes = clampInteger(Number(value), 0, 1440, 0);
					await this.plugin.saveSettings();
					this.plugin.gitSync.updateAutoSync();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.periodicPull.name'))
			.setDesc(tr('setting.periodicPull.desc'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.periodicPullMinutes)).onChange(async value => {
					this.plugin.settings.periodicPullMinutes = clampInteger(Number(value), 0, 1440, 0);
					await this.plugin.saveSettings();
					this.plugin.gitSync.updateAutoSync();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.syncOnClose.name'))
			.setDesc(tr('setting.syncOnClose.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.syncOnClose).onChange(async value => {
					this.plugin.settings.syncOnClose = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.autoStash.name'))
			.setDesc(tr('setting.autoStash.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.autoStashOnPull).onChange(async value => {
					this.plugin.settings.autoStashOnPull = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName(tr('section.editor')).setHeading();

		new Setting(containerEl)
			.setName(tr('setting.gutterIndicators.name'))
			.setDesc(tr('setting.gutterIndicators.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.showGutterIndicators).onChange(async value => {
					this.plugin.settings.showGutterIndicators = value;
					await this.plugin.saveSettings();
					this.plugin.applyGutterSetting();
				}),
			);

		new Setting(containerEl).setName(tr('section.commits')).setHeading();

		new Setting(containerEl)
			.setName(tr('setting.commitMessageMode.name'))
			.setDesc(tr('setting.commitMessageMode.desc'))
			.addDropdown(dropdown =>
				dropdown
					.addOption('smart', tr('setting.commitMessageMode.smart'))
					.addOption('template', tr('setting.commitMessageMode.template'))
					.setValue(this.plugin.settings.commitMessageMode)
					.onChange(async (value: string) => {
						this.plugin.settings.commitMessageMode = value === 'template' ? 'template' : 'smart';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(tr('setting.commitMessage.name'))
			.setDesc(tr('setting.commitMessage.desc'))
			.addText(text =>
				text
					.setValue(this.plugin.settings.commitMessage)
					.setPlaceholder(DEFAULT_SETTINGS.commitMessage)
					.onChange(async value => {
						this.plugin.settings.commitMessage = value.trim() || DEFAULT_SETTINGS.commitMessage;
						await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.commitAuthorName.name'))
			.setDesc(tr('setting.commitAuthorName.desc'))
			.addText(text =>
				text.setValue(this.plugin.settings.commitAuthorName).onChange(async value => {
					this.plugin.settings.commitAuthorName = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.commitAuthorEmail.name'))
			.setDesc(tr('setting.commitAuthorEmail.desc'))
			.addText(text =>
				text.setValue(this.plugin.settings.commitAuthorEmail).onChange(async value => {
					this.plugin.settings.commitAuthorEmail = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName(tr('section.repoContent')).setHeading();

		new Setting(containerEl)
			.setName(tr('setting.protectPluginData.name'))
			.setDesc(tr('setting.protectPluginData.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.protectPluginData).onChange(async value => {
					this.plugin.settings.protectPluginData = value;
					await this.plugin.saveSettings();
					this.plugin.gitSync.invalidateSettingsCache();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.excludeWorkspace.name'))
			.setDesc(tr('setting.excludeWorkspace.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.excludeWorkspace).onChange(async value => {
					this.plugin.settings.excludeWorkspace = value;
					await this.plugin.saveSettings();
					this.plugin.gitSync.invalidateSettingsCache();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.manageGitignore.name'))
			.setDesc(tr('setting.manageGitignore.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.manageGitignore).onChange(async value => {
					this.plugin.settings.manageGitignore = value;
					await this.plugin.saveSettings();
					this.plugin.gitSync.invalidateSettingsCache();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.maxFileSizeMB.name'))
			.setDesc(tr('setting.maxFileSizeMB.desc'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.maxFileSizeMB)).onChange(async value => {
					this.plugin.settings.maxFileSizeMB = clampNumber(Number(value), 0, 10240, DEFAULT_SETTINGS.maxFileSizeMB);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.excludePatterns.name'))
			.setDesc(tr('setting.excludePatterns.desc'))
			.addTextArea(text => {
				text
					.setPlaceholder('drafts/**\n**/*.tmp\n.trash/**')
					.setValue(this.plugin.settings.excludePatterns)
					.onChange(async value => {
						this.plugin.settings.excludePatterns = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
			});

		new Setting(containerEl).setName(tr('section.notifications')).setHeading();

		new Setting(containerEl)
			.setName(tr('setting.noticeLevel.name'))
			.setDesc(tr('setting.noticeLevel.desc'))
			.addDropdown(dropdown =>
				dropdown
					.addOption('all', tr('setting.noticeLevel.all'))
					.addOption('warnings', tr('setting.noticeLevel.warnings'))
					.addOption('errors', tr('setting.noticeLevel.errors'))
					.setValue(this.plugin.settings.noticeLevel)
					.onChange(async (value: string) => {
						this.plugin.settings.noticeLevel = normalizeNoticeLevel(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(tr('setting.showSuccessNotice.name'))
			.setDesc(tr('setting.showSuccessNotice.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.showSuccessNotice).onChange(async value => {
					this.plugin.settings.showSuccessNotice = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.verboseLog.name'))
			.setDesc(tr('setting.verboseLog.desc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.verboseLog).onChange(async value => {
					this.plugin.settings.verboseLog = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.networkBackoff.name'))
			.setDesc(tr('setting.networkBackoff.desc'))
			.addText(text =>
				text.setValue(String(this.plugin.settings.networkBackoffMaxMinutes)).onChange(async value => {
					this.plugin.settings.networkBackoffMaxMinutes = clampInteger(Number(value), 1, 1440, 30);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName(tr('section.manualActions')).setHeading();

		new Setting(containerEl)
			.setName(tr('setting.manualSync.name'))
			.setDesc(tr('setting.manualSync.desc'))
			.addButton(btn =>
				btn.setButtonText(tr('setting.manualSync.btn')).setCta().onClick(async () => {
					await this.plugin.gitSync.syncNow('manual');
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.manualPull.name'))
			.setDesc(tr('setting.manualPull.desc'))
			.addButton(btn =>
				btn.setButtonText(tr('setting.manualPull.btn')).onClick(async () => {
					await this.plugin.gitSync.pullNow('manual');
				}),
			);

		new Setting(containerEl)
			.setName(tr('setting.connectionStatus.name'))
			.setDesc(tr('setting.connectionStatus.desc'))
			.addButton(btn =>
				btn.setButtonText(tr('setting.connectionStatus.testBtn')).onClick(async () => {
					await this.plugin.gitSync.testConnection();
				}),
			)
			.addButton(btn =>
				btn.setButtonText(tr('setting.connectionStatus.statusBtn')).onClick(async () => {
					await this.plugin.gitSync.showStatus();
				}),
			)
			.addButton(btn =>
				btn.setButtonText(tr('setting.connectionStatus.openViewBtn')).onClick(async () => {
					await this.plugin.activateGitSyncView();
				}),
			);

		let squashInput: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName(tr('setting.squash.name'))
			.setDesc(tr('setting.squash.desc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '2';
				text.inputEl.max = '50';
				text.inputEl.value = '2';
				text.inputEl.style.width = '60px';
				text.setPlaceholder('N');
				squashInput = text.inputEl;
			})
			.addButton(btn =>
				btn.setButtonText(tr('setting.squash.btn')).setWarning().onClick(async () => {
					const n = parseInt(squashInput?.value ?? '2', 10);
					if (!n || n < 2) return;
					try {
						await this.plugin.gitSync.squashCommits(n);
					} catch (error) {
						const { Notice } = await import('obsidian');
						new Notice(`${tr('setting.squash.error')}${error instanceof Error ? error.message : String(error)}`, 10000);
					}
				}),
			);

		new Setting(containerEl).setName(tr('section.remotes')).setHeading();
		containerEl.createEl('p', {
			text: tr('remotes.description'),
			cls: 'setting-item-description',
		});

		renderRemoteList(containerEl, this.plugin, () => this.display());
	}
}
