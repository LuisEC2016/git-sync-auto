import { App, Modal } from 'obsidian';
import { t } from './i18n';
import type { LanguageCode } from './i18n';

export class ConflictModal extends Modal {
	constructor(
		app: App,
		private readonly files: string[],
		private readonly openFile: (file: string) => void,
		private readonly lang: LanguageCode = 'en',
	) {
		super(app);
	}

	onOpen(): void {
		const tr = (key: Parameters<typeof t>[0]) => t(key, this.lang);
		const { contentEl } = this;
		contentEl.createEl('h3', { text: tr('conflictModal.title') });
		contentEl.createEl('p', {
			text: tr('conflictModal.desc'),
			cls: 'git-sync-muted',
		});

		const list = contentEl.createDiv({ cls: 'git-sync-conflict-list' });
		for (const file of this.files) {
			const row = list.createDiv({ cls: 'git-sync-conflict-row' });
			row.createSpan({ text: file });
			row.createEl('button', { text: tr('conflictModal.open') }).onClickEvent(() => this.openFile(file));
		}

		const footer = contentEl.createDiv({ cls: 'git-sync-conflict-footer' });
		const openAll = footer.createEl('button', { text: tr('conflictModal.openAll') });
		openAll.addClass('mod-cta');
		openAll.onClickEvent(() => {
			for (const file of this.files) this.openFile(file);
			this.close();
		});
		footer.createEl('button', { text: tr('conflictModal.close') }).onClickEvent(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
