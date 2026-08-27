import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import type { RtcBaselineJson, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import { isRtcBaselineConfinedArtifactPath } from '../contracts/rtc-baseline-validation.ts';
import { validateRtcPerformanceObservationEvidence } from './rtc-performance-observation-evidence.ts';
import type {
    RtcPerformanceObservation,
    RtcPerformanceObservationIndexEntryDto
} from './rtc-performance-observation.ts';
import {
    decodeRtcPerformanceObservationIndexEntry,
    toRtcPerformanceObservationArchivePath
} from './rtc-performance-observation.ts';

const MAX_ARCHIVE_BYTE_LENGTH = 90 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_COUNT = 10_000;
const MAX_ARCHIVE_EXPANDED_BYTE_LENGTH = 256 * 1024 * 1024;

class RtcPerformanceObservationArchiveResourceError extends Error {}

export interface CreateRtcPerformanceObservationArchiveInput {
    readonly observation: RtcPerformanceObservation;
    readonly primaryArtifacts: ReadonlyMap<string, Uint8Array>;
    readonly repeatArtifacts?: ReadonlyMap<string, Uint8Array>;
}

export interface RtcPerformanceObservationArchiveWritten {
    readonly bytes: Uint8Array;
    readonly indexEntry: RtcPerformanceObservationIndexEntryDto;
}

export interface VerifyRtcPerformanceObservationArchiveInput {
    readonly bytes: Uint8Array;
    readonly indexEntry: RtcBaselineJson | RtcPerformanceObservationIndexEntryDto;
}

interface VerifiedRtcPerformanceObservationArchiveInput {
    readonly bytes: Uint8Array;
    readonly indexEntry: RtcPerformanceObservationIndexEntryDto;
}

interface AppendRtcPerformanceObservationArtifactsInput {
    readonly entries: Map<string, Uint8Array>;
    readonly role: 'primary' | 'repeat';
    readonly baselineId: string;
    readonly artifacts: ReadonlyMap<string, Uint8Array>;
}

export async function createRtcPerformanceObservationArchive(
    archive: CreateRtcPerformanceObservationArchiveInput
): Promise<RtcPerformanceObservationArchiveWritten> {
    assertRtcPerformanceObservationArchiveInput(archive);
    const contentEntries = toArchiveContentEntries(archive);
    assertRtcPerformanceObservationArchiveCreationBudget(contentEntries);
    contentEntries.set('checksums.sha256', strToU8(await toChecksumFile(contentEntries)));
    const entries = Object.fromEntries([...contentEntries].sort(([left], [right]) => left.localeCompare(right)));
    const bytes = zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1) });
    if (bytes.byteLength > MAX_ARCHIVE_BYTE_LENGTH) {
        throw new Error('observation archive exceeds its creation resource budget');
    }
    return {
        bytes,
        indexEntry: {
            schema: 'rallar.rtc-performance-observation.index-entry.v1',
            observation: archive.observation,
            archive: {
                path: toRtcPerformanceObservationArchivePath(archive.observation),
                byteLength: bytes.byteLength,
                sha256: await sha256(bytes)
            }
        }
    };
}

export async function verifyRtcPerformanceObservationArchive(
    archive: VerifyRtcPerformanceObservationArchiveInput
): Promise<RtcBaselineResult<RtcPerformanceObservation>> {
    const decodedIndexEntry = decodeRtcPerformanceObservationIndexEntry(archive.indexEntry);
    if (!decodedIndexEntry.ok) {
        return decodedIndexEntry;
    }
    const verifiedArchive: VerifiedRtcPerformanceObservationArchiveInput = {
        ...archive,
        indexEntry: decodedIndexEntry.value
    };
    const issues = await validateRtcPerformanceObservationArchiveIndex(verifiedArchive);
    const entries = readArchiveEntries(archive.bytes);
    if (!entries.ok) {
        return entries;
    }
    issues.push(
        ...await validateRtcPerformanceObservationArchiveEntries(
            entries.value,
            verifiedArchive.indexEntry.observation
        ),
        ...await validateRtcPerformanceObservationEvidence({
            entries: entries.value,
            observation: verifiedArchive.indexEntry.observation,
            sha256
        })
    );
    return issues.length > 0
        ? { ok: false, issues }
        : { ok: true, value: verifiedArchive.indexEntry.observation };
}

function assertRtcPerformanceObservationArchiveInput(
    archive: CreateRtcPerformanceObservationArchiveInput
) {
    if (archive.primaryArtifacts.size === 0) {
        throw new Error('primary evidence must not be empty');
    }
    assertRtcPerformanceObservationArtifactPaths(
        archive.observation.observationId,
        archive.primaryArtifacts
    );
    const repeatExpected = archive.observation.repeat.decision === 'required';
    if (repeatExpected !== (archive.repeatArtifacts !== undefined)) {
        throw new Error('repeat evidence contradicts the repeat decision');
    }
    if (archive.repeatArtifacts !== undefined) {
        if (archive.repeatArtifacts.size === 0) {
            throw new Error('repeat evidence must not be empty');
        }
        assertRtcPerformanceObservationArtifactPaths(
            `${archive.observation.observationId}-repeat-01`,
            archive.repeatArtifacts
        );
    }
}

function assertRtcPerformanceObservationArtifactPaths(
    baselineId: string,
    artifacts: ReadonlyMap<string, Uint8Array>
) {
    if ([...artifacts.keys()].some((path) => !isRtcBaselineConfinedArtifactPath(baselineId, path))) {
        throw new Error('artifact paths must be confined');
    }
}

function toArchiveContentEntries(archive: CreateRtcPerformanceObservationArchiveInput) {
    const entries = new Map<string, Uint8Array>([
        ['observation.json', strToU8(`${JSON.stringify(archive.observation, null, 2)}\n`)]
    ]);
    appendArtifacts({
        entries,
        role: 'primary',
        baselineId: archive.observation.observationId,
        artifacts: archive.primaryArtifacts
    });
    if (archive.repeatArtifacts !== undefined) {
        appendArtifacts({
            entries,
            role: 'repeat',
            baselineId: `${archive.observation.observationId}-repeat-01`,
            artifacts: archive.repeatArtifacts
        });
    }
    return entries;
}

async function validateRtcPerformanceObservationArchiveIndex(
    archive: VerifiedRtcPerformanceObservationArchiveInput
) {
    return [
        ...(archive.indexEntry.archive.byteLength !== archive.bytes.byteLength
            ? [issue(
                '$.archive.byteLength',
                'archive-length-mismatch',
                'Archive byte length does not match its index entry.'
            )]
            : []),
        ...(archive.indexEntry.archive.sha256 !== await sha256(archive.bytes)
            ? [issue('$.archive.sha256', 'archive-sha256-mismatch', 'Archive SHA-256 does not match its index entry.')]
            : []),
        ...(archive.indexEntry.archive.path !==
                toRtcPerformanceObservationArchivePath(archive.indexEntry.observation)
            ? [issue(
                '$.archive.path',
                'archive-path-mismatch',
                'Archive path does not match its observation identity and date.'
            )]
            : [])
    ];
}

async function validateRtcPerformanceObservationArchiveEntries(
    entries: Record<string, Uint8Array>,
    observation: RtcPerformanceObservation
) {
    const contentEntries = new Map(
        Object.entries(entries).filter(([path]) => path !== 'checksums.sha256')
    );
    const checksumBytes = entries['checksums.sha256'];
    const expectedObservation = `${JSON.stringify(observation, null, 2)}\n`;
    const observationMatches = entries['observation.json'] !== undefined &&
        strFromU8(entries['observation.json']) === expectedObservation;
    return [
        ...(!observationMatches
            ? [issue(
                '$.observation',
                'archive-observation-mismatch',
                'Archived observation does not match its canonical index entry.'
            )]
            : []),
        ...validateRtcPerformanceObservationEntryPaths(contentEntries, observation),
        ...(checksumBytes === undefined ||
                strFromU8(checksumBytes) !== await toChecksumFile(contentEntries)
            ? [
                issue(
                    '$.checksums',
                    'archive-checksum-mismatch',
                    'Archive checksums do not exactly cover its content entries.'
                )
            ]
            : [])
    ];
}

function validateRtcPerformanceObservationEntryPaths(
    entries: ReadonlyMap<string, Uint8Array>,
    observation: RtcPerformanceObservation
) {
    const primaryPrefix = `primary/${observation.observationId}/`;
    const repeatId = `${observation.observationId}-repeat-01`;
    const repeatPrefix = `repeat/${repeatId}/`;
    const paths = [...entries.keys()].filter((path) => path !== 'observation.json');
    const unexpected = paths.filter((path) => {
        if (path.startsWith(primaryPrefix)) {
            return !isRtcBaselineConfinedArtifactPath(
                observation.observationId,
                path.slice(primaryPrefix.length)
            );
        }
        if (observation.repeat.decision === 'required' && path.startsWith(repeatPrefix)) {
            return !isRtcBaselineConfinedArtifactPath(repeatId, path.slice(repeatPrefix.length));
        }
        return true;
    });
    return unexpected.length === 0
        ? []
        : [issue(
            '$.entries',
            'unexpected-archive-entry',
            'Archive contains an entry outside its observation evidence paths.'
        )];
}

function appendArtifacts(input: AppendRtcPerformanceObservationArtifactsInput) {
    for (
        const [relativePath, bytes] of [...input.artifacts].sort(
            ([left], [right]) => left.localeCompare(right)
        )
    ) {
        input.entries.set(`${input.role}/${input.baselineId}/${relativePath}`, bytes);
    }
}

function assertRtcPerformanceObservationArchiveCreationBudget(
    contentEntries: ReadonlyMap<string, Uint8Array>
) {
    const entryCount = contentEntries.size + 1;
    const contentByteLength = [...contentEntries.values()].reduce(
        (total, bytes) => total + bytes.byteLength,
        0
    );
    const checksumByteLength = [...contentEntries.keys()].reduce(
        (total, path) => total + 67 + strToU8(path).byteLength,
        0
    );
    if (
        entryCount > MAX_ARCHIVE_ENTRY_COUNT ||
        contentByteLength + checksumByteLength > MAX_ARCHIVE_EXPANDED_BYTE_LENGTH
    ) {
        throw new Error('observation archive exceeds its creation resource budget');
    }
}

async function toChecksumFile(entries: ReadonlyMap<string, Uint8Array>) {
    const lines = await Promise.all(
        [...entries].sort(([left], [right]) => left.localeCompare(right)).map(
            async ([path, bytes]) => `${await sha256(bytes)}  ${path}`
        )
    );
    return `${lines.join('\n')}\n`;
}

function readArchiveEntries(bytes: Uint8Array): RtcBaselineResult<Record<string, Uint8Array>> {
    if (bytes.byteLength > MAX_ARCHIVE_BYTE_LENGTH) {
        return archiveResourceLimit();
    }
    let entryCount = 0;
    let expandedByteLength = 0;
    try {
        return {
            ok: true,
            value: unzipSync(bytes, {
                filter: ({ originalSize }) => {
                    entryCount += 1;
                    expandedByteLength += originalSize;
                    if (
                        entryCount > MAX_ARCHIVE_ENTRY_COUNT ||
                        expandedByteLength > MAX_ARCHIVE_EXPANDED_BYTE_LENGTH
                    ) {
                        throw new RtcPerformanceObservationArchiveResourceError();
                    }
                    return true;
                }
            })
        };
    }
    catch (error) {
        if (error instanceof RtcPerformanceObservationArchiveResourceError) {
            return archiveResourceLimit();
        }
        return {
            ok: false,
            issues: [issue('$.archive', 'invalid-zip', 'Observation archive must be a readable ZIP file.')]
        };
    }
}

function archiveResourceLimit(): RtcBaselineResult<never> {
    return {
        ok: false,
        issues: [
            issue(
                '$.archive',
                'archive-resource-limit',
                'Observation archive exceeds its verification resource budget.'
            )
        ]
    };
}

async function sha256(bytes: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function issue(path: string, code: string, message: string) {
    return { path, code, message };
}
