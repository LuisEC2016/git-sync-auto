import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import type GitSyncAutoPlugin from './main';
import { VIEW_TYPE_GIT_SYNC_AUTO } from './repo-status';
import type { RepoStatusSnapshot } from './repo-status';
import { renderChangedFiles } from './view-changed-files';
import type { ChangedFilesState } from './view-changed-files';
import { renderRecentCommits } from './view-recent-commits';
import { PrePullDiffModal } from './pre-pull-diff-modal';
import { insertBadgeIntoFile } from './badge-service';
import { t } from './i18n';
import { makeSvg } from './svg-utils';

export class GitSyncAutoView extends ItemView {
	private readonly state: ChangedFilesState = {
		selectedFiles: new Set<string>(),
		commitMessage: '',
	};
	private rendering = false;
	private renderPending = false;
	private initialized = false;
	private activeTab: 'commits' | 'changes' = 'commits';

	// Persistent DOM regions — created once, updated in-place
	private regionHeader!: HTMLElement;
	private regionTabBar!: HTMLElement;
	private regionCommits!: HTMLElement;
	private regionChanged!: HTMLElement;
	private statusDot!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: GitSyncAutoPlugin,
	) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_GIT_SYNC_AUTO; }
	getDisplayText(): string { return 'Git sync'; }
	getIcon(): string { return 'git-pull-request'; }

	async onOpen(): Promise<void> { await this.render(); }

	rebuild(): void {
		this.initialized = false;
		void this.render(false);
	}

	async render(fetchRemote = true): Promise<void> {
		if (this.rendering) { this.renderPending = true; return; }
		this.rendering = true;
		try {
			if (!this.initialized) {
				await this._buildShell();
				this.initialized = true;
			}
			await this._updateContent(fetchRemote);
		} finally {
			this.rendering = false;
			if (this.renderPending) {
				this.renderPending = false;
				void this.render();
			}
		}
	}

	private async _buildShell(): Promise<void> {
		const lang = this.plugin.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

		const root = this.contentEl;
		root.empty();
		root.addClass('git-sync-view');

		// ── Scrollable content area ────────────────────────────────
		const scrollWrap = root.createDiv({ cls: 'git-sync-scroll-wrap' });

		// ── Header (branch + status) ───────────────────────────────
		this.regionHeader = scrollWrap.createDiv({ cls: 'git-sync-header' });

		// ── Toolbar ────────────────────────────────────────────────
		const toolbar = scrollWrap.createDiv({ cls: 'git-sync-toolbar' });

		// Fila 1: Sync (col 1) + Pull (col 2)
		this.addSyncBtn(toolbar, tr('view.toolbar.sync'), async () => {
			await this.plugin.gitSync.syncNow('manual');
			await this.render();
		});
		this.addToolbarBtn(toolbar, tr('view.toolbar.pull'), [
			{ tag: 'path', attrs: { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' } },
			{ tag: 'polyline', attrs: { points: '7 10 12 15 17 10' } },
			{ tag: 'line', attrs: { x1: '12', y1: '15', x2: '12', y2: '3' } },
		], async () => { await this.plugin.gitSync.pullNow('manual'); await this.render(); }, 'git-sync-pull-btn');

		// Fila 2: Actualizar + Vista previa + ··· + dot
		const row2 = toolbar.createDiv({ cls: 'git-sync-toolbar-row2' });
		this.addToolbarBtn(row2, tr('view.toolbar.refresh'), [
			{ tag: 'polyline', attrs: { points: '23 4 23 10 17 10' } },
			{ tag: 'path', attrs: { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' } },
		], () => void this.render());
		this.addToolbarBtn(row2, tr('view.toolbar.prePull'), [
			{ tag: 'path', attrs: { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' } },
			{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
		], () => void this.openPrePullDiff());

		// overflow menu (···)
		const moreBtn = row2.createEl('button', { cls: 'git-sync-action-btn git-sync-more-btn' });
		moreBtn.appendChild(makeSvg([
			{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '1' } },
			{ tag: 'circle', attrs: { cx: '19', cy: '12', r: '1' } },
			{ tag: 'circle', attrs: { cx: '5', cy: '12', r: '1' } },
		]));
		moreBtn.onClickEvent(() => this.openMoreMenu(moreBtn, tr));

		this.statusDot = row2.createDiv({ cls: 'git-sync-status-dot' });
		this.statusDot.style.marginLeft = 'auto';

		// ── Tab bar ────────────────────────────────────────────────
		this.regionTabBar  = scrollWrap.createDiv({ cls: 'git-sync-tab-bar' });

		// ── Tab content regions ────────────────────────────────────
		this.regionCommits = scrollWrap.createDiv({ cls: 'git-sync-region' });
		this.regionChanged = scrollWrap.createDiv({ cls: 'git-sync-region' });

		// ── Quick actions bar (outside scroll, fixed at bottom) ────
		const qa = root.createDiv({ cls: 'git-sync-quick-actions' });
		this.addQuickAction(qa, tr('qa.createPr.title'), tr('qa.createPr.sub'), [
			{ tag: 'circle', attrs: { cx: '18', cy: '18', r: '3' } },
			{ tag: 'circle', attrs: { cx: '6', cy: '6', r: '3' } },
			{ tag: 'path', attrs: { d: 'M13 6h3a2 2 0 0 1 2 2v7' } },
			{ tag: 'line', attrs: { x1: '6', y1: '9', x2: '6', y2: '21' } },
		], { bg: 'rgba(59,130,246,0.35)', stroke: '#93c5fd' }, () => new Notice(tr('qa.createPr.soon'), 4000));
		this.addQuickAction(qa, tr('qa.compare.title'), tr('qa.compare.sub'), [
			{ tag: 'circle', attrs: { cx: '18', cy: '18', r: '3' } },
			{ tag: 'circle', attrs: { cx: '6', cy: '6', r: '3' } },
			{ tag: 'circle', attrs: { cx: '18', cy: '6', r: '3' } },
			{ tag: 'circle', attrs: { cx: '6', cy: '18', r: '3' } },
			{ tag: 'path', attrs: { d: 'M6 9v3a3 3 0 0 0 3 3h3' } },
			{ tag: 'path', attrs: { d: 'M18 9v3a3 3 0 0 1-3 3h-3' } },
		], { bg: 'rgba(34,197,94,0.35)', stroke: '#86efac' }, () => void this.openPrePullDiff());
		this.addQuickAction(qa, tr('qa.tags.title'), tr('qa.tags.sub'), [
			{ tag: 'path', attrs: { d: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z' } },
			{ tag: 'line', attrs: { x1: '7', y1: '7', x2: '7.01', y2: '7' } },
		], { bg: 'rgba(249,115,22,0.35)', stroke: '#fdba74' }, () => new Notice(tr('qa.tags.soon'), 4000));

	}

	private async _updateContent(fetchRemote = true): Promise<void> {
		const lang = this.plugin.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

		this.statusDot?.addClass('git-sync-status-dot-loading');

		let snapshot: RepoStatusSnapshot;
		try {
			snapshot = await this.plugin.gitSync.getRepoStatus(fetchRemote);
		} finally {
			this.statusDot?.removeClass('git-sync-status-dot-loading');
		}

		if (snapshot.error === '__syncing__') {
			this.regionHeader.empty();
			const b = this.regionHeader.createDiv({ cls: 'git-sync-banner git-sync-banner-syncing' });
			b.createDiv({ cls: 'git-sync-spinner' });
			b.createSpan({ text: tr('view.status.syncing') });
			this.plugin.gitSync.onSyncDone(() => {
				if (this.containerEl.isConnected) void this.render(false);
			});
			return;
		}

		if (snapshot.error) {
			this.regionHeader.empty();
			const b = this.regionHeader.createDiv({ cls: 'git-sync-banner git-sync-banner-error' });
			b.createSpan({ text: '⚠ ' + snapshot.error });
			this.regionTabBar.empty();
			this.regionCommits.empty();
			this.regionChanged.empty();
			return;
		}

		// Header
		this.regionHeader.empty();
		renderHeader(this.regionHeader, snapshot, this.plugin, () => void this.render());

		// Tab bar
		this.regionTabBar.empty();
		this._renderTabBar(snapshot);

		// Tab content — render both, toggle visibility
		this.regionCommits.empty();
		renderRecentCommits(this.regionCommits, snapshot, this.plugin);

		this.regionChanged.empty();
		renderChangedFiles(this.regionChanged, snapshot, this.plugin, this.state, () => this.render());

		this._applyTabVisibility();
	}

	private _renderTabBar(snapshot: RepoStatusSnapshot): void {
		const lang = this.plugin.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);
		const changedCount = snapshot.changed.length;
		const commitsCount = snapshot.recent.length;

		const tabs: { id: 'commits' | 'changes'; label: string; count: number; svgPaths: { tag: string; attrs: Record<string, string> }[] }[] = [
			{
				id: 'commits',
				label: tr('tab.history'),
				count: commitsCount,
				svgPaths: [
					{ tag: 'line', attrs: { x1: '6', y1: '3', x2: '6', y2: '15' } },
					{ tag: 'circle', attrs: { cx: '18', cy: '6', r: '3' } },
					{ tag: 'circle', attrs: { cx: '6', cy: '18', r: '3' } },
					{ tag: 'path', attrs: { d: 'M18 9a9 9 0 0 1-9 9' } },
				],
			},
			{
				id: 'changes',
				label: tr('tab.changes'),
				count: changedCount,
				svgPaths: [
					{ tag: 'path', attrs: { d: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' } },
					{ tag: 'path', attrs: { d: 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' } },
				],
			},
		];

		for (const tab of tabs) {
			const btn = this.regionTabBar.createEl('button', {
				cls: 'git-sync-tab-btn' + (this.activeTab === tab.id ? ' git-sync-tab-active' : ''),
			});
			const iconWrap = btn.createDiv({ cls: 'git-sync-tab-icon' });
			iconWrap.appendChild(makeSvg(tab.svgPaths));
			btn.createSpan({ text: tab.label, cls: 'git-sync-tab-label' });
			if (tab.count > 0) {
				btn.createSpan({ text: String(tab.count), cls: 'git-sync-tab-count' + (tab.id === 'changes' && tab.count > 0 ? ' git-sync-tab-count-warn' : '') });
			}
			btn.onClickEvent(() => {
				this.activeTab = tab.id;
				this.regionTabBar.querySelectorAll('.git-sync-tab-btn').forEach(b => b.removeClass('git-sync-tab-active'));
				btn.addClass('git-sync-tab-active');
				this._applyTabVisibility();
			});
		}
	}

	private _applyTabVisibility(): void {
		if (this.activeTab === 'commits') {
			this.regionCommits.style.display = '';
			this.regionChanged.style.display = 'none';
		} else {
			this.regionCommits.style.display = 'none';
			this.regionChanged.style.display = '';
		}
	}

	private openMoreMenu(anchor: HTMLElement, tr: (key: Parameters<typeof t>[0]) => string): void {
		const doc = anchor.ownerDocument;
		doc.querySelector('.git-sync-more-popup')?.remove();
		const popup = doc.createElement('div');
		popup.className = 'git-sync-more-popup';

		const items: [string, () => void][] = [
			[tr('view.toolbar.addBadge'), () => void this.addBadgeToActiveFile()],
			[tr('more.connectionTest'), () => void this.plugin.gitSync.testConnection()],
			[tr('more.gitStatus'), () => void this.plugin.gitSync.showStatus()],
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

	private async openPrePullDiff(): Promise<void> {
		const lang = this.plugin.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);
		try {
			const branch = await this.plugin.gitSync.getCurrentBranch();
			const { commits, diff } = await this.plugin.gitSync.getIncomingChanges(branch);
			if (commits.length === 0) {
				new Notice(tr('prePull.noChanges'), 5000);
				return;
			}
			new PrePullDiffModal(this.plugin.app, commits, diff, lang, async () => {
				await this.plugin.gitSync.pullNow('manual');
				await this.render();
			}).open();
		} catch (error) {
			new Notice(`${tr('prePull.fetchFailed')}${error instanceof Error ? error.message : String(error)}`, 10000);
		}
	}

	private async addBadgeToActiveFile(): Promise<void> {
		const lang = this.plugin.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);
		const activeFile = this.plugin.app.workspace.getActiveFile()
			?? this.plugin.app.workspace.getLastOpenFiles()
				.map(path => this.plugin.app.vault.getAbstractFileByPath(path))
				.find((f): f is TFile => f instanceof TFile && f.path.endsWith('.md'))
			?? null;
		if (!activeFile || !activeFile.path.endsWith('.md')) {
			new Notice(tr('badge.noFile'), 5000);
			return;
		}
		const remote = this.plugin.gitSync.getPrimaryRemote();
		if (!remote) {
			new Notice(tr('badge.noRemote'), 5000);
			return;
		}
		const result = await insertBadgeIntoFile(this.plugin.app, activeFile, remote, lang);
		new Notice(result.message, 5000);
	}

	private addSyncBtn(container: HTMLElement, text: string, onClick: () => void | Promise<void>): void {
		const btn = container.createEl('button', { cls: 'git-sync-action-btn git-sync-sync-btn mod-cta' });
		btn.appendChild(makeSvg([
			{ tag: 'polyline', attrs: { points: '23 4 23 10 17 10' } },
			{ tag: 'polyline', attrs: { points: '1 20 1 14 7 14' } },
			{ tag: 'path', attrs: { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' } },
		]));
		btn.createSpan({ text });
		btn.onClickEvent(() => void onClick());
	}

	private addToolbarBtn(container: HTMLElement, text: string, svgPaths: { tag: string; attrs: Record<string, string> }[], onClick: () => void | Promise<void>, extraCls = ''): void {
		const btn = container.createEl('button', { cls: ('git-sync-action-btn ' + extraCls).trim() });
		btn.appendChild(makeSvg(svgPaths));
		btn.createSpan({ text });
		btn.onClickEvent(() => void onClick());
	}

	private addQuickAction(container: HTMLElement, title: string, subtitle: string, svgPaths: { tag: string; attrs: Record<string, string> }[], color: { bg: string; stroke: string }, onClick: () => void): void {
		const btn = container.createEl('button', { cls: 'git-sync-qa-btn' });
		const icon = btn.createDiv({ cls: 'git-sync-qa-icon' });
		icon.style.background = color.bg;
		icon.style.borderRadius = '8px';
		icon.style.width = '32px';
		icon.style.height = '32px';
		icon.style.display = 'flex';
		icon.style.alignItems = 'center';
		icon.style.justifyContent = 'center';
		icon.style.flexShrink = '0';
		const svg = makeSvg(svgPaths);
		svg.style.width = '15px';
		svg.style.height = '15px';
		svg.style.stroke = color.stroke;
		svg.style.fill = 'none';
		icon.appendChild(svg);
		const info = btn.createDiv({ cls: 'git-sync-qa-info' });
		info.createDiv({ text: title, cls: 'git-sync-qa-title' });
		info.createDiv({ text: subtitle, cls: 'git-sync-qa-sub' });
		btn.onClickEvent(onClick);
	}
}

// ── Header component ─────────────────────────────────────────────

function renderHeader(
	root: HTMLElement,
	snapshot: RepoStatusSnapshot,
	plugin: GitSyncAutoPlugin,
	onRender: () => void,
): void {
	const lang = plugin.settings.language;
	const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

	const header = root.createDiv({ cls: 'git-sync-top-header' });

	// Left: branch icon + name + chevron + tags
	const left = header.createDiv({ cls: 'git-sync-header-left' });
	const branchRow = left.createDiv({ cls: 'git-sync-header-branch-row' });
	const branchIcon = branchRow.createDiv({ cls: 'git-sync-header-branch-icon' });
	branchIcon.appendChild(makeSvg([
		{ tag: 'line', attrs: { x1: '6', y1: '3', x2: '6', y2: '15' } },
		{ tag: 'circle', attrs: { cx: '18', cy: '6', r: '3' } },
		{ tag: 'circle', attrs: { cx: '6', cy: '18', r: '3' } },
		{ tag: 'path', attrs: { d: 'M18 9a9 9 0 0 1-9 9' } },
	]));
	const branchName = branchRow.createDiv({ cls: 'git-sync-header-branch-name' });
	branchName.createSpan({ text: snapshot.branch });
	branchName.createSpan({ text: ' ⌄', cls: 'git-sync-header-chevron' });
	branchName.setAttr('title', tr('header.switchTitle'));
	branchName.onClickEvent(() => void plugin.openBranchSwitcher().then(onRender));

	const tags = left.createDiv({ cls: 'git-sync-header-tags' });
	tags.createSpan({ text: tr('header.tag.currentBranch'), cls: 'git-sync-header-tag' });
	if (plugin.gitSync.getPrimaryRemote()) {
		const remoteName = plugin.gitSync.getPrimaryRemote()?.name || 'main repository';
		tags.createSpan({ text: remoteName, cls: 'git-sync-header-tag git-sync-header-tag-accent' });
	}

	// Right: sync status
	const right = header.createDiv({ cls: 'git-sync-header-right' });
	if (snapshot.changed.length === 0 && snapshot.ahead === 0 && snapshot.behind === 0) {
		const status = right.createDiv({ cls: 'git-sync-header-status ok' });
		status.appendChild(makeSvg([{ tag: 'polyline', attrs: { points: '20 6 9 17 4 12' } }]));
		status.createSpan({ text: tr('header.status.clean') });
	} else if (snapshot.behind > 0) {
		const status = right.createDiv({ cls: 'git-sync-header-status warn' });
		status.createSpan({ text: tr('header.status.behind').replace('{n}', String(snapshot.behind)) });
	} else if (snapshot.ahead > 0) {
		const status = right.createDiv({ cls: 'git-sync-header-status info' });
		status.createSpan({ text: tr('header.status.ahead').replace('{n}', String(snapshot.ahead)) });
	} else if (snapshot.changed.length > 0) {
		const status = right.createDiv({ cls: 'git-sync-header-status changed' });
		status.createSpan({ text: tr('header.status.changed').replace('{n}', String(snapshot.changed.length)) });
	}
}

