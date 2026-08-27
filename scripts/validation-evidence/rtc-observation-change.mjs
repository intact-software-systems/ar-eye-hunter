import { execFileSync } from 'node:child_process';

const indexPath = 'performance-observations/rtc-b05/index.jsonl';
const observationRoot = 'performance-observations/';
const archivePathPattern =
    /^performance-observations\/rtc-b05\/(\d{4})\/(\d{2})\/(\d{2})\/\d{8}T\d{6}Z-[0-9a-f]{12}-e2-browser-gh[1-9]\d*-a[1-9]\d*\.zip$/u;

export function inspectRtcObservationChange({ repoRoot, base, head }) {
    const changes = readNameStatus(repoRoot, base, head);
    if (!changes.ok) {
        return rejected(changes.reason, true);
    }
    const observationTouched = changes.value.some(({ path }) => path.startsWith(observationRoot));
    if (changes.value.length !== 2) {
        return rejected('rtc-observation-change-count', observationTouched);
    }
    const archive = changes.value.find(({ path }) => path.endsWith('.zip'));
    const index = changes.value.find(({ path }) => path === indexPath);
    if (
        archive?.status !== 'A' ||
        index === undefined ||
        !['A', 'M'].includes(index.status) ||
        !canonicalArchivePath(archive.path)
    ) {
        return rejected('rtc-observation-change-shape', observationTouched);
    }
    const oldIndex = readRevisionFile(repoRoot, base, indexPath);
    const newIndex = readRevisionFile(repoRoot, head, indexPath);
    if (
        newIndex === null ||
        (oldIndex === null) !== (index.status === 'A') ||
        (oldIndex !== null && index.status !== 'M')
    ) {
        return rejected('rtc-observation-index-status', observationTouched);
    }
    const appended = readAppendedIndexEntry(oldIndex ?? '', newIndex);
    if (!appended.ok || appended.value.archive?.path !== archive.path) {
        return rejected(
            appended.ok ? 'rtc-observation-index-archive-mismatch' : appended.reason,
            observationTouched
        );
    }
    return {
        observationOnly: true,
        observationTouched: true,
        reason: 'rtc-observation-only',
        archivePath: archive.path,
        indexEntry: appended.value
    };
}

function readNameStatus(repoRoot, base, head) {
    try {
        const output = execFileSync(
            'git',
            ['diff', '--name-status', '-z', '--no-renames', base, head, '--'],
            { cwd: repoRoot }
        );
        const source = output.toString('utf8');
        if (!source.endsWith('\0')) {
            return { ok: false, reason: 'rtc-observation-malformed-name-status' };
        }
        const tokens = source.slice(0, -1).split('\0');
        if (tokens.length % 2 !== 0) {
            return { ok: false, reason: 'rtc-observation-malformed-name-status' };
        }
        const changes = [];
        for (let index = 0; index < tokens.length; index += 2) {
            const status = tokens[index];
            const path = tokens[index + 1];
            if (!/^[ACDMRTUXB][0-9]*$/u.test(status) || path === '') {
                return { ok: false, reason: 'rtc-observation-malformed-name-status' };
            }
            changes.push({ status: status[0], path });
        }
        return { ok: true, value: changes };
    }
    catch {
        return { ok: false, reason: 'rtc-observation-diff-failed' };
    }
}

function readRevisionFile(repoRoot, revision, path) {
    try {
        return execFileSync('git', ['show', `${revision}:${path}`], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
    }
    catch {
        return null;
    }
}

function readAppendedIndexEntry(oldIndex, newIndex) {
    if (
        (oldIndex !== '' && !oldIndex.endsWith('\n')) ||
        !newIndex.startsWith(oldIndex) ||
        !newIndex.endsWith('\n')
    ) {
        return { ok: false, reason: 'rtc-observation-index-not-append-only' };
    }
    const appended = newIndex.slice(oldIndex.length);
    if (appended.length <= 1 || appended.slice(0, -1).includes('\n')) {
        return { ok: false, reason: 'rtc-observation-index-row-count' };
    }
    const line = appended.slice(0, -1);
    try {
        const value = JSON.parse(line);
        return JSON.stringify(value) === line && isRecord(value) && isRecord(value.archive)
            ? { ok: true, value }
            : { ok: false, reason: 'rtc-observation-index-row-not-canonical' };
    }
    catch {
        return { ok: false, reason: 'rtc-observation-index-row-not-json' };
    }
}

function canonicalArchivePath(value) {
    const match = archivePathPattern.exec(value);
    if (match === null) {
        return false;
    }
    const isoDate = `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
    const timestamp = Date.parse(isoDate);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === isoDate;
}

function rejected(reason, observationTouched) {
    return { observationOnly: false, observationTouched, reason };
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
