// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { DEFAULT_RALLAR_CRDT_DB_NAME, RALLAR_CRDT_LOCAL_STORE_NAMES } from '@shared-web/browser/rallar-crdt-local-store.ts';
import { createRallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import { createRallarDataFacade, type RallarDataScope } from '@shared-web/browser/rallar-data.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    InMemoryRallarCrdtMetricsSink,
    isRallarCrdtEncryptedOperationBatch,
    rallarCrdtBatch,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentTypePolicy
} from '@shared/crdt/mod.ts';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createHttpCatchUpResponse,
    createTransportDocument,
    FakeBroadcastChannel,
    FakeCrdtTransportNetwork,
    testKeyring,
    waitFor
} from './rallar-crdt-test-runtime.ts';

const roomRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1'
};

const resolveTestDataScopeKey = (scope: RallarDataScope): string => String(scope);

describe('Rallar CRDT browser facade', () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;

    afterEach(() => {
        globalThis.BroadcastChannel = originalBroadcastChannel;
        FakeBroadcastChannel.clear();
    });

    it('is exposed on the main Rallar facade as a local-only document API', async () => {
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'rallar-test',
            workspaceId: 'main'
        });
        const document = await facade.crdt.open<Record<string, unknown>>(
            'mission-notes',
            {
                persist: false,
                tabSync: false
            }
        );

        await document.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'register.set',
                    path: ['title'],
                    policy: 'lww',
                    value: 'North entrance'
                }
            ])
        );

        expect(document.read()).toEqual({
            title: 'North entrance'
        });
        expect(await document.sync()).toMatchObject({
            status: 'local-only',
            transport: 'local-only'
        });
    });

    it('offers ordered-list helpers and actor-scoped undo/redo metadata', async () => {
        const document = await createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            })
        }).open<Record<string, unknown>>('room-checklist', {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            documentType: 'checklist',
            documentId: roomRef.groupId,
            scope: {
                kind: 'room',
                roomRef
            },
            persist: false,
            tabSync: false,
            replicaId: 'replica-sequence',
            actorId: 'actor-a'
        });

        const insert = await document.sequenceInsert(
            {
                path: ['items'],
                elementId: 'item-a',
                positionId: 'a',
                value: { text: 'Alpha' }
            },
            {
                operationGroupId: 'actor-a:add-alpha'
            }
        );
        const beta = await document.sequenceInsert({
            path: ['items'],
            elementId: 'item-b',
            positionId: 'b',
            value: { text: 'Beta' }
        });
        await document.sequenceMove({
            path: ['items'],
            elementId: 'item-b',
            positionId: '0',
            observedUpdateIds: [beta.updateId]
        });

        expect(document.read()).toEqual({
            items: [{ text: 'Beta' }, { text: 'Alpha' }]
        });
        expect(document.operationGroupUpdateIds('actor-a:add-alpha')).toEqual([
            insert.updateId
        ]);

        const undo = await document.undoOperationGroup({
            targetOperationGroupId: 'actor-a:add-alpha',
            operations: [
                {
                    kind: 'sequence.delete',
                    path: ['items'],
                    elementId: 'item-a',
                    observedUpdateIds: [insert.updateId]
                }
            ]
        });

        expect(undo.payload.undo).toMatchObject({
            actorId: 'actor-a',
            targetOperationGroupId: 'actor-a:add-alpha',
            targetUpdateIds: [insert.updateId]
        });
        expect(document.read()).toEqual({
            items: [{ text: 'Beta' }]
        });

        const redo = await document.redoOperationGroup({
            targetOperationGroupId: 'undo:actor-a:add-alpha',
            operations: [
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-a-redo',
                    positionId: 'z',
                    value: { text: 'Alpha' }
                }
            ]
        });

        expect(redo.payload.redo).toMatchObject({
            actorId: 'actor-a',
            targetOperationGroupId: 'undo:actor-a:add-alpha',
            targetUpdateIds: [undo.updateId]
        });
        expect(document.read()).toEqual({
            items: [{ text: 'Beta' }, { text: 'Alpha' }]
        });
    });

    it('offers numeric counter and min/max helpers', async () => {
        const document = await createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            })
        }).open<Record<string, unknown>>('room-metrics', {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            documentType: 'metrics',
            documentId: roomRef.groupId,
            scope: {
                kind: 'room',
                roomRef
            },
            persist: false,
            tabSync: false,
            replicaId: 'replica-numeric'
        });

        await document.counterIncrement(['votes']);
        await document.counterAdd({
            path: ['votes'],
            delta: 4
        });
        await document.counterDecrement(['votes']);
        await document.numberMin({
            path: ['latencyMs'],
            value: 42
        });
        await document.numberMin({
            path: ['latencyMs'],
            value: 21
        });
        await document.numberMax({
            path: ['score'],
            value: 7
        });
        await document.numberMax({
            path: ['score'],
            value: 11
        });

        expect(document.read()).toEqual({
            votes: 4,
            latencyMs: 21,
            score: 11
        });
    });

    it('persists snapshots, pending updates, and seen updates through close/reopen', async () => {
        globalThis.BroadcastChannel = FakeBroadcastChannel as never;

        const dbName = `rallar-crdt-${crypto.randomUUID()}`;
        const firstFacade = createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            }),
            readDefaults: () => ({
                applicationId: 'rallar-test',
                workspaceId: 'main'
            })
        });
        const first = await firstFacade.open<Record<string, unknown>>(
            'mission-notes',
            {
                dbName,
                tabSync: false
            }
        );

        const update = await first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Persisted title'
                }
            ])
        );

        expect(first.pendingUpdates().map((entry) => entry.updateId)).toEqual([
            update.updateId
        ]);
        expect(first.health()).toMatchObject({
            pendingUpdateCount: 1,
            seenUpdateCount: 1
        });
        await first.close();

        expect(
            FakeBroadcastChannel.names().some((name) => name.startsWith('rallar-data:'))
        ).toBe(false);

        const secondFacade = createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            }),
            readDefaults: () => ({
                applicationId: 'rallar-test',
                workspaceId: 'main'
            })
        });
        const second = await secondFacade.open<Record<string, unknown>>(
            'mission-notes',
            {
                dbName,
                tabSync: false
            }
        );

        expect(second.read()).toEqual({
            title: 'Persisted title'
        });
        expect(second.pendingUpdates().map((entry) => entry.updateId)).toEqual([
            update.updateId
        ]);
        expect(second.health()).toMatchObject({
            pendingUpdateCount: 1,
            seenUpdateCount: 1
        });
        await second.destroy();
    });

    it('quarantines corrupt local artifacts during hydration', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const ref = {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            scope: 'room' as const,
            documentType: 'checklist',
            documentId: roomRef.groupId,
            roomRef
        };
        const documentKey = toRallarCrdtDocumentKey(ref);
        const snapshotStore = await data.open<unknown>(
            RALLAR_CRDT_LOCAL_STORE_NAMES.snapshots,
            {
                dbName: DEFAULT_RALLAR_CRDT_DB_NAME,
                scope: 'app',
                schemaVersion: 1,
                sync: false
            }
        );
        const pendingStore = await data.open<unknown>(
            RALLAR_CRDT_LOCAL_STORE_NAMES.pendingUpdates,
            {
                dbName: DEFAULT_RALLAR_CRDT_DB_NAME,
                scope: 'app',
                schemaVersion: 1,
                sync: false
            }
        );
        await snapshotStore.set(encodeURIComponent(documentKey), {
            protocolVersion: 99
        });
        await pendingStore.set(`${encodeURIComponent(documentKey)}/bad`, {
            bad: true
        });

        const document = await createRallarCrdtFacade({
            data
        }).open<Record<string, unknown>>('room-checklist', {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            documentType: ref.documentType,
            documentId: ref.documentId,
            scope: {
                kind: 'room',
                roomRef
            },
            replicaId: 'replica-corrupt',
            transport: 'local-only'
        });

        expect(document.health()).toMatchObject({
            corruptLocalArtifactCount: 2,
            pendingUpdateCount: 0
        });
        expect(document.read()).toEqual({});
        await document.destroy();
    });

    it('syncs same-origin tabs through CRDT update BroadcastChannel messages', async () => {
        globalThis.BroadcastChannel = FakeBroadcastChannel as never;

        const dbName = `rallar-crdt-${crypto.randomUUID()}`;
        const first = await createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            })
        }).open<Record<string, unknown>>('room-checklist', {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            documentType: 'checklist',
            documentId: roomRef.groupId,
            scope: {
                kind: 'room',
                roomRef
            },
            dbName,
            replicaId: 'tab-a'
        });
        const second = await createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            })
        }).open<Record<string, unknown>>('room-checklist', {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            documentType: 'checklist',
            documentId: roomRef.groupId,
            scope: {
                kind: 'room',
                roomRef
            },
            dbName,
            replicaId: 'tab-b'
        });

        await first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'orset.add',
                    path: ['items'],
                    elementId: 'a',
                    value: { text: 'Inspect north entrance', done: false }
                }
            ])
        );
        await second.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'orset.add',
                    path: ['items'],
                    elementId: 'b',
                    value: { text: 'Check supply cache', done: false }
                }
            ])
        );

        await waitFor(
            () => JSON.stringify(first.read()) === JSON.stringify(second.read())
        );

        expect(first.read()).toEqual({
            items: [
                { text: 'Inspect north entrance', done: false },
                { text: 'Check supply cache', done: false }
            ]
        });
        expect(
            FakeBroadcastChannel.names().some((name) => name.startsWith('rallar-crdt:'))
        ).toBe(true);
        expect(
            FakeBroadcastChannel.names().some((name) => name.startsWith('rallar-data:'))
        ).toBe(false);

        await first.destroy();
        await second.destroy();
    });

    it('accepts WS and RTC transport choices while reporting live sync as deferred', async () => {
        const metrics = new InMemoryRallarCrdtMetricsSink();
        const facade = createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            }),
            readDefaults: () => ({
                applicationId: 'rallar-test',
                workspaceId: 'main'
            })
        });
        const document = await facade.open<Record<string, unknown>>(
            'mission-notes',
            {
                persist: false,
                tabSync: false,
                transport: 'ws-then-rtc',
                metrics
            }
        );

        expect(await document.sync()).toMatchObject({
            status: 'deferred',
            transport: 'ws-then-rtc'
        });
        expect(metrics.count('crdt.merge.replay.ms')).toBe(1);
        expect(metrics.count('crdt.sync.bytes')).toBe(1);
    });

    it('converges over mocked WS when the WS strategy is selected', async () => {
        const network = new FakeCrdtTransportNetwork();
        const first = await createTransportDocument({ replicaId: 'tab-a', network, transport: 'ws' });
        const second = await createTransportDocument({ replicaId: 'tab-b', network, transport: 'ws' });

        await first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'WS title'
                }
            ])
        );

        await waitFor(
            () => JSON.stringify(second.read()) === '{"title":"WS title"}'
        );

        expect(second.health()).toMatchObject({
            liveReceivedUpdateCount: 1,
            lastLiveTransport: 'ws'
        });
        expect(network.sentUpdateTransports()).toEqual(['ws']);
    });

    it('encrypts live updates and decrypts them before browser merge', async () => {
        const network = new FakeCrdtTransportNetwork();
        const encryption = testKeyring();
        const first = await createTransportDocument({
            replicaId: 'tab-a',
            network,
            transport: 'ws',
            options: { encryption }
        });
        const second = await createTransportDocument({
            replicaId: 'tab-b',
            network,
            transport: 'ws',
            options: { encryption }
        });

        const update = await first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Encrypted WS title'
                }
            ])
        );

        expect(isRallarCrdtEncryptedOperationBatch(update.payload)).toBe(true);
        expect(JSON.stringify(update)).not.toContain('Encrypted WS title');
        await waitFor(
            () => JSON.stringify(second.read()) === '{"title":"Encrypted WS title"}'
        );
        expect(second.health()).toMatchObject({
            liveReceivedUpdateCount: 1,
            lastLiveTransport: 'ws'
        });
    });

    it('converges over mocked RTC when the RTC strategy is selected', async () => {
        const network = new FakeCrdtTransportNetwork();
        const first = await createTransportDocument({ replicaId: 'tab-a', network, transport: 'rtc' });
        const second = await createTransportDocument({ replicaId: 'tab-b', network, transport: 'rtc' });

        await first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'RTC title'
                }
            ])
        );

        await waitFor(
            () => JSON.stringify(second.read()) === '{"title":"RTC title"}'
        );

        expect(second.health()).toMatchObject({
            liveReceivedUpdateCount: 1,
            lastLiveTransport: 'rtc'
        });
        expect(network.sentUpdateTransports()).toEqual(['rtc']);
    });

    it('uses configured combined and fallback transport order', async () => {
        const combined = new FakeCrdtTransportNetwork();
        const combinedDoc = await createTransportDocument({
            replicaId: 'tab-a',
            network: combined,
            transport: 'ws-then-rtc'
        });
        await createTransportDocument({
            replicaId: 'tab-b',
            network: combined,
            transport: 'ws-then-rtc'
        });

        await combinedDoc.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Combined title'
                }
            ])
        );

        expect(combined.sentUpdateTransports()).toEqual(['ws', 'rtc']);

        const fallback = new FakeCrdtTransportNetwork({
            rtcStatuses: ['sent', 'sent', 'sent', 'no-route']
        });
        const fallbackDoc = await createTransportDocument({
            replicaId: 'tab-a',
            network: fallback,
            transport: 'rtc-with-ws-fallback'
        });
        const receiver = await createTransportDocument({
            replicaId: 'tab-b',
            network: fallback,
            transport: 'rtc-with-ws-fallback'
        });

        await fallbackDoc.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Fallback title'
                }
            ])
        );

        await waitFor(
            () => JSON.stringify(receiver.read()) === '{"title":"Fallback title"}'
        );
        expect(fallback.sentUpdateTransports()).toEqual(['rtc', 'ws']);
    });

    it('can disable RTC while WS transport continues', async () => {
        const network = new FakeCrdtTransportNetwork();
        const policies: readonly RallarCrdtDocumentTypePolicy[] = [
            {
                documentType: 'checklist',
                rollout: 'durable-beta',
                flags: {
                    rtc: false
                }
            }
        ];
        const sender = await createTransportDocument({
            replicaId: 'tab-a',
            network,
            transport: 'ws-then-rtc',
            options: { policies }
        });
        const receiver = await createTransportDocument({
            replicaId: 'tab-b',
            network,
            transport: 'ws-then-rtc',
            options: { policies }
        });

        await sender.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'WS only title'
                }
            ])
        );

        await waitFor(
            () => JSON.stringify(receiver.read()) === '{"title":"WS only title"}'
        );
        expect(network.sentUpdateTransports()).toEqual(['ws']);
        expect(sender.health()).toMatchObject({
            lastLiveTransport: 'rtc',
            lastLiveSendStatus: 'rtc-disabled'
        });
    });

    it('catches up from a peer when a browser opens after missing live updates', async () => {
        const network = new FakeCrdtTransportNetwork();
        const first = await createTransportDocument({ replicaId: 'tab-a', network, transport: 'ws' });

        await first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Catch-up title'
                }
            ])
        );

        const second = await createTransportDocument({ replicaId: 'tab-b', network, transport: 'ws' });

        await waitFor(
            () => JSON.stringify(second.read()) === '{"title":"Catch-up title"}'
        );

        expect(second.health()).toMatchObject({
            liveSyncRequestCount: 1,
            liveSyncResponseCount: 1,
            liveReceivedUpdateCount: 1
        });
    });

    it('clears pending updates after a durable append acceptance response', async () => {
        const network = new FakeCrdtTransportNetwork({
            appendResponses: 'accepted'
        });
        const document = await createTransportDocument({ replicaId: 'tab-a', network, transport: 'ws' });

        const update = await document.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Durable title'
                }
            ])
        );

        await waitFor(() => document.pendingUpdates().length === 0);

        expect(document.pendingUpdates()).toEqual([]);
        expect(document.failedPendingUpdates()).toEqual([]);
        expect(document.health()).toMatchObject({
            pendingUpdateCount: 0,
            lastServerAppendSequence: 1,
            lastServerAckAtEpochMs: 5_000
        });
        expect(update.updateId).toBeTruthy();
    });

    it('moves pending updates to failed pending after a durable append rejection response', async () => {
        const network = new FakeCrdtTransportNetwork({
            appendResponses: 'rejected'
        });
        const document = await createTransportDocument({ replicaId: 'tab-a', network, transport: 'ws' });

        const update = await document.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Rejected title'
                }
            ])
        );

        await waitFor(() => document.failedPendingUpdates().length === 1);

        expect(document.pendingUpdates()).toEqual([]);
        expect(document.failedPendingUpdates()).toEqual([
            expect.objectContaining({
                update,
                retryable: false,
                reason: 'Document is archived.'
            })
        ]);
    });

    it('uses HTTP durable catch-up when no live transport is configured', async () => {
        const document = await createRallarCrdtFacade({
            data: createRallarDataFacade({
                manager: new RepositoryManager(),
                resolveScopeKey: resolveTestDataScopeKey
            })
        }).open<Record<string, unknown>>('room-checklist', {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            documentType: 'checklist',
            documentId: roomRef.groupId,
            scope: {
                kind: 'room',
                roomRef
            },
            persist: false,
            tabSync: false,
            transport: 'ws',
            durableCatchUp: async (request) => createHttpCatchUpResponse(request)
        });

        expect(document.read()).toEqual({
            title: 'HTTP durable title'
        });
        expect(await document.sync()).toMatchObject({
            status: 'synced',
            transport: 'ws'
        });
        expect(document.health()).toMatchObject({
            lastServerAppendSequence: 1
        });
    });
});
