import { execFileSync } from 'node:child_process';

const observationRoot = 'performance-observations/';
const archivePathPattern =
    /^performance-observations\/(rtc-b05|rtc-b06)\/(\d{4})\/(\d{2})\/(\d{2})\/\d{8}T\d{6}Z-[0-9a-f]{12}-(e2-browser|e3-memory)-gh[1-9]\d*-a[1-9]\d*\.zip$/u;
const streamConfiguration = {
    'rtc-b05': {
        environment: 'e2-browser',
        indexPath: 'performance-observations/rtc-b05/index.jsonl'
    },
    'rtc-b06': {
        environment: 'e3-memory',
        indexPath: 'performance-observations/rtc-b06/index.jsonl'
    }
};

export function inspectRtcObservationChange({ repoRoot, base, head }) {
    const changes = readNameStatus(repoRoot, base, head);
    if (!changes.ok) {
        return rejected(changes.reason, true);
    }
    const observationTouched = changes.value.some(({ path }) => path.startsWith(observationRoot));
    if (changes.value.length < 2) {
        return rejected('rtc-observation-change-count', observationTouched);
    }
    const archives = changes.value.filter(({ path }) => path.endsWith('.zip'));
    if (archives.length !== changes.value.length - 1) {
        return rejected('rtc-observation-change-shape', observationTouched);
    }
    const streams = new Set(archives.map(({ path }) => canonicalArchiveStream(path)));
    const stream = streams.size === 1 ? [...streams][0] : null;
    const indexPath = stream === null ? null : streamConfiguration[stream].indexPath;
    const index = changes.value.find(({ path }) => path === indexPath);
    if (
        archives.length === 0 ||
        archives.some(({ status }) => status !== 'A') ||
        indexPath === null ||
        index === undefined ||
        !['A', 'M'].includes(index.status) ||
        stream === null
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
    const appended = readAppendedIndexEntries(oldIndex ?? '', newIndex);
    if (!appended.ok) {
        return rejected(appended.reason, observationTouched);
    }
    const archivePaths = archives.map(({ path }) => path).sort();
    const indexedArchivePaths = appended.value
        .map(({ archive }) => archive.path)
        .sort();
    if (
        indexedArchivePaths.some((path) => typeof path !== 'string') ||
        new Set(indexedArchivePaths).size !== indexedArchivePaths.length ||
        JSON.stringify(indexedArchivePaths) !== JSON.stringify(archivePaths)
    ) {
        return rejected(
            'rtc-observation-index-archive-mismatch',
            observationTouched
        );
    }
    return {
        observationOnly: true,
        observationTouched: true,
        reason: 'rtc-observation-only',
        archivePaths,
        indexPath,
        indexEntries: appended.value
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

function readAppendedIndexEntries(oldIndex, newIndex) {
    if (
        (oldIndex !== '' && !oldIndex.endsWith('\n')) ||
        !newIndex.startsWith(oldIndex) ||
        !newIndex.endsWith('\n')
    ) {
        return { ok: false, reason: 'rtc-observation-index-not-append-only' };
    }
    const appended = newIndex.slice(oldIndex.length);
    if (appended.length <= 1) {
        return { ok: false, reason: 'rtc-observation-index-row-count' };
    }
    const entries = [];
    for (const line of appended.slice(0, -1).split('\n')) {
        try {
            const value = JSON.parse(line);
            if (JSON.stringify(value) !== line || !isRecord(value) || !isRecord(value.archive)) {
                return { ok: false, reason: 'rtc-observation-index-row-not-canonical' };
            }
            entries.push(value);
        }
        catch {
            return { ok: false, reason: 'rtc-observation-index-row-not-json' };
        }
    }
    return { ok: true, value: entries };
}

function canonicalArchiveStream(value) {
    const match = archivePathPattern.exec(value);
    if (match === null) {
        return null;
    }
    const stream = match[1];
    const configuration = streamConfiguration[stream];
    if (configuration === undefined || configuration.environment !== match[5]) {
        return null;
    }
    const isoDate = `${match[2]}-${match[3]}-${match[4]}T00:00:00.000Z`;
    const timestamp = Date.parse(isoDate);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === isoDate
        ? stream
        : null;
}

function rejected(reason, observationTouched) {
    return { observationOnly: false, observationTouched, reason };
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
