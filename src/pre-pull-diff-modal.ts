import { Modal, App } from 'obsidian';
import { renderDiffInto } from './view-diff';
import { t } from './i18n';
import type { LanguageCode } from './i18n';

interface IncomingCommit {
	hash: string;
	author: string;
	date: string;
	message: string;
}

export class PrePullDiffModal extends Modal {
	private onConfirm: () => void;
	private commits: IncomingCommit[];
	private diff: string;
	private lang: LanguageCode;

	constructor(
		app: App,
		commits: IncomingCommit[],
		diff: string,
		lang: LanguageCode,
		onConfirm: () => void,
	) {
		super(app);
		this.commits = commits;
		this.diff = diff;
		this.lang = lang;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const tr = (key: Parameters<typeof t>[0]) => t(key, this.lang);
		const { contentEl } = this;
		contentEl.addClass('git-sync-prepull-modal');

		const header = contentEl.createDiv({ cls: 'git-sync-prepull-header' });
		header.createEl('h3', { text: tr('prePull.title') });
		header.createEl('p', {
			text: tr('prePull.subtitle').replace('{n}', String(this.commits.length)),
			cls: 'git-sync-prepull-subtitle',
		});

		// Incoming commits list
		if (this.commits.length > 0) {
			const commitsSection = contentEl.createDiv({ cls: 'git-sync-prepull-section' });
			commitsSection.createDiv({
				text: tr('prePull.incomingCommits'),
				cls: 'git-sync-prepull-section-label',
			});
			const list = commitsSection.createEl('ul', { cls: 'git-sync-prepull-commitlist' });
			for (const commit of this.commits) {
				const item = list.createEl('li', { cls: 'git-sync-prepull-commititem' });
				const typeMatch = commit.message.match(/^(feat|fix|chore|docs|style|refactor|test|ci|perf|build)(\(.+?\))?:/);
				const typeTag = typeMatch?.[1] ?? null;
				const msgText = typeTag
					? commit.message.replace(/^(feat|fix|chore|docs|style|refactor|test|ci|perf|build)(\(.+?\))?:\s*/, '')
					: commit.message;
				const row = item.createDiv({ cls: 'git-sync-prepull-commit-row' });
				if (typeTag) row.createSpan({ text: typeTag, cls: `git-sync-commit-type git-sync-commit-type-${typeTag}` });
				row.createSpan({ text: msgText, cls: 'git-sync-prepull-commitmsg' });
				const meta = item.createDiv({ cls: 'git-sync-prepull-commitmeta' });
				meta.createSpan({ text: commit.hash.slice(0, 7), cls: 'git-sync-prepull-hash' });
				meta.createSpan({ text: commit.author, cls: 'git-sync-prepull-author' });
			}
		}

		// Diff section (collapsible)
		if (this.diff) {
			const diffSection = contentEl.createDiv({ cls: 'git-sync-prepull-section' });
			const diffToggle = diffSection.createDiv({ cls: 'git-sync-prepull-diff-toggle' });
			const arrow = diffToggle.createSpan({ text: '▶', cls: 'git-sync-prepull-arrow' });
			diffToggle.createSpan({ text: tr('prePull.showDiff') });
			const diffBody = diffSection.createDiv({ cls: 'git-sync-prepull-diffbody' });
			diffBody.style.display = 'none';
			renderDiffInto(diffBody, this.diff);
			diffToggle.onClickEvent(() => {
				const open = diffBody.style.display !== 'none';
				diffBody.style.display = open ? 'none' : 'block';
				arrow.setText(open ? '▶' : '▼');
			});
		}

		// Footer buttons
		const footer = contentEl.createDiv({ cls: 'git-sync-prepull-footer' });
		const cancelBtn = footer.createEl('button', {
			text: tr('prePull.cancel'),
			cls: 'git-sync-btn',
		});
		const pullBtn = footer.createEl('button', {
			text: tr('prePull.pull'),
			cls: 'git-sync-btn git-sync-btn-cta',
		});

		cancelBtn.onClickEvent(() => this.close());
		pullBtn.onClickEvent(() => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
