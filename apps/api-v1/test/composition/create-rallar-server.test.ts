import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { AppDataRepository } from '@shared-server/app-data/app-data-repository.ts';
import { installRallarGameAuthorityServer } from '@shared-server/game/mod.ts';
import type { RallarServerApplicationSystemInstallers } from '@shared-server/rallar-server/rallar-server-application.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1RouteInstallers } from '../../src/composition/create-api-v1-route-installers.ts';
import { createRallarServer } from '../../src/composition/create-rallar-server.ts';

Deno.test('required server assembly preserves explicit owners and mounts each installer once', () => {
    const state = createState();
    const runtime = createRuntime(state);
    const repositories = new RepositoryManager();
    const systemInstallers = createSystemInstallers(state);
    const routeInstallers = createRouteInstallers(state);
    const server = createRallarServer({
        runtime,
        repositories,
        appDataRepository: APP_DATA_REPOSITORY,
        nowEpochMs: () => 1_000,
        ws: {},
        systemInstallers,
        routeInstallers
    });
    const app = new Hono();

    server.installSystemTopics().installSystemTopics();
    server.installWebSocketLifecycle().installWebSocketLifecycle();
    server.mountWebSocket(app).mountWebSocket(app);
    server.mountRest(app).mountRest(app);
    server.start();

    assert.equal(server.runtime, runtime);
    assert.equal(server.repositories, repositories);
    assert.deepEqual(state.events, ['topics', 'lifecycle', 'ws-route', 'rest-route', 'start']);
});

Deno.test('required server assembly retains the room-scoped game authority surface', () => {
    const state = createState();
    const server = createRallarServer({
        runtime: createRuntime(state),
        repositories: new RepositoryManager(),
        appDataRepository: APP_DATA_REPOSITORY,
        nowEpochMs: () => 1_000,
        ws: {},
        systemInstallers: createSystemInstallers(state),
        routeInstallers: createRouteInstallers(state)
    });

    const authority = installRallarGameAuthorityServer<{ action: string; }, { tick: number; }, { kind: string; }>({
        rallar: server,
        protocol: 'test-game.authority.v1',
        topicId: 'room.test-game.authority',
        authority: { kind: 'server', id: 'api-v1-test-authority', epoch: 1 },
        handleCommand: () => ({ status: 'accepted' }),
        readSnapshot: () => ({ tick: 0 })
    });

    assert.deepEqual(authority.authority(), {
        kind: 'server',
        id: 'api-v1-test-authority',
        epoch: 1
    });
    assert.equal(authority.status().topicId, 'room.test-game.authority');
    assert.throws(
        () =>
            installRallarGameAuthorityServer({
                rallar: server,
                protocol: 'test-game.authority.v1',
                topicId: 'game.test-game.authority',
                handleCommand: () => ({ status: 'accepted' })
            }),
        /Rallar user WS topic must start with app\. or room\./
    );
});

interface TestState {
    readonly events: string[];
}

function createState(): TestState {
    return { events: [] };
}

function createRuntime(state: TestState): ApiV1Runtime {
    const wsQBoxServerService = {
        socket: { connections: new Map() },
        onAnyInboxMessageDo: () => wsQBoxServerService,
        removeAnyInboxMessageCallback: () => true
    };
    return Object.assign({} as ApiV1Runtime, {
        wsQBoxServerService,
        qboxEngine: {
            start: () => {
                state.events.push('start');
            },
            wake: () => {}
        }
    });
}

function createSystemInstallers(
    state: TestState
): RallarServerApplicationSystemInstallers<ApiV1Runtime> {
    return {
        installSystemTopics: (runtime) => {
            assert.ok(runtime);
            state.events.push('topics');
        },
        installWebSocketLifecycle: (runtime) => {
            assert.ok(runtime);
            state.events.push('lifecycle');
        }
    };
}

function createRouteInstallers(state: TestState): ApiV1RouteInstallers {
    return {
        webSocket: (app) => {
            assert.ok(app);
            state.events.push('ws-route');
        },
        rest: [
            (app) => {
                assert.ok(app);
                state.events.push('rest-route');
            }
        ]
    };
}

const APP_DATA_REPOSITORY: AppDataRepository = {
    findEntry: () => Promise.resolve(undefined),
    findEntriesPage: () => Promise.resolve([]),
    upsert: () => Promise.resolve(),
    insertIfAbsent: () => Promise.resolve({ status: 'inserted', entry: APP_DATA_ENTRY }),
    upsertIfRevision: () => Promise.resolve({ status: 'written', entry: APP_DATA_ENTRY }),
    deleteByKey: () => Promise.resolve(false),
    deleteIfRevision: () => Promise.resolve({ status: 'conflict' }),
    deleteExpired: () => Promise.resolve(0)
};

const APP_DATA_ENTRY = {
    namespace: 'test',
    storeName: 'test',
    key: 'test',
    value: null,
    schemaVersion: 1,
    expireAtTimestamp: 1_000,
    updatedTimestamp: '1970-01-01T00:00:01.000Z',
    revision: 0
} as const;
