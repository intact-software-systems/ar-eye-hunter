import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { requireApiAuthSession } from '@shared-server/http/request-auth-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { toAuthenticatedGroupMutationQueueKey } from '@shared-server/rallar-system/group-state/inbox/to-authenticated-group-mutation-queue-key.ts';
import { registerApplicationQueueReaderTasks } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import defaults from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import { createApiV1MutationRuntime, type ApiV1MutationRuntime } from '../../src/composition/create-api-v1-mutation-runtime.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { registerGroupStateRoutes } from '../../src/group-state/register-group-state-routes.ts';
import { toApiMutationRouteFailure } from '../../src/routes/api-mutation-route-failure.ts';
import { createGroupAdmissionQuota } from '../../src/services/group-admission-rate-limit.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { FUTURE_MS, withPGliteSql } from './pglite-auth-test-harness.ts';

interface GroupSetupRequestResult {
    readonly requestId: string;
    readonly status: number;
    readonly body: unknown;
    readonly elapsedMs: number;
}

interface GroupSetupRuntime {
    readonly mutation: ApiV1MutationRuntime;
    readonly engine: InboxOutboxEngine;
    readonly app: Hono;
    readonly requestKeys: ReadonlyMap<string, Key>;
}

interface GroupSetupQueue {
    readonly engine: InboxOutboxEngine;
    readonly groupInbox: GroupStateInboxService;
}

interface GroupSetupRequest {
    readonly requestId: string;
    readonly path: string;
    readonly method: 'POST' | 'PUT';
    readonly body: Readonly<Record<string, string>>;
}

const GROUP_REF = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'ordinary-setup-room' };
const GROUP_PATH = '/api/state/apps/rallar-server/workspaces/default/groups';

Deno.test('PGlite ordinary group setup completes for one director and fourteen concurrent authenticated players', async () => {
    await withPGliteSql(async (sql) => {
        const setup = createGroupSetupRuntime(sql);
        const sessions = await createGroupSetupSessions(setup.mutation);
        const [director, ...players] = sessions;
        assert.ok(director);
        setup.engine.start();
        try {
            const directorResults = await writeGroupSetupRequests(setup.app, director, 'director');
            assert.deepEqual(directorResults.map((result) => result.status), [201, 200]);
            const playerOutcomes = await Promise.allSettled(players.map((session) => writeGroupSetupRequests(setup.app, session, 'player')));
            const playerResults = playerOutcomes.map((outcome) => {
                if (outcome.status === 'rejected') {
                    throw outcome.reason;
                }
                return outcome.value;
            });
            assert.deepEqual(playerResults.map((results) => results.map((result) => result.status)), Array.from({ length: 14 }, () => [409, 200]));
            const snapshot = await setup.mutation.groupsRepository.readSnapshot(GROUP_REF);
            assert.ok(snapshot);
            assert.equal(snapshot.group.ownerPrincipalId, director.clientId);
            assert.equal(snapshot.group.activeMemberCount, 15);
            assert.equal(snapshot.memberCount, 15);
            assert.deepEqual(snapshot.members.map((member) => member.principalId).sort(), sessions.map((session) => session.clientId).sort());
            assert.ok(snapshot.members.every((member) => member.status === 'active'));
            const results = [...directorResults, ...playerResults.flat()];
            await assertGroupSetupDurableResults(setup, results);
            console.log(
                JSON.stringify({
                    requests: results.length,
                    participants: sessions.length,
                    maxRequestElapsedMs: Math.max(...results.map((result) => result.elapsedMs)),
                    groupStatus: 201,
                    existingGroupStatuses: 14,
                    memberStatuses: 15
                })
            );
        }
        finally {
            await setup.engine.stop();
        }
    });
});

function createGroupSetupRuntime(sql: PGliteSql): GroupSetupRuntime {
    const mutation = createGroupSetupMutation(sql);
    const { engine, groupInbox } = createGroupSetupQueue(mutation);
    const requestKeys = new Map<string, Key>();
    const app = createGroupSetupApp(mutation, groupInbox, requestKeys);
    return { mutation, engine, app, requestKeys };
}

function createGroupSetupMutation(sql: PGliteSql): ApiV1MutationRuntime {
    const completion = defaults.appInbox.completionWait;
    return createApiV1MutationRuntime({
        database: sql,
        serviceId: 'pglite-ordinary-setup',
        authCredentialSecret: 'group-setup-test-secret'.repeat(2),
        maxConcurrentPasswordDerivations: 1,
        nowEpochMs: Date.now,
        timing: () => {},
        appInboxOptions: {
            phaseTiming: false,
            waitMaxElapsedMsecs: completion.maxElapsedMs,
            waitRetryIntervalMsecs: completion.retryIntervalMs,
            waitMaxRetryIntervalMsecs: completion.maxRetryIntervalMs,
            waitJitterRatio: completion.jitterRatio,
            nowEpochMs: Date.now
        },
        appInboxNewLaneConcurrency: 1,
        appInboxNewLaneHeldRows: 4,
        appInboxFinishedRetentionMs: defaults.appInbox.finishedRetentionMs,
        disconnectedSessionRetentionMs: defaults.clientSessions.disconnectedRetentionMs,
        groupCapacity: { defaultMaxMembers: defaults.group.defaultMaxMembers },
        groupCurrentSnapshotCacheMaxEntries: defaults.group.currentSnapshotCacheMaxEntries,
        groupFormationRecomputeDebounceMs: defaults.topology.recompute.formationDebounceMs,
        groupFormationRecomputeMaxWaitMs: defaults.topology.recompute.formationMaxWaitMs,
        adminClientIds: [],
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        resilience: { inbox: createApiV1TestQueueResilience(), outbox: createApiV1TestQueueResilience(), appOutbox: createApiV1TestQueueResilience() },
        appInboxCompletionNotices: undefined
    });
}

function createGroupSetupQueue(mutation: ApiV1MutationRuntime): GroupSetupQueue {
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
        name: 'pglite-ordinary-setup',
        readAuthenticatedConnectionScope: () => undefined
    });
    const groupInbox = mutation.createGroupStateInboxService({
        wsQBoxServerService,
        appInboxResilience: mutation.resilience.inbox,
        appOutboxResilience: mutation.resilience.appOutbox,
        inboxQueueReader,
        outboxQueueReader,
        wakeQueueEngine: () => engine.wakeAfterExternalWrite(new Set([EnqueuedType.APP_INBOX, EnqueuedType.APP_OUTBOX, EnqueuedType.WS_OUTBOX]))
    });
    registerApplicationQueueReaderTasks({
        engine,
        nowEpochMs: Date.now,
        inboxQueueReader,
        outboxQueueReader,
        appInboxResilience: mutation.resilience.inbox,
        appOutboxResilience: mutation.resilience.appOutbox
    });
    // Downstream topology publication is outside the AppInbox setup mutation boundary.
    engine.excludeTask(OutboxQueueReader.OUTBOX_ENQUEUE_TYPE);
    return { engine, groupInbox };
}

function createGroupSetupApp(mutation: ApiV1MutationRuntime, groupInbox: GroupStateInboxService, requestKeys: Map<string, Key>): Hono {
    const app = new Hono();
    registerGroupStateRoutes(app, {
        groupStateService: mutation.groupStateService,
        rtcRttRepository: new RtcRttRepository(mutation.runtimeStateRepository),
        requireApiAuthSession: (request) => requireApiAuthSession(request, mutation.authSessionRepository),
        processGroupAppInbox: async (authority, enqueue) => {
            assert.ok(enqueue.resourceId);
            assert.ok(enqueue.topicId);
            assert.ok(enqueue.contextId);
            requestKeys.set(enqueue.resourceId, toAuthenticatedGroupMutationQueueKey(enqueue));
            const result = await groupInbox.processAuthenticatedGroupEntryUntilCompletion(enqueue, authority);
            return result.fold((failure) => {
                throw toApiMutationRouteFailure(failure);
            }, (value) => value);
        },
        processQuickJoin: (input, authority) => groupInbox.processQuickJoinUntilCompletion(input, authority),
        groupAdmissionQuota: createGroupAdmissionQuota(defaults.group.admission),
        strictReadAuthorization: true,
        groupDefaultMaxMembers: defaults.group.defaultMaxMembers,
        nowEpochMs: () => Date.now(),
        hydrateStateSyncSnapshotCaches: () => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 }),
        findStateSyncGroupSnapshot: () => undefined,
        readGroupSnapshot: async (ref) => {
            const snapshot = await mutation.groupsRepository.readSnapshot(ref);
            return snapshot ? { status: 'found', source: 'durable', snapshot } : { status: 'not-found', source: 'durable' };
        }
    });
    return app;
}

async function createGroupSetupSessions(mutation: ApiV1MutationRuntime): Promise<readonly IssuedAuthSession[]> {
    const sessions = Array.from({ length: 15 }, (_, index): IssuedAuthSession => ({
        clientId: `controller-${String(index + 1).padStart(2, '0')}`,
        username: `participant-${index + 1}`,
        sessionId: `setup-session-${index + 1}`,
        accessToken: `setup-test-token-${index + 1}`,
        issuedAtEpochMs: Date.now() - 1_000,
        expiresAtEpochMs: FUTURE_MS
    }));
    for (const session of sessions) {
        await mutation.authSessionRepository.putSession(session);
    }
    return sessions;
}

async function writeGroupSetupRequests(app: Hono, session: IssuedAuthSession, role: 'director' | 'player'): Promise<readonly GroupSetupRequestResult[]> {
    const groupRequestId = `alm-scale-${role}-ensure-group-${session.clientId}`;
    const memberRequestId = `alm-scale-${role}-ensure-member-${session.clientId}`;
    const group = await writeGroupSetupRequest(app, session, {
        requestId: groupRequestId,
        path: `${GROUP_PATH}/requests/${groupRequestId}`,
        method: 'POST',
        body: { groupId: GROUP_REF.groupId, displayName: GROUP_REF.groupId, kind: 'room', joinMode: 'open' }
    });
    const member = await writeGroupSetupRequest(app, session, {
        requestId: memberRequestId,
        path: `${GROUP_PATH}/${GROUP_REF.groupId}/members/${session.clientId}/requests/${memberRequestId}`,
        method: 'PUT',
        body: { status: 'active' }
    });
    return [group, member];
}

async function writeGroupSetupRequest(app: Hono, session: IssuedAuthSession, request: GroupSetupRequest): Promise<GroupSetupRequestResult> {
    const startedAt = performance.now();
    const pending = Promise.resolve(app.request(request.path, {
        method: request.method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId },
        body: JSON.stringify(request.body)
    })).then(async (response) => ({
        requestId: request.requestId,
        status: response.status,
        body: await response.json(),
        elapsedMs: performance.now() - startedAt
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${request.requestId} exceeded 5000 ms HTTP allowance`)), 5_000);
            })
        ]);
    }
    finally {
        clearTimeout(timer);
        await pending.catch(() => undefined);
    }
}

async function assertGroupSetupDurableResults(setup: GroupSetupRuntime, results: readonly GroupSetupRequestResult[]): Promise<void> {
    for (const result of results) {
        assert.ok(result.elapsedMs < 5_000, result.requestId);
        const key = setup.requestKeys.get(result.requestId);
        assert.ok(key, result.requestId);
        const queued = await setup.mutation.resourceInboxRepository.entries.findAnyByKey(key);
        const durable = await setup.mutation.resourceInboxResultsRepository.findAnyByKey(key);
        assert.ok(queued, result.requestId);
        assert.ok(durable, result.requestId);
        const body = JSON.parse(durable.resource);
        if (result.status === 409) {
            assert.equal(queued.status, EntityStatus.FAILED);
            assert.equal(durable.status, EntityStatus.FAILED);
            assert.equal(body.code, 'group-already-exists');
        }
        else {
            assert.equal(queued.status, EntityStatus.COMPLETED);
            assert.equal(durable.status, EntityStatus.COMPLETED);
            assert.equal(body.status, result.status === 201 ? 'created' : 'ok');
            assert.deepEqual(body.result.snapshot, result.body);
        }
    }
}
