// Strict semver MAJOR.MINOR.PATCH validation per https://semver.org/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertSemver(version, label = 'version') {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`${label} "${version}" is not valid semver (expected MAJOR.MINOR.PATCH)`);
	}
}

export function parseSemver(version) {
	const m = SEMVER_RE.exec(version);
	if (!m) throw new Error(`"${version}" is not valid semver`);
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function bumpVersion(version, type) {
	const { major, minor, patch } = parseSemver(version);
	switch (type) {
		case 'major': return `${major + 1}.0.0`;
		case 'minor': return `${major}.${minor + 1}.0`;
		case 'patch': return `${major}.${minor}.${patch + 1}`;
		default: throw new Error(`Unknown bump type "${type}" — use major, minor, or patch`);
	}
}
