import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { toOrderedSendArtifact } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/artifact/to-ordered-send-artifact.ts';
import {
    resolveOrderedSendArtifactPath,
    writeOrderedSendArtifact
} from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/artifact/write-ordered-send-artifact.ts';

const RUN = {
    createdAt: '2026-11-26T19:24:04.123Z',
    shape: {
        publishers: 5,
        sendsPerSecond: 2,
        durationS: 20,
        delayMs: 5,
        senderRecovery: 'client-stand-in',
        applicationPoolMaxConnections: 10
    }
} as const;

/** The artifact of a run of that shape that offered nothing. */
const ARTIFACT = toOrderedSendArtifact({
    ...RUN,
    source: { commit: 'abc1234def5678900000000000000000000000ff', dirty: false },
    environment: {
        host: { cpuModel: 'Test CPU', cpuCount: 4, totalMemoryBytes: 16_000_000_000 },
        os: { platform: 'linux', release: '6.18.0', architecture: 'x64' },
        bunVersion: '1.3.0',
        postgresServerVersion: '16.4'
    },
    loadAverage: { atStart: [0.5, 0.6, 0.7], atEnd: [1.5, 0.9, 0.8] },
    observationTailMs: 75_000,
    wallMs: 95_000,
    run: {
        observations: {
            sends: [],
            resends: [],
            acks: [],
            arrivals: [],
            handOffs: [],
            receipts: [],
            controls: [],
            unclassifiedControls: [],
            sendEnds: [],
            declinedRepairs: [],
            observationEndedAtMs: 0
        },
        runtime: {
            sendWindow: {
                wallMs: 0,
                loopLag: { ticks: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, shareOfTicksOverOneMsLate: null },
                cpu: { userMs: 0, systemMs: 0, coresBusy: null }
            },
            applicationPoolMaxConnections: 10
        }
    }
});

describe('resolveOrderedSendArtifactPath', () => {
    it('names a run\'s file after its start and every field of its shape, under tmp/perf', () => {
        expect(resolveOrderedSendArtifactPath({ kind: 'named-by-run' }, RUN)).toBe(
            'tmp/perf/alm-ordered-send/2026-11-26T19-24-04-123Z-p5-2hz-d5ms-20s-client-stand-in-pool10.json'
        );
    });

    it('takes the file the invocation named as it is', () => {
        expect(resolveOrderedSendArtifactPath({ kind: 'file', path: '/var/tmp/runs/one.json' }, RUN))
            .toBe('/var/tmp/runs/one.json');
    });
});

describe('writeOrderedSendArtifact', () => {
    it('creates the folders of its path and writes the artifact there as JSON', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'ordered-send-artifact-'));
        onTestFinished(async () => await rm(folder, { recursive: true }));
        const path = join(folder, 'runs', 'reference', 'one.json');

        await writeOrderedSendArtifact(ARTIFACT, path);

        const written = JSON.parse(await readFile(path, 'utf8'));
        expect(written).toEqual(JSON.parse(JSON.stringify(ARTIFACT)));
        expect(written).toMatchObject({
            schema: 'rallar.alm.ordered-send-cell.v1',
            createdAt: '2026-11-26T19:24:04.123Z',
            shape: { publishers: 5, delayMs: 5, senderRecovery: 'client-stand-in', applicationPoolMaxConnections: 10 }
        });
    });
});
