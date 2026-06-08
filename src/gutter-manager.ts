import { MarkdownView } from 'obsidian';
import type { App, Plugin, TAbstractFile } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Editor } from 'obsidian';
import { gitGutter, parseDiffHunks, dispatchHunks, gutterHunksField, setGutterActionCallback } from './gutter-extension';

export interface GutterHost {
	app: App;
	registerEvent(event: ReturnType<App['vault']['on']>): void;
	registerEditorExtension(extension: Extension): void;
	gitSync: {
		getDiffForFile(path: string, staged: boolean): Promise<string>;
		stageFile(path: string): Promise<void>;
		unstageFile(path: string): Promise<void>;
		resetFile(path: string): Promise<void>;
	};
}

export class GutterManager {
	private gutterDebounceId: number | null = null;
	private editorDebounceId: number | null = null;
	private gutterEnabled = false;
	private extensionsRegistered = false;
	private diffCache = new Map<string, { mtime: number; hunks: import('./gutter-extension').GutterHunk[] }>();

	constructor(private readonly host: GutterHost & Pick<Plugin, 'registerEvent'>) {}

	applyGutterSetting(showGutterIndicators: boolean): void {
		if (showGutterIndicators) {
			this.enable();
		} else {
			this.disable();
		}
	}

	enable(): void {
		if (this.gutterEnabled) return;
		this.gutterEnabled = true;
		setGutterActionCallback(async (line, _type, action) => {
			const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.file) return;
			try {
				if (action === 'stage') {
					await this.host.gitSync.stageFile(view.file.path);
					const { Notice } = await import('obsidian');
					new Notice(`Staged: ${view.file.path}`, 3000);
				} else {
					await this.host.gitSync.resetFile(view.file.path);
					const { Notice } = await import('obsidian');
					new Notice(`Reset: ${view.file.path}`, 3000);
				}
				await this.updateForActiveFile();
			} catch (error) {
				const { Notice } = await import('obsidian');
				new Notice(`${action} failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
			}
		});
		if (!this.extensionsRegistered) {
			this.extensionsRegistered = true;
			this.host.registerEditorExtension(gitGutter);
			this.host.registerEditorExtension(this.buildEditorListener());
		}
		this.startUpdater();
	}

	private buildEditorListener(): Extension {
		return EditorView.updateListener.of((update) => {
			if (!this.gutterEnabled || !update.docChanged) return;
			if (this.editorDebounceId !== null) window.clearTimeout(this.editorDebounceId);
			// 600 ms — matches the vault modify debounce; short enough for interactive
			// feel, long enough to coalesce rapid keystrokes into one git-diff call.
			this.editorDebounceId = window.setTimeout(() => {
				this.editorDebounceId = null;
				void this.updateForActiveFile();
			}, 600);
		});
	}

	disable(): void {
		this.gutterEnabled = false;
		if (this.gutterDebounceId !== null) {
			window.clearTimeout(this.gutterDebounceId);
			this.gutterDebounceId = null;
		}
		if (this.editorDebounceId !== null) {
			window.clearTimeout(this.editorDebounceId);
			this.editorDebounceId = null;
		}
		this.host.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof MarkdownView) {
				const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
				if (cm?.dispatch) dispatchHunks(cm, []);
			}
		});
	}

	async updateForActiveFile(): Promise<void> {
		if (!this.gutterEnabled) return;
		const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!cm?.dispatch) return;
		try {
			const filePath = view.file.path;
			const mtime = view.file.stat.mtime;
			const cached = this.diffCache.get(filePath);
			let hunks: import('./gutter-extension').GutterHunk[];
			if (cached && cached.mtime === mtime) {
				hunks = cached.hunks;
			} else {
				const diff = await this.host.gitSync.getDiffForFile(filePath, false);
				hunks = parseDiffHunks(diff);
				// LRU eviction: keep at most 20 entries (one per recently-opened file).
				// Map insertion order = access order after delete+set refresh.
				if (this.diffCache.size >= 20 && !this.diffCache.has(filePath)) {
					this.diffCache.delete(this.diffCache.keys().next().value!);
				}
				this.diffCache.set(filePath, { mtime, hunks });
			}
			dispatchHunks(cm as unknown as import('@codemirror/view').EditorView, hunks);
		} catch {
			// File not tracked — skip silently
		}
	}

	invalidateDiffCache(filePath?: string): void {
		if (filePath) this.diffCache.delete(filePath);
		else this.diffCache.clear();
	}

	navigateHunk(editor: Editor, direction: 'next' | 'prev'): void {
		const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!cm) return;

		const hunks = cm.state.field(gutterHunksField, false) ?? [];
		if (hunks.length === 0) return;

		const cursorLine = editor.getCursor().line + 1;
		const sorted = [...hunks].sort((a, b) => a.line - b.line);

		let target: number | null = null;
		if (direction === 'next') {
			target = sorted.find(h => h.line > cursorLine)?.line ?? sorted[0]?.line ?? null;
		} else {
			const before = sorted.filter(h => h.line < cursorLine);
			target = before[before.length - 1]?.line ?? sorted[sorted.length - 1]?.line ?? null;
		}

		if (target !== null) {
			editor.setCursor({ line: target - 1, ch: 0 });
			editor.scrollIntoView({ from: { line: target - 1, ch: 0 }, to: { line: target - 1, ch: 0 } }, true);
		}
	}

	async stageHunkAtCursor(editor: Editor): Promise<void> {
		const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!cm) return;

		const cursorLine = editor.getCursor().line + 1;
		const hunks = cm.state.field(gutterHunksField, false) ?? [];
		const hunk = hunks.find(h => Math.abs(h.line - cursorLine) <= 1);
		if (!hunk) return;

		try {
			await this.host.gitSync.stageFile(view.file.path);
			const { Notice } = await import('obsidian');
			new Notice(`Staged: ${view.file.path}`, 3000);
			await this.updateForActiveFile();
		} catch (error) {
			const { Notice } = await import('obsidian');
			new Notice(`Stage failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
		}
	}

	async resetHunkAtCursor(editor: Editor): Promise<void> {
		const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!cm) return;

		const cursorLine = editor.getCursor().line + 1;
		const hunks = cm.state.field(gutterHunksField, false) ?? [];
		const hunk = hunks.find(h => Math.abs(h.line - cursorLine) <= 1);
		if (!hunk) return;

		try {
			await this.host.gitSync.resetFile(view.file.path);
			const { Notice } = await import('obsidian');
			new Notice(`Reset: ${view.file.path}`, 3000);
			await this.updateForActiveFile();
		} catch (error) {
			const { Notice } = await import('obsidian');
			new Notice(`Reset failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
		}
	}

	private startUpdater(): void {
		const scheduleRefresh = (debounce: number) => () => {
			if (!this.gutterEnabled) return;
			if (this.gutterDebounceId !== null) window.clearTimeout(this.gutterDebounceId);
			this.gutterDebounceId = window.setTimeout(() => void this.updateForActiveFile(), debounce);
		};
		// vault.on('modify') fires on every file write — including files the user
		// is not viewing. Guard: only queue a refresh when the modified file is the
		// active file. This eliminates spurious git-diff calls during bulk operations
		// (sync, pull, attachment imports).
		this.host.registerEvent(
			this.host.app.vault.on('modify', (file: TAbstractFile) => {
				if (!this.gutterEnabled) return;
				const active = this.host.app.workspace.getActiveViewOfType(MarkdownView);
				if (!active?.file || active.file.path !== file.path) return;
				scheduleRefresh(600)();
			}),
		);
		// file-open: refresh when switching files (short delay lets CM6 settle)
		this.host.registerEvent(this.host.app.workspace.on('file-open', scheduleRefresh(50)));
		void this.updateForActiveFile();
	}
}
