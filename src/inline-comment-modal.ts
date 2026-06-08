import { App, Modal, TFile } from 'obsidian';
import type GitSyncAutoPlugin from './main';
import { buildCommentMarker } from './comment-extension';
import type { CommentType, CommentPriority } from './comment-extension';
import { t } from './i18n';

const TYPE_OPTIONS: { value: CommentType; icon: string; label: string }[] = [
	{ value: 'note',       icon: '💬', label: 'Nota' },
	{ value: 'suggestion', icon: '💡', label: 'Sugerencia' },
	{ value: 'question',   icon: '❓', label: 'Pregunta' },
	{ value: 'issue',      icon: '🐛', label: 'Issue' },
];

const PRIORITY_OPTIONS: { value: CommentPriority; label: string; color: string }[] = [
	{ value: 'info',     label: 'Info',     color: 'var(--text-muted)' },
	{ value: 'minor',    label: 'Minor',    color: 'var(--color-blue, #6ea8fe)' },
	{ value: 'major',    label: 'Major',    color: 'var(--color-orange, #e8a838)' },
	{ value: 'critical', label: 'Critical', color: 'var(--color-red, #ff6b6b)' },
];

export class InlineCommentModal extends Modal {
	private commentInput!: HTMLTextAreaElement;
	private selectedType: CommentType = 'note';
	private selectedPriority: CommentPriority = 'info';

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly selectedText: string,
		private readonly plugin: GitSyncAutoPlugin,
		private readonly selectionOffset: number = -1,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('git-sync-comment-modal');

		const lang = this.plugin.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

		contentEl.createEl('h3', { text: tr('comment.title'), cls: 'git-sync-comment-modal-heading' });

		// Selected text preview
		const preview = contentEl.createDiv({ cls: 'git-sync-comment-preview' });
		preview.createSpan({ text: tr('comment.selection'), cls: 'git-sync-muted git-sync-comment-label' });
		const previewText = this.selectedText.length > 200
			? this.selectedText.slice(0, 200) + '…'
			: this.selectedText;
		preview.createEl('blockquote', { text: previewText, cls: 'git-sync-comment-quote' });

		// Type selector
		const typeWrap = contentEl.createDiv({ cls: 'git-sync-comment-row' });
		typeWrap.createSpan({ text: 'Tipo:', cls: 'git-sync-muted git-sync-comment-label' });
		const typeGroup = typeWrap.createDiv({ cls: 'git-sync-chip-group' });
		for (const opt of TYPE_OPTIONS) {
			const btn = typeGroup.createEl('button', {
				text: `${opt.icon} ${opt.label}`,
				cls: 'git-sync-chip-btn' + (opt.value === this.selectedType ? ' active' : ''),
			});
			btn.dataset['value'] = opt.value;
			btn.addEventListener('click', () => {
				this.selectedType = opt.value;
				typeGroup.querySelectorAll('.git-sync-chip-btn').forEach(b => b.removeClass('active'));
				btn.addClass('active');
			});
		}

		// Priority selector
		const prioWrap = contentEl.createDiv({ cls: 'git-sync-comment-row' });
		prioWrap.createSpan({ text: 'Prioridad:', cls: 'git-sync-muted git-sync-comment-label' });
		const prioGroup = prioWrap.createDiv({ cls: 'git-sync-chip-group' });
		for (const opt of PRIORITY_OPTIONS) {
			const btn = prioGroup.createEl('button', {
				text: opt.label,
				cls: 'git-sync-chip-btn' + (opt.value === this.selectedPriority ? ' active' : ''),
			});
			btn.dataset['value'] = opt.value;
			btn.style.setProperty('--chip-color', opt.color);
			btn.addEventListener('click', () => {
				this.selectedPriority = opt.value;
				prioGroup.querySelectorAll('.git-sync-chip-btn').forEach(b => b.removeClass('active'));
				btn.addClass('active');
			});
		}

		// Comment textarea
		const inputWrap = contentEl.createDiv({ cls: 'git-sync-comment-input-wrap' });
		inputWrap.createSpan({ text: tr('comment.label'), cls: 'git-sync-muted git-sync-comment-label' });
		this.commentInput = inputWrap.createEl('textarea', {
			cls: 'git-sync-comment-textarea',
			attr: { placeholder: tr('comment.placeholder'), rows: '3' },
		});

		window.setTimeout(() => this.commentInput.focus(), 50);

		// Buttons
		const btnRow = contentEl.createDiv({ cls: 'git-sync-comment-btns' });
		btnRow.createEl('button', { text: tr('comment.cancel'), cls: 'git-sync-btn' })
			.onClickEvent(() => this.close());
		btnRow.createEl('button', { text: tr('comment.submit'), cls: 'git-sync-btn mod-cta' })
			.onClickEvent(() => void this.submit());

		this.commentInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.submit(); }
		});
	}

	private async submit(): Promise<void> {
		const lang = this.plugin.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);
		const comment = this.commentInput.value.trim();
		if (!comment) return;

		this.close();

		try {
			const vault = this.plugin.app.vault;
			let content = await vault.read(this.file);

			const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			const author = await this.plugin.gitSync.getGitUser();

			const marker = buildCommentMarker(id, this.selectedText, comment, author, this.selectedType, this.selectedPriority);
			// Prefer the exact offset captured from the editor cursor when the modal opened.
			// Fall back to searching from the closest match to that offset, or appending.
			let idx = -1;
			if (this.selectionOffset >= 0 && content.slice(this.selectionOffset, this.selectionOffset + this.selectedText.length) === this.selectedText) {
				idx = this.selectionOffset;
			} else {
				idx = content.indexOf(this.selectedText);
			}
			if (idx === -1) {
				content += '\n' + marker;
			} else {
				content = content.slice(0, idx) + marker + content.slice(idx + this.selectedText.length);
			}

			await vault.modify(this.file, content);
			await this.plugin.gitSync.stageFile(this.file.path);
			await this.plugin.gitSync.commitStaged(`comment(${this.file.basename}): [${this.selectedType}] ${comment}`);

			new (await import('obsidian')).Notice(
				tr('comment.success').replace('{file}', this.file.basename), 5000,
			);
		} catch (error) {
			new (await import('obsidian')).Notice(
				`${t('comment.failed', lang)}${error instanceof Error ? error.message : String(error)}`, 10000,
			);
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
