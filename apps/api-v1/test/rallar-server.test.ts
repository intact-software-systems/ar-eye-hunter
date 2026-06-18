import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    hashRallarCrdtUpdateEnvelope,
    InMemoryRallarCrdtAuditSink,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    rallarCrdtBatch,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { InMemoryRallarCrdtLogRepository } from '@shared-server/crdt/InMemoryRallarCrdtLogRepository.ts';
import { installRallarGameAuthorityServer } from '@shared-server/game/mod.ts';
import type { Middleware } from '../src/middleware.ts';
import { createRallarServer } from '../src/create-rallar-server.ts';
import { init as initCrdtAdminRoutes } from '../src/routes/crdt-admin-routes.ts';

Deno.test(
    'createRallarServer wires system topics, lifecycle, routes, and start',
    async () => {
        const runtime = createFakeMiddleware();
        const rallar = createRallarServer({
            middleware: runtime.middleware,
        });

        rallar.system
            .useDefaultMiddlewareTopics()
            .useDefaultMiddlewareTopics()
            .useWebSocketLifecycle()
            .useWebSocketLifecycle();
        rallar.start();

        assert.equal(runtime.starts, 1);
        assert.deepEqual(runtime.inboxTopics, [
            AppTopics.clientStateSnapshot,
            AppTopics.clientStateEvent,
            AppTopics.groupStateSnapshot,
            AppTopics.groupDirectorySnapshot,
            AppTopics.groupStateEvent,
            AppTopics.graphs,
            AppTopics.overlayTopology,
            AppTopics.chat,
            AppTopics.rtt,
            AppTopics.rtcSignaling,
        ]);
        assert.equal(runtime.inboxTopics.some(isAuthorityTopic), false);
        assert.deepEqual(runtime.outboxTopics, [
            AppTopics.clientStateSnapshot,
            AppTopics.clientStateEvent,
            AppTopics.groupStateSnapshot,
            AppTopics.groupDirectorySnapshot,
            AppTopics.groupStateEvent,
            AppTopics.graphs,
            AppTopics.overlayTopology,
        ]);
        assert.equal(runtime.outboxTopics.some(isAuthorityTopic), false);
        assert.deepEqual(
            [...runtime.anyInboxCallbackIds],
            ['dynamic-ws-topic-router'],
        );
        assert.deepEqual(
            [...runtime.websocketCallbackIds],
            ['handle-ws-lifecycle'],
        );

        const app = new Hono();
        rallar.ws.mount(app).mount(app);
        rallar.rest.mount(app).mount(app);

        assert.equal((await app.request('/api/ws/session-1')).status, 426);
        assert.equal((await app.request('/api/docs')).status, 200);
    },
);

Deno.test(
    'createRallarServer exposes Rallar Game Authority as an explicit room-scoped WS extension',
    () => {
        const runtime = createFakeMiddleware();
        const rallar = createRallarServer({
            middleware: runtime.middleware,
        });

        const authority = installRallarGameAuthorityServer<
            { action: string },
            { tick: number },
            { kind: string }
        >({
            rallar,
            protocol: 'test-game.authority.v1',
            topicId: 'room.test-game.authority',
            authority: {
                kind: 'server',
                id: 'api-v1-test-authority',
                epoch: 1,
            },
            handleCommand: () => ({ status: 'accepted' }),
            readSnapshot: () => ({ tick: 0 }),
        });

        assert.deepEqual(authority.authority(), {
            kind: 'server',
            id: 'api-v1-test-authority',
            epoch: 1,
        });
        assert.equal(authority.status().topicId, 'room.test-game.authority');
        assert.equal(runtime.inboxTopics.some(isAuthorityTopic), false);
        assert.equal(runtime.outboxTopics.some(isAuthorityTopic), false);
    },
);

Deno.test(
    'createRallarServer rejects unsupported game authority topic namespaces',
    () => {
        const runtime = createFakeMiddleware();
        const rallar = createRallarServer({
            middleware: runtime.middleware,
        });

        assert.throws(
            () =>
                installRallarGameAuthorityServer<
                    { action: string },
                    { tick: number },
                    { kind: string }
                >({
                    rallar,
                    protocol: 'test-game.authority.v1',
                    topicId: 'game.test-game.authority',
                    handleCommand: () => ({ status: 'accepted' }),
                }),
            /Rallar user WS topic must start with app\. or room\./,
        );
    },
);

Deno.test('CRDT admin routes expose repository health operations', async () => {
    const audit = new InMemoryRallarCrdtAuditSink();
    const repository = new InMemoryRallarCrdtLogRepository({
        now: () => 10_000,
        audit,
    });
    const update = createCrdtUpdate('update-1');
    await repository.append({
        update,
        trusted: {
            authorizationScope: 'room',
            actorId: 'actor-a',
            principalId: 'principal-a',
            acceptedAtEpochMs: 10_000,
        },
    });

    const app = new Hono();
    initCrdtAdminRoutes(app, {
        repository,
        audit,
        now: () => 12_000,
        requireAuth: false,
    });

    const list = await postJson(app, '/api/crdt/admin/documents/list', {});
    assert.equal(list.ok, true);
    assert.equal(list.result.documents.length, 1);
    assert.equal(list.result.documents[0].updateCount, 1);

    const integrity = await postJson(
        app,
        '/api/crdt/admin/documents/integrity',
        {
            document: update.document,
        },
    );
    assert.equal(integrity.ok, true);
    assert.equal(integrity.result.valid, true);
    assert.equal(integrity.result.checkedUpdateCount, 1);

    const debug = await postJson(
        app,
        '/api/crdt/admin/documents/debug-export',
        {
            document: update.document,
            reason: 'test-export',
        },
    );
    assert.equal(debug.ok, true);
    assert.equal(debug.result.format, 'rallar.crdt.debug-bundle.v1');
    assert.equal(debug.result.redaction.payloadsRedacted, true);
    assert.deepEqual(debug.result.records[0].update.payload.operations, []);

    const rebuild = await postJson(
        app,
        '/api/crdt/admin/documents/rebuild-projection',
        {
            document: update.document,
            projectionId: 'test-projection',
        },
    );
    assert.equal(rebuild.ok, true);
    assert.equal(rebuild.result.valid, true);

    const compact = await postJson(app, '/api/crdt/admin/documents/compact', {
        document: update.document,
        reason: 'test-compaction',
    });
    assert.equal(compact.ok, true);
    assert.equal(typeof compact.result.snapshot.snapshotId, 'string');
    assert.equal(compact.result.snapshot.snapshotId.length > 0, true);
    assert.equal(
        (await repository.readSnapshot(update.document))?.metadata.updateCount,
        1,
    );

    const lifecycle = await postJson(
        app,
        '/api/crdt/admin/documents/lifecycle',
        {
            document: update.document,
            lifecycle: 'quarantined',
            changedAtEpochMs: 11_000,
        },
    );
    assert.equal(lifecycle.ok, true);
    assert.equal(lifecycle.result.lifecycle, 'quarantined');

    const erase = await postJson(app, '/api/crdt/admin/documents/erase', {
        document: update.document,
        mode: 'destroy-document',
        requestedBy: 'principal-a',
        reason: 'test-erasure',
    });
    assert.equal(erase.ok, true);
    assert.equal(erase.result.auditEvent.kind, 'erase');
    assert.equal(erase.result.metadata.lifecycle, 'destroyed');
    assert.equal(audit.count('compact'), 1);
    assert.equal(audit.count('quarantine'), 1);
    assert.equal(audit.count('destroy'), 1);
    assert.equal(audit.count('erase'), 1);
});

type FakeRuntime = Readonly<{
    middleware: Middleware;
    inboxTopics: string[];
    outboxTopics: string[];
    anyInboxCallbackIds: Set<string>;
    websocketCallbackIds: Set<string>;
    starts: number;
}>;

function createFakeMiddleware(): FakeRuntime {
    const inboxTopics: string[] = [];
    const outboxTopics: string[] = [];
    const anyInboxCallbackIds = new Set<string>();
    const websocketCallbackIds = new Set<string>();
    let starts = 0;

    const socket = {
        onWebsocketCallbacksDo(id: string): unknown {
            websocketCallbackIds.add(id);
            return this;
        },
        addConnection(): void {
        },
    };

    const wsQBoxServerService = {
        socket,
        onInboxMessageDo(topicId: string): unknown {
            inboxTopics.push(topicId);
            return this;
        },
        onOutboxMessageDo(topicId: string): unknown {
            outboxTopics.push(topicId);
            return this;
        },
        onAnyInboxMessageDo(id: string): unknown {
            anyInboxCallbackIds.add(id);
            return this;
        },
        enqueueOutboxIfAbsent(): Promise<undefined> {
            return Promise.resolve(undefined);
        },
    } as unknown as WsQueueBoxServerService;

    const runtime = {
        qboxEngine: {
            start(): void {
                starts += 1;
            },
        },
        wsQBoxServerService,
        clientsRepository: {},
        groupsRepository: {},
    } as unknown as Middleware;

    return {
        middleware: runtime,
        inboxTopics,
        outboxTopics,
        anyInboxCallbackIds,
        websocketCallbackIds,
        get starts() {
            return starts;
        },
    };
}

const CRDT_ROOM_REF = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1',
};

const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'room-1',
    roomRef: CRDT_ROOM_REF,
};

function createCrdtUpdate(updateId: string): RallarCrdtUpdateEnvelope {
    const updateWithoutHash: RallarCrdtUpdateEnvelope = {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: CRDT_DOCUMENT_REF,
        updateId,
        replicaId: 'replica-a',
        actorId: 'actor-a',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 9_000,
        payload: rallarCrdtBatch([
            {
                kind: 'map.set',
                path: [],
                key: 'title',
                value: 'Admin route test',
            },
        ]),
    };

    return {
        ...updateWithoutHash,
        hash: hashRallarCrdtUpdateEnvelope(updateWithoutHash),
    };
}

function isAuthorityTopic(topicId: string): boolean {
    return topicId.includes('authority');
}

async function postJson(app: Hono, path: string, body: unknown): Promise<any> {
    const response = await app.request(path, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return await response.json();
}
