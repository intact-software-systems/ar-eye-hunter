import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
    createRtcPerformanceObservationArchive,
    verifyRtcPerformanceObservationArchive
} from '../../../baseline/observation/rtc-performance-observation-archive.ts';
import {
    decodeRtcPerformanceObservationIndexEntry,
    type RtcPerformanceObservation,
    type RtcPerformanceObservationIndexEntryDto
} from '../../../baseline/observation/rtc-performance-observation.ts';
import { createRtcB05FinalizedArtifacts } from './rtc-performance-observation-fixture.ts';

const encoder = new TextEncoder();
const observation: RtcPerformanceObservation = {
    schema: 'rallar.rtc-performance-observation.v1',
    observationId: '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2',
    startedAt: '2026-08-27T03:15:00.417Z',
    completedAt: '2026-08-27T03:18:00.417Z',
    source: {
        commit: 'eaf526518c70e3b396dad91c008125a622b38b00',
        tree: '1111111111111111111111111111111111111111',
        ref: 'main'
    },
    workflow: {
        runId: 123456789,
        runAttempt: 2,
        url: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789'
    },
    primary: { outcome: 'passed', acceptedMetrics: true },
    repeat: { decision: 'not-required', outcome: 'not-run' }
};
const primaryArtifacts = await createRtcB05FinalizedArtifacts(observation.observationId, 'passed');
const indexEntry: RtcPerformanceObservationIndexEntryDto = {
    schema: 'rallar.rtc-performance-observation.index-entry.v1',
    observation,
    archive: {
        path: 'performance-observations/rtc-b05/2026/08/27/' +
            '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2.zip',
        byteLength: 123,
        sha256: 'a'.repeat(64)
    }
};

async function toIndexEntry(
    indexEntry: RtcPerformanceObservationIndexEntryDto,
    bytes: Uint8Array
): Promise<RtcPerformanceObservationIndexEntryDto> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
    return {
        ...indexEntry,
        archive: {
            ...indexEntry.archive,
            byteLength: bytes.byteLength,
            sha256: [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
        }
    };
}

async function artifactSha256(artifacts: ReadonlyMap<string, Uint8Array>, path: string) {
    const bytes = artifacts.get(path);
    if (bytes === undefined) {
        throw new Error(`Missing observation fixture artifact ${path}.`);
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function toInternallyChecksummedZip(entries: Record<string, Uint8Array>) {
    const contentEntries = Object.entries(entries)
        .filter(([path]) => path !== 'checksums.sha256')
        .sort(([left], [right]) => left.localeCompare(right));
    const checksumLines = await Promise.all(
        contentEntries.map(async ([path, bytes]) => {
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
            const sha256 = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
            return `${sha256}  ${path}`;
        })
    );
    return zipSync(
        { ...Object.fromEntries(contentEntries), 'checksums.sha256': strToU8(`${checksumLines.join('\n')}\n`) },
        { level: 9, mtime: new Date(1980, 0, 1) }
    );
}

function withUnsafeOriginalSize(bytes: Uint8Array) {
    const changed = Uint8Array.from(bytes);
    for (let index = 0; index <= changed.length - 4; index += 1) {
        if (
            changed[index] === 0x50 &&
            changed[index + 1] === 0x4b &&
            changed[index + 2] === 0x01 &&
            changed[index + 3] === 0x02
        ) {
            new DataView(changed.buffer).setUint32(index + 24, 0xffff_ffff, true);
            return changed;
        }
    }
    throw new Error('Expected one ZIP central-directory entry.');
}

describe('RTC performance observation archive', () => {
    it('decodes one canonical index entry from repository JSON', () => {
        expect(decodeRtcPerformanceObservationIndexEntry(indexEntry)).toEqual({ ok: true, value: indexEntry });
    });

    it('rejects malformed index input before reading the archive', async () => {
        const written = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts });

        await expect(verifyRtcPerformanceObservationArchive({
            bytes: written.bytes,
            indexEntry: { unexpected: true }
        })).resolves.toMatchObject({
            ok: false,
            issues: [expect.objectContaining({ code: 'invalid-index-entry' })]
        });
    });

    it.each<[
        string,
        (entry: RtcPerformanceObservationIndexEntryDto) => RtcPerformanceObservationIndexEntryDto
    ]>([
        [
            'observation-id-mismatch',
            (entry) => ({
                ...entry,
                observation: {
                    ...entry.observation,
                    observationId: entry.observation.observationId.replace('eaf526518c70', 'ffffffffffff')
                }
            })
        ],
        [
            'invalid-observation-interval',
            (entry) => ({
                ...entry,
                observation: { ...entry.observation, completedAt: '2026-08-27T03:14:00.417Z' }
            })
        ],
        [
            'invalid-accepted-metrics',
            (entry) => ({
                ...entry,
                observation: {
                    ...entry.observation,
                    primary: { outcome: 'failed', acceptedMetrics: true }
                }
            })
        ],
        [
            'invalid-repeat-outcome',
            (entry) => ({
                ...entry,
                observation: {
                    ...entry.observation,
                    repeat: { decision: 'required', outcome: 'not-run' }
                }
            })
        ],
        [
            'archive-path-mismatch',
            (entry) => ({
                ...entry,
                archive: { ...entry.archive, path: 'performance-observations/rtc-b05/wrong.zip' }
            })
        ]
    ])('rejects repository index entry with %s', (code, changeIndexEntry) => {
        const result = decodeRtcPerformanceObservationIndexEntry(changeIndexEntry(indexEntry));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
        }
    });

    it('creates deterministic bytes, internal checksums, and one canonical index entry', async () => {
        const first = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts });
        const second = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts });

        expect(first).toEqual(second);
        expect(first.indexEntry.archive.path).toBe(
            'performance-observations/rtc-b05/2026/08/27/' +
                '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2.zip'
        );
        expect(first.indexEntry.archive.byteLength).toBe(first.bytes.byteLength);
        expect(first.indexEntry.archive.sha256).toMatch(/^[0-9a-f]{64}$/);

        const entries = unzipSync(first.bytes);
        expect(Object.keys(entries).sort()).toEqual([
            'checksums.sha256',
            'observation.json',
            `primary/${observation.observationId}/SHA256SUMS`,
            `primary/${observation.observationId}/environment.json`,
            `primary/${observation.observationId}/manifest.json`,
            `primary/${observation.observationId}/results/external-attempts/` +
            'RTC-B05-browser-data-channel-lifecycle-iterations-25-retained-001.json',
            `primary/${observation.observationId}/summary.json`
        ]);
        expect(JSON.parse(strFromU8(entries['observation.json']!))).toEqual(observation);
        expect(strFromU8(entries['checksums.sha256']!)).toMatch(
            /^[0-9a-f]{64}  observation\.json\n[0-9a-f]{64}  primary\//
        );
        expect(
            await verifyRtcPerformanceObservationArchive({
                bytes: first.bytes,
                indexEntry: first.indexEntry
            })
        ).toEqual({ ok: true, value: observation });
    });

    it('accepts structurally complete failed evidence without accepting its metrics', async () => {
        const failedObservation: RtcPerformanceObservation = {
            ...observation,
            primary: { outcome: 'failed', acceptedMetrics: false }
        };
        const failedArtifacts = await createRtcB05FinalizedArtifacts(
            observation.observationId,
            'failed'
        );
        const written = await createRtcPerformanceObservationArchive({
            observation: failedObservation,
            primaryArtifacts: failedArtifacts
        });

        expect(
            await verifyRtcPerformanceObservationArchive({
                bytes: written.bytes,
                indexEntry: written.indexEntry
            })
        ).toEqual({ ok: true, value: failedObservation });
    });

    it('verifies a required controlled repeat and its exact primary link', async () => {
        const repeatObservation: RtcPerformanceObservation = {
            ...observation,
            repeat: { decision: 'required', outcome: 'passed' }
        };
        const repeatId = `${observation.observationId}-repeat-01`;
        const repeatArtifacts = await createRtcB05FinalizedArtifacts(repeatId, 'passed', {
            primaryBaselineId: observation.observationId,
            primarySummarySha256: await artifactSha256(primaryArtifacts, 'summary.json')
        });
        const written = await createRtcPerformanceObservationArchive({
            observation: repeatObservation,
            primaryArtifacts,
            repeatArtifacts
        });

        expect(
            await verifyRtcPerformanceObservationArchive({
                bytes: written.bytes,
                indexEntry: written.indexEntry
            })
        ).toEqual({ ok: true, value: repeatObservation });
    });

    it('rejects a passing declaration over structurally complete failed evidence', async () => {
        const failedArtifacts = await createRtcB05FinalizedArtifacts(
            observation.observationId,
            'failed'
        );
        const written = await createRtcPerformanceObservationArchive({
            observation,
            primaryArtifacts: failedArtifacts
        });

        expect(
            await verifyRtcPerformanceObservationArchive({
                bytes: written.bytes,
                indexEntry: written.indexEntry
            })
        ).toMatchObject({
            ok: false,
            issues: expect.arrayContaining([
                expect.objectContaining({ code: 'archive-evidence-outcome-mismatch' })
            ])
        });
    });

    it.each([
        [new Map<string, Uint8Array>(), undefined, 'primary evidence must not be empty'],
        [
            new Map([['../summary.json', encoder.encode('{}\n')]]),
            undefined,
            'artifact paths must be confined'
        ],
        [primaryArtifacts, primaryArtifacts, 'repeat evidence contradicts the repeat decision']
    ])(
        'rejects unsafe or contradictory evidence before creating an archive',
        async (candidatePrimaryArtifacts, repeatArtifacts, message) => {
            await expect(
                createRtcPerformanceObservationArchive({
                    observation,
                    primaryArtifacts: candidatePrimaryArtifacts,
                    repeatArtifacts
                })
            ).rejects.toThrow(message);
        }
    );

    it.each([
        ['archive-length-mismatch', (entry: RtcPerformanceObservationIndexEntryDto) => ({
            ...entry,
            archive: { ...entry.archive, byteLength: entry.archive.byteLength + 1 }
        })],
        ['archive-sha256-mismatch', (entry: RtcPerformanceObservationIndexEntryDto) => ({
            ...entry,
            archive: { ...entry.archive, sha256: '0'.repeat(64) }
        })],
        ['archive-path-mismatch', (entry: RtcPerformanceObservationIndexEntryDto) => ({
            ...entry,
            archive: { ...entry.archive, path: 'performance-observations/rtc-b05/wrong.zip' }
        })]
    ])('rejects index metadata drift with %s', async (code, changeIndexEntry) => {
        const written = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts });

        const result = await verifyRtcPerformanceObservationArchive({
            bytes: written.bytes,
            indexEntry: changeIndexEntry(written.indexEntry)
        });

        expect(result).toMatchObject({
            ok: false,
            issues: expect.arrayContaining([expect.objectContaining({ code })])
        });
    });

    it('rejects changed evidence even when the outer archive digest is updated', async () => {
        const written = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts });
        const entries = unzipSync(written.bytes);
        const summaryPath = 'primary/20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2/summary.json';
        entries[summaryPath] = strToU8('{"tampered":true}\n');
        const bytes = zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1) });
        const indexEntry = await toIndexEntry(written.indexEntry, bytes);

        const result = await verifyRtcPerformanceObservationArchive({ bytes, indexEntry });

        expect(result).toMatchObject({
            ok: false,
            issues: expect.arrayContaining([
                expect.objectContaining({ code: 'archive-checksum-mismatch' })
            ])
        });
    });

    it('rejects an archive whose declared expansion exceeds the verification budget', async () => {
        const written = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts });
        const bytes = withUnsafeOriginalSize(written.bytes);
        const changedIndexEntry = await toIndexEntry(written.indexEntry, bytes);

        const result = await verifyRtcPerformanceObservationArchive({
            bytes,
            indexEntry: changedIndexEntry
        });

        expect(result).toMatchObject({
            ok: false,
            issues: [expect.objectContaining({ code: 'archive-resource-limit' })]
        });
    });

    it.each([
        [
            'archive-observation-mismatch',
            (entries: Record<string, Uint8Array>) => {
                entries['observation.json'] = strToU8(
                    `${JSON.stringify({ ...observation, completedAt: '2026-08-27T03:19:00.417Z' }, null, 2)}\n`
                );
            }
        ],
        [
            'unexpected-archive-entry',
            (entries: Record<string, Uint8Array>) => {
                entries['notes.txt'] = strToU8('not part of the observation contract\n');
            }
        ]
    ])('rejects a self-consistent archive with %s', async (code, mutateEntries) => {
        const written = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts });
        const entries = unzipSync(written.bytes);
        mutateEntries(entries);
        const bytes = await toInternallyChecksummedZip(entries);
        const indexEntry = await toIndexEntry(written.indexEntry, bytes);

        const result = await verifyRtcPerformanceObservationArchive({ bytes, indexEntry });

        expect(result).toMatchObject({
            ok: false,
            issues: expect.arrayContaining([expect.objectContaining({ code })])
        });
    });
});
