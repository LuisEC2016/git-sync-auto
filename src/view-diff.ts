export interface DiffLine {
	type: 'context' | 'add' | 'del' | 'hunk' | 'meta';
	text: string;
	oldLine: number | null;
	newLine: number | null;
}

export interface SidePair {
	left: DiffLine | null;
	right: DiffLine | null;
	isMeta?: boolean;
	isHunk?: boolean;
	metaText?: string;
}

// ── Unified diff line parser ───────────────────────────────────
export function parseUnified(diff: string): DiffLine[] {
	const lines: DiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;

	for (const raw of diff.split('\n')) {
		if (
			raw.startsWith('diff ') ||
			raw.startsWith('index ') ||
			raw.startsWith('--- ') ||
			raw.startsWith('+++ ')
		) {
			lines.push({ type: 'meta', text: raw, oldLine: null, newLine: null });
			continue;
		}
		if (raw.startsWith('@@')) {
			const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (m) { oldLine = parseInt(m[1]!); newLine = parseInt(m[2]!); }
			lines.push({ type: 'hunk', text: raw, oldLine: null, newLine: null });
			continue;
		}
		if (raw.startsWith('-')) {
			lines.push({ type: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
		} else if (raw.startsWith('+')) {
			lines.push({ type: 'add', text: raw.slice(1), newLine: newLine++, oldLine: null });
		} else if (raw.startsWith('\\')) {
			// "\ No newline at end of file" — skip, not a visible diff line
		} else {
			const t = raw.startsWith(' ') ? raw.slice(1) : raw;
			lines.push({ type: 'context', text: t, oldLine: oldLine++, newLine: newLine++ });
		}
	}
	return lines;
}

// Keep parseSideBySide as alias for callers that use it (splitByFile)
export function parseSideBySide(diff: string): SidePair[] {
	const lines = parseUnified(diff);
	const pairs: SidePair[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (line.type === 'meta') { pairs.push({ left: line, right: line, isMeta: true, metaText: line.text }); i++; continue; }
		if (line.type === 'hunk') { pairs.push({ left: line, right: line, isHunk: true, metaText: line.text }); i++; continue; }
		if (line.type === 'context') { pairs.push({ left: line, right: line }); i++; continue; }
		const dels: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (i < lines.length && lines[i]!.type === 'del') dels.push(lines[i++]!);
		while (i < lines.length && lines[i]!.type === 'add') adds.push(lines[i++]!);
		const max = Math.max(dels.length, adds.length);
		for (let j = 0; j < max; j++) pairs.push({ left: dels[j] ?? null, right: adds[j] ?? null });
	}
	return pairs;
}

export function detectLang(pairs: SidePair[]): string {
	for (const p of pairs) {
		if (p.isMeta && p.metaText) {
			const m = p.metaText.match(/\+\+\+ b\/(.+)/);
			if (m) {
				const ext = m[1]!.split('.').pop()?.toLowerCase() ?? '';
				if (['ts', 'tsx', 'js', 'jsx', 'mjs'].includes(ext)) return 'ts';
				if (['py'].includes(ext)) return 'py';
				if (['java', 'kt'].includes(ext)) return 'java';
				if (['go'].includes(ext)) return 'go';
				if (['css', 'scss'].includes(ext)) return 'css';
				if (['json'].includes(ext)) return 'json';
				if (['sh', 'bash', 'zsh'].includes(ext)) return 'sh';
				if (['xml', 'html'].includes(ext)) return 'xml';
				if (['yaml', 'yml'].includes(ext)) return 'yaml';
			}
		}
	}
	return 'text';
}

// ── Token types ────────────────────────────────────────────────
type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'decorator' | 'type' | 'plain';
interface Token { type: TokenType; text: string; }

const TS_KEYWORDS = new Set([
	'import', 'export', 'from', 'const', 'let', 'var', 'function', 'class',
	'extends', 'implements', 'interface', 'type', 'enum', 'return', 'new',
	'async', 'await', 'if', 'else', 'for', 'while', 'switch', 'case', 'break',
	'continue', 'throw', 'try', 'catch', 'finally', 'void', 'null', 'undefined',
	'true', 'false', 'this', 'super', 'static', 'private', 'public', 'protected',
	'readonly', 'abstract', 'of', 'in', 'instanceof', 'typeof', 'default', 'delete',
]);

function tokenizeTs(line: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === '/' && line[i + 1] === '/') { tokens.push({ type: 'comment', text: line.slice(i) }); break; }
		if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
			const q = line[i]!; let j = i + 1;
			while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
			tokens.push({ type: 'string', text: line.slice(i, ++j) }); i = j; continue;
		}
		if (line[i] === '@') {
			let j = i + 1;
			while (j < line.length && /\w/.test(line[j]!)) j++;
			tokens.push({ type: 'decorator', text: line.slice(i, j) }); i = j; continue;
		}
		if (/\d/.test(line[i]!)) {
			let j = i;
			while (j < line.length && /[\d._xboXBO]/.test(line[j]!)) j++;
			tokens.push({ type: 'number', text: line.slice(i, j) }); i = j; continue;
		}
		if (/[a-zA-Z_$]/.test(line[i]!)) {
			let j = i;
			while (j < line.length && /\w/.test(line[j]!)) j++;
			const word = line.slice(i, j);
			tokens.push({ type: TS_KEYWORDS.has(word) ? 'keyword' : /^[A-Z]/.test(word) ? 'type' : 'plain', text: word });
			i = j; continue;
		}
		const last = tokens[tokens.length - 1];
		if (last?.type === 'plain') last.text += line[i++]!;
		else { tokens.push({ type: 'plain', text: line[i++]! }); }
	}
	return tokens;
}

function tokenize(line: string, lang: string): Token[] {
	if (['ts', 'js', 'java', 'go'].includes(lang)) return tokenizeTs(line);
	return [{ type: 'plain', text: line }];
}

function renderTokens(container: HTMLElement, line: string, lang: string): void {
	for (const tok of tokenize(line, lang)) {
		const span = container.createSpan({ text: tok.text });
		if (tok.type !== 'plain') span.addClass(`git-sync-tok-${tok.type}`);
	}
}

// ── Unified renderer (single column, wrap-aware) ───────────────
function renderDiffTable(container: HTMLElement, pairs: SidePair[], lang: string): void {
	// Convert pairs back to flat lines and render unified
	const lines: DiffLine[] = [];
	for (const p of pairs) {
		if (p.isMeta) { lines.push({ type: 'meta', text: p.metaText ?? '', oldLine: null, newLine: null }); continue; }
		if (p.isHunk) { lines.push({ type: 'hunk', text: p.metaText ?? '', oldLine: null, newLine: null }); continue; }
		if (p.left && p.right && p.left === p.right) { lines.push(p.left); continue; }
		if (p.left) lines.push(p.left);
		if (p.right) lines.push(p.right);
	}
	renderUnified(container, lines, lang);
}

export function renderUnified(container: HTMLElement, lines: DiffLine[], lang: string): void {
	const block = container.createDiv({ cls: 'git-sync-unified-block' });

	for (const line of lines) {
		if (line.type === 'meta') continue; // filename shown in file-header bar

		if (line.type === 'hunk') {
			block.createDiv({ cls: 'git-sync-u-hunk', text: line.text });
			continue;
		}

		const row = block.createDiv({ cls: `git-sync-u-row git-sync-u-${line.type}` });

		// Gutter: line numbers
		const gutter = row.createDiv({ cls: 'git-sync-u-gutter' });
		gutter.createSpan({
			text: line.oldLine !== null ? String(line.oldLine) : '',
			cls: 'git-sync-u-num',
		});
		gutter.createSpan({
			text: line.newLine !== null ? String(line.newLine) : '',
			cls: 'git-sync-u-num',
		});

		// Sign
		const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
		row.createSpan({ text: sign, cls: 'git-sync-u-sign' });

		// Code with syntax highlighting
		const code = row.createDiv({ cls: 'git-sync-u-code' });
		renderTokens(code, line.text, lang);
	}
}

// Legacy flat renderer
export function renderDiffInto(container: HTMLElement, diff: string): void {
	const pairs = parseSideBySide(diff);
	const lang = detectLang(pairs);
	renderDiffTable(container, pairs, lang);
}
