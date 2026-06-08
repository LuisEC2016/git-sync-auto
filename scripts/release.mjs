/**
 * manifest.json is the source of truth for version.
 * Syncs package.json and versions.json, then commits + tags.
 * Usage: npm run release
 */
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { assertSemver } from './semver.mjs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { version, minAppVersion } = manifest;

assertSemver(version, 'manifest.json version');
assertSemver(minAppVersion, 'manifest.json minAppVersion');

// Sync package.json
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version !== version) {
	pkg.version = version;
	writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + '\n', 'utf8');
	console.log(`package.json → ${version}`);
}

// Sync versions.json (only if minAppVersion changed)
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
const lastMin = Object.values(versions).at(-1);
if (lastMin !== minAppVersion) {
	versions[version] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n', 'utf8');
	console.log(`versions.json → added ${version}: ${minAppVersion}`);
}

// Verify no lint/type errors before tagging
execFileSync('npm', ['run', 'lint'], { stdio: 'inherit' });

// Commit and tag
execFileSync('git', ['add', 'manifest.json', 'package.json', 'versions.json'], { stdio: 'inherit' });
try {
	execFileSync('git', ['commit', '-m', version], { stdio: 'inherit' });
} catch {
	// Nothing to commit — already in sync
}
execFileSync('git', ['tag', '-a', version, '-m', version], { stdio: 'inherit' });

console.log(`\nTagged ${version}. Run: git push origin main --follow-tags`);
