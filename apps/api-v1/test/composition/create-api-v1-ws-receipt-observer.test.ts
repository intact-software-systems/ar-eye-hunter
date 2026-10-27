import assert from 'node:assert/strict';

import { createConsoleRallarTimingSink, type RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createApiV1WsReceiptObserver } from '../../src/composition/create-api-v1-ws-receipt-observer.ts';
import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';

Deno.test('private receipt observer is absent when the existing timing gate is off', () => {
    const timing = (_event: RallarTimingEvent) => {
        throw new Error('disabled observation reached timing');
    };
    assert.equal(createApiV1WsReceiptObserver({ enabled: false, timing, serviceId: 'api', publisherId: 'publisher' }), undefined);
});

Deno.test('private receipt observer uses the existing console sink with real process and publisher identity', () => {
    const logs: string[] = [];
    const timing = createConsoleRallarTimingSink({ enabled: true, logger: (line) => logs.push(line) });
    const observer = createApiV1WsReceiptObserver({ enabled: true, timing, serviceId: 'api', publisherId: 'publisher' });
    observer?.({
        kind: 'receipt-outbox',
        serverPeerId: 'server',
        receiptControlMsgId: 'receipt-1',
        deadlineAtMs: 30000,
        receipt: {
            msgId: 'subject',
            originPeerId: 'origin',
            expectedRecipientPeerIds: ['peer'],
            confirmedRecipientPeerIds: ['peer'],
            phase: 'complete',
            snapshotVersion: 7,
            observedAtEpochMs: 1000
        },
        verdict: { kind: 'duplicate', durable: undefined, queuedAttempts: undefined, reason: undefined, cause: undefined, limit: undefined },
        entryCount: 0,
        trackedReceiptAlgo: 'none'
    });
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0]);
    assert.equal(event.serviceId, 'api');
    assert.equal(event.details.publisherId, 'publisher');
    assert.deepEqual(event.wsReceipt.receipt.expectedRecipientPeerIds, ['peer']);
});

for (const enabled of [false, true]) {
    Deno.test({
        name: `default composition retains private receipt evidence only when timingLogs=${enabled}`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            const logs: string[] = [];
            const originalInfo = console.info;
            console.info = (line) => logs.push(String(line));
            const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
            try {
                const configuration = decodeApiV1Configuration(validDecodeApiV1ConfigurationInput());
                const server = await createDefaultRallarServer({
                    configuration: { ...configuration, observability: { ...configuration.observability, timingLogs: enabled } },
                    databaseLifecycle
                });
                await server.runtime.readiness;
                const expectedWarning = 'Skipping outbound dispatch: WS message has no verified scoped audience';
                const warnings: Parameters<typeof console.warn>[] = [];
                const originalWarn = console.warn;
                console.warn = (...values) => {
                    warnings.push(values);
                    if (values.length !== 1 || values[0] !== expectedWarning) {
                        originalWarn(...values);
                    }
                };
                try {
                    await server.runtime.wsQBoxServerService.enqueueOutboxIfAbsent(newALUnicastMessage(
                        'server',
                        { topicId: 'timing-test', resourceId: 'no-recipient', contextId: 'test' },
                        'absent-peer',
                        'timing.test.v1',
                        {},
                        { ttlMs: 30_000 }
                    ));
                }
                finally {
                    console.warn = originalWarn;
                }
                assert.deepEqual(warnings, [[expectedWarning]]);
                const batches = logs.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
                    .filter((event) => event.component === 'alm-outbound-dequeue' && event.operation === 'work-batch');
                assert.equal(batches.length > 0, enabled);
                if (enabled) {
                    assert.ok(batches.every((event) => event.details.claimedCount === 0 && event.details.completedCount === 0));
                    assert.ok(batches.every((event) => typeof event.details.workerId === 'string'));
                }
                const ack = newALAckControlMessage({
                    v: 4,
                    msgId: 'ack-1',
                    senderId: 'recipient',
                    ts: Date.now(),
                    traceId: 'trace-create-api-v1-ws-receipt-observer'
                }, {
                    ackedMsgId: 'subject',
                    originPeerId: 'origin',
                    fromPeerId: 'recipient',
                    toPeerId: 'origin',
                    logicalRecipientPeerId: 'recipient',
                    carrier: 'ws',
                    status: 'delivered',
                    observedAtEpochMs: Date.now()
                });
                const result = await server.runtime.wsQBoxServerService.acceptIncomingMessage(ack, 'missing-connection');
                assert.equal(result.left?.code, 'unauthorized');
                const records = logs.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).filter((event) => event.component === 'ws-receipt');
                assert.equal(records.length, enabled ? 1 : 0);
                if (enabled) {
                    assert.equal(records[0].wsReceipt.outcome, 'rejected');
                    assert.equal(records[0].wsReceipt.connectionId, 'missing-connection');
                    assert.equal(records[0].wsReceipt.scopeDisposition, 'unobserved');
                    assert.equal(typeof records[0].details.publisherId, 'string');
                    assert.equal(typeof records[0].serviceId, 'string');
                }
                await server.runtime.backgroundTasks.stop();
            }
            finally {
                console.info = originalInfo;
                await databaseLifecycle.close();
            }
        }
    });
}
