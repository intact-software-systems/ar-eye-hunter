import assert from 'node:assert/strict';

import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';
import { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/client-state/test-disconnected-session-retention.ts';
import {
    createApiV1MutationRuntime,
    type ApiV1MutationRuntime
} from '../../src/composition/create-api-v1-mutation-runtime.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';

Deno.test('mutation runtime keeps one database identity and performs no construction query', () => {
    const databaseProbe = createDatabaseProbe();
    const mutation = createProbedMutationRuntime(databaseProbe.database);

    assert.equal(mutation.runtimeStateRepository.sql, databaseProbe.database);
    assert.equal(mutation.queueBox.resourceInbox, mutation.resourceInboxRepository);
    assert.equal(databaseProbe.queryCount(), 0);
    assert.equal(databaseProbe.transactionCount(), 0);
});

/** One status batch per tick covers every waiter of the process only while they all read through one entries repository. */
Deno.test('mutation runtime gives every AppInbox service it composes the one entries repository of its queue', () => {
    const mutation = createProbedMutationRuntime(createDatabaseProbe().database);
    const services = createComposedInboxServices(mutation);

    for (const [name, service] of Object.entries(services)) {
        const ports = readAppInboxEntryPorts(service);
        assert.ok(ports.length > 0, `${name} composes no AppInbox client`);
        for (const port of ports) {
            assert.equal(port, mutation.resourceInboxRepository.entries, name);
        }
    }
    assert.equal(mutation.queueBox.resourceInbox.entries, mutation.resourceInboxRepository.entries);
});

function createProbedMutationRuntime(database: PSqlSql): ApiV1MutationRuntime {
    return createApiV1MutationRuntime({
        database,
        serviceId: 'api-test',
        authCredentialSecret: 'a'.repeat(32),
        maxConcurrentPasswordDerivations: 1,
        nowEpochMs: () => 1_000,
        timing: () => {},
        appInboxOptions: { nowEpochMs: () => 1_000 },
        appInboxNewLaneConcurrency: 1,
        appInboxNewLaneHeldRows: 4,
        appInboxFinishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS,
        roomOwnedAppDataBindings: [],
        groupCapacity: { defaultMaxMembers: 10 },
        groupCurrentSnapshotCacheMaxEntries: 512,
        groupFormationRecomputeDebounceMs: 250,
        groupFormationRecomputeMaxWaitMs: 1_000,
        adminClientIds: ['admin-1'],
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        resilience: {
            inbox: createApiV1TestQueueResilience(),
            outbox: createApiV1TestQueueResilience(),
            appOutbox: createApiV1TestQueueResilience()
        },
        appInboxCompletionNotices: undefined
    });
}

/** Every AppInbox service the mutation runtime composes, built as the middleware builds them. */
function createComposedInboxServices(mutation: ApiV1MutationRuntime): Readonly<Record<string, object>> {
    const engine = new InboxOutboxEngine();
    const inboxQueueReader = new InboxQueueReader(mutation.queueBox, {
        ...mutation.appInboxDequeueOptions,
        flightEntryListener: (settlement) => engine.retainSettlingWork(InboxQueueReader.INBOX_ENQUEUE_TYPE, settlement)
    });
    const outboxQueueReader = new OutboxQueueReader(mutation.queueBox);
    const wsQBoxServerService = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        inboundStores: createDefaultPSqlALInboundRuntimeStores({ repository: mutation.runtimeStateRepository }),
        outboundStores: createDefaultPSqlALOutboundRuntimeStores({
            repository: mutation.runtimeStateRepository,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        }),
        queueEngine: engine,
        outbox: mutation.queueBox,
        socket: mutation.webSocketServer,
        name: 'composition-test',
        readAuthenticatedConnectionScope: () => undefined
    });
    const factoryInput = {
        inboxQueueReader,
        outboxQueueReader,
        wsQBoxServerService,
        appInboxResilience: mutation.resilience.inbox,
        appOutboxResilience: mutation.resilience.appOutbox,
        wakeQueueEngine: () => {}
    };
    return {
        groupState: mutation.createGroupStateInboxService(factoryInput),
        appClient: mutation.createAppClientInboxService(factoryInput),
        appAuth: mutation.createAppAuthInboxService(factoryInput),
        appAdmin: mutation.createAppAdminInboxService(factoryInput),
        appCrdt: mutation.createAppCrdtInboxService(factoryInput)
    };
}

/** The entries ports of every result waiter and reservation client a service holds, directly or in its command client. */
function readAppInboxEntryPorts(service: object): readonly object[] {
    const held = Object.values(service)
        .filter(isHeldObject)
        .flatMap((value) => [value, ...Object.values(value).filter(isHeldObject)]);
    return held.flatMap((value) => {
        if (value instanceof AppInboxResultWaiter) {
            return [Reflect.get(value, 'statusRepository')];
        }
        if (value instanceof AppInboxReservationClient) {
            return [Reflect.get(value, 'repository')];
        }
        return [];
    });
}

interface DatabaseProbe {
    readonly database: PSqlSql;
    queryCount(): number;
    transactionCount(): number;
}

function createDatabaseProbe(): DatabaseProbe {
    let queries = 0;
    let transactions = 0;
    function query<T>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<T>;
    function query(_values: readonly PSqlParameter[]): object;
    function query(
        _input: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): never {
        queries += 1;
        throw new Error('query not expected');
    }
    const database: PSqlSql = Object.assign(
        query,
        {
            begin<T>(_operation: (transaction: PSqlSql) => Promise<T>): Promise<T> {
                transactions += 1;
                return Promise.reject(new Error('transaction not expected'));
            }
        }
    );

    return {
        database,
        queryCount: () => queries,
        transactionCount: () => transactions
    };
}

function isHeldObject(value: object | null): value is object {
    return typeof value === 'object' && value !== null;
}
