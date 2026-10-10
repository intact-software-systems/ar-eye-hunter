import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('full-stack private upstream receipt capture', () => {
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
