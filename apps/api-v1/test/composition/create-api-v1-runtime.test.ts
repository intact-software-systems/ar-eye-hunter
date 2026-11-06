import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeAppOutboxInsert, writeAppOutboxInserts } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import { toAuthorisedWsClientConnection } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { computeViewInvalidationPublication } from '@shared-server/rallar-system/websocket/outbox/compute-view-invalidation-publication.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import { computeRuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { writeRuntimeStateConditionalBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';
import assert from 'node:assert/strict';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { putAuthorisedWsTestTicket } from '../../../../packages/tests/shared-server/rallar-system/client-state/authorised-ws-test-ticket.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/client-state/test-disconnected-session-retention.ts';
import { TestWebSocket } from '../../../../packages/tests/shared/websocket/test-web-socket.ts';
import { createApiV1BackgroundTaskLifecycle } from '../../src/composition/api-v1-background-task-lifecycle.ts';
import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { createApiV1PartyServices } from '../../src/composition/create-api-v1-party-services.ts';
import { createApiV1Runtime, type CreateApiV1RuntimeInput } from '../../src/composition/create-api-v1-runtime.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from '../../src/db/api-v1-database-lifecycle.ts';
import { API_V1_LIVE_WS_NOTICE_CHANNEL } from '../../src/db/api-v1-live-ws-notice-transport.ts';
import { createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';
import { releaseAuthorisedWsCloseFacts, rememberAuthorisedWsConnection } from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { createRuntimeStateExpiryLifecycle } from '../../src/services/runtime-state-expiry-startup.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';
import { waitFor } from '../db/pglite-traced-rallar-test-runtime.ts';

const SCOPE = { applicationId: 'composition-app', workspaceId: 'default' };

Deno.test('runtime rejects missing room bindings and invalid lease margins before SQL or background startup', () => {
    let effects = 0;
    const unreachable = (): never => {
        effects += 1;
        throw new Error('Unexpected startup effect');
    };
    const database: PSqlSql = Object.assign(unreachable, { begin: unreachable });
    const backgroundTasks = {
        beginStartupGeneration: unreachable,
        register: unreachable,
        stop: async () => {
            unreachable();
        }
    };
    const input = createInput(database, backgroundTasks, new NotificationPort());
    const missing = { ...input };
    Reflect.deleteProperty(missing, 'roomOwnedAppDataBindings');
    assert.throws(() => createApiV1Runtime(missing), /room-owned|Room-owned/);
    for (const attemptDeadlineMarginMs of [0, input.resilience.inbox.reservationLeaseMs, input.resilience.inbox.reservationLeaseMs + 1]) {
        assert.throws(() => createApiV1Runtime({ ...input, appInboxOptions: { nowEpochMs: Date.now, attemptDeadlineMarginMs } }), /attempt deadline margin/);
    }
    assert.equal(effects, 0);
});

Deno.test('real runtime commits a party notice through AppInbox and sends only to its authenticated own account', async () => {
    const fixture = await createFixture();
    try {
        const alice = await connectAccount(fixture.runtime, 'alice', fixture.releases);
        const bob = await connectAccount(fixture.runtime, 'bob', fixture.releases);
        const ref = { ...SCOPE, partyId: 'private-party' };
        const result = await fixture.parties.mutation.submit({
            command: {
                principalId: 'alice',
                sessionId: alice.session.sessionId,
                sessionIssuedAtEpochMs: alice.session.issuedAtEpochMs,
                sessionExpiresAtEpochMs: alice.session.expiresAtEpochMs,
                requestId: 'create-private-party',
                request: { ref, expectedRosterRevision: null, intent: { action: 'create' } },
                capturedAtEpochMs: null,
                policy: null
            },
            traceId: 'runtime-party-create'
        });
        assert.ok(result.right);
        const notice = await waitFor('native own-account party notice', async () => messages(alice.native, AppTopics.viewInvalidated)[0]);
        assert.equal(notice.id.senderId, fixture.runtime.wsQBoxServerService.name);
        assert.notEqual(notice.id.senderId, fixture.input.serviceId);
        assert.deepEqual(decodeViewInvalidationMessage(notice), {
            version: 1,
            resource: 'party',
            scope: SCOPE,
            principalId: 'alice',
            changeId: JSON.parse(notice.payload.resource).changeId
        });
        assert.deepEqual(messages(bob.native, AppTopics.viewInvalidated), []);
        assert.equal((await fixture.parties.reader.read(SCOPE, 'alice')).party?.ref.partyId, 'private-party');

        const corrupted = await writeCorruptPublication(fixture.sql, fixture.runtime.wsQBoxServerService.name);
        await waitFor('rejected forged account publication', async () => {
            const stored = await fixture.runtime.wsQBoxServerService.outbox.getItem(corrupted.key);
            return stored?.status === EntityStatus.NON_RETRYABLE ? stored : undefined;
        });
        assert.equal(messages(alice.native, AppTopics.viewInvalidated).length, 1);
        assert.equal(messages(bob.native, AppTopics.viewInvalidated).length, 0);
    }
    finally {
        await fixture.stop();
    }
});

Deno.test('real runtime resubscribing either PostgreSQL listener resyncs unchanged authenticated sockets only', async () => {
    const fixture = await createFixture();
    try {
        const alice = await connectAccount(fixture.runtime, 'alice', fixture.releases);
        const anonymous = new TestWebSocket('ws://anonymous');
        anonymous.open();
        fixture.runtime.wsQBoxServerService.socket.addConnection(new ConnectionContext({ id: 'anonymous', socket: anonymous }));
        const baseline = messages(alice.native, AppTopics.viewResync).length;
        for (
            const channel of [fixture.input.queuePubSubChannel, API_V1_LIVE_WS_NOTICE_CHANNEL, fixture.input.queuePubSubChannel, API_V1_LIVE_WS_NOTICE_CHANNEL]
        ) {
            fixture.notifications.resubscribe(channel);
        }
        assert.equal(messages(alice.native, AppTopics.viewResync).length, baseline + 4);
        assert.deepEqual(messages(anonymous, AppTopics.viewResync), []);
        assert.equal(fixture.runtime.wsQBoxServerService.socket.connections.get(alice.connection.id), alice.connection);
    }
    finally {
        await fixture.stop();
        await fixture.stop();
    }
});

function messages(native: TestWebSocket, topic: string): ALMessage[] {
    return native.sent.map((value) => JSON.parse(value) as ALMessage).filter((message) => message.route.topicId === topic);
}

interface ApiRuntimeFixture {
    readonly runtime: ApiV1Runtime;
    readonly input: CreateApiV1RuntimeInput;
    readonly parties: ReturnType<typeof createApiV1PartyServices>;
    readonly notifications: NotificationPort;
    readonly releases: (() => void)[];
    readonly sql: PSqlSql;
    readonly stop: () => Promise<void>;
}

async function createFixture(): Promise<ApiRuntimeFixture> {
    const database = await createApiV1TestPGliteDatabaseLifecycle();
    const backgroundTasks = createApiV1BackgroundTaskLifecycle({ runtimeStateExpiry: createRuntimeStateExpiryLifecycle() });
    const notifications = new NotificationPort();
    const input = createInput(database.database, backgroundTasks, notifications);
    const runtime = createApiV1Runtime(input);
    const releases: (() => void)[] = [];
    const parties = createApiV1PartyServices({
        configuration: decodeApiV1Configuration(validDecodeApiV1ConfigurationInput()),
        runtime,
        runtimeStateRepository: new PSqlRuntimeStateRepository(database.database),
        nowEpochMs: Date.now,
        timing: undefined
    });
    runtime.appInbox.start();
    await runtime.readiness;
    runtime.qboxEngine.start();
    let stopped: Promise<void> | undefined;
    const stop = () =>
        stopped ??= (async () => {
            await runtime.wsQBoxServerService.dispose();
            await runtime.qboxEngine.stop();
            await backgroundTasks.stop();
            releases.forEach((release) => release());
            await database.close();
        })();
    return { runtime, input, parties, notifications, releases, sql: database.database, stop };
}

interface ConnectedAccount {
    readonly session: PersistedAuthSession;
    readonly native: TestWebSocket;
    readonly connection: ConnectionContext;
}

async function connectAccount(runtime: ApiV1Runtime, principalId: string, releases: (() => void)[]): Promise<ConnectedAccount> {
    const issued = await runtime.appAuthInboxService.issueSession({
        requestId: `runtime-${principalId}`,
        traceId: `runtime-${principalId}`,
        clientId: principalId,
        username: principalId,
        authority: { kind: 'static-client', clientId: principalId, normalizedUsername: principalId },
        ttlMs: 3600000
    });
    assert.ok(issued.right);
    const session = await runtime.authSessionRepository.findBySessionId(issued.right.sessionId);
    assert.ok(session);
    const generationId = crypto.randomUUID();
    const now = Date.now();
    const input = { ...SCOPE, clientInstanceId: `browser-${principalId}`, connectedAtEpochMs: now, expiresAtEpochMs: now + 60000 };
    const ticketDigest = await putAuthorisedWsTestTicket(runtime.authSessionRepository, session);
    const connected = await runtime.appClientInboxService.writeAuthorisedWsClientConnect({
        authSession: session,
        generationId,
        ticketDigest,
        input,
        traceId: `connect-${principalId}`
    });
    assert.equal(connected.right?.status, 'ok');
    const native = new TestWebSocket(`ws://${principalId}`);
    native.open();
    const connection = new ConnectionContext({ id: session.sessionId, socket: native, generationId, generationStartedAtEpochMs: now });
    rememberAuthorisedWsConnection(session.sessionId, generationId, toAuthorisedWsClientConnection({ authSession: session, generationId, input }));
    runtime.wsQBoxServerService.socket.addConnection(connection);
    releases.push(() =>
        releaseAuthorisedWsCloseFacts({
            sessionId: session.sessionId,
            generationId,
            generationStartedAtEpochMs: now,
            disconnectedAtEpochMs: Date.now(),
            reason: 'test-cleanup'
        })
    );
    return { session, native, connection };
}

async function writeCorruptPublication(sql: PSqlSql, serviceId: string): Promise<ResourceEntry> {
    const publication = computeViewInvalidationPublication({
        resource: 'party',
        scope: SCOPE,
        principalIds: ['alice'],
        changeId: 'forged-view',
        createdAtEpochMs: Date.now(),
        retentionMs: 60000,
        serviceId,
        traceId: 'forged-view'
    });
    const [proof] = publication.provenance;
    assert.ok(proof?.operation === 'insert');
    const storage = {
        creation: null,
        inserts: [],
        batch: computeRuntimeStateGuardedBatchWrite({
            guard: { operation: 'insert', namespace: proof.namespace, key: proof.key, value: proof.value, expireAtTimestamp: proof.expireAtTimestamp },
            effects: []
        })
    };
    const entry = publication.outbox[0]!.entry;
    const message: ALMessage = JSON.parse(entry.resource);
    const corrupt = {
        ...entry,
        resource: JSON.stringify({
            ...message,
            payload: { ...message.payload, resource: JSON.stringify({ ...JSON.parse(message.payload.resource), principalId: 'bob' }) }
        })
    };
    const outbox = [computeAppOutboxInsert(corrupt)];
    await sql.begin(async (transaction) => {
        await writeRuntimeStateConditionalBatch(transaction, storage);
        await writeAppOutboxInserts(transaction, outbox);
    });
    return corrupt;
}

namespace NotificationPort {
    export interface Listener {
        readonly onMessage: (payload: string) => void | Promise<void>;
        readonly onSubscribed: (() => void) | undefined;
    }
}

/** Exercises production transport callbacks without substituting runtime construction. */
class NotificationPort implements ApiV1DatabaseNotificationPort {
    private readonly listeners = new Map<string, NotificationPort.Listener[]>();
    async notify(channel: string, message: object): Promise<void> {
        for (const listener of this.listeners.get(channel) ?? []) {
            await listener.onMessage(JSON.stringify(message));
        }
    }
    async listen(channel: string, onMessage: (payload: string) => void | Promise<void>, onSubscribed?: () => void): Promise<void> {
        const listeners = this.listeners.get(channel) ?? [];
        listeners.push({ onMessage, onSubscribed });
        this.listeners.set(channel, listeners);
        onSubscribed?.();
    }
    resubscribe(channel: string): void {
        const listeners = this.listeners.get(channel);
        assert.ok(listeners);
        assert.ok(listeners.some((listener) => listener.onSubscribed !== undefined), `Missing subscription readiness for ${channel}`);
        listeners.forEach((listener) => listener.onSubscribed?.());
    }
}

function createInput(
    database: PSqlSql,
    backgroundTasks: CreateApiV1RuntimeInput['backgroundTasks'],
    notification: ApiV1DatabaseNotificationPort
): CreateApiV1RuntimeInput {
    const identity = crypto.randomUUID();
    return {
        database,
        backgroundTasks,
        serviceId: `api-${identity}`,
        publisherStreamId: crypto.randomUUID(),
        queuePubSubPublisherId: `publisher-${identity}`,
        queuePubSubChannel: 'runtime-test-ws',
        queuePubSubLocalBus: createLocalQueuePubSubBus(),
        wsRuntimeName: `ws-${identity}`,
        authCredentialSecret: 'a'.repeat(32),
        maxConcurrentPasswordDerivations: 1,
        nowEpochMs: Date.now,
        timing: () => {},
        appInboxOptions: { nowEpochMs: Date.now },
        appInboxNewLaneConcurrency: 1,
        appInboxNewLaneHeldRows: 4,
        appInboxFinishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS,
        roomOwnedAppDataBindings: [],
        groupCapacity: { defaultMaxMembers: 10 },
        groupCurrentSnapshotCacheMaxEntries: 512,
        groupFormationRecomputeDebounceMs: 250,
        groupFormationRecomputeMaxWaitMs: 1000,
        databasePubSubMode: 'postgres',
        databaseNotification: notification,
        topologyReplay: { mode: 'disabled', queueWorkers: 'disabled' },
        topologyDelivery: TEST_TOPOLOGY_DELIVERY,
        adminClientIds: ['admin'],
        rtcTopologyOptions: { rttReplanMinimumLayoutAgeMs: 15000 },
        rttRefinementGateConfig: { minIntervalMs: 0, vivaldiDeltaThresholdMs: 0 },
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        grantedTopics: new WsGrantedTopicSet(),
        resilience: { inbox: createApiV1TestQueueResilience(), outbox: createApiV1TestQueueResilience(), appOutbox: createApiV1TestQueueResilience() }
    };
}
const TEST_TOPOLOGY_DELIVERY: CreateApiV1RuntimeInput['topologyDelivery'] = {
    publicationRetentionMs: 86_400_000,
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    antiEntropyIntervalMs: 1_000,
    pageSize: 100,
    maxPagesPerTurn: 10,
    maxEntriesPerTurn: 1_000,
    compactionIntervalMs: 60_000,
    compactionPageSize: 1_000,
    reconnectBatchWindowMs: 25,
    consumerRetentionMs: 86_400_000
};
