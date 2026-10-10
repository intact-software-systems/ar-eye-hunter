import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SafeApiWsReceiptObservationDto } from '../../../apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts';

import type { ReceiptOwnerScenario, ReceiptOwnerSink } from './full-stack-api-receipt-owner-fixture.ts';

const captureScript = 'apps/rallar-black-box/scripts/run-full-stack-api-with-timing.ts';

function ownerChild(expectedRecipientPeerIds: readonly string[]): string {
    const source = (file: string) => JSON.stringify(path.resolve(file));
    return `
        import { WsQueueBoxServerReceiptAggregation } from ${source('packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts')};
        import { InboxOutboxEngine } from ${source('packages/shared/services/InboxOutboxEngine.ts')};
        import { newALAckControlMessage } from ${source('packages/shared/al-contracts/al-control.ts')};
        import { createApiV1WsReceiptObserver } from ${source('apps/api-v1/src/composition/create-api-v1-ws-receipt-observer.ts')};
        import { createConsoleRallarTimingSink } from ${source('packages/shared-server/rallar-system/observability/timing.ts')};
        const timing = createConsoleRallarTimingSink({ enabled: true, logger: (line) => { const event = JSON.parse(line); console.log(JSON.stringify({ ...event, headers: { authorization: 'AUTH_SENTINEL' }, error: { message: 'ERROR_SENTINEL' } })); } });
        const owner = new WsQueueBoxServerReceiptAggregation({
            serverPeerId: 'server', clock: { nowMs: () => 1000 }, newControlId: () => 'receipt-1',
            qosProvider: undefined, queueEngine: new InboxOutboxEngine(),
            enqueueOutbox: async (message) => ({ message, verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 }, entries: [], trackedReceiptAlgo: 'none' }),
            acceptServerControl: async () => ({ kind: 'not-handled' }),
            acceptServerReceipt: async () => ({ kind: 'not-handled' }),
            receiptObserver: createApiV1WsReceiptObserver({ enabled: true, timing, serviceId: 'api-process', publisherId: 'publisher-1' })
        });
        owner.recordAdmission({ msgId: 'subject', originPeerId: 'origin', expectedRecipientPeerIds: ${
        JSON.stringify(expectedRecipientPeerIds)
    }, snapshotVersion: 7, deadlineAtMs: 30000 });
        await owner.acceptControlMessage(newALAckControlMessage(
            { v: 3, msgId: 'ack-1', senderId: 'recipient', ts: 900 },
            { ackedMsgId: 'subject', fromPeerId: 'recipient', toPeerId: 'origin', originPeerId: 'origin', logicalRecipientPeerId: 'recipient', carrier: 'ws', status: 'delivered', observedAtEpochMs: 901 }
        ));
        owner.dispose();
    `;
}

interface CapturedOwnerReceiptEvidence {
    readonly status: number | null;
    readonly text: string;
    readonly mode: number;
    readonly summary: {
        readonly retainedRecords: number;
        readonly rejectedLines: number;
        readonly oversizedLines: number;
        readonly stdoutEof: boolean;
        readonly cleanup: string;
        readonly observation: string;
        readonly durableRequestCompletion: string;
    };
}

async function captureOwnerReceiptEvidence(expectedRecipientPeerIds: readonly string[]): Promise<CapturedOwnerReceiptEvidence> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-receipt-capture-'));
    try {
        const fixture = path.join(directory, 'owner-child.mts');
        await writeFile(fixture, ownerChild(expectedRecipientPeerIds));
        const result = spawnSync(process.execPath, ['--import', 'tsx', captureScript, directory, '--', process.execPath, '--import', 'tsx', fixture], {
            encoding: 'utf8',
            timeout: 15000,
            env: {
                ...process.env,
                RALLAR_TIMING_LOGS: 'true',
                RALLAR_APP_INBOX_PHASE_TIMING: 'true',
                TSX_TSCONFIG_PATH: path.resolve('packages/tests/tsconfig.json')
            }
        });
        const recordsPath = path.join(directory, 'api-setup-timing.jsonl');
        return {
            status: result.status,
            text: await readFile(recordsPath, 'utf8'),
            mode: (await stat(recordsPath)).mode & 0o777,
            summary: JSON.parse(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8'))
        };
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}

interface PendingReceiptCapture {
    readonly records: readonly SafeApiWsReceiptObservationDto[];
    readonly text: string;
    readonly mode: number;
    readonly summary: CapturedOwnerReceiptEvidence['summary'];
    readonly effects: {
        readonly conflicted: boolean;
        readonly receiptControlMsgId: string;
        readonly nativeCalls: number;
        readonly publications: number;
        readonly clockReads: number;
        readonly releases: number;
        readonly lastReceiptReleaseAtMs: number;
        readonly receiptReleaseStatuses: readonly string[];
        readonly mutationResults: readonly boolean[];
    };
}

async function capturePendingReceipt(scenario: ReceiptOwnerScenario, sink: ReceiptOwnerSink = 'collecting'): Promise<PendingReceiptCapture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-pending-receipt-'));
    try {
        const evidencePath = path.join(directory, 'independent-effects.json');
        const fixture = path.join(directory, 'pending-owner.mts');
        await writeFile(
            fixture,
            `import { writePendingReceiptOwnerEvidence } from ${
                JSON.stringify(path.resolve('packages/tests/rallar-black-box/full-stack-api-receipt-owner-fixture.ts'))
            }; await writePendingReceiptOwnerEvidence(${JSON.stringify(evidencePath)}, ${JSON.stringify(scenario)}, ${JSON.stringify(sink)});`
        );
        const child = spawnSync(process.execPath, ['--import', 'tsx', captureScript, directory, '--', process.execPath, '--import', 'tsx', fixture], {
            encoding: 'utf8',
            timeout: 15000,
            env: {
                ...process.env,
                RALLAR_TIMING_LOGS: 'true',
                RALLAR_APP_INBOX_PHASE_TIMING: 'true',
                TSX_TSCONFIG_PATH: path.resolve('packages/tests/tsconfig.json')
            }
        });
        expect(child.status, child.stdout + child.stderr).toBe(0);
        const effects: PendingReceiptCapture['effects'] = JSON.parse(await readFile(evidencePath, 'utf8'));
        expect(effects.conflicted).toBe(true);
        const recordsPath = path.join(directory, 'api-setup-timing.jsonl');
        const text = await readFile(recordsPath, 'utf8');
        return {
            effects,
            text,
            records: text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).wsReceipt),
            mode: (await stat(recordsPath)).mode & 0o777,
            summary: JSON.parse(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8'))
        };
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}

describe('full-stack private upstream receipt capture', () => {
    it.each([
        ['native-return', { transport: 'recipient', nativeCall: 'returned', outcome: 'sent' }],
        ['later-throw', { transport: 'recipient', nativeCall: 'returned', outcome: 'threw' }],
        ['closed', { transport: 'recipient', nativeCall: 'not-called', outcome: 'not-ready' }],
        ['native-throw', { transport: 'recipient', nativeCall: 'invoked', outcome: 'threw' }],
        ['publish-return', { transport: 'cluster-receipt', publisherCall: 'returned', outcome: 'not-ready', submissionAttempted: false }],
        ['publish-throw', { transport: 'cluster-receipt', publisherCall: 'invoked', outcome: 'threw' }],
        ['direct-failure', { transport: 'cluster-receipt', publisherCall: 'invoked', outcome: 'threw' }]
    ])('retains real pending receipt %s through the child recorder', async (scenario, transport) => {
        const { records, effects } = await capturePendingReceipt(scenario as ReceiptOwnerScenario);
        expect(records).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'receipt-outbox',
                receiptControlMsgId: effects.receiptControlMsgId,
                verdict: expect.objectContaining({ kind: 'pending' })
            }),
            expect.objectContaining({
                kind: 'receipt-work',
                receiptControlMsgId: effects.receiptControlMsgId,
                effectKind: 'admit-message',
                callbackOutcome: 'completed'
            }),
            expect.objectContaining({
                kind: 'receipt-work',
                receiptControlMsgId: effects.receiptControlMsgId,
                effectKind: 'dequeue-message',
                callbackOutcome: 'completed'
            }),
            expect.objectContaining({ kind: 'receipt-transport', receiptControlMsgId: effects.receiptControlMsgId, ...transport })
        ]));
        expect(effects.receiptReleaseStatuses).toContain(scenario === 'native-return' ? 'COMPLETED' : 'RETRY');
        if (scenario === 'publish-return') {
            expect(records).toContainEqual(
                expect.objectContaining({
                    kind: 'receipt-publication',
                    receiptControlMsgId: effects.receiptControlMsgId,
                    publishCall: 'returned',
                    directCall: 'returned',
                    outcome: 'returned',
                    directStatus: 'no-recipients',
                    sentCount: 0
                })
            );
        }
        if (scenario === 'publish-throw') {
            expect(records).toContainEqual(
                expect.objectContaining({
                    kind: 'receipt-publication',
                    receiptControlMsgId: effects.receiptControlMsgId,
                    publishCall: 'invoked',
                    directCall: 'not-called',
                    outcome: 'threw'
                })
            );
        }
        if (scenario === 'direct-failure') {
            expect(records).toContainEqual(
                expect.objectContaining({
                    kind: 'receipt-publication',
                    receiptControlMsgId: effects.receiptControlMsgId,
                    publishCall: 'returned',
                    directCall: 'returned',
                    outcome: 'threw',
                    directStatus: 'failed',
                    failedCount: 1
                })
            );
        }
    });

    it('preserves actual effects, work release and owned clock reads with absent, mutating or throwing sinks', async () => {
        const baseline = await capturePendingReceipt('native-return', 'collecting');
        for (const sink of ['disabled', 'mutating', 'throwing'] as const) {
            const captured = await capturePendingReceipt('native-return', sink);
            expect(captured.effects).toMatchObject({
                nativeCalls: baseline.effects.nativeCalls,
                publications: baseline.effects.publications,
                clockReads: baseline.effects.clockReads,
                releases: baseline.effects.releases,
                receiptReleaseStatuses: baseline.effects.receiptReleaseStatuses,
                conflicted: true
            });
            expect(captured.effects.nativeCalls).toBeGreaterThan(0);
            expect(captured.effects.releases).toBeGreaterThan(0);
            if (sink === 'mutating') {
                expect(captured.effects.mutationResults.length).toBeGreaterThan(0);
                expect(captured.effects.mutationResults.every((result) => result === false)).toBe(true);
            }
            if (sink === 'disabled') {
                expect(captured.records).toEqual([]);
            }
        }
    });

    it('publishes transport evidence after the actual work release clock', async () => {
        const baseline = await capturePendingReceipt('native-return');
        const captured = await capturePendingReceipt('native-return', 'clock-mutating');
        expect(captured.effects.lastReceiptReleaseAtMs).toBe(baseline.effects.lastReceiptReleaseAtMs);
        expect(captured.effects.lastReceiptReleaseAtMs).toBe(1700000000000);
    });

    it('rejects unsafe new work records entirely while retaining the transport evidence', async () => {
        const captured = await capturePendingReceipt('native-return', 'unsafe');
        expect(captured.text).not.toContain('unsafe identity sentinel');
        expect(captured.records).not.toContainEqual(expect.objectContaining({ kind: 'receipt-work' }));
        expect(captured.records).toContainEqual(expect.objectContaining({ kind: 'receipt-transport' }));
        expect(captured.summary.rejectedLines).toBeGreaterThan(0);
        expect(captured.mode).toBe(0o600);
    });

    it.each(
        [
            { sink: 'unsafe-transport', kind: 'receipt-transport', scenario: 'native-return' },
            { sink: 'unsafe-publication', kind: 'receipt-publication', scenario: 'publish-return' }
        ] as const
    )('rejects an unsafe $kind at the actual recorder boundary', async ({ sink, kind, scenario }) => {
        const captured = await capturePendingReceipt(scenario, sink);
        expect(captured.text).not.toContain('unsafe identity sentinel');
        expect(captured.records).not.toContainEqual(expect.objectContaining({ kind }));
        expect(captured.records).toContainEqual(expect.objectContaining({ kind: 'receipt-work' }));
        expect(captured.summary.rejectedLines).toBeGreaterThan(0);
        expect(captured.mode).toBe(0o600);
    });

    it('retains actual owner-produced count and outbox fields through the real child recorder', async () => {
        const captured = await captureOwnerReceiptEvidence(['recipient']);
        expect(captured.status).toBe(0);
        const records = captured.text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(records).toMatchObject([
            {
                component: 'ws-receipt',
                serviceId: 'api-process',
                details: { publisherId: 'publisher-1' },
                wsReceipt: {
                    kind: 'receipt-outbox',
                    receiptControlMsgId: 'receipt-1',
                    trackedReceiptAlgo: 'none',
                    verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 },
                    receipt: {
                        msgId: 'subject',
                        originPeerId: 'origin',
                        expectedRecipientPeerIds: ['recipient'],
                        confirmedRecipientPeerIds: ['recipient'],
                        phase: 'complete',
                        snapshotVersion: 7,
                        observedAtEpochMs: 1000
                    }
                }
            },
            {
                component: 'ws-receipt',
                serviceId: 'api-process',
                details: { publisherId: 'publisher-1' },
                wsReceipt: {
                    kind: 'ack-count',
                    controlMsgId: 'ack-1',
                    source: 'local',
                    countAtEpochMs: 1000,
                    outcome: 'complete',
                    ack: { ackedMsgId: 'subject', observedAtEpochMs: 901 },
                    before: { expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: [], snapshotVersion: 7, deadlineAtMs: 30000 },
                    after: { expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: ['recipient'] }
                }
            }
        ]);
        expect(captured.text).not.toMatch(/AUTH_SENTINEL|ERROR_SENTINEL|authorization|headers/);
        expect(captured.mode).toBe(0o600);
        expect(captured.summary).toMatchObject({
            retainedRecords: 2,
            rejectedLines: 0,
            stdoutEof: true,
            trailingPartial: false,
            cleanup: 'reaped',
            observation: 'stream-complete',
            durableRequestCompletion: 'unverified'
        });
    });

    it('reports a rejected exact set instead of retaining a partial audience', async () => {
        const captured = await captureOwnerReceiptEvidence(['recipient', 'unsafe recipient']);
        expect(captured.status).toBe(0);
        expect(captured.text).toBe('');
        expect(captured.summary).toMatchObject({ retainedRecords: 0, rejectedLines: 1, observation: 'partial', durableRequestCompletion: 'unverified' });
    });

    it('keeps the existing 64KiB bound and loss summary for a large actual owner record', async () => {
        const audience = ['recipient', ...Array.from({ length: 4000 }, (_, index) => `peer-${index}-long-session-identity`)];
        const captured = await captureOwnerReceiptEvidence(audience);
        expect(captured.status).toBe(0);
        expect(captured.text).toBe('');
        expect(captured.summary).toMatchObject({
            retainedRecords: 0,
            oversizedLines: 1,
            observation: 'partial',
            cleanup: 'reaped',
            durableRequestCompletion: 'unverified'
        });
    });
});
