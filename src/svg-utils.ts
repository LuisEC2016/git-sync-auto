const NS = 'http://www.w3.org/2000/svg';

export function makeSvg(paths: { tag: string; attrs: Record<string, string> }[], size = 16): SVGSVGElement {
	const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
	svg.setAttributeNS(null, 'viewBox', '0 0 24 24');
	svg.setAttributeNS(null, 'width', String(size));
	svg.setAttributeNS(null, 'height', String(size));
	for (const { tag, attrs } of paths) {
		const el = document.createElementNS(NS, tag);
		for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(null, k, v);
		svg.appendChild(el);
	}
	return svg;
}
