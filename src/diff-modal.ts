import { App, Modal } from 'obsidian';
import { parseSideBySide, parseUnified, detectLang, renderUnified } from './view-diff';
import type { SidePair } from './view-diff';

export class DiffModal extends Modal {
	constructor(
		app: App,
		private readonly filePath: string,
		private readonly diff: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('git-sync-diff-modal');

		const titleRow = contentEl.createDiv({ cls: 'git-sync-diff-modal-title' });
		const parts = this.filePath.split('/');
		const name = parts.pop() ?? this.filePath;
		const dir = parts.join('/');
		const titleText = titleRow.createEl('h3');
		if (dir) titleText.createSpan({ text: dir + '/', cls: 'git-sync-diff-modal-dir' });
		titleText.createSpan({ text: name });
		titleRow.createEl('button', { text: '✕', cls: 'git-sync-diff-close-btn' })
			.onClickEvent(() => this.close());

		if (!this.diff) {
			contentEl.createEl('p', { text: 'No diff available (file may be new or binary).', cls: 'git-sync-muted' });
			return;
		}

		const pairs = parseSideBySide(this.diff);
		const lines = parseUnified(this.diff);
		const lang = detectLang(pairs);
		renderUnified(contentEl, lines, lang);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Split pairs by file (separated by meta rows with "diff --git" prefix)
export function splitByFile(pairs: SidePair[]): { header: string; fileName: string; pairs: SidePair[] }[] {
	const files: { header: string; fileName: string; pairs: SidePair[] }[] = [];
	let current: { header: string; fileName: string; pairs: SidePair[] } | null = null;

	for (const pair of pairs) {
		if (pair.isMeta && pair.metaText?.startsWith('diff --git')) {
			if (current) files.push(current);
			const m = pair.metaText.match(/diff --git a\/.+ b\/(.+)/);
			const fileName = m?.[1] ?? '';
			current = { header: pair.metaText, fileName, pairs: [] };
			continue;
		}
		if (current) {
			current.pairs.push(pair);
		}
	}
	if (current) files.push(current);
	return files;
}
