import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { gutter, GutterMarker, EditorView } from '@codemirror/view';

export interface GutterHunk {
	line: number;
	type: 'added' | 'modified' | 'deleted';
}

const setHunksEffect = StateEffect.define<GutterHunk[]>();

type HunkActionCallback = (line: number, type: GutterHunk['type'], action: 'stage' | 'reset') => void;

let globalActionCallback: HunkActionCallback | null = null;

export function setGutterActionCallback(cb: HunkActionCallback): void {
	globalActionCallback = cb;
}

class HunkMarker extends GutterMarker {
	constructor(
		private readonly hunkType: GutterHunk['type'],
		private readonly line: number,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const el = document.createElement('div');
		el.className = `git-sync-gutter-mark git-sync-gutter-${this.hunkType}`;
		el.setAttribute('title', 'Click to stage/reset');

		el.addEventListener('click', (e) => {
			e.stopPropagation();
			const ownerDoc = el.ownerDocument;
			const existing = ownerDoc.querySelector('.git-sync-gutter-popup');
			if (existing) { existing.remove(); return; }

			const popup = ownerDoc.createElement('div');
			popup.className = 'git-sync-gutter-popup';

			const dismiss = (ev: MouseEvent) => {
				if (!popup.contains(ev.target as Node)) closePopup();
			};
			const closePopup = () => {
				popup.remove();
				ownerDoc.removeEventListener('click', dismiss);
			};

			const stageBtn = ownerDoc.createElement('button');
			stageBtn.textContent = '+ Stage';
			stageBtn.className = 'git-sync-gutter-popup-btn git-sync-gutter-popup-stage';
			stageBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				closePopup();
				globalActionCallback?.(this.line, this.hunkType, 'stage');
			});

			const resetBtn = ownerDoc.createElement('button');
			resetBtn.textContent = '↺ Reset';
			resetBtn.className = 'git-sync-gutter-popup-btn git-sync-gutter-popup-reset';
			resetBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				closePopup();
				globalActionCallback?.(this.line, this.hunkType, 'reset');
			});

			popup.appendChild(stageBtn);
			popup.appendChild(resetBtn);

			const rect = el.getBoundingClientRect();
			popup.style.position = 'fixed';
			popup.style.top = `${rect.bottom + 4}px`;
			popup.style.left = `${rect.left}px`;
			ownerDoc.body.appendChild(popup);

			(el.ownerDocument.defaultView ?? window).setTimeout(
				() => ownerDoc.addEventListener('click', dismiss), 10,
			);
		});

		return el;
	}
}

export const gutterHunksField = StateField.define<GutterHunk[]>({
	create() { return []; },
	update(hunks, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHunksEffect)) return effect.value;
		}
		return hunks;
	},
});

export const gitGutter = [
	gutterHunksField,
	gutter({
		class: 'git-sync-gutter',
		markers(view) {
			const hunks = view.state.field(gutterHunksField);
			const builder = new RangeSetBuilder<GutterMarker>();
			if (view.state.doc.lines === 0) return builder.finish();
			const sorted = [...hunks].sort((a, b) => a.line - b.line);
			for (const hunk of sorted) {
				const lineNum = Math.max(1, Math.min(hunk.line, view.state.doc.lines));
				const line = view.state.doc.line(lineNum);
				builder.add(line.from, line.from, new HunkMarker(hunk.type, hunk.line));
			}
			return builder.finish();
		},
		initialSpacer() { return new HunkMarker('added', 0); },
	}),
	EditorView.domEventHandlers({
		keydown(e, view) {
			if (e.key === 'Escape') {
				view.dom.ownerDocument.querySelector('.git-sync-gutter-popup')?.remove();
			}
		},
	}),
];

export function dispatchHunks(view: EditorView, hunks: GutterHunk[]): void {
	view.dispatch({ effects: setHunksEffect.of(hunks) });
}

export function parseDiffHunks(diff: string): GutterHunk[] {
	const hunks: GutterHunk[] = [];
	let currentNewLine = 0;

	for (const line of diff.split('\n')) {
		if (!line) continue; // skip empty lines (trailing newline in diff output)
		const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (hunkHeader) {
			currentNewLine = parseInt(hunkHeader[1]!, 10);
			continue;
		}
		if (line.startsWith('+') && !line.startsWith('+++')) {
			// In unified diff, '-' always precedes '+' for a changed line.
			// If the previous hunk is 'deleted' at the same new-line position,
			// upgrade it to 'modified' instead of adding a redundant 'added' marker.
			const last = hunks.length > 0 ? hunks[hunks.length - 1]! : null;
			if (last && last.line === currentNewLine && last.type === 'deleted') {
				last.type = 'modified';
			} else {
				hunks.push({ line: currentNewLine, type: 'added' });
			}
			currentNewLine++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			hunks.push({ line: Math.max(1, currentNewLine), type: 'deleted' });
		} else if (!line.startsWith('\\')) {
			currentNewLine++;
		}
	}

	return hunks;
}
