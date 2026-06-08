import type { RepoStatusSnapshot } from './repo-status';
import type GitSyncAutoPlugin from './main';
import { DiffModal } from './diff-modal';
import { t } from './i18n';

export interface ChangedFilesState {
	selectedFiles: Set<string>;
	commitMessage: string;
}

export function renderChangedFiles(
	root: HTMLElement,
	snapshot: RepoStatusSnapshot,
	plugin: GitSyncAutoPlugin,
	state: ChangedFilesState,
	onRender: () => Promise<void>,
): void {
	const lang = plugin.settings.language;
	const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

	const section = root.createDiv({ cls: 'git-sync-section' });

	const heading = section.createDiv({ cls: 'git-sync-section-heading' });
	appendSectionIcon(heading, [{ tag: 'circle', cx: '12', cy: '12', r: '10' }, { tag: 'path', d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }, { tag: 'polyline', points: '22 4 12 14.01 9 11.01' }]);
	heading.createSpan({ text: tr('view.localChanges.heading') });
	if (snapshot.changed.length > 0)
		heading.createSpan({ text: String(snapshot.changed.length), cls: 'git-sync-badge' });

	if (snapshot.changed.length === 0) {
		state.selectedFiles.clear();
		const empty = section.createEl('p', { cls: 'git-sync-empty' });
		appendEmptyIcon(empty);
		empty.createSpan({ text: tr('view.localChanges.clean') });
		return;
	}

	// Purge selections for files that are no longer in the working tree.
	// Stale selections cause stageFile() calls on non-existent paths after
	// a sync that renamed, deleted, or committed those files.
	const currentPaths = new Set(snapshot.changed.slice(0, 200).map(f => f.path));
	for (const p of state.selectedFiles) {
		if (!currentPaths.has(p)) state.selectedFiles.delete(p);
	}

	const msgRow = section.createDiv({ cls: 'git-sync-commit-msg-row' });
	const msgInput = msgRow.createEl('input', { cls: 'git-sync-commit-input' }) as HTMLInputElement;
	msgInput.type = 'text';
	msgInput.placeholder = tr('view.localChanges.commitPlaceholder');
	msgInput.value = state.commitMessage;
	msgInput.addEventListener('input', () => { state.commitMessage = msgInput.value; });

	const toolbar = section.createDiv({ cls: 'git-sync-staging-toolbar' });
	const selectAllBtn = toolbar.createEl('button', { text: tr('view.localChanges.selectAll'), cls: 'git-sync-btn' });
	const commitSelBtn = toolbar.createEl('button', { text: tr('view.localChanges.commitSelected'), cls: 'git-sync-btn git-sync-btn-accent' });
	updateCommitBtn(commitSelBtn, state.selectedFiles.size);

	const list = section.createEl('ul', { cls: 'git-sync-filelist' });

	selectAllBtn.onClickEvent(() => {
		const allPaths = snapshot.changed.slice(0, 200).map(f => f.path);
		const selectingAll = state.selectedFiles.size !== allPaths.length;
		if (selectingAll) allPaths.forEach(p => state.selectedFiles.add(p));
		else state.selectedFiles.clear();

		list.querySelectorAll<HTMLLIElement>('li.git-sync-fileitem').forEach((item, i) => {
			const p = allPaths[i];
			if (!p) return;
			const cb = item.querySelector<HTMLInputElement>('input.git-sync-file-checkbox');
			if (selectingAll) { item.addClass('git-sync-fileitem-selected'); if (cb) cb.checked = true; }
			else { item.removeClass('git-sync-fileitem-selected'); if (cb) cb.checked = false; }
		});
		updateCommitBtn(commitSelBtn, state.selectedFiles.size);
	});

	commitSelBtn.onClickEvent(async () => {
		if (state.selectedFiles.size === 0) return;
		const rawMsg = msgInput.value.trim();
		const msg = rawMsg ? prefixCommitMessage(rawMsg, [...state.selectedFiles]) : undefined;
		try {
			// Stage all selected files first, then commit in one shot.
			// If any stageFile call fails, abort before committing — partial staging
			// would commit fewer files than the user selected without any warning.
			const paths = [...state.selectedFiles];
			for (const f of paths) await plugin.gitSync.stageFile(f);
			await plugin.gitSync.commitStaged(msg);
			state.selectedFiles.clear();
			state.commitMessage = '';
			msgInput.value = '';
			await onRender();
		} catch (error) {
			const { Notice } = await import('obsidian');
			new Notice(`${tr('view.localChanges.commitFailed')}${error instanceof Error ? error.message : String(error)}`, 10000);
		}
	});

	for (const file of snapshot.changed.slice(0, 200)) {
		const item = list.createEl('li', { cls: 'git-sync-fileitem' });
		if (state.selectedFiles.has(file.path)) item.addClass('git-sync-fileitem-selected');

		const checkbox = item.createEl('input', { cls: 'git-sync-file-checkbox' }) as HTMLInputElement;
		checkbox.type = 'checkbox';
		checkbox.checked = state.selectedFiles.has(file.path);
		checkbox.onClickEvent(e => {
			e.stopPropagation();
			if (state.selectedFiles.has(file.path)) {
				state.selectedFiles.delete(file.path);
				item.removeClass('git-sync-fileitem-selected');
				checkbox.checked = false;
			} else {
				state.selectedFiles.add(file.path);
				item.addClass('git-sync-fileitem-selected');
				checkbox.checked = true;
			}
			updateCommitBtn(commitSelBtn, state.selectedFiles.size);
		});

		const statusLabel = describeStatus(file.index, file.working);
		item.createSpan({ text: statusIcon(statusLabel), cls: `git-sync-status-icon git-sync-status-${statusLabel}` });

		const fileInfo = item.createDiv({ cls: 'git-sync-file-info' });
		const parts = file.path.split('/');
		const fileName = parts.pop() ?? file.path;
		const dirPath = parts.join('/');
		if (dirPath) fileInfo.createSpan({ text: dirPath + '/', cls: 'git-sync-filepath-dir' });
		const nameSpan = fileInfo.createSpan({ text: fileName, cls: 'git-sync-filepath-name' });
		nameSpan.onClickEvent(e => {
			e.stopPropagation();
			void plugin.app.workspace.openLinkText('', file.path, true);
		});

		const diffBtn = item.createEl('button', { text: tr('file.diffBtn'), cls: 'git-sync-diff-btn' });
		diffBtn.onClickEvent(async e => {
			e.stopPropagation();
			const diff = await plugin.gitSync.getDiffForFile(file.path, file.index !== ' ' && file.index !== '?');
			new DiffModal(plugin.app, file.path, diff).open();
		});

		const discardBtn = item.createEl('button', { text: tr('file.discardBtn'), cls: 'git-sync-discard-btn' });
		discardBtn.setAttribute('title', tr('file.discardConfirm').replace('{file}', file.path));
		discardBtn.onClickEvent(async e => {
			e.stopPropagation();
			const msg = tr('file.discardConfirm').replace('{file}', fileName);
			if (!window.confirm(msg)) return;
			try {
				await plugin.gitSync.discardFile(file.path);
				state.selectedFiles.delete(file.path);
				await onRender();
			} catch (error) {
				const { Notice } = await import('obsidian');
				new Notice(`Discard failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
			}
		});
	}

	if (snapshot.changed.length > 200) {
		const moreText = tr('view.localChanges.andMore').replace('{n}', String(snapshot.changed.length - 200));
		section.createEl('p', { text: moreText, cls: 'git-sync-muted' });
	}
}

function updateCommitBtn(btn: HTMLElement, count: number): void {
	if (count === 0) {
		(btn as HTMLButtonElement).setAttr('disabled', 'true');
		btn.addClass('git-sync-btn-disabled');
	} else {
		(btn as HTMLButtonElement).removeAttribute('disabled');
		btn.removeClass('git-sync-btn-disabled');
	}
}

function statusIcon(status: string): string {
	switch (status) {
		case 'new': return '＋';
		case 'modified': return '●';
		case 'deleted': return '－';
		case 'renamed': return '→';
		case 'conflict': return '⚠';
		default: return '●';
	}
}

const CONVENTIONAL_PREFIX_RE = /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+\))?!?:/;

function prefixCommitMessage(msg: string, files: string[]): string {
	// Already has a conventional commit prefix — leave as-is
	if (CONVENTIONAL_PREFIX_RE.test(msg)) return msg;
	// All selected files are .md → add docs: prefix
	const allDocs = files.length > 0 && files.every(f => f.toLowerCase().endsWith('.md'));
	return allDocs ? `docs: ${msg}` : msg;
}

function describeStatus(index: string, working: string): string {
	const combined = `${index}${working}`.replace(/ /g, '');
	if (combined.includes('U') || (index === 'A' && working === 'A')) return 'conflict';
	if (combined.includes('A') || combined === '??') return 'new';
	if (combined.includes('D')) return 'deleted';
	if (combined.includes('R')) return 'renamed';
	return 'modified';
}

type SvgShapeSpec = { tag: 'circle'; cx: string; cy: string; r: string } | { tag: 'path'; d: string } | { tag: 'polyline'; points: string };

export function appendSectionIcon(container: HTMLElement, shapes: SvgShapeSpec[]): void {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttributeNS(null, 'viewBox', '0 0 24 24');
	for (const s of shapes) {
		const el = document.createElementNS(NS, s.tag);
		if (s.tag === 'circle') {
			el.setAttributeNS(null, 'cx', s.cx);
			el.setAttributeNS(null, 'cy', s.cy);
			el.setAttributeNS(null, 'r', s.r);
		} else if (s.tag === 'path') {
			el.setAttributeNS(null, 'd', s.d);
		} else {
			el.setAttributeNS(null, 'points', s.points);
		}
		svg.appendChild(el);
	}
	container.appendChild(svg);
}

export function appendEmptyIcon(container: HTMLElement): void {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttributeNS(null, 'viewBox', '0 0 24 24');
	const circle = document.createElementNS(NS, 'circle');
	circle.setAttributeNS(null, 'cx', '12');
	circle.setAttributeNS(null, 'cy', '12');
	circle.setAttributeNS(null, 'r', '10');
	svg.appendChild(circle);
	container.appendChild(svg);
}
