import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { toRoomSendThrownAnswer } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/answer/to-room-send-cell-answer.ts';
import {
    toRoomSendArtifact,
    type ToRoomSendArtifactInput
} from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/artifact/to-room-send-artifact.ts';
import { decodeRoomSendCellOptions } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/decode-room-send-cell-options.ts';

const API_V1_DEFAULTS = JSON.parse(
    readFileSync(
        new URL('../../../../../../apps/api-v1/resources/configuration/defaults-config.json', import.meta.url),
        'utf8'
    )
);

const SEND_WINDOW = {
    wallMs: 500,
    loopLag: { ticks: 50, p50Ms: 0.1, p95Ms: 0.4, p99Ms: 0.9, maxMs: 1.5, shareOfTicksOverOneMsLate: 0.02 },
    cpu: { scope: 'whole process, every thread', userMs: 200, systemMs: 50, coresBusy: 0.5 }
} as const;

const TAIL = {
    wallMs: 75_000,
    loopLag: { ticks: 7_400, p50Ms: 0.1, p95Ms: 0.3, p99Ms: 0.6, maxMs: 2.5, shareOfTicksOverOneMsLate: 0.001 },
    cpu: { scope: 'whole process, every thread', userMs: 15_000, systemMs: 3_750, coresBusy: 0.25 }
} as const;

const DATABASE_URL = 'postgres://app:s3cret-pw@db.internal:5432/alm_cell_run?sslmode=require';

/** Two sends of one publisher to one recipient: the first was written to its socket, the second never was. */
const INPUT: ToRoomSendArtifactInput = {
    createdAt: '2026-11-26T19:24:04.123Z',
    source: { commit: 'abc1234def5678900000000000000000000000ff', branch: 'claude/alm-room-send-measurement', dirty: true },
    givenOptions: {
        ordering: 'ordering-key',
        publishers: '1',
        'duration-s': '1',
        'delay-ms': '5',
        'sender-recovery': 'none',
        'application-pool': '10'
    },
    environment: {
        host: { cpuModel: 'Test CPU', cpuCount: 4, totalMemoryBytes: 16_000_000_000 },
        os: { platform: 'linux', release: '6.18.0', architecture: 'x64' },
        bunVersion: '1.3.0',
        postgresServerVersion: '16.4'
    },
    loadAverage: { atStart: [0.5, 0.6, 0.7], atEnd: [1.5, 0.9, 0.8] },
    shape: {
        ordering: 'ordering-key',
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
            ordering: 'ordering-key',
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
            acks: [],
            arrivals: [{ msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 1_040.5, namesOrderingKey: true }],
            handOffs: [],
            receipts: [],
            controls: [],
            unclassifiedControls: [],
            sendEnds: [],
            declinedRepairs: [],
            observationEndedAtMs: 76_500.25
        },
        runtime: { sendWindow: SEND_WINDOW, tail: TAIL, applicationPoolMaxConnections: 10 }
    }
};

describe('toRoomSendArtifact', () => {
    it('records what was run, on what, for how long, and the pool beside the API\'s default', () => {
        const artifact = toRoomSendArtifact(INPUT);

        expect(artifact).toMatchObject({
            schema: 'rallar.alm.room-send-cell.v1',
            createdAt: '2026-11-26T19:24:04.123Z',
            commit: 'abc1234def5678900000000000000000000000ff',
            branch: 'claude/alm-room-send-measurement',
            dirty: true,
            invocation: { givenOptions: INPUT.givenOptions },
            environment: INPUT.environment,
            loadAverage: { atStart: [0.5, 0.6, 0.7], atEnd: [1.5, 0.9, 0.8] },
            shape: INPUT.shape,
            constants: { sessionCount: 15, instanceCount: 3, sendLifetimeMs: 30_000, receiptGraceMs: 45_000 },
            applicationPool: {
                effectiveMaxConnections: 10,
                apiV1DefaultMaxConnections: API_V1_DEFAULTS.database.applicationPool.maxConnections
            },
            observation: { tailMs: 75_000, firstOfferAtMs: 1_000.5, lastOfferAtMs: 1_500.25, endedAtMs: 76_500.25 },
            run: { wallMs: 77_250, sendWindow: SEND_WINDOW, tail: TAIL }
        });
    });

    it('carries the report of the run\'s observations', () => {
        const { report } = toRoomSendArtifact(INPUT);

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
        const artifact = toRoomSendArtifact(INPUT);

        expect(artifact.databaseLatency.delayMs).toBe(5);
        expect(artifact.databaseLatency.delayed.join(' ')).toContain('NOTIFY publish');
        expect(artifact.databaseLatency.notDelayed.join(' ')).toContain('delivery of a NOTIFY');
        expect(artifact.limits.join(' ')).toContain(
            'One event loop runs the three instances and the load, where a deployment gives each instance a process. ' +
                'With no latency added the loop is busy most of the time, and of three runs of one shape the slowest ' +
                'took 2.3 times the fastest at the 99th percentile from offer to complete receipt'
        );
        expect(artifact.limits.join(' ')).toContain('room authorizer');
        expect(artifact.limits.join(' ')).toContain('Nothing reorders a copy of an unordered send');
    });

    it('holds the keys of its schema and nothing else', () => {
        expect(Object.keys(toRoomSendArtifact(INPUT)).toSorted()).toEqual([
            'applicationPool',
            'branch',
            'commit',
            'constants',
            'createdAt',
            'databaseLatency',
            'dirty',
            'environment',
            'invocation',
            'limits',
            'loadAverage',
            'observation',
            'observations',
            'report',
            'run',
            'schema',
            'shape'
        ]);
    });

    it('keeps the small observation lists with their instants, the offers that threw, a summary of the declined repairs, and only the counts of the large lists', () => {
        const threw = toRoomSendThrownAnswer(new Error('Buffered inbound ordering slot lost its canonical message'), 1_520);
        const [admitted, pending] = INPUT.run.observations.sends;
        const thrownSend = { ...pending, ...threw };
        const resend = { msgId: admitted.msgId, cause: 'first-hop', attempt: 1, sentAtMs: 3_000.5, ...threw } as const;
        const ack = { msgId: admitted.msgId, recipientPeerId: 'session-02-b', sentAtMs: 1_050 };
        const observations = {
            ...INPUT.run.observations,
            sends: [admitted, thrownSend],
            resends: [resend],
            acks: [
                { ...ack, acceptance: 'control', answeredAtMs: 1_060 } as const,
                { ...ack, ...threw }
            ],
            handOffs: [{ msgId: admitted.msgId, instanceIndex: 1, atMs: 1_030 }],
            receipts: [{ msgId: admitted.msgId, phase: 'admitted', atMs: 1_025 } as const],
            controls: [{ type: 'nack', msgId: admitted.msgId, reason: 'gap', atMs: 1_700 } as const],
            unclassifiedControls: [{ typeId: 'al.control.ack.v3', atMs: 1_800 }],
            sendEnds: [{ msgId: admitted.msgId, cause: 'first-hop-exhausted', atMs: 9_010 } as const],
            declinedRepairs: [{ msgId: admitted.msgId, reason: 'send-ended', atMs: 9_500 } as const]
        };

        const artifact = toRoomSendArtifact({ ...INPUT, run: { ...INPUT.run, observations } });

        expect(artifact.observations).toEqual({
            counts: {
                sends: 2,
                resends: 1,
                acks: 2,
                arrivals: 1,
                handOffs: 1,
                receipts: 1,
                controls: 1,
                unclassifiedControls: 1,
                sendEnds: 1,
                declinedRepairs: 1
            },
            thrownSends: [thrownSend],
            resends: [resend],
            thrownAcks: [{ ...ack, ...threw }],
            receipts: observations.receipts,
            controls: observations.controls,
            unclassifiedControls: observations.unclassifiedControls,
            sendEnds: observations.sendEnds,
            declinedRepairs: {
                countByReason: { 'send-ended': 1, 'send-expired': 0, 'named-send-expired': 0 },
                firstDeclined: [{ msgId: 'session-01-a-send-1', reason: 'send-ended', atMs: 9_500 }],
                bySendAndReason: [
                    { msgId: 'session-01-a-send-1', reason: 'send-ended', count: 1, firstAtMs: 9_500, lastAtMs: 9_500 }
                ]
            }
        });
    });

    it('holds nothing URL-shaped anywhere, built from an invocation that named its database and a run whose offer threw a URL', () => {
        const options = decodeRoomSendCellOptions([
            `--database-url=${DATABASE_URL}`,
            '--ordering=ordering-key',
            '--publishers=1',
            '--duration-s=1',
            '--out=tmp/perf/alm-room-send/one.json'
        ]).right!;
        const threw = toRoomSendThrownAnswer(new Error(`connect ${DATABASE_URL} refused`), 1_520);
        const [admitted, pending] = INPUT.run.observations.sends;
        const observations = {
            ...INPUT.run.observations,
            sends: [admitted, { ...pending, ...threw }],
            resends: [{ msgId: admitted.msgId, cause: 'repair', attempt: 1, sentAtMs: 3_000, ...threw } as const],
            acks: [{ msgId: admitted.msgId, recipientPeerId: 'session-02-b', sentAtMs: 1_050, ...threw }],
            declinedRepairs: [{ msgId: admitted.msgId, reason: 'send-expired', atMs: 31_500 } as const]
        };

        const text = JSON.stringify(toRoomSendArtifact({
            ...INPUT,
            shape: options.shape,
            givenOptions: options.givenOptions,
            run: { ...INPUT.run, observations }
        }));

        expect(text).toContain('connect <url removed> refused');
        expect(text).toContain('tmp/perf/alm-room-send/one.json');
        expect(text).toContain('"bySendAndReason":[{"msgId":"session-01-a-send-1","reason":"send-expired"');
        expect(text).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
        for (const secret of ['s3cret-pw', 'db.internal', 'alm_cell_run', 'sslmode', 'database-url']) {
            expect(text).not.toContain(secret);
        }
    });
});
