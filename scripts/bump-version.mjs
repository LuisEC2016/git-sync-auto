import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

// Sync manifest.json version
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n', 'utf8');

// Add entry to versions.json only if not already present
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n', 'utf8');
}
