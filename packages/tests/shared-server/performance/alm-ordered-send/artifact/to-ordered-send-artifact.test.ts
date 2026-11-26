import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    toOrderedSendArtifact,
    type ToOrderedSendArtifactInput
} from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/artifact/to-ordered-send-artifact.ts';

const API_V1_DEFAULTS = JSON.parse(
    readFileSync(
        new URL('../../../../../../apps/api-v1/resources/configuration/defaults-config.json', import.meta.url),
        'utf8'
    )
);

const SEND_WINDOW = {
    wallMs: 500,
    loopLag: { ticks: 50, p50Ms: 0.1, p95Ms: 0.4, p99Ms: 0.9, maxMs: 1.5, shareOfTicksOverOneMsLate: 0.02 },
    cpu: { userMs: 200, systemMs: 50, coresBusy: 0.5 }
};

/** Two sends of one publisher to one recipient: the first was written to its socket, the second never was. */
const INPUT: ToOrderedSendArtifactInput = {
    createdAt: '2026-11-26T19:24:04.123Z',
    source: { commit: 'abc1234def5678900000000000000000000000ff', dirty: true },
    environment: {
        host: { cpuModel: 'Test CPU', cpuCount: 4, totalMemoryBytes: 16_000_000_000 },
        os: { platform: 'linux', release: '6.18.0', architecture: 'x64' },
        bunVersion: '1.3.0',
        postgresServerVersion: '16.4'
    },
    loadAverage: { atStart: [0.5, 0.6, 0.7], atEnd: [1.5, 0.9, 0.8] },
    shape: {
        publishers: 1,
        sendsPerSecond: 2,
        durationS: 1,
        delayMs: 5,
        senderRecovery: 'none',
        applicationPoolMaxConnections: 10
    },
    observationTailMs: 75_000,
    wallMs: 77_250,
    run: {
        observations: {
            sends: [
                {
                    msgId: 'session-01-a-send-1',
                    publisherPeerId: 'session-01-a',
                    seq: 1,
                    dueAtMs: 1_000,
                    sentAtMs: 1_000.5,
                    expectedRecipientPeerIds: ['session-02-b'],
                    acceptance: 'admitted',
                    answeredAtMs: 1_020
                },
                {
                    msgId: 'session-01-a-send-2',
                    publisherPeerId: 'session-01-a',
                    seq: 2,
                    dueAtMs: 1_500,
                    sentAtMs: 1_500.25,
                    expectedRecipientPeerIds: ['session-02-b'],
                    acceptance: 'pending-admission',
                    answeredAtMs: 1_640
                }
            ],
            resends: [],
            arrivals: [{ msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 1_040.5 }],
            handOffs: [],
            receipts: [],
            controls: [],
            unclassifiedControls: [],
            observationEndedAtMs: 76_500.25
        },
        runtime: { sendWindow: SEND_WINDOW, applicationPoolMaxConnections: 10 }
    }
};

describe('toOrderedSendArtifact', () => {
    it('records what was run, on what, for how long, and the pool beside the API\'s default', () => {
        const artifact = toOrderedSendArtifact(INPUT);

        expect(artifact).toMatchObject({
            schema: 'rallar.alm.ordered-send-cell.v1',
            createdAt: '2026-11-26T19:24:04.123Z',
            commit: 'abc1234def5678900000000000000000000000ff',
            dirty: true,
            environment: INPUT.environment,
            loadAverage: { atStart: [0.5, 0.6, 0.7], atEnd: [1.5, 0.9, 0.8] },
            shape: INPUT.shape,
            constants: { sessionCount: 15, instanceCount: 3, sendLifetimeMs: 30_000, receiptGraceMs: 45_000 },
            applicationPool: {
                effectiveMaxConnections: 10,
                apiV1DefaultMaxConnections: API_V1_DEFAULTS.database.applicationPool.maxConnections
            },
            observation: { tailMs: 75_000, firstOfferAtMs: 1_000.5, lastOfferAtMs: 1_500.25, endedAtMs: 76_500.25 },
            run: { wallMs: 77_250, sendWindow: SEND_WINDOW }
        });
    });

    it('carries the report of the run\'s observations', () => {
        const { report } = toOrderedSendArtifact(INPUT);

        expect(report.sends.attempted).toBe(2);
        expect(report.sends.byAcceptance).toMatchObject({ admitted: 1, 'pending-admission': 1 });
        expect(report.delivery).toMatchObject({ copiesExpected: 2, copiesRead: 1 });
        expect(report.recipientDelays.dueToFirstReadOverExpectedCopiesMs).toEqual({
            count: 2,
            p50: 40.5,
            p95: null,
            p99: null
        });
    });

    it('says which round trips its latency was added to and which not, and what the run does not show', () => {
        const artifact = toOrderedSendArtifact(INPUT);

        expect(artifact.databaseLatency.delayMs).toBe(5);
        expect(artifact.databaseLatency.delayed.join(' ')).toContain('NOTIFY publish');
        expect(artifact.databaseLatency.notDelayed.join(' ')).toContain('delivery of a NOTIFY');
        expect(artifact.limits.join(' ')).toContain('One event loop');
        expect(artifact.limits.join(' ')).toContain('room authorizer');
    });

    it('holds the keys of its schema and nothing else: no observation list and no database URL', () => {
        expect(Object.keys(toOrderedSendArtifact(INPUT)).toSorted()).toEqual([
            'applicationPool',
            'commit',
            'constants',
            'createdAt',
            'databaseLatency',
            'dirty',
            'environment',
            'limits',
            'loadAverage',
            'observation',
            'report',
            'run',
            'schema',
            'shape'
        ]);
    });
});
