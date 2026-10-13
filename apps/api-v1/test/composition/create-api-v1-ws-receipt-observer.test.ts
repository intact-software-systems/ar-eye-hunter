import type { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { RallarServerApplication } from '@shared-server/rallar-server/rallar-server-application.ts';
import { createConsoleRallarTimingSink, type RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { createApiV1WsReceiptObserver } from '../../src/composition/create-api-v1-ws-receipt-observer.ts';
import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle, type ApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';

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

interface ReceiptCompositionTestDependencies {
    readonly enabled: boolean;
    readonly acquireDatabase: typeof createApiV1TestPGliteDatabaseLifecycle;
    readonly createServer: typeof createDefaultRallarServer;
}

async function runReceiptCompositionFixture(dependencies: ReceiptCompositionTestDependencies): Promise<void> {
    const logs: string[] = [];
    const originalInfo = console.info;
    let databaseLifecycle: ApiV1TestPGliteDatabaseLifecycle | undefined;
    let server: RallarServerApplication<ApiV1Runtime, Hono> | undefined;
    let primaryFailed = false;
    try {
        console.info = (line) => logs.push(String(line));
        databaseLifecycle = await dependencies.acquireDatabase();
        const configuration = decodeApiV1Configuration(validDecodeApiV1ConfigurationInput());
        server = await dependencies.createServer({
            configuration: { ...configuration, observability: { ...configuration.observability, timingLogs: dependencies.enabled } },
            databaseLifecycle
        });
        await server.runtime.readiness;
        await assertReceiptCompositionIngress(server, logs, dependencies.enabled);
    }
    catch (error) {
        primaryFailed = true;
        throw error;
    }
    finally {
        let shutdownFailures: readonly Error[];
        try {
            shutdownFailures = await stopReceiptComposition(server, databaseLifecycle);
        }
        finally {
            console.info = originalInfo;
        }
        if (!primaryFailed) {
            if (shutdownFailures.length > 0) {
                throw new AggregateError(shutdownFailures, 'Receipt fixture shutdown failed');
            }
            assertReceiptCompositionClose(logs, dependencies.enabled);
        }
    }
}

async function stopReceiptComposition(
    server: RallarServerApplication<ApiV1Runtime, Hono> | undefined,
    databaseLifecycle: ApiV1TestPGliteDatabaseLifecycle | undefined
): Promise<readonly Error[]> {
    const failures: Error[] = [];
    try {
        await server?.runtime.wsQBoxServerService.dispose();
    }
    catch (error) {
        failures.push(toError(error));
    }
    try {
        await server?.runtime.backgroundTasks.stop();
    }
    catch (error) {
        failures.push(toError(error));
    }
    try {
        await databaseLifecycle?.close();
    }
    catch (error) {
        failures.push(toError(error));
    }
    return failures;
}

async function assertReceiptCompositionIngress(
    server: RallarServerApplication<ApiV1Runtime, Hono>,
    logs: readonly string[],
    enabled: boolean
): Promise<void> {
    const ack = newALAckControlMessage({ v: 3, msgId: 'ack-1', senderId: 'recipient', ts: Date.now() }, {
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
}

function assertReceiptCompositionClose(logs: readonly string[], enabled: boolean): void {
    const closed = logs.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
        .filter((event) => event.wsReceipt?.kind === 'outbound-phase-summary');
    assert.equal(closed.length, enabled ? 1 : 0);
    if (enabled) {
        assert.equal(closed[0].wsReceipt.closed, true);
        assert.equal(closed[0].wsReceipt.maxRecords, 4096);
        assert.equal(closed[0].wsReceipt.maxBytes, 8 * 1024 * 1024);
        assert.equal(closed[0].wsReceipt.unfinishedBatches, 0);
    }
}

for (const enabled of [false, true]) {
    Deno.test({
        name: `default composition retains private receipt evidence only when timingLogs=${enabled}`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: () => runReceiptCompositionFixture({ enabled, acquireDatabase: createApiV1TestPGliteDatabaseLifecycle, createServer: createDefaultRallarServer })
    });
}

Deno.test('receipt fixture restores global logging when database acquisition fails', async () => {
    const originalInfo = console.info;
    const original = new Error('acquisition failed');
    try {
        await assert.rejects(() =>
            runReceiptCompositionFixture({
                enabled: true,
                acquireDatabase: () => Promise.reject(original),
                createServer: createDefaultRallarServer
            }), (error) => error === original);
        assert.equal(console.info, originalInfo);
    }
    finally {
        console.info = originalInfo;
    }
});

Deno.test({
    name: 'receipt fixture joins all owned cleanup after readiness failure and preserves the original error',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const originalInfo = console.info;
        const original = new Error('readiness failed');
        const cleanupFailure = new Error('dispose failed after join');
        const calls: string[] = [];
        let ownedServer: RallarServerApplication<ApiV1Runtime, Hono> | undefined;
        try {
            await assert.rejects(() =>
                runReceiptCompositionFixture({
                    enabled: true,
                    acquireDatabase: createApiV1TestPGliteDatabaseLifecycle,
                    createServer: async (input) => {
                        const server = await createDefaultRallarServer(input);
                        ownedServer = server;
                        await server.runtime.readiness;
                        Object.defineProperty(server.runtime, 'readiness', {
                            get: () => {
                                throw original;
                            }
                        });
                        const dispose = server.runtime.wsQBoxServerService.dispose.bind(server.runtime.wsQBoxServerService);
                        server.runtime.wsQBoxServerService.dispose = async () => {
                            calls.push('ws');
                            await dispose();
                            throw cleanupFailure;
                        };
                        const stop = server.runtime.backgroundTasks.stop.bind(server.runtime.backgroundTasks);
                        server.runtime.backgroundTasks.stop = async () => {
                            calls.push('background');
                            await stop();
                        };
                        return server;
                    }
                }), (error) => error === original);
            assert.deepEqual(calls, ['ws', 'background']);
            assert.equal(console.info, originalInfo);
        }
        finally {
            console.info = originalInfo;
            try {
                await ownedServer?.runtime.wsQBoxServerService.dispose();
            }
            catch { /* The injected failure occurs after the real disposal joined. */ }
            await ownedServer?.runtime.backgroundTasks.stop();
        }
    }
});
