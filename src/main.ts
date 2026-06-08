import { Plugin, Notice, TFile, MarkdownView } from 'obsidian';
import type { Editor, Menu, MarkdownFileInfo } from 'obsidian';
import { ConflictModal } from './conflict-modal';
import { BranchSwitchModal, showBranchNotice } from './branch-modal';
import { GitSyncService } from './git-sync-service';
import { VIEW_TYPE_GIT_SYNC_AUTO } from './repo-status';
import { GitSyncAutoView } from './repo-status-view';
import { GitSyncAutoSettingTab } from './settings-tab';
import { GitSyncAutoSettings, normalizeSettings } from './settings';
import { GutterManager } from './gutter-manager';
import { PrePullDiffModal } from './pre-pull-diff-modal';
import { insertBadgeIntoFile } from './badge-service';
import { InlineCommentModal } from './inline-comment-modal';
import { commentDecorations, setCommentDeleteCallback, setCommentResolveCallback } from './comment-extension';
import { t } from './i18n';

export default class GitSyncAutoPlugin extends Plugin {
	declare settings: GitSyncAutoSettings;
	declare gitSync: GitSyncService;
	private gutterManager!: GutterManager;

	async onload() {
		await this.loadSettings();
		this.gitSync = new GitSyncService(this);
		this.gutterManager = new GutterManager(this);

		this.registerView(VIEW_TYPE_GIT_SYNC_AUTO, leaf => new GitSyncAutoView(leaf, this));

		this.addRibbonIcon('git-branch', 'Sync vault with Git', () => {
			void this.gitSync.syncNow('manual');
		});

		this.addRibbonIcon('git-pull-request', 'Open Git sync', () => {
			void this.activateGitSyncView();
		});

		this.addCommand({
			id: 'sync-now',
			name: 'Sync vault with Git',
			callback: async () => { await this.gitSync.syncNow('manual'); },
		});

		this.addCommand({
			id: 'pull-remote',
			name: 'Pull remote changes',
			callback: async () => { await this.gitSync.pullNow('manual'); },
		});

		this.addCommand({
			id: 'show-git-status',
			name: 'Show sync status',
			callback: async () => { await this.gitSync.showStatus(); },
		});

		this.addCommand({
			id: 'test-git-connection',
			name: 'Test Git connection',
			callback: async () => { await this.gitSync.testConnection(); },
		});

		this.addCommand({
			id: 'open-git-sync-view',
			name: 'Open Git sync view',
			callback: async () => { await this.activateGitSyncView(); },
		});

		this.addCommand({
			id: 'switch-branch',
			name: 'Switch Git branch',
			callback: async () => { await this.openBranchSwitcher(); },
		});

		this.addCommand({
			id: 'next-hunk',
			name: 'Go to next change hunk',
			editorCallback: (editor) => { this.gutterManager.navigateHunk(editor, 'next'); },
		});

		this.addCommand({
			id: 'prev-hunk',
			name: 'Go to previous change hunk',
			editorCallback: (editor) => { this.gutterManager.navigateHunk(editor, 'prev'); },
		});

		this.addCommand({
			id: 'stage-hunk',
			name: 'Stage hunk under cursor',
			editorCallback: (editor) => { void this.gutterManager.stageHunkAtCursor(editor); },
		});

		this.addCommand({
			id: 'reset-hunk',
			name: 'Reset hunk under cursor',
			editorCallback: (editor) => { void this.gutterManager.resetHunkAtCursor(editor); },
		});

		this.addCommand({
			id: 'preview-pull',
			name: 'Preview incoming pull changes',
			callback: async () => { await this.openPrePullDiff(); },
		});

		this.addCommand({
			id: 'add-github-badge',
			name: 'Add GitHub badge to current note',
			callback: async () => { await this.addBadgeToActiveFile(); },
		});

		// Right-click context menu in editor: "Add comment to Git"
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				const selection = editor.getSelection();
				if (!selection) return;
				const file = (info as { file?: TFile }).file;
				if (!file || !(file instanceof TFile) || !file.path.endsWith('.md')) return;
				const lang = this.settings.language;
				menu.addItem(item => {
					item
						.setTitle(t('comment.menuItem', lang))
						.setIcon('message-square')
						.onClick(() => {
							const selectionStart = editor.posToOffset(editor.getCursor('from'));
							new InlineCommentModal(this.app, file, selection, this, selectionStart).open();
						});
				});
			}),
		);

		// CM6 extension: render git-comment markers as badges in editor
		this.registerEditorExtension(commentDecorations);

		// Wire up comment deletion from editor popup
		setCommentDeleteCallback((_id, from, to) => {
			void this.deleteCommentAt(from, to);
		});

		// Wire up comment resolution from editor popup
		setCommentResolveCallback((_id, from, to) => {
			void this.resolveCommentAt(from, to);
		});

		// Reading/Preview mode: hide raw comment markers, show badge
		this.registerMarkdownPostProcessor((el) => {
			const deleteComment = (from: number, to: number) => void this.deleteCommentAt(from, to);
			el.querySelectorAll('*').forEach(node => {
				if (node.nodeType !== Node.ELEMENT_NODE) return;
				processCommentNodes(node as HTMLElement, deleteComment);
			});
			processCommentNodes(el, deleteComment);
			processCalloutNodes(el);
		});

		this.addSettingTab(new GitSyncAutoSettingTab(this.app, this));

		if (this.settings.showGutterIndicators) {
			this.gutterManager.enable();
		}

		this.gitSync.start();
	}

	applyGutterSetting(): void {
		this.gutterManager.applyGutterSetting(this.settings.showGutterIndicators);
	}

	async updateGutterForActiveFile(): Promise<void> {
		return this.gutterManager.updateForActiveFile();
	}

	invalidateGutterCache(): void {
		this.gutterManager.invalidateDiffCache();
	}

	async onunload() {
		if (this.settings?.syncOnClose && this.gitSync) {
			await this.gitSync.syncNow('manual');
		}
		setCommentDeleteCallback(() => {});
		setCommentResolveCallback(() => {});
	}

	rebuildView(): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC_AUTO)[0];
		if (leaf?.view instanceof GitSyncAutoView) leaf.view.rebuild();
	}

	async activateGitSyncView(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_SYNC_AUTO)[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_GIT_SYNC_AUTO, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	openConflictModal(files: string[]): void {
		new ConflictModal(this.app, files, file => {
			void this.app.workspace.openLinkText('', file, true);
		}, this.settings.language).open();
	}

	async openBranchSwitcher(): Promise<void> {
		const branches = await this.gitSync.listBranches();
		new BranchSwitchModal(this.app, branches, async ({ branch, isNew }) => {
			try {
				await this.gitSync.switchBranch(branch, isNew);
				showBranchNotice(branch, isNew, this.settings.language);
			} catch (error) {
				const { Notice } = await import('obsidian');
				new Notice(`Branch switch failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
			}
		}, this.settings.language).open();
	}

	async openPrePullDiff(): Promise<void> {
		const lang = this.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);
		try {
			const branch = await this.gitSync.getCurrentBranch();
			const { commits, diff } = await this.gitSync.getIncomingChanges(branch);
			if (commits.length === 0) {
				new Notice(tr('prePull.noChanges'), 5000);
				return;
			}
			new PrePullDiffModal(this.app, commits, diff, lang, async () => {
				await this.gitSync.pullNow('manual');
			}).open();
		} catch (error) {
			new Notice(`${tr('prePull.fetchFailed')}${error instanceof Error ? error.message : String(error)}`, 10000);
		}
	}

	async addBadgeToActiveFile(): Promise<void> {
		const lang = this.settings.language;
		const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

		const activeFile = this.app.workspace.getActiveFile()
			?? this.app.workspace.getLastOpenFiles()
				.map(path => this.app.vault.getAbstractFileByPath(path))
				.find((f): f is TFile => f instanceof TFile && f.path.endsWith('.md'))
			?? null;

		if (!activeFile || !activeFile.path.endsWith('.md')) {
			new Notice(tr('badge.noFile'), 5000);
			return;
		}
		const remote = this.gitSync.getPrimaryRemote();
		if (!remote) {
			new Notice(tr('badge.noRemote'), 5000);
			return;
		}
		const result = await insertBadgeIntoFile(this.app, activeFile, remote, lang);
		new Notice(result.message, 5000);
	}

	async resolveCommentAt(from: number, to: number): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		// Read from the editor's in-memory buffer so positions from CM6 decorations
		// remain valid even if the file on disk hasn't been flushed yet.
		const editorView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const content = editorView
			? editorView.editor.getValue()
			: await this.app.vault.read(file);
		if (from < 0 || to > content.length || from >= to) return;
		// Replace status="open" with status="resolved" within the marker span
		const marker = content.slice(from, to);
		const updated = marker.replace(/\bstatus="open"/, 'status="resolved"');
		if (updated === marker) return;
		await this.app.vault.modify(file, content.slice(0, from) + updated + content.slice(to));
	}

	async deleteCommentAt(from: number, to: number): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		// Read from the editor's in-memory buffer so positions from CM6 decorations
		// remain valid even if the file on disk hasn't been flushed yet.
		const editorView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const content = editorView
			? editorView.editor.getValue()
			: await this.app.vault.read(file);
		if (from < 0 || to > content.length || from >= to) return;
		const inner = content.slice(from, to);
		// Extract the selected text between the tags to restore it
		const innerMatch = inner.match(/^<!--[\s\S]*?-->([\s\S]*?)<!--\s*\/git-comment\s*-->$/);
		const restored = innerMatch ? innerMatch[1] : '';
		const newContent = content.slice(0, from) + restored + content.slice(to);
		await this.app.vault.modify(file, newContent);
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<GitSyncAutoSettings> | null;
		this.settings = normalizeSettings(data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// Post-processor helper: scan rendered HTML for raw git-comment text nodes and replace with badges
function processCommentNodes(el: HTMLElement, onDelete?: (from: number, to: number) => void): void {
	// Walk text nodes looking for the comment pattern
	const OPEN = '<!-- git-comment ';
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const toReplace: { node: Text; full: string }[] = [];
	let node: Node | null;
	while ((node = walker.nextNode()) !== null) {
		const text = (node as Text).textContent ?? '';
		if (text.includes(OPEN)) {
			toReplace.push({ node: node as Text, full: text });
		}
	}

	for (const { node: textNode, full } of toReplace) {
		const parent = textNode.parentNode;
		if (!parent) continue;

		// Parse all comments in this text chunk
		// Format: <!-- git-comment id="..." comment="..." author="..." type="..." priority="..." status="..." -->SELECTED_TEXT<!-- /git-comment -->
		const FULL_RE = /<!--\s*git-comment\s+id="([^"]+)"\s+comment="([^"]*?)"(?:\s+author="([^"]*?)")?(?:\s+type="([^"]*?)")?(?:\s+priority="([^"]*?)")?(?:\s+status="([^"]*?)")?\s*-->([\s\S]*?)<!--\s*\/git-comment\s*-->/g;
		let last = 0;
		const frag = document.createDocumentFragment();
		let m: RegExpExecArray | null;
		FULL_RE.lastIndex = 0;
		while ((m = FULL_RE.exec(full)) !== null) {
			const commentText = m[2]!.replace(/&#34;/g, '"').replace(/&amp;/g, '&');
			const status = m[6] ?? 'open';
			const selectedText = m[7]!;
			const author = m[3] ? m[3].replace(/&#34;/g, '"').replace(/&amp;/g, '&') : '';
			if (m.index > last) {
				frag.appendChild(document.createTextNode(full.slice(last, m.index)));
			}
			// Badge before selected text
			const badge = document.createElement('span');
			badge.className = status === 'resolved'
				? 'git-sync-comment-badge git-sync-comment-resolved'
				: 'git-sync-comment-badge';
			badge.textContent = '💬';
			badge.setAttribute('title', commentText);
			const matchStart = m.index;
			const matchEnd = m.index + m[0].length;
			badge.addEventListener('click', (e) => {
				e.stopPropagation();
				const delCb = onDelete ? () => onDelete(matchStart, matchEnd) : undefined;
				showPreviewCommentPopup(badge, selectedText, commentText, author, delCb);
			});
			frag.appendChild(badge);
			// Highlighted selected text
			const mark = document.createElement('mark');
			mark.className = 'git-sync-comment-highlight';
			mark.textContent = selectedText;
			frag.appendChild(mark);
			last = m.index + m[0].length;
		}
		if (last < full.length) {
			frag.appendChild(document.createTextNode(full.slice(last)));
		}
		parent.replaceChild(frag, textNode);
	}
}

function showPreviewCommentPopup(anchor: HTMLElement, selection: string, text: string, author = '', onDelete?: () => void): void {
	const doc = anchor.ownerDocument;
	doc.querySelector('.git-sync-comment-popup')?.remove();

	const popup = doc.createElement('div');
	popup.className = 'git-sync-comment-popup';

	if (author) {
		const authorEl = doc.createElement('div');
		authorEl.className = 'git-sync-comment-popup-author';
		authorEl.textContent = author;
		popup.appendChild(authorEl);
	}

	const selEl = doc.createElement('div');
	selEl.className = 'git-sync-comment-popup-selection';
	selEl.textContent = selection.length > 80 ? selection.slice(0, 80) + '…' : selection;
	popup.appendChild(selEl);

	const textEl = doc.createElement('div');
	textEl.className = 'git-sync-comment-popup-text';
	textEl.textContent = text;
	popup.appendChild(textEl);

	if (onDelete) {
		const del = doc.createElement('button');
		del.className = 'git-sync-comment-popup-delete';
		del.textContent = '🗑 Borrar comentario';
		del.addEventListener('click', (e) => {
			e.stopPropagation();
			closePopup();
			onDelete();
		});
		popup.appendChild(del);
	}

	const rect = anchor.getBoundingClientRect();
	popup.style.position = 'fixed';
	popup.style.top = `${rect.bottom + 6}px`;
	popup.style.left = `${rect.left}px`;
	doc.body.appendChild(popup);

	const pr = popup.getBoundingClientRect();
	if (pr.right > doc.documentElement.clientWidth - 8) {
		popup.style.left = `${doc.documentElement.clientWidth - pr.width - 8}px`;
	}

	const dismiss = (ev: MouseEvent) => {
		if (!popup.contains(ev.target as Node)) {
			closePopup();
		}
	};
	function closePopup(): void {
		popup.remove();
		doc.removeEventListener('click', dismiss);
	}
	(doc.defaultView ?? window).setTimeout(() => doc.addEventListener('click', dismiss), 10);
}

// Post-processor for Obsidian-rendered callout blocks:
// > [!note] Comentario Git  →  collapsed badge
function processCalloutNodes(el: HTMLElement): void {
	el.querySelectorAll<HTMLElement>('.callout[data-callout="note"]').forEach(callout => {
		const title = callout.querySelector('.callout-title-inner');
		if (!title || title.textContent?.trim() !== 'Comentario Git') return;

		// Extract selection from "**Sobre:** `...`" paragraph
		let selection = '';
		let commentText = '';
		const paragraphs = callout.querySelectorAll('.callout-content p');
		paragraphs.forEach((p, i) => {
			if (i === 0) {
				// First paragraph: **Sobre:** `<selection>`
				const code = p.querySelector('code');
				selection = code?.textContent?.replace(/…$/, '').trim() ?? '';
			} else {
				commentText += (commentText ? '\n' : '') + (p.textContent ?? '');
			}
		});
		if (!commentText && paragraphs.length === 1) {
			// Text may be in same paragraph after the code
			const raw = paragraphs[0]?.textContent ?? '';
			const afterCode = raw.replace(/^.*`[^`]*`\s*/, '').trim();
			if (afterCode) commentText = afterCode;
		}

		// Replace callout with inline badge
		const badge = document.createElement('span');
		badge.className = 'git-sync-comment-badge';
		badge.textContent = '💬';
		badge.setAttribute('title', commentText || selection);
		badge.addEventListener('click', (e) => {
			e.stopPropagation();
			showPreviewCommentPopup(badge, selection, commentText);
		});
		callout.replaceWith(badge);
	});
}
