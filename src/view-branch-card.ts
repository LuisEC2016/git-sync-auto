import type { RepoStatusSnapshot } from './repo-status';
import type GitSyncAutoPlugin from './main';
import { t } from './i18n';

export function renderBranchCard(
	root: HTMLElement,
	snapshot: RepoStatusSnapshot,
	plugin: GitSyncAutoPlugin,
	onRender: () => void,
): void {
	const lang = plugin.settings.language;
	const tr = (key: Parameters<typeof t>[0]) => t(key, lang);

	const card = root.createDiv({ cls: 'git-sync-card' });

	const row = card.createDiv({ cls: 'git-sync-branch-row' });
	const branchBtn = row.createDiv({ cls: 'git-sync-branch-btn' });
	const iconWrap = branchBtn.createDiv({ cls: 'git-sync-branch-icon' });
	appendBranchSvg(iconWrap);
	branchBtn.createSpan({ text: snapshot.branch, cls: 'git-sync-branch-name' });
	branchBtn.createSpan({ text: '⌄', cls: 'git-sync-branch-chevron' });
	branchBtn.setAttr('title', tr('branch.switchTitle'));
	branchBtn.onClickEvent(() => void plugin.openBranchSwitcher().then(onRender));

	const pills = row.createDiv({ cls: 'git-sync-pills' });
	addPill(pills, `↑ ${snapshot.ahead} ${tr('branch.ahead')}`, 'pill-ahead', snapshot.ahead > 0);
	addPill(pills, `↓ ${snapshot.behind} ${tr('branch.behind')}`, 'pill-behind', snapshot.behind > 0);
	if (snapshot.ahead === 0 && snapshot.behind === 0) addPill(pills, tr('branch.upToDate'), 'pill-ok', true);
	addPill(pills, `${snapshot.changed.length} ${tr('branch.changed')}`, 'pill-changed', snapshot.changed.length > 0);

	if (snapshot.conflicted.length > 0) {
		const count = snapshot.conflicted.length;
		const label = count === 1 ? tr('branch.conflict') : tr('branch.conflicts');
		const cr = card.createDiv({ cls: 'git-sync-conflict-banner' });
		cr.createSpan({ text: `⚠ ${count}${label}` });
		const btn = cr.createEl('button', { text: tr('branch.resolve'), cls: 'git-sync-btn-danger' });
		btn.onClickEvent(() => plugin.openConflictModal([...snapshot.conflicted]));
	}
}

function addPill(container: HTMLElement, text: string, cls: string, show: boolean): void {
	if (!show) return;
	container.createDiv({ text, cls: `git-sync-pill ${cls}` });
}

function appendBranchSvg(container: HTMLElement): void {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttributeNS(null, 'viewBox', '0 0 24 24');
	// git-branch icon (Feather)
	const line1 = document.createElementNS(NS, 'line');
	line1.setAttributeNS(null, 'x1', '6'); line1.setAttributeNS(null, 'y1', '3');
	line1.setAttributeNS(null, 'x2', '6'); line1.setAttributeNS(null, 'y2', '15');
	const circle1 = document.createElementNS(NS, 'circle');
	circle1.setAttributeNS(null, 'cx', '18'); circle1.setAttributeNS(null, 'cy', '6'); circle1.setAttributeNS(null, 'r', '3');
	const circle2 = document.createElementNS(NS, 'circle');
	circle2.setAttributeNS(null, 'cx', '6'); circle2.setAttributeNS(null, 'cy', '18'); circle2.setAttributeNS(null, 'r', '3');
	const path = document.createElementNS(NS, 'path');
	path.setAttributeNS(null, 'd', 'M18 9a9 9 0 0 1-9 9');
	svg.appendChild(line1);
	svg.appendChild(circle1);
	svg.appendChild(circle2);
	svg.appendChild(path);
	container.appendChild(svg);
}
