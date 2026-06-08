import { ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// Matches <!-- git-comment id="..." comment="..." author="..." type="..." priority="..." status="..." -->SELECTED_TEXT<!-- /git-comment -->
const COMMENT_RE = /<!--\s*git-comment\s+id="([^"]+)"\s+comment="([^"]*?)"(?:\s+author="([^"]*?)")?(?:\s+type="([^"]*?)")?(?:\s+priority="([^"]*?)")?(?:\s+status="([^"]*?)")?\s*-->([\s\S]*?)<!--\s*\/git-comment\s*-->/g;

export type CommentType = 'note' | 'suggestion' | 'question' | 'issue';
export type CommentPriority = 'info' | 'minor' | 'major' | 'critical';
export type CommentStatus = 'open' | 'resolved';

// Matches Obsidian callout format:
// > [!note] Comentario Git
// > **Sobre:** `<selection>`
// >
// > <comment text lines>
const CALLOUT_RE = /^> \[!note\] Comentario Git\n> \*\*Sobre:\*\* `([^\n`]*)`\n((?:>.*\n?)*)/gm;

export interface ParsedComment {
	id: string;
	selection: string;
	text: string;
	author: string;
	type: CommentType;
	priority: CommentPriority;
	status: CommentStatus;
	from: number;
	to: number;
}

export function parseComments(doc: string): ParsedComment[] {
	const results: ParsedComment[] = [];
	let m: RegExpExecArray | null;

	// Format 1: <!-- git-comment --> markers
	COMMENT_RE.lastIndex = 0;
	while ((m = COMMENT_RE.exec(doc)) !== null) {
		results.push({
			id: m[1]!,
			text: decodeAttr(m[2]!),
			author: m[3] ? decodeAttr(m[3]) : '',
			type: (m[4] as CommentType) || 'note',
			priority: (m[5] as CommentPriority) || 'info',
			status: (m[6] as CommentStatus) || 'open',
			selection: m[7]!,
			from: m.index,
			to: m.index + m[0].length,
		});
	}

	// Format 2: > [!note] Comentario Git callouts
	CALLOUT_RE.lastIndex = 0;
	while ((m = CALLOUT_RE.exec(doc)) !== null) {
		const selection = m[1]!.replace(/…$/, '').trim();
		// Extract text from remaining callout lines (strip leading "> ")
		const bodyLines = m[2]!
			.split('\n')
			.map(l => l.replace(/^>\s?/, ''))
			.join('\n')
			.trim();
		if (!bodyLines) continue;
		results.push({
			id: 'callout-' + m.index.toString(36),
			selection,
			author: '',
			text: bodyLines,
			type: 'note',
			priority: 'info',
			status: 'open',
			from: m.index,
			to: m.index + m[0].length,
		});
	}

	// Sort by position so RangeSetBuilder gets them in order
	results.sort((a, b) => a.from - b.from);
	return results;
}

function decodeAttr(s: string): string {
	return s.replace(/&#34;/g, '"').replace(/&amp;/g, '&');
}

export function encodeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&#34;').replace(/\n/g, ' ');
}

export function buildCommentMarker(
	id: string,
	selectedText: string,
	commentText: string,
	author = '',
	type: CommentType = 'note',
	priority: CommentPriority = 'info',
	status: CommentStatus = 'open',
): string {
	const authorAttr = author ? ` author="${encodeAttr(author)}"` : '';
	return `<!-- git-comment id="${id}" comment="${encodeAttr(commentText)}"${authorAttr} type="${type}" priority="${priority}" status="${status}" -->${selectedText}<!-- /git-comment -->`;
}

// ── Type/priority helpers ───────────────────────────────────────

const TYPE_ICON: Record<CommentType, string> = {
	note: '💬',
	suggestion: '💡',
	question: '❓',
	issue: '🐛',
};

const PRIORITY_COLOR: Record<CommentPriority, string> = {
	info: 'var(--text-muted)',
	minor: 'var(--color-blue, #6ea8fe)',
	major: 'var(--color-orange, #e8a838)',
	critical: 'var(--color-red, #ff6b6b)',
};

const PRIORITY_LABEL: Record<CommentPriority, string> = {
	info: 'Info', minor: 'Minor', major: 'Major', critical: 'Critical',
};

const TYPE_LABEL: Record<CommentType, string> = {
	note: 'Nota', suggestion: 'Sugerencia', question: 'Pregunta', issue: 'Issue',
};

// ── Delete / resolve callbacks ──────────────────────────────────

type DeleteCallback = (id: string, from: number, to: number) => void;
type ResolveCallback = (id: string, from: number, to: number) => void;
let globalDeleteCallback: DeleteCallback | null = null;
let globalResolveCallback: ResolveCallback | null = null;
export function setCommentDeleteCallback(cb: DeleteCallback): void { globalDeleteCallback = cb; }
export function setCommentResolveCallback(cb: ResolveCallback): void { globalResolveCallback = cb; }

// ── Widget shown in editor ──────────────────────────────────────

class CommentBadgeWidget extends WidgetType {
	constructor(private readonly comment: ParsedComment) { super(); }

	eq(other: CommentBadgeWidget): boolean { return other.comment.id === this.comment.id; }

	toDOM(): HTMLElement {
		const wrap = document.createElement('span');
		const resolved = this.comment.status === 'resolved';
		wrap.className = 'git-sync-comment-badge' + (resolved ? ' git-sync-comment-resolved' : '');
		wrap.setAttribute('data-type', this.comment.type);
		wrap.setAttribute('data-priority', this.comment.priority);
		wrap.setAttribute('title', `[${TYPE_LABEL[this.comment.type]}] ${this.comment.text}`);
		wrap.textContent = TYPE_ICON[this.comment.type];
		wrap.style.color = resolved ? 'var(--text-faint)' : PRIORITY_COLOR[this.comment.priority];
		wrap.addEventListener('click', (e) => {
			e.stopPropagation();
			showCommentPopup(wrap, this.comment);
		});
		return wrap;
	}

	ignoreEvent(): boolean { return false; }
}

function showCommentPopup(anchor: HTMLElement, comment: ParsedComment): void {
	const doc = anchor.ownerDocument;
	doc.querySelector('.git-sync-comment-popup')?.remove();

	const popup = doc.createElement('div');
	popup.className = 'git-sync-comment-popup';
	if (comment.status === 'resolved') popup.classList.add('git-sync-comment-popup-resolved');

	// Header row: author + chips
	const header = doc.createElement('div');
	header.className = 'git-sync-comment-popup-header';

	if (comment.author) {
		const authorEl = doc.createElement('span');
		authorEl.className = 'git-sync-comment-popup-author';
		authorEl.textContent = comment.author;
		header.appendChild(authorEl);
	}

	const chips = doc.createElement('span');
	chips.className = 'git-sync-comment-popup-chips';

	const typeChip = doc.createElement('span');
	typeChip.className = `git-sync-chip git-sync-chip-type git-sync-chip-${comment.type}`;
	typeChip.textContent = TYPE_LABEL[comment.type];
	chips.appendChild(typeChip);

	const prioChip = doc.createElement('span');
	prioChip.className = `git-sync-chip git-sync-chip-priority git-sync-chip-${comment.priority}`;
	prioChip.textContent = PRIORITY_LABEL[comment.priority];
	prioChip.style.color = PRIORITY_COLOR[comment.priority];
	chips.appendChild(prioChip);

	if (comment.status === 'resolved') {
		const resolvedChip = doc.createElement('span');
		resolvedChip.className = 'git-sync-chip git-sync-chip-resolved';
		resolvedChip.textContent = '✓ Resuelto';
		chips.appendChild(resolvedChip);
	}

	header.appendChild(chips);
	popup.appendChild(header);

	// Selected text
	const selEl = doc.createElement('div');
	selEl.className = 'git-sync-comment-popup-selection';
	selEl.textContent = comment.selection.length > 80
		? comment.selection.slice(0, 80) + '…'
		: comment.selection;
	popup.appendChild(selEl);

	// Comment text
	const textEl = doc.createElement('div');
	textEl.className = 'git-sync-comment-popup-text';
	textEl.textContent = comment.text;
	popup.appendChild(textEl);

	// Action buttons
	const actions = doc.createElement('div');
	actions.className = 'git-sync-comment-popup-actions';

	if (globalResolveCallback && comment.status === 'open') {
		const resolveBtn = doc.createElement('button');
		resolveBtn.className = 'git-sync-comment-popup-resolve';
		resolveBtn.textContent = '✓ Resolver';
		resolveBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			closePopup();
			globalResolveCallback!(comment.id, comment.from, comment.to);
		});
		actions.appendChild(resolveBtn);
	}

	if (globalDeleteCallback) {
		const del = doc.createElement('button');
		del.className = 'git-sync-comment-popup-delete';
		del.textContent = '🗑 Borrar';
		del.addEventListener('click', (e) => {
			e.stopPropagation();
			closePopup();
			globalDeleteCallback!(comment.id, comment.from, comment.to);
		});
		actions.appendChild(del);
	}

	if (actions.children.length) popup.appendChild(actions);

	const rect = anchor.getBoundingClientRect();
	popup.style.position = 'fixed';
	popup.style.top = `${rect.bottom + 6}px`;
	popup.style.left = `${rect.left}px`;
	doc.body.appendChild(popup);

	// Clamp to viewport
	const pr = popup.getBoundingClientRect();
	if (pr.right > doc.documentElement.clientWidth - 8) {
		popup.style.left = `${doc.documentElement.clientWidth - pr.width - 8}px`;
	}

	const dismiss = (ev: MouseEvent) => {
		if (!popup.contains(ev.target as Node)) {
			closePopup();
		}
	};
	// closePopup removes both the DOM node and the listener; action buttons also
	// call closePopup so the listener is never left orphaned on the document.
	function closePopup(): void {
		popup.remove();
		doc.removeEventListener('click', dismiss);
	}
	(doc.defaultView ?? window).setTimeout(() => doc.addEventListener('click', dismiss), 10);
}

// ── ViewPlugin ──────────────────────────────────────────────────

class CommentViewPlugin {
	decorations: DecorationSet;
	private cachedDoc = '';
	private cachedComments: ParsedComment[] = [];

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.build(update.view);
		}
	}

	private build(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		const doc = view.state.doc.toString();
		// Skip regex scan when document unchanged — avoids O(N) parse on every viewport scroll
		if (doc !== this.cachedDoc) {
			this.cachedDoc = doc;
			this.cachedComments = parseComments(doc);
		}
		const comments = this.cachedComments;

		let lastTo = -1;
		for (const c of comments) {
			if (c.from >= doc.length || c.to > doc.length) continue;
			// RangeSetBuilder requires strictly ascending non-overlapping ranges.
			// Skip any comment whose range overlaps the previous one.
			if (c.from <= lastTo) continue;

			// Opening tag ends at first '-->' after c.from
			const openTagEnd = doc.indexOf('-->', c.from);
			// Closing tag starts at last '<!--' before c.to
			const closeTagStart = doc.lastIndexOf('<!--', c.to - 1);
			const valid = openTagEnd !== -1 && closeTagStart > openTagEnd
				&& openTagEnd + 3 <= closeTagStart && closeTagStart < c.to;

			if (valid) {
				builder.add(c.from, openTagEnd + 3, Decoration.replace({ widget: new CommentBadgeWidget(c) }));
				const hlClass = c.status === 'resolved'
					? 'git-sync-comment-highlight git-sync-comment-highlight-resolved'
					: `git-sync-comment-highlight git-sync-comment-highlight-${c.priority}`;
				builder.add(openTagEnd + 3, closeTagStart, Decoration.mark({ class: hlClass }));
				builder.add(closeTagStart, c.to, Decoration.replace({}));
			} else {
				builder.add(c.from, c.to, Decoration.replace({ widget: new CommentBadgeWidget(c) }));
			}
			lastTo = c.to;
		}
		return builder.finish();
	}
}

export const commentDecorations = ViewPlugin.fromClass(CommentViewPlugin, {
	decorations: v => v.decorations,
});
