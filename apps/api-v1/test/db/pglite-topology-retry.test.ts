import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { requireRecord } from '@shared-server/rallar-system/protocol/exact-object-decoding.ts';
import { decodeJsonWireValue, hashMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupTopologyConfigMutationCommand } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { createGroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import * as graphTopologyRoutes from '../../src/routes/graph-topology-routes.ts';
import { toResilienceDto } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { canonicalAuditStamp } from './pglite-state-mutation-test-runtime.ts';
import {
    requireTopologyMutationOwners,
    submitPGliteTopologyCommand,
    topologyConfigCommand,
    topologyGroupSnapshot
} from './pglite-topology-test-runtime.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

interface NumericCountRow {
    readonly count: string | number;
}

Deno.test(
    'PGlite topology route preserves structured AppInbox terminal and unavailable failures',
    async () => {
        await withPGliteSql(async (sql) => {
            const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
            const runtime = new PSqlRuntimeStateRepository(sql);
            const resourceInbox = createPSqlResourceInboxRepository(sql);
            const resourceResults = new ResourceInboxResultsRepository(sql);
            const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
            const authSessions = new AuthSessionRepository(runtime);
            const authority: IssuedAuthSession = {
                clientId: 'owner',
                sessionId: 'owner-session',
                accessToken: 'owner-token',
                username: 'owner',
                issuedAtEpochMs: nowEpochMs - 1_000,
                expiresAtEpochMs: FUTURE_MS
            };
            await authSessions.putSession(authority);
            const groupRef = {
                applicationId: 'pglite-topology-route-errors',
                workspaceId: 'default',
                groupId: 'room'
            };
            const snapshot = topologyGroupSnapshot(groupRef);
            const groupRepository = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
            assert.equal((await groupRepository.insertGroup(snapshot.group)).status, 'applied');
            for (const member of snapshot.members) {
                await groupRepository.putMember(member);
            }
            const groupState = createGroupStateService({
                readPlannedLayoutRow: () => Promise.resolve(null),
                readAcceptedLayoutRow: () => Promise.resolve(null),
                runtimeRepository: runtime,
                groupStateEventStore: new PSqlGroupStateEventRepository(sql),
                authSessionRepository: authSessions,
                serviceId: 'pglite-topology-route-errors',
                now: () => nowEpochMs
            });
            const configRepository = new GroupTopologyConfigRepository(runtime);
            const topologyRuntime = createGroupTopologyRuntimeOwners({
                findGroupSnapshotByRef: (ref) => groupRepository.readSnapshot(ref),
                readCurrentGroupSnapshot: async (ref) => await groupRepository.readSnapshot(ref),
                readRttMeasurements: () => [],
                configRepository,
                topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs })
            });
            const topologyMutation = createGroupTopologyMutationOwners({
                groupStateRepository: groupRepository,
                configRepository,
                planning: topologyRuntime.planning,
                nowEpochMs: () => nowEpochMs,
                isPlatformAdmin: () => false,
                outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
            });
            const createAppGroup = (waitMaxElapsedMsecs: number) => {
                const service = new TopologyInboxService(
                    {
                        inboxQueueReader: inboxReader,
                        resourceInboxRepository: resourceInbox.entries,
                        resourceInboxResultsRepository: resourceResults,
                        database: sql,
                        groupStateService: groupState,
                        mutationOwners: requireTopologyMutationOwners(topologyMutation)
                    },
                    {
                        serviceId: 'pglite-topology-route-errors',
                        timing: undefined,
                        options: {
                            waitMaxElapsedMsecs,
                            waitRetryIntervalMsecs: 1,
                            waitMaxRetryIntervalMsecs: 4,
                            waitJitterRatio: 0,
                            nowEpochMs: () => nowEpochMs
                        }
                    }
                );
                return service;
            };
            const appGroup = createAppGroup(5_000);
            const createRouteApp = (service: TopologyInboxService) => {
                const app = new Hono();
                graphTopologyRoutes.registerGraphTopologyRoutes(app, {
                    strictReadAuthorization: false,
                    groupStateService: {
                        readCurrentSnapshot: (ref) => groupRepository.readSnapshot(ref)
                    },
                    graphDiagnostics: {
                        readScopedGlobalGraphDiagnostic: () => Either.ofLeft('Graph diagnostics are unavailable in this mutation-route fixture'),
                        readGroupGraphDiagnostic: () => Either.ofLeft('Graph diagnostics are unavailable in this mutation-route fixture')
                    },
                    topologyQuery: topologyRuntime.query,
                    topologyPlanning: topologyRuntime.planning,
                    processTopologyAppInbox: (authSession, enqueue) => graphTopologyRoutes.processTopologyAppInbox(service, authSession, enqueue),
                    requireApiAuthSession: () => Promise.resolve(authority),
                    adminClientIds: [],
                    readLifecyclePolicy: () => Promise.resolve({ status: 'absent' as const }),
                    readPlannedLayoutFingerprint: () => Promise.resolve(null),
                    now: () => nowEpochMs
                });
                return app;
            };
            const routePath = `/api/state/apps/${groupRef.applicationId}/workspaces/${groupRef.workspaceId}` +
                `/groups/${groupRef.groupId}/topology/config`;
            const submit = (
                app: Hono,
                requestId: string,
                config: GroupTopologyConfigPatch
            ) => app.request(`${routePath}/requests/${requestId}`, {
                method: 'PUT',
                headers: {
                    authorization: 'Bearer owner-token',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ config })
            });

            const validationPending = submit(
                createRouteApp(appGroup),
                'route-validation-request-0001',
                { degreeLimit: 0 }
            );
            await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
            await inboxReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );
            const validation = await validationPending;
            assert.equal(validation.status, 422);
            assert.deepEqual(await validation.json(), {
                type: 'api-mutation-failure',
                version: 'canonical.v2',
                code: 'group-topology-config-validation-failed',
                status: 422,
                message: 'Group topology config validation failed',
                issues: [{
                    code: 'invalid-positive-integer',
                    path: ['degreeLimit'],
                    message: 'degreeLimit must be a positive integer',
                    details: { value: 0 }
                }],
                denial: null,
                retry: null
            });

            const authorityPending = submit(
                createRouteApp(appGroup),
                'route-authority-request-0001',
                { topologyKind: 'tree' }
            );
            await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
            await authSessions.deleteSession(authority);
            await inboxReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );
            const denied = await authorityPending;
            assert.equal(denied.status, 403);
            const denialBody = requireRecord(await denied.json(), 'Topology route denial response');
            assert.equal(denialBody.code, 'group-mutation-authority-denied');
            assert.deepEqual(denialBody.denial, {
                code: 'group-mutation-authority-denied',
                message: 'Forbidden: Topology mutation authority is missing, expired, revoked, or mismatched.',
                details: null
            });
            await authSessions.putSession(authority);

            const firstPending = submit(
                createRouteApp(appGroup),
                'route-idempotency-request-0001',
                { topologyKind: 'tree' }
            );
            await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
            await inboxReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );
            assert.equal((await firstPending).status, 200);
            const conflict = await submit(
                createRouteApp(appGroup),
                'route-idempotency-request-0001',
                { topologyKind: 'mesh' }
            );
            assert.equal(conflict.status, 409);
            assert.equal(
                requireRecord(await conflict.json(), 'Topology conflict response').code,
                'app-inbox-idempotency-conflict'
            );

            const unavailable = await submit(
                createRouteApp(createAppGroup(0)),
                'route-unavailable-request-0001',
                { topologyKind: 'mesh' }
            );
            assert.equal(unavailable.status, 503);
            assert.deepEqual(await unavailable.json(), {
                type: 'api-mutation-failure',
                version: 'canonical.v2',
                code: 'app-inbox-unavailable',
                status: 503,
                message: 'App inbox entry did not complete within the wait budget',
                issues: null,
                denial: null,
                retry: {
                    kind: 'unavailable',
                    retryAfterMs: null,
                    attempts: null,
                    lane: null,
                    queueAgeMs: null,
                    dueAgeMs: null
                }
            });
        });
    }
);

Deno.test('PGlite AppGroup rereads lifecycle after a retryable topology conflict', async () => {
    await withPGliteSql(async (sql) => {
        const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
        const runtime = new PSqlRuntimeStateRepository(sql);
        const resourceInbox = createPSqlResourceInboxRepository(sql);
        const authority: IssuedAuthSession = {
            clientId: 'owner',
            sessionId: 'retry-owner-session',
            accessToken: 'retry-owner-token',
            username: 'owner',
            issuedAtEpochMs: nowEpochMs - 1_000,
            expiresAtEpochMs: FUTURE_MS
        };
        const authSessions = new AuthSessionRepository(runtime);
        await authSessions.putSession(authority);
        const groupRef = {
            applicationId: 'pglite-topology-retry',
            workspaceId: 'lifecycle',
            groupId: 'room'
        };
        const snapshot = topologyGroupSnapshot(groupRef);
        const groupRepository = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
        assert.equal((await groupRepository.insertGroup(snapshot.group)).status, 'applied');
        for (const member of snapshot.members) {
            await groupRepository.putMember(member);
        }
        const configRepository = new GroupTopologyConfigRepository(runtime);
        const topologyRuntime = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: (ref) => groupRepository.readSnapshot(ref),
            readCurrentGroupSnapshot: async (ref) => await groupRepository.readSnapshot(ref),
            readRttMeasurements: () => [],
            configRepository,
            topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs })
        });
        const outboxWriter = new RtcTopologyOutboxWriter({ recordWrite: () => undefined });
        const baselineMutation = createGroupTopologyMutationOwners({
            groupStateRepository: groupRepository,
            configRepository,
            planning: topologyRuntime.planning,
            nowEpochMs: () => nowEpochMs,
            isPlatformAdmin: () => false,
            outboxWriter
        });
        const staleConfigRead = await baselineMutation.configMutation.read(
            topologyConfigCommand(
                groupRef,
                'lifecycle-change-after-conflict',
                'tree'
            )
        );
        const groupState = createGroupStateService({
            readPlannedLayoutRow: () => Promise.resolve(null),
            readAcceptedLayoutRow: () => Promise.resolve(null),
            runtimeRepository: runtime,
            groupStateEventStore: new PSqlGroupStateEventRepository(sql),
            authSessionRepository: authSessions,
            serviceId: 'pglite-topology-retry',
            now: () => nowEpochMs
        });
        let readCount = 0;
        let readsAtFirstRetryRelease = 0;
        let staleReadCount = 0;
        const topologyMutation = createGroupTopologyMutationOwners({
            groupStateRepository: groupRepository,
            configRepository,
            planning: topologyRuntime.planning,
            nowEpochMs: () => nowEpochMs,
            isPlatformAdmin: () => false,
            outboxWriter
        });
        const configMutation = topologyMutation.configMutation;
        const readTopologyConfigMutation = configMutation.read.bind(configMutation);
        configMutation.read = async (command: GroupTopologyConfigMutationCommand) => {
            readCount += 1;
            if (
                command.commandId === 'lifecycle-change-after-conflict' &&
                staleReadCount === 0
            ) {
                staleReadCount += 1;
                return staleConfigRead;
            }
            return await readTopologyConfigMutation(command);
        };
        const onFirstRetryRelease = async () => {
            readsAtFirstRetryRelease = readCount;
            const current = await groupRepository.findGroupEntry(groupRef);
            assert.ok(current);
            assert.equal(
                (await groupRepository.updateGroup({
                    ...current.value,
                    status: 'archived',
                    snapshotVersion: current.value.snapshotVersion + 1,
                    updated: canonicalAuditStamp(2),
                    archived: canonicalAuditStamp(2),
                    deleted: null
                }, current.entry.revision)).status,
                'applied'
            );
        };
        let retryReleaseCount = 0;
        class RetryObservedQueueBox extends PSqlQueueBox {
            override async releaseEntries(
                ...args: Parameters<PSqlQueueBox['releaseEntries']>
            ): ReturnType<PSqlQueueBox['releaseEntries']> {
                const released = await super.releaseEntries(...args);
                if (args[1].status === EntityStatus.RETRY && retryReleaseCount++ === 0) {
                    await onFirstRetryRelease();
                }
                return released;
            }
        }
        const inboxReader = new InboxQueueReader(new RetryObservedQueueBox(resourceInbox));
        const appGroup = new TopologyInboxService(
            {
                inboxQueueReader: inboxReader,
                resourceInboxRepository: resourceInbox.entries,
                resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
                database: sql,
                groupStateService: groupState,
                mutationOwners: requireTopologyMutationOwners(topologyMutation)
            },
            {
                serviceId: 'pglite-topology-retry',
                timing: undefined,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 4,
                    waitJitterRatio: 0,
                    nowEpochMs: () => nowEpochMs
                }
            }
        );
        const seedCommand = await toTopologyAppInboxCommand({
            actor: { principalId: authority.clientId, sessionId: authority.sessionId },
            groupRef,
            requestId: 'lifecycle-conflict-seed-override',
            capturedAtEpochMs: nowEpochMs,
            payload: {
                operation: 'putOverride',
                config: { degreeLimit: 4 },
                ttlMs: 60_000,
                expiresAtEpochMs: null
            }
        });
        const seedPending = submitPGliteTopologyCommand(
            appGroup,
            authority,
            seedCommand
        );
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            toResilienceDto()
        );
        assert.ok((await seedPending).right);
        const command = await toTopologyAppInboxCommand({
            actor: { principalId: authority.clientId, sessionId: authority.sessionId },
            groupRef,
            requestId: 'lifecycle-change-after-conflict',
            capturedAtEpochMs: nowEpochMs,
            payload: { operation: 'putConfig', config: { topologyKind: 'tree' } }
        });
        const pending = submitPGliteTopologyCommand(appGroup, authority, command);
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            toResilienceDto()
        );
        const result = await pending;
        assert.match(result.left?.message ?? '', /active|archived|lifecycle|forbidden/i);
        assert.equal(retryReleaseCount, 1);
        assert.equal(staleReadCount, 1);
        assert.ok(readsAtFirstRetryRelease >= 1);
        assert.ok(readCount > readsAtFirstRetryRelease);
        assert.equal(
            await configRepository.findMutationRecord(
                groupRef,
                command.requestId
            ),
            undefined
        );
    });
});

Deno.test(
    'PGlite topology authority fence rejects an archive overlapping the stable authorization read',
    async () => {
        await withPGliteSql(async (sql) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const topology = new GroupTopologyConfigRepository(runtime);
            const groupState = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
            const groupRef = {
                applicationId: 'pglite-topology-authority',
                workspaceId: 'overlap',
                groupId: 'room'
            };
            const snapshot = topologyGroupSnapshot(groupRef);
            assert.equal((await groupState.insertGroup(snapshot.group)).status, 'applied');
            for (const member of snapshot.members) {
                await groupState.putMember(member);
            }
            const observed = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            let pauseFirstRead = false;
            class PausingGroupStateRepository extends GroupStateRepository {
                override async readSnapshotWithAuthorityGuard(ref: GroupRef) {
                    const observation = await super.readSnapshotWithAuthorityGuard(ref);
                    if (pauseFirstRead) {
                        pauseFirstRead = false;
                        observed.resolve();
                        await release.promise;
                    }
                    return observation;
                }
            }
            const pausingGroupState = new PausingGroupStateRepository(
                runtime,
                new PSqlGroupStateEventRepository(sql)
            );
            const topologyRuntime = createGroupTopologyRuntimeOwners({
                findGroupSnapshotByRef: () => snapshot,
                readCurrentGroupSnapshot: async (ref) => await pausingGroupState.readSnapshot(ref),
                readRttMeasurements: () => [],
                configRepository: topology,
                topologyService: new RallarRtcTopologyService()
            });
            const service = createGroupTopologyMutationOwners({
                groupStateRepository: pausingGroupState,
                configRepository: topology,
                planning: topologyRuntime.planning,
                nowEpochMs: () => 1_000,
                isPlatformAdmin: () => false,
                outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
            });
            const command = topologyConfigCommand(
                groupRef,
                'pglite-overlapping-archive',
                'tree'
            );
            const mutation = service.configMutation;
            const preparation = await mutation.prepare({
                command,
                commandHash: await hashMutationCommand(decodeJsonWireValue(command, 'Topology mutation command')),
                capturedAtEpochMs: 1_000
            });
            pauseFirstRead = true;
            const firstReadPromise = mutation.read(command);
            await observed.promise;
            const current = await groupState.findGroupEntry(groupRef);
            assert.ok(current);
            const archived: Group = {
                ...current.value,
                status: 'archived',
                snapshotVersion: current.value.snapshotVersion + 1,
                updated: canonicalAuditStamp(2),
                archived: canonicalAuditStamp(2),
                deleted: null
            };
            assert.equal(
                (await groupState.updateGroup(archived, current.entry.revision)).status,
                'applied'
            );
            release.resolve();
            const firstRead = await firstReadPromise;
            const firstComputed = mutation.compute(
                preparation,
                firstRead,
                1
            );
            mutation.validate(
                preparation,
                firstRead,
                1,
                firstComputed
            );
            assert.equal(firstComputed.outcome, 'write');
            if (firstComputed.outcome !== 'write') {
                throw new Error('Expected topology write');
            }
            await assert.rejects(
                () => sql.begin((transaction) => mutation.write(transaction, firstComputed)),
                /conditional write conflict/
            );
            const retryRead = await mutation.read(command);
            assert.throws(
                () =>
                    mutation.compute(
                        preparation,
                        retryRead,
                        2
                    ),
                (error) => error instanceof Error && 'status' in error && error.status === 403
            );
            assert.equal(await topology.findConfig(groupRef), undefined);
            assert.equal(
                await topology.findMutationRecord(groupRef, 'pglite-overlapping-archive'),
                undefined
            );
            assert.equal((await groupState.findGroup(groupRef))?.status, 'archived');
            assert.equal(
                Number(
                    (await sql<NumericCountRow[]>`
        select count(*) as count
        from resource_inbox
        where ri_type_id = 'APP_OUTBOX'
      `)[0]?.count
                ),
                0
            );
        });
    }
);
