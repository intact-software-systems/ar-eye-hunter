import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import assert from 'node:assert/strict';

import { toRelicRoomGroupRef } from '@relic-hunters/mod.ts';
import { RELIC_ROOM_DATA_BINDING } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import {
    createRallarServerApplication,
    type RallarServerAppInbox,
    type RallarServerApplication,
    type RallarServerRuntime
} from '@shared-server/mod.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { computeGroupPresenceSummary } from '@shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { InMemoryQueueBox } from '@shared/mod.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import defaults from '@api-v1/resources/configuration/defaults-config.json' with { type: 'json' };
import { createApiV1AppInbox, type CreateApiV1AppInboxInput } from '@api-v1/src/composition/create-api-v1-app-inbox.ts';
import {
    createApiV1MutationRuntime,
    type ApiV1MutationRuntime
} from '@api-v1/src/composition/create-api-v1-mutation-runtime.ts';
import { createApiV1TestQueueResilience } from '@api-v1/test/api-v1-test-queue-resilience.ts';
import { createRelicGameServices, type RelicGameServices } from '../src/create-relic-game-services.ts';

export const RELIC_TEST_GAME_ID = 'cold-expedition';

export interface RelicTestStack {
    readonly owner: IssuedAuthSession;
    readonly sessions: AuthSessionRepository;
    readonly services: RelicGameServices;
    readonly reader: InboxQueueReader;
}

/** A passive producer over one seeded room the owner is live in: admission is open, the caller drains the inbox. */
export async function createRelicTestStack(database: PSqlSql): Promise<RelicTestStack> {
    const now = Date.now();
    const mutation = createRelicTestMutationRuntime(database, now);
    const owner = await seedRelicTestRoom(mutation, now);
    await connectRelicTestSession(mutation, owner, now);
    const runtime = createRelicTestQueueRuntime(mutation);
    const appInbox = createApiV1AppInbox({ mutation, runtime, timing: () => {} });
    const sessions = mutation.authSessionRepository;
    const services = createRelicGameServices({
        database,
        groups: mutation.groupsRepository,
        sessions,
        serviceId: mutation.serviceId,
        roomOwnedAppDataBindings: [RELIC_ROOM_DATA_BINDING],
        appInbox,
        wakeQueue: () => {},
        wsRuntimeName: 'default-qbox-server',
        nowEpochMs: () => now,
        timing: () => {}
    });
    appInbox.start();
    return { owner, sessions, services, reader: runtime.inboxQueueReader };
}

export function createRelicTestMutationRuntime(database: PSqlSql, now: number): ApiV1MutationRuntime {
    return createApiV1MutationRuntime({
        database,
        serviceId: 'cold-worker',
        authCredentialSecret: 'test-secret-for-cold-composition-12345',
        maxConcurrentPasswordDerivations: 1,
        nowEpochMs: () => now,
        timing: () => {},
        appInboxOptions: {
            nowEpochMs: Date.now,
            waitMaxElapsedMsecs: 1000,
            waitRetryIntervalMsecs: 1,
            waitMaxRetryIntervalMsecs: 2,
            waitJitterRatio: 0
        },
        appInboxFinishedRetentionMs: defaults.appInbox.finishedRetentionMs,
        groupCurrentSnapshotCacheMaxEntries: defaults.group.currentSnapshotCacheMaxEntries,
        appInboxNewLaneConcurrency: 1,
        appInboxNewLaneHeldRows: 4,
        disconnectedSessionRetentionMs: 86400000,
        roomOwnedAppDataBindings: [RELIC_ROOM_DATA_BINDING],
        groupCapacity: { defaultMaxMembers: 10 },
        groupFormationRecomputeDebounceMs: 250,
        groupFormationRecomputeMaxWaitMs: 1000,
        adminClientIds: [],
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        resilience: {
            inbox: createApiV1TestQueueResilience(),
            outbox: createApiV1TestQueueResilience(),
            appOutbox: createApiV1TestQueueResilience()
        },
        appInboxCompletionNotices: undefined
    });
}

/** Seeds the owner's session and the open Relic room it owns; returns the owner session. */
export async function seedRelicTestRoom(mutation: ApiV1MutationRuntime, now: number): Promise<IssuedAuthSession> {
    const owner = {
        clientId: 'owner',
        username: 'owner',
        sessionId: 'owner-session',
        accessToken: 'owner-token',
        issuedAtEpochMs: now,
        expiresAtEpochMs: now + 86400000
    };
    await new AuthSessionPersistence(mutation.runtimeStateRepository).putSession(owner);
    const ref = toRelicRoomGroupRef(RELIC_TEST_GAME_ID);
    await writeRelicTestGroupMutation(
        mutation,
        owner,
        now,
        mutationDescriptor({
            operation: 'createGroup',
            scope: ref,
            groupId: ref.groupId,
            request: {
                requestId: 'cold-room',
                groupId: ref.groupId,
                displayName: 'Cold expedition',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                actorPrincipalId: 'owner',
                retention: { mode: 'temporary', reconnectGraceMs: 1000 }
            }
        })
    );
    return owner;
}

export function createRelicTestQueueRuntime(mutation: ApiV1MutationRuntime): CreateApiV1AppInboxInput['runtime'] {
    const qboxEngine = new InboxOutboxEngine();
    const inboxQueueReader = new InboxQueueReader(mutation.queueBox, {
        ...mutation.appInboxDequeueOptions,
        flightEntryListener: (settlement) =>
            qboxEngine.retainSettlingWork(InboxQueueReader.INBOX_ENQUEUE_TYPE, settlement)
    });
    return { inboxQueueReader, qboxEngine };
}

export function createRelicTestApplication(
    mutation: ApiV1MutationRuntime,
    runtime: CreateApiV1AppInboxInput['runtime'],
    appInbox: RallarServerAppInbox
): RallarServerApplication<RallarServerRuntime, void> {
    return createRallarServerApplication<RallarServerRuntime, void>({
        appInbox,
        runtime: {
            qboxEngine: runtime.qboxEngine,
            wsQBoxServerService: createDefaultWsQueueBoxServerService({
                name: 'cold-worker',
                outbox: new InMemoryQueueBox(),
                socket: mutation.webSocketServer,
                inboundVolatileStores: undefined,
                readAuthenticatedConnectionScope: () => undefined,
                queueEngine: runtime.qboxEngine
            })
        },
        repositories: new RepositoryManager(),
        appDataRepository: new PSqlAppDataRepository(mutation.database),
        nowEpochMs: Date.now,
        ws: { grantedTopics: new WsGrantedTopicSet() },
        systemInstallers: { installSystemTopics: () => {}, installWebSocketLifecycle: () => {} },
        routeInstallers: { webSocket: () => {}, rest: [] }
    });
}

/** Dequeues the inbox until the pending caller settles: a passive producer runs no worker of its own. */
export async function drainRelicTestInbox<Result>(reader: InboxQueueReader, pending: Promise<Result>): Promise<Result> {
    let settled = false;
    const observed = pending.finally(() => {
        settled = true;
    });
    observed.catch(() => {});
    while (!settled) {
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return await observed;
}

/** The trace of every Relic publication the WS outbox holds. */
export async function readRelicPublicationTraces(database: PSqlSql): Promise<readonly string[]> {
    const rows = await database<{ traceId: string; }[]>`
        select ri_resource::jsonb #>> '{id,traceId}' as "traceId" from resource_inbox
        where ri_type_id = 'WS_OUTBOX' and ri_resource_id like 'relic:%'
    `;
    return rows.map((row) => row.traceId);
}

/** Connects the owner's live room session, as its WS upgrade would, so group policy admits its room commands. */
async function connectRelicTestSession(
    mutation: ApiV1MutationRuntime,
    owner: IssuedAuthSession,
    now: number
): Promise<void> {
    const ref = toRelicRoomGroupRef(RELIC_TEST_GAME_ID);
    await writeRelicTestGroupMutation(
        mutation,
        owner,
        now,
        mutationDescriptor({
            operation: 'connectPresence',
            scope: ref,
            groupId: ref.groupId,
            sessionId: owner.sessionId,
            request: {
                requestId: `connect-${owner.sessionId}`,
                principalId: owner.clientId,
                generationId: `generation-${owner.sessionId}`,
                connectionGenerationId: `connection-${owner.sessionId}`,
                connectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: now + 60_000,
                actorPrincipalId: owner.clientId
            }
        })
    );
    const observed = await mutation.groupsRepository.readPresenceSummaryEntries(ref);
    if (observed.group === undefined || observed.current === undefined) {
        throw new Error('Expected the seeded room and its presence summary');
    }
    const computed = computeGroupPresenceSummary({
        ref,
        nowEpochMs: now,
        read: {
            group: observed.group,
            members: observed.members,
            admissions: observed.admissions,
            presenceSessions: observed.presenceSessions,
            current: observed.current,
            publicationGrants: observed.publicationGrants
        }
    });
    if (computed.outcome === 'write' && computed.operation === 'update') {
        await mutation.groupsRepository.updatePresenceSummary(computed.summary, computed.expectedRevision);
    }
}

async function writeRelicTestGroupMutation(
    mutation: ApiV1MutationRuntime,
    actor: IssuedAuthSession,
    now: number,
    descriptor: ReturnType<typeof mutationDescriptor>
): Promise<void> {
    const service = mutation.groupStateService;
    const ingress = await service.captureMutationIngress(descriptor, actor);
    const command = {
        ...ingress,
        facts: toGroupMutationAttemptFacts({
            ingressFacts: ingress.facts,
            attemptCount: 1,
            laneNowEpochMs: now,
            traceId: 'trace-relic-game-test-runtime'
        })
    };
    const read = await service.read(command);
    const computed = service.compute(command, read);
    assert.deepEqual(service.validate(command, read, computed), []);
    if (computed.outcome !== 'write') {
        throw new Error('Expected a Relic test room write');
    }
    await mutation.database.begin((transaction) => service.write(transaction, computed));
}
