import { App, SuggestModal, Notice } from 'obsidian';
import { t } from './i18n';
import type { LanguageCode } from './i18n';

export interface BranchModalResult {
	branch: string;
	isNew: boolean;
}

export class BranchSwitchModal extends SuggestModal<string> {
	private branches: string[] = [];
	private onChoose: (result: BranchModalResult) => void;
	private inputValue = '';
	private lang: LanguageCode;

	constructor(
		app: App,
		branches: string[],
		onChoose: (result: BranchModalResult) => void,
		lang: LanguageCode = 'en',
	) {
		super(app);
		this.branches = branches;
		this.onChoose = onChoose;
		this.lang = lang;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);
		this.setPlaceholder(tr('branchModal.placeholder'));
		this.setInstructions([
			{ command: '↑↓', purpose: tr('branchModal.navigate') },
			{ command: '↵', purpose: tr('branchModal.switch') },
			{ command: 'esc', purpose: tr('branchModal.cancel') },
		]);
	}

	getSuggestions(query: string): string[] {
		this.inputValue = query.trim();
		const lower = query.toLowerCase();
		const filtered = this.branches.filter(b => b.toLowerCase().includes(lower));

		if (this.inputValue && !this.branches.includes(this.inputValue)) {
			return [...filtered, `+ Create "${this.inputValue}"`];
		}
		return filtered;
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		if (value.startsWith('+ Create "')) {
			el.addClass('git-sync-branch-new');
			el.createSpan({ text: '+ ', cls: 'git-sync-branch-new-icon' });
			el.createSpan({ text: value.slice(2) });
		} else {
			el.createSpan({ text: value, cls: 'git-sync-branch-item' });
		}
	}

	onChooseSuggestion(value: string): void {
		if (value.startsWith('+ Create "')) {
			const newBranch = this.inputValue;
			if (!newBranch) return;
			this.onChoose({ branch: newBranch, isNew: true });
		} else {
			this.onChoose({ branch: value, isNew: false });
		}
	}
}

export function showBranchNotice(branch: string, created: boolean, lang: LanguageCode = 'en'): void {
	const prefix = created ? t('branchModal.created', lang) : t('branchModal.switched', lang);
	new Notice(`${prefix}${branch}`, 4000);
}
