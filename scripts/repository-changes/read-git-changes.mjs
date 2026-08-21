import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';

export function readChangedPaths(repoRoot, base) {
    validateGitRevision(repoRoot, base);
    const changes = parseRawChanges(
        runGit(repoRoot, [
            'diff',
            '--raw',
            '-z',
            '--find-renames',
            '--find-copies',
            '--end-of-options',
            base,
            '--'
        ])
    );
    const knownPaths = new Set(changes.map((change) => change.path));
    const untracked = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const untrackedPath of untracked.split('\0').filter(Boolean)) {
        if (!knownPaths.has(untrackedPath)) {
            changes.push({
                status: 'A',
                oldMode: '000000',
                newMode: readUntrackedGitMode(repoRoot, untrackedPath),
                path: untrackedPath
            });
        }
    }
    return sortChanges(changes);
}

export function readChangedPathsBetweenRevisions(repoRoot, base, head) {
    validateGitRevision(repoRoot, base);
    validateGitRevision(repoRoot, head);
    return sortChanges(
        parseRawChanges(
            runGit(repoRoot, [
                'diff',
                '--raw',
                '-z',
                '--find-renames',
                '--find-copies',
                '--end-of-options',
                base,
                head,
                '--'
            ])
        )
    );
}

export function validateGitRevision(repoRoot, revision) {
    if (typeof revision !== 'string' || revision === '') {
        throw new Error('Git base must be a non-empty revision');
    }
    if (revision.startsWith('-')) {
        throw new Error('Git base must not begin with an option prefix');
    }
    if (/[\0\r\n]/u.test(revision)) {
        throw new Error('Git base contains forbidden control characters');
    }
    try {
        runGit(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
    }
    catch {
        throw new Error(`Git base is not a valid commit: ${revision}`);
    }
}

function parseRawChanges(output) {
    const tokens = output.split('\0').filter(Boolean);
    const changes = [];
    for (let index = 0; index < tokens.length;) {
        const metadata = parseRawMetadata(tokens[index++]);
        if (metadata.status.startsWith('R') || metadata.status.startsWith('C')) {
            changes.push({ ...metadata, oldPath: tokens[index++], path: tokens[index++] });
        }
        else {
            changes.push({ ...metadata, path: tokens[index++] });
        }
    }
    return changes;
}

function parseRawMetadata(value) {
    const match = value.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z]\d*)$/u);
    if (!match) {
        throw new Error('Git returned malformed raw diff metadata');
    }
    return { oldMode: match[1], newMode: match[2], status: match[3] };
}

function readUntrackedGitMode(repoRoot, relativePath) {
    const stat = lstatSync(path.join(repoRoot, relativePath));
    if (stat.isSymbolicLink()) {
        return '120000';
    }
    return stat.mode & 0o111 ? '100755' : '100644';
}

function runGit(repoRoot, args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function sortChanges(changes) {
    return changes.sort((left, right) => left.path.localeCompare(right.path));
}
