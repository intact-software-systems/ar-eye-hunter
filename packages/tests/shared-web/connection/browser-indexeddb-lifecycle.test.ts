import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import { initialiseMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import * as stateSnapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import * as auth from '@shared/api/auth.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';

describe('browser IndexedDB terminal ownership', () => {
    it('retires each successful connection while a fresh connection keeps persisted rows usable', async () => {
        const opened: IDBDatabase[] = [];
        const originalOpen = indexedDB.open.bind(indexedDB);
        vi.spyOn(indexedDB, 'open').mockImplementation((...arguments_) => {
            const request = originalOpen(...arguments_);
            request.addEventListener('success', () => opened.push(request.result));
            return request;
        });
        const runtime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
        onTestFinished(() => {
            runtime.shutdown();
            for (const database of opened) {
                database.close();
            }
            vi.restoreAllMocks();
        });
        const session = { clientId: 'client', sessionId: 'session', username: 'test', accessToken: 'test', expiresAtEpochMs: 60_000 };
        vi.spyOn(auth, 'readSession').mockReturnValue(session);
        vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({
            apiBaseUrl: 'http://test',
            wsBaseUrl: 'ws://test',
            endpoints: { createWs: '/ws' }
        });
        vi.spyOn(connectionHttp, 'readIceCandidates').mockResolvedValue({ iceServers: [], expiresAtEpochMs: 60_000 });
        vi.spyOn(JsonWebSocketClient.prototype, 'connect').mockResolvedValue();
        vi.spyOn(stateSnapshots, 'refreshStateSnapshots').mockResolvedValue({ clients: [], groups: [] });
        vi.spyOn(heartbeat, 'initHeartbeat').mockResolvedValue({ sessionId: session.sessionId, generationId: 'heartbeat', stop: () => {} });
        const options = {
            rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' } as const,
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false },
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            onResyncRequired: () => {},
            scope: { applicationId: 'indexeddb-lifecycle', workspaceId: 'successful' }
        };
        await runtime.init(options);
        await vi.waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(5));
        const retired = [...opened];
        const row = { key: 'independent-row', value: 'persisted', expireAtTimestamp: Number.MAX_SAFE_INTEGER, writeToken: 'write-1', revision: 1 };
        const transaction = retired[0].transaction('entries', 'readwrite');
        await readIndexedDbTransaction(transaction, () => readIndexedDbRequest(transaction.objectStore('entries').put(row)));
        await runtime.readMiddleware()!.middleware.webSocketQueueBox.close();
        for (const database of retired) {
            expect(() => database.transaction('entries')).not.toThrow();
        }
        runtime.shutdown();
        await vi.waitFor(() => {
            for (const database of retired) {
                expect(() => database.transaction(database.objectStoreNames[0])).toThrow();
                expect(database.onversionchange).toBeNull();
            }
        });
        await runtime.init(options);
        await vi.waitFor(() => expect(opened.length).toBeGreaterThan(retired.length));
        const current = opened.slice(retired.length);
        for (const database of current) {
            expect(() => database.transaction(database.objectStoreNames[0])).not.toThrow();
        }
        expect(await readIndexedDbRequest(current[0].transaction('entries').objectStore('entries').get('independent-row'))).toEqual(row);
        runtime.shutdown();
        await vi.waitFor(() => {
            for (const database of current) {
                expect(() => database.transaction(database.objectStoreNames[0])).toThrow();
            }
        });
    });

    it('releases stores opened before a socket startup failure while preserving that failure', async () => {
        const opened: IDBDatabase[] = [];
        const originalOpen = indexedDB.open.bind(indexedDB);
        vi.spyOn(indexedDB, 'open').mockImplementation((...arguments_) => {
            const request = originalOpen(...arguments_);
            request.addEventListener('success', () => opened.push(request.result));
            return request;
        });
        onTestFinished(() => {
            for (const database of opened) {
                database.close();
            }
            vi.restoreAllMocks();
        });
        const failure = new Error('socket unavailable');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({
            apiBaseUrl: 'http://test',
            wsBaseUrl: 'ws://test',
            endpoints: { createWs: '/ws' }
        });
        vi.spyOn(JsonWebSocketClient.prototype, 'connect').mockImplementation(async () => {
            await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
            throw failure;
        });

        await expect(initialiseMiddleware(
            {
                clientId: 'indexeddb-client',
                sessionId: 'indexeddb-session',
                username: 'test',
                accessToken: 'test',
                expiresAtEpochMs: 60_000
            },
            'rtc',
            {
                rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' },
                qosProvider: undefined,
                readVolatileSessionLimits: undefined,
                deliverySettlements: { ws: () => {}, rtc: () => {} },
                diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
                onResyncRequired: () => {},
                durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
                readIceCandidates: (signal) => connectionHttp.readIceCandidates({ signal }),
                scope: { applicationId: 'indexeddb-lifecycle', workspaceId: 'failure' }
            }
        )).rejects.toBe(failure);

        expect(opened.length).toBeGreaterThan(0);
        for (const database of opened) {
            expect(() => database.transaction(database.objectStoreNames[0])).toThrow();
        }
    });
});
