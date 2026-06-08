import { Modal, App } from 'obsidian';
import type { RepoStatusSnapshot } from './repo-status';
import type GitSyncAutoPlugin from './main';
import { parseSideBySide, parseUnified, detectLang, renderUnified } from './view-diff';
import { splitByFile } from './diff-modal';
import { t } from './i18n';
import { makeSvg } from './svg-utils';

export function renderRecentCommits(
	root: HTMLElement,
	snapshot: RepoStatusSnapshot,
	plugin: GitSyncAutoPlugin,
): void {
	const lang = plugin.settings.language;
	const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

	const section = root.createDiv({ cls: 'git-sync-commits-section' });

	// ── Section header ─────────────────────────────────────────
	const header = section.createDiv({ cls: 'git-sync-commits-header' });
	const headerLeft = header.createDiv({ cls: 'git-sync-commits-header-left' });
	headerLeft.createDiv({ text: tr('commits.title'), cls: 'git-sync-commits-title' });
	headerLeft.createDiv({
		text: tr('commits.subtitle').replace('{branch}', snapshot.branch),
		cls: 'git-sync-commits-subtitle',
	});

	const headerRight = header.createDiv({ cls: 'git-sync-commits-header-right' });

	// Search box
	const searchWrap = headerRight.createDiv({ cls: 'git-sync-commits-search' });
	const searchInput = searchWrap.createEl('input', { cls: 'git-sync-commits-search-input' }) as HTMLInputElement;
	searchInput.type = 'text';
	searchInput.placeholder = tr('commits.search');
	const searchIcon = searchWrap.createDiv({ cls: 'git-sync-commits-search-icon' });
	searchIcon.appendChild(makeSvg([
		{ tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
		{ tag: 'line', attrs: { x1: '21', y1: '21', x2: '16.65', y2: '16.65' } },
	]));

	// Filter btn
	const filterBtn = headerRight.createEl('button', { cls: 'git-sync-commits-filter-btn' });
	filterBtn.appendChild(makeSvg([
		{ tag: 'line', attrs: { x1: '4', y1: '6', x2: '20', y2: '6' } },
		{ tag: 'line', attrs: { x1: '8', y1: '12', x2: '16', y2: '12' } },
		{ tag: 'line', attrs: { x1: '12', y1: '18', x2: '12', y2: '18' } },
	]));

	if (snapshot.recent.length === 0) {
		section.createEl('p', { text: tr('view.recentHistory.noCommits'), cls: 'git-sync-empty' });
		return;
	}

	// ── Filter state ───────────────────────────────────────────
	let activeAuthor = '';
	let activeType = '';

	// ── Commit list ────────────────────────────────────────────
	const list = section.createDiv({ cls: 'git-sync-commits-list' });
	let visibleItems: HTMLElement[] = [];

	const headHash = snapshot.recent[0]?.hash ?? '';

	const renderItems = (filter: string) => {
		list.empty();
		visibleItems = [];
		const lower = filter.toLowerCase();
		const commits = snapshot.recent.filter(c => {
			if (activeAuthor && c.author !== activeAuthor) return false;
			if (activeType && extractCommitType(c.message) !== activeType) return false;
			if (!filter) return true;
			return c.message.toLowerCase().includes(lower) || c.hash.includes(lower) || c.author.toLowerCase().includes(lower);
		});

		for (let i = 0; i < commits.length; i++) {
			const commit = commits[i];
			if (!commit) continue;
			const isHead = commit.hash === headHash;
			const isLast = i === commits.length - 1;

			const row = list.createDiv({ cls: 'git-sync-commit-row' + (isHead ? ' git-sync-commit-row-head' : '') });
			visibleItems.push(row);

			// Spine
			const spine = row.createDiv({ cls: 'git-sync-commit-spine' });
			spine.createDiv({ cls: 'git-sync-commit-dot' + (isHead ? ' git-sync-commit-dot-head' : '') });
			if (!isLast) spine.createDiv({ cls: 'git-sync-commit-spine-line' });

			// Avatar
			const avatar = row.createDiv({ cls: `git-sync-commit-avatar ${commitAvatarClass(commit.message)}` });
			avatar.appendChild(commitAvatarIcon(commit.message));

			// Body
			const body = row.createDiv({ cls: 'git-sync-commit-body' });

			// Badges row (HEAD + branch + type tag)
			if (isHead || extractCommitType(commit.message)) {
				const badges = body.createDiv({ cls: 'git-sync-commit-badges' });
				if (isHead) {
					badges.createSpan({ text: 'HEAD', cls: 'git-sync-commit-badge-head' });
					if (snapshot.branch) {
						const branchBadge = badges.createSpan({ cls: 'git-sync-commit-badge-branch' });
						branchBadge.appendChild(makeSvg([
							{ tag: 'line', attrs: { x1: '6', y1: '3', x2: '6', y2: '15' } },
							{ tag: 'circle', attrs: { cx: '18', cy: '6', r: '3' } },
							{ tag: 'circle', attrs: { cx: '6', cy: '18', r: '3' } },
							{ tag: 'path', attrs: { d: 'M18 9a9 9 0 0 1-9 9' } },
						]));
						branchBadge.createSpan({ text: snapshot.branch });
					}
				}
				const typeTag = extractCommitType(commit.message);
				if (typeTag) badges.createSpan({ text: typeTag.toUpperCase(), cls: `git-sync-commit-type git-sync-commit-type-${typeTag}` });
			}

			// Message
			const msgWrap = body.createDiv({ cls: 'git-sync-commit-msg-wrap' });
			const msg = msgWrap.createDiv({ cls: 'git-sync-commit-msg' });
			msg.createSpan({ text: stripCommitType(commit.message) });
			msgWrap.createDiv({ text: commit.hash.slice(0, 7), cls: 'git-sync-commit-hash' });

			// Click opens diff modal
			row.onClickEvent(() => {
				new CommitDiffModal(plugin.app, commit.hash, commit.message, plugin, tr).open();
			});

			// Meta
			const meta = row.createDiv({ cls: 'git-sync-commit-meta' });
			const authorEl = meta.createDiv({ cls: 'git-sync-commit-author' });
			authorEl.appendChild(makeSvg([
				{ tag: 'path', attrs: { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' } },
				{ tag: 'circle', attrs: { cx: '12', cy: '7', r: '4' } },
			]));
			authorEl.createSpan({ text: commit.author });
			meta.createDiv({ text: relativeTime(commit.date, tr), cls: 'git-sync-commit-time' });

			const check = meta.createDiv({ cls: 'git-sync-commit-check' });
			check.appendChild(makeSvg([
				{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
				{ tag: 'polyline', attrs: { points: '9 12 11 14 15 10' } },
			]));

			// ··· menu
			const menuBtn = meta.createEl('button', { cls: 'git-sync-commit-menu-btn' });
			menuBtn.textContent = '···';
			menuBtn.onClickEvent((e) => {
				e.stopPropagation();
				openCommitMenu(menuBtn, commit, plugin, tr);
			});
		}
	};

	renderItems('');

	searchInput.addEventListener('input', () => renderItems(searchInput.value));

	filterBtn.onClickEvent((e) => {
		e.stopPropagation();
		openFilterMenu(filterBtn, snapshot.recent, activeAuthor, activeType, tr, (author, type) => {
			activeAuthor = author;
			activeType = type;
			const hasFilter = Boolean(author || type);
			filterBtn.toggleClass('git-sync-commits-filter-btn-active', hasFilter);
			renderItems(searchInput.value);
		});
	});
}

function openFilterMenu(
	anchor: HTMLElement,
	commits: { author: string; message: string }[],
	currentAuthor: string,
	currentType: string,
	tr: (key: Parameters<typeof t>[0]) => string,
	onApply: (author: string, type: string) => void,
): void {
	const doc = anchor.ownerDocument;
	doc.querySelector('.git-sync-filter-popup')?.remove();

	const popup = doc.createElement('div');
	popup.className = 'git-sync-filter-popup git-sync-more-popup';

	const authors = [...new Set(commits.map(c => c.author))].sort();
	const types = [...new Set(commits.map(c => extractCommitType(c.message)).filter(Boolean))] as string[];

	let selAuthor = currentAuthor;
	let selType = currentType;

	const section = (label: string) => {
		const h = doc.createElement('div');
		h.className = 'git-sync-filter-section-label';
		h.textContent = label;
		popup.appendChild(h);
	};

	const chip = (label: string, active: boolean, onClick: () => void) => {
		const btn = doc.createElement('button');
		btn.className = 'git-sync-filter-chip' + (active ? ' active' : '');
		btn.textContent = label;
		btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
		popup.appendChild(btn);
	};

	const render = () => {
		while (popup.firstChild) popup.removeChild(popup.firstChild);

		section(tr('filter.author'));
		chip(tr('filter.all'), !selAuthor, () => { selAuthor = ''; render(); });
		for (const a of authors) chip(a, selAuthor === a, () => { selAuthor = selAuthor === a ? '' : a; render(); });

		if (types.length > 0) {
			section(tr('filter.type'));
			chip(tr('filter.all'), !selType, () => { selType = ''; render(); });
			for (const tp of types) chip(tp, selType === tp, () => { selType = selType === tp ? '' : tp; render(); });
		}

		const applyBtn = doc.createElement('button');
		applyBtn.className = 'git-sync-filter-apply';
		applyBtn.textContent = tr('filter.apply');
		applyBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			popup.remove();
			doc.removeEventListener('click', dismiss);
			onApply(selAuthor, selType);
		});
		popup.appendChild(applyBtn);
	};

	render();

	const rect = anchor.getBoundingClientRect();
	popup.style.position = 'fixed';
	popup.style.top = `${rect.bottom + 4}px`;
	popup.style.right = `${doc.documentElement.clientWidth - rect.right}px`;
	popup.style.minWidth = '160px';
	doc.body.appendChild(popup);

	const dismiss = (e: MouseEvent) => {
		if (!popup.contains(e.target as Node)) {
			popup.remove();
			doc.removeEventListener('click', dismiss);
		}
	};
	(doc.defaultView ?? window).setTimeout(() => doc.addEventListener('click', dismiss), 10);
}

function openCommitMenu(
	anchor: HTMLElement,
	commit: { hash: string; message: string; author: string; date: string },
	plugin: GitSyncAutoPlugin,
	_tr: (key: Parameters<typeof t>[0]) => string,
): void {
	const doc = anchor.ownerDocument;
	doc.querySelector('.git-sync-commit-popup')?.remove();
	const popup = doc.createElement('div');
	popup.className = 'git-sync-commit-popup';

	const items: [string, () => void][] = [
		[_tr('commit.viewDiff'), () => new CommitDiffModal(plugin.app, commit.hash, commit.message, plugin, _tr).open()],
		[_tr('commit.copyHash'), () => void navigator.clipboard.writeText(commit.hash)],
	];
	for (const [label, action] of items) {
		const btn = doc.createElement('button');
		btn.className = 'git-sync-more-item';
		btn.textContent = label;
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			popup.remove();
			doc.removeEventListener('click', dismiss);
			action();
		});
		popup.appendChild(btn);
	}

	const rect = anchor.getBoundingClientRect();
	popup.style.position = 'fixed';
	popup.style.top = `${rect.bottom + 4}px`;
	popup.style.right = `${doc.documentElement.clientWidth - rect.right}px`;
	doc.body.appendChild(popup);

	const dismiss = (e: MouseEvent) => {
		if (!popup.contains(e.target as Node)) {
			popup.remove();
			doc.removeEventListener('click', dismiss);
		}
	};
	(doc.defaultView ?? window).setTimeout(() => doc.addEventListener('click', dismiss), 10);
}

// ── Avatar colors by commit type ──────────────────────────────────

const AVATAR_CLASSES: Record<string, string> = {
	feat: 'avatar-green',
	fix: 'avatar-red',
	chore: 'avatar-dark',
	docs: 'avatar-blue',
	refactor: 'avatar-purple',
	ci: 'avatar-orange',
	style: 'avatar-dark',
	test: 'avatar-green',
	perf: 'avatar-blue',
	build: 'avatar-dark',
};

function commitAvatarClass(msg: string): string {
	const type = extractCommitType(msg);
	return type ? (AVATAR_CLASSES[type] ?? 'avatar-default') : 'avatar-default';
}

function commitAvatarIcon(msg: string): SVGSVGElement {
	const type = extractCommitType(msg);
	switch (type) {
		case 'feat':
			return makeSvg([{ tag: 'polyline', attrs: { points: '23 6 13.5 15.5 8.5 10.5 1 18' } }, { tag: 'polyline', attrs: { points: '17 6 23 6 23 12' } }], 14);
		case 'fix':
			return makeSvg([{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } }, { tag: 'line', attrs: { x1: '12', y1: '8', x2: '12', y2: '12' } }, { tag: 'line', attrs: { x1: '12', y1: '16', x2: '12.01', y2: '16' } }], 14);
		case 'docs':
			return makeSvg([{ tag: 'path', attrs: { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' } }, { tag: 'polyline', attrs: { points: '14 2 14 8 20 8' } }, { tag: 'line', attrs: { x1: '16', y1: '13', x2: '8', y2: '13' } }, { tag: 'line', attrs: { x1: '16', y1: '17', x2: '8', y2: '17' } }, { tag: 'polyline', attrs: { points: '10 9 9 9 8 9' } }], 14);
		case 'chore':
			return makeSvg([{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } }, { tag: 'path', attrs: { d: 'M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14' } }], 14);
		default:
			return makeSvg([{ tag: 'line', attrs: { x1: '6', y1: '3', x2: '6', y2: '15' } }, { tag: 'circle', attrs: { cx: '18', cy: '6', r: '3' } }, { tag: 'circle', attrs: { cx: '6', cy: '18', r: '3' } }, { tag: 'path', attrs: { d: 'M18 9a9 9 0 0 1-9 9' } }], 14);
	}
}

// ── Commit diff modal (unchanged logic, same as before) ───────────

class CommitDiffModal extends Modal {
	constructor(
		app: App,
		private readonly hash: string,
		private readonly message: string,
		private readonly plugin: GitSyncAutoPlugin,
		private readonly tr: (key: Parameters<typeof t>[0]) => string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl, modalEl } = this;
		modalEl.addClass('git-sync-commit-modal');

		const header = contentEl.createDiv({ cls: 'git-sync-commit-modal-header' });
		const titleBlock = header.createDiv({ cls: 'git-sync-commit-modal-title' });
		const typeTag = extractCommitType(this.message);
		if (typeTag) titleBlock.createSpan({ text: typeTag, cls: `git-sync-commit-type git-sync-commit-type-${typeTag}` });
		titleBlock.createSpan({ text: stripCommitType(this.message), cls: 'git-sync-commit-modal-msg' });

		const hashRow = header.createDiv({ cls: 'git-sync-commit-modal-hashrow' });
		const hashEl = hashRow.createSpan({ text: this.hash.slice(0, 7), cls: 'git-sync-commit-modal-hash' });
		hashEl.setAttr('title', this.tr('commit.copyTitle'));
		hashEl.onClickEvent(() => {
			void navigator.clipboard.writeText(this.hash);
			hashEl.setText(this.tr('commit.copied'));
			window.setTimeout(() => hashEl.setText(this.hash.slice(0, 7)), 1500);
		});

		const body = contentEl.createDiv({ cls: 'git-sync-commit-modal-body' });
		const loading = body.createDiv({ cls: 'git-sync-loading' });
		loading.createDiv({ cls: 'git-sync-spinner' });
		loading.createSpan({ text: this.tr('view.recentHistory.loading'), cls: 'git-sync-muted' });

		const diff = await this.plugin.gitSync.getCommitDiff(this.hash);
		loading.remove();

		if (!diff) {
			body.createDiv({ text: this.tr('view.recentHistory.noDiff'), cls: 'git-sync-empty' });
			return;
		}

		const allPairs = parseSideBySide(diff);
		const files = splitByFile(allPairs);
		const allLines = parseUnified(diff);

		if (files.length === 0) {
			const lang = detectLang(allPairs);
			renderUnified(body, allLines, lang);
			return;
		}

		const fileLineGroups = splitUnifiedByFile(allLines);
		for (const fg of fileLineGroups) {
			const fileBlock = body.createDiv({ cls: 'git-sync-commit-file-block' });
			const fileHeader = fileBlock.createDiv({ cls: 'git-sync-commit-file-header' });
			const parts = fg.fileName.split('/');
			const name = parts.pop() ?? fg.fileName;
			const dir = parts.join('/');
			const nameEl = fileHeader.createDiv({ cls: 'git-sync-commit-file-name' });
			if (dir) nameEl.createSpan({ text: dir + '/', cls: 'git-sync-diff-modal-dir' });
			nameEl.createSpan({ text: name });
			const added = fg.lines.filter(l => l.type === 'add').length;
			const removed = fg.lines.filter(l => l.type === 'del').length;
			const statsEl = fileHeader.createDiv({ cls: 'git-sync-commit-file-stats' });
			if (added > 0) statsEl.createSpan({ text: `+${added}`, cls: 'git-sync-file-stat-add' });
			if (removed > 0) statsEl.createSpan({ text: `−${removed}`, cls: 'git-sync-file-stat-del' });
			const lang = detectLang(allPairs.filter(p => p.isMeta && p.metaText?.includes(fg.fileName)));
			renderUnified(fileBlock, fg.lines, lang);
		}
	}

	onClose(): void { this.contentEl.empty(); }
}

function splitUnifiedByFile(lines: import('./view-diff').DiffLine[]): { fileName: string; lines: import('./view-diff').DiffLine[] }[] {
	const files: { fileName: string; lines: import('./view-diff').DiffLine[] }[] = [];
	let current: { fileName: string; lines: import('./view-diff').DiffLine[] } | null = null;
	for (const line of lines) {
		if (line.type === 'meta' && line.text.startsWith('diff --git')) {
			if (current) files.push(current);
			const m = line.text.match(/diff --git a\/.+ b\/(.+)/);
			current = { fileName: m?.[1] ?? '', lines: [] };
			continue;
		}
		if (current) current.lines.push(line);
	}
	if (current) files.push(current);
	return files;
}

function extractCommitType(msg: string): string | null {
	const m = msg.match(/^(feat|fix|chore|docs|style|refactor|test|ci|perf|build)(\(.+?\))?:/);
	return m?.[1] ?? null;
}

function stripCommitType(msg: string): string {
	return msg.replace(/^(feat|fix|chore|docs|style|refactor|test|ci|perf|build)(\(.+?\))?:\s*/, '');
}

function relativeTime(iso: string, tr: (key: Parameters<typeof t>[0]) => string): string {
	if (!iso) return '';
	const parsed = new Date(iso).getTime();
	if (!Number.isFinite(parsed)) return '';
	const diff = Date.now() - parsed;
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return tr('time.justNow');
	if (mins < 60) return tr('time.minutesAgo').replace('{n}', String(mins));
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return tr('time.hoursAgo').replace('{n}', String(hrs));
	const days = Math.floor(hrs / 24);
	if (days < 7) return tr('time.daysAgo').replace('{n}', String(days));
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
