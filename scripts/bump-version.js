#!/usr/bin/env node
/*
 * Development versioning.
 *
 *   node scripts/bump-version.js patch|minor|major   next development version
 *   node scripts/bump-version.js release             turn the development version into a release
 *
 * Development versions are `<next release>-devel.<n>`:
 *   0.4.0         + minor -> 0.5.0-devel.1
 *   0.5.0-devel.1 + patch -> 0.5.0-devel.2   (the upcoming release already covers it)
 *   0.4.1-devel.3 + minor -> 0.5.0-devel.1   (a bigger change raises the upcoming release)
 *   0.5.0-devel.2 release -> 0.5.0
 *
 * Updates package.json, package-lock.json and the CHANGELOG.md heading of the
 * upcoming release (`## 0.5.0 (in development)`, renamed to `## 0.5.0` on release).
 * Prints the new version. Tagging is done separately after committing.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const level = process.argv[2];
if (!['patch', 'minor', 'major', 'release'].includes(level)) {
    console.error('usage: bump-version.js patch|minor|major|release');
    process.exit(2);
}

const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const m = /^(\d+)\.(\d+)\.(\d+)(?:-devel\.(\d+))?$/.exec(pkg.version);
if (!m) {
    console.error(`unsupported version in package.json: ${pkg.version}`);
    process.exit(1);
}
const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
const devel = m[4] === undefined ? undefined : Number(m[4]);
const base = `${major}.${minor}.${patch}`;

let next;
if (level === 'release') {
    if (devel === undefined) {
        console.error(`${pkg.version} is not a development version`);
        process.exit(1);
    }
    next = base;
} else if (devel === undefined) {
    // last version was a release: start the next one
    next =
        level === 'major' ? `${major + 1}.0.0` : level === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
    next += '-devel.1';
} else {
    // already developing `base`: raise it if the change needs a bigger step
    let target = base;
    if (level === 'major' && (minor !== 0 || patch !== 0)) {
        target = `${major + 1}.0.0`;
    } else if (level === 'minor' && patch !== 0) {
        target = `${major}.${minor + 1}.0`;
    }
    next = target === base ? `${base}-devel.${devel + 1}` : `${target}-devel.1`;
}

// package.json and package-lock.json
pkg.version = next;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
const lockFile = path.join(root, 'package-lock.json');
if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.version = next;
    if (lock.packages && lock.packages['']) {
        lock.packages[''].version = next;
    }
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}

// CHANGELOG.md: one heading for the upcoming release
const logFile = path.join(root, 'CHANGELOG.md');
const nextBase = next.replace(/-devel\.\d+$/, '');
let log = fs.readFileSync(logFile, 'utf8');
const dev = /^## (\d+\.\d+\.\d+) \(in development\)$/m;
const found = dev.exec(log);
if (level === 'release') {
    log = found ? log.replace(dev, `## ${nextBase}`) : log;
} else if (found) {
    log = log.replace(dev, `## ${nextBase} (in development)`);
} else {
    log = log.replace(/^# Changelog\n/, `# Changelog\n\n## ${nextBase} (in development)\n`);
}
fs.writeFileSync(logFile, log);

console.log(next);
