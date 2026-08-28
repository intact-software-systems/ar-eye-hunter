import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { requirePlannedTopology } from '@shared-test/shared-server/require-planned-topology.ts';
import assert from 'node:assert/strict';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { RtcTopologyDeliveryLeaseLostError } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-stream-service.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupPresenceSummary, GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import { toResilienceDto } from '../api-v1-test-queue-resilience.ts';
import { readPGliteDatabaseEpochMs } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { canonicalAuditStamp } from './pglite-state-mutation-test-runtime.ts';
import {
    activeTopologySnapshot,
    createPGliteRemovalPlanningScenario,
    createPGliteTopologyWorkFixture,
    readRtcTopologyDeliveryState,
    topologyGroupSnapshot,
    topologyGroupSnapshotWithSessionIds
} from './pglite-topology-test-runtime.ts';

interface NumericCountRow {
    readonly count: string | number;
}

interface ResourceInboxAttemptStatusRow {
    readonly ri_attempts: string | number;
    readonly ri_status: string;
}

Deno.test(
    'PGlite topology planning uses the immutable group update time for a planned removal tombstone',
    async () => {
        await withPGliteSql(async (sql) => {
            const scenario = await createPGliteRemovalPlanningScenario(sql, {
                name: 'immutable-removal-time',
                status: 'archived',
                expiresAtEpochMs: null,
                updatedAtEpochMs: 123
            });

            const result = requirePlannedTopology(scenario.service.planning.computeTopologyFromAuthority(
                scenario.authority,
                scenario.previous,
                { intent: 'full-rebuild', origin: 'automatic' }
            ));

            assert.equal(result.snapshot.state, 'removed');
            assert.equal(result.snapshot.updatedAtEpochMs, 123);
            assert.equal(result.snapshot.createdAtEpochMs, 1);
        });
    }
);

Deno.test(
    'PGlite topology planning does not let a stale removal delete a newer active topology',
    async () => {
        await withPGliteSql(async (sql) => {
            const scenario = await createPGliteRemovalPlanningScenario(sql, {
                name: 'newer-active',
                status: 'active',
                expiresAtEpochMs: null,
                updatedAtEpochMs: 200
            });

            const result = requirePlannedTopology(scenario.service.planning.computeTopologyFromAuthority(
                scenario.authority,
                scenario.previous,
                { intent: 'full-rebuild', origin: 'automatic' }
            ));

            assert.equal(scenario.authority.group.group.status, 'active');
            assert.equal(result.snapshot.state, 'active');
            assert.deepEqual(
                result.snapshot.sourceGroupStateCausalRevision,
                scenario.authority.group.causalRevision
            );
        });
    }
);

Deno.test(
    'PGlite topology planning does not treat a newer expired active group as removal cancellation',
    async () => {
        await withPGliteSql(async (sql) => {
            const scenario = await createPGliteRemovalPlanningScenario(sql, {
                name: 'newer-expired',
                status: 'active',
                expiresAtEpochMs: 999,
                updatedAtEpochMs: 201
            });

            const result = requirePlannedTopology(scenario.service.planning.computeTopologyFromAuthority(
                scenario.authority,
                scenario.previous,
                { intent: 'full-rebuild', origin: 'automatic' }
            ));

            assert.equal(scenario.authority.group.group.status, 'active');
            assert.equal(result.snapshot.state, 'removed');
            assert.deepEqual(
                result.snapshot.sourceGroupStateCausalRevision,
                scenario.authority.group.causalRevision
            );
        });
    }
);

Deno.test(
    'PGlite topology planning replans a stale removal from the newer terminal group authority',
    async () => {
        await withPGliteSql(async (sql) => {
            const scenario = await createPGliteRemovalPlanningScenario(sql, {
                name: 'newer-terminal',
                status: 'archived',
                expiresAtEpochMs: null,
                updatedAtEpochMs: 202
            });

            const result = requirePlannedTopology(scenario.service.planning.computeTopologyFromAuthority(
                scenario.authority,
                scenario.previous,
                { intent: 'full-rebuild', origin: 'automatic' }
            ));

            assert.equal(scenario.authority.group.group.status, 'archived');
            assert.equal(result.snapshot.state, 'removed');
            assert.equal(result.snapshot.updatedAtEpochMs, 202);
            assert.deepEqual(
                result.snapshot.sourceGroupStateCausalRevision,
                scenario.authority.group.causalRevision
            );
        });
    }
);

Deno.test(
    'PGlite topology planning filters RTTs outside recomputed group reporting edges',
    async () => {
        await withPGliteSql(async (sql) => {
            const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
            const groupRef = {
                applicationId: 'pglite-topology-rtt-filter',
                workspaceId: 'planning',
                groupId: 'room'
            };
            const group = topologyGroupSnapshotWithSessionIds(
                groupRef,
                ['session-a', 'session-b', 'session-c', 'session-d'],
                nowEpochMs
            );
            const runtime = new PSqlRuntimeStateRepository(sql);
            const groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
            assert.equal((await groups.insertGroup(group.group)).status, 'applied');
            for (const member of group.members) {
                await groups.putMember(member);
            }
            for (const session of group.activeSessions) {
                await groups.putPresenceSession(session);
            }
            const presenceSummary: GroupPresenceSummary = {
                ...groupRef,
                causalRevision: group.causalRevision,
                activePrincipalIds: group.activeSessions
                    .map((session) => session.principalId)
                    .toSorted(),
                activeSessionIds: group.activeSessions.map((session) => session.sessionId),
                activeSessions: group.activeSessions,
                activePrincipalCount: group.onlineMemberCount,
                activeSessionCount: group.activeSessions.length,
                computedAtEpochMs: nowEpochMs
            };
            assert.equal(
                (await groups.insertPresenceSummary(presenceSummary)).status,
                'applied'
            );
            const rttRepository = new RtcRttRepository(runtime, {
                now: () => nowEpochMs
            });
            const storedRtt = {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-c',
                rttMs: 7,
                createdAtEpochMs: nowEpochMs,
                version: 1
            };
            assert.equal(await rttRepository.putMeasurementIfNewer(storedRtt), true);
            let plannedRtts: readonly typeof storedRtt[] = [];
            class RecordingTopologyService extends RallarRtcTopologyService {
                override planGroupTopologyAt(
                    ...args: Parameters<RallarRtcTopologyService['planGroupTopologyAt']>
                ): ReturnType<RallarRtcTopologyService['planGroupTopologyAt']> {
                    plannedRtts = args[1] as readonly typeof storedRtt[];
                    return super.planGroupTopologyAt(...args);
                }
            }
            // The reporting limit resolves no lower than the planning degree
            // limit, so a non-reporting pair needs both endpoints at full
            // planned degree: a four-session ring keeps every selection
            // exactly the planned hops and leaves the a-c chord outside.
            const topologyService = new RecordingTopologyService({
                now: () => nowEpochMs,
                topologyKind: 'tree',
                degreeLimit: 2,
                rttReportingDegreeLimit: 2
            });
            const service = createGroupTopologyRuntimeOwners({
                findGroupSnapshotByRef: () => group,
                readCurrentGroupSnapshot: async (ref) => await groups.readSnapshot(ref),
                readRttMeasurements: async (snapshot) =>
                    await rttRepository.listMeasurementsForSessionIds(
                        snapshot.activeSessions.map((session) => session.sessionId)
                    ),
                configRepository: new GroupTopologyConfigRepository(runtime),
                topologyService,
                serverDefaults: {
                    topologyKind: 'tree',
                    degreeLimit: 2,
                    rttReportingDegreeLimit: 2
                }
            });
            const previous = activeTopologySnapshot({
                groupRef,
                sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
                activeSessionIds: ['session-a', 'session-b', 'session-c', 'session-d'],
                nextHopsBySessionId: {
                    'session-a': ['session-b', 'session-d'],
                    'session-b': ['session-a', 'session-c'],
                    'session-c': ['session-b', 'session-d'],
                    'session-d': ['session-a', 'session-c']
                }
            });
            const authority = await service.planning.readTopologyPlanningAuthority({
                groupRef,
                snapshotSelection: 'prefer-current'
            });
            assert.deepEqual(authority.rttMeasurements, [storedRtt]);

            service.planning.computeTopologyFromAuthority(authority, previous, {
                intent: 'full-rebuild',
                origin: 'automatic'
            });

            assert.deepEqual(plannedRtts, []);
        });
    }
);

Deno.test(
    'PGlite topology worker rereads authority and predecessor after removal CAS conflict',
    async () => {
        await withPGliteSql(async (sql) => {
            const nowEpochMs = 1_000;
            const groupRef = {
                applicationId: 'pglite-removal-retry',
                workspaceId: 'planning',
                groupId: 'room'
            };
            const active = topologyGroupSnapshot(groupRef);
            const terminal: GroupSnapshot = {
                ...active,
                group: {
                    ...active.group,
                    status: 'archived',
                    updated: canonicalAuditStamp(100),
                    archived: canonicalAuditStamp(100),
                    deleted: null
                }
            };
            const runtimeRepository = new PSqlRuntimeStateRepository(sql);
            const groups = new GroupStateRepository(runtimeRepository, new PSqlGroupStateEventRepository(runtimeRepository.sql));
            assert.equal((await groups.insertGroup(terminal.group)).status, 'applied');
            for (const member of terminal.members) {
                await groups.putMember(member);
            }
            const durableTerminal = await groups.readSnapshot(groupRef);
            assert.ok(durableTerminal);
            const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
            const predecessor = activeTopologySnapshot({
                groupRef,
                sourceGroupStateCausalRevision: { groupRevision: 0, presenceRevision: 0 },
                activeSessionIds: [],
                nextHopsBySessionId: {}
            });
            assert.equal(await snapshots.observeSnapshot(predecessor), 'inserted');
            const movedPredecessor = { ...predecessor, version: 1, updatedAtEpochMs: 2 };
            let authorityReadCount = 0;
            const topologyManagement = createGroupTopologyRuntimeOwners({
                findGroupSnapshotByRef: (ref) => groups.readSnapshot(ref),
                readCurrentGroupSnapshot: async (ref) => await groups.readSnapshot(ref),
                readRttMeasurements: () => [],
                configRepository: new GroupTopologyConfigRepository(runtimeRepository),
                topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
                topologySnapshotRepository: snapshots
            });
            const readTopologyPlanningAuthority = topologyManagement.planning
                .readTopologyPlanningAuthority.bind(
                    topologyManagement.planning
                );
            topologyManagement.planning.readTopologyPlanningAuthority = async (input) => {
                const authority = await readTopologyPlanningAuthority(input);
                authorityReadCount += 1;
                if (authorityReadCount === 1) {
                    assert.equal(await snapshots.observeSnapshot(movedPredecessor), 'advanced');
                }
                return authority;
            };
            const resourceInbox = createPSqlResourceInboxRepository(sql);
            let retryReleaseCount = 0;
            class RetryObservedQueueBox extends PSqlQueueBox {
                override async releaseEntries(
                    ...args: Parameters<PSqlQueueBox['releaseEntries']>
                ): ReturnType<PSqlQueueBox['releaseEntries']> {
                    const released = await super.releaseEntries(...args);
                    if (args[1].status === EntityStatus.RETRY) {
                        retryReleaseCount += 1;
                    }
                    return released;
                }
            }
            const outboxReader = new OutboxQueueReader(
                new RetryObservedQueueBox(resourceInbox)
            );
            const workRuntime = createRtcTopologyOutboxPublisher({
                outboxQueueReader: outboxReader,
                senderId: 'pglite-removal-retry',
                now: () => nowEpochMs
            });
            const executionRepository = new RtcTopologyExecutionRepository(
                runtimeRepository,
                60_000,
                () => nowEpochMs
            );
            outboxReader.onOutboxMessageDo(
                workRuntime.workType,
                createRtcTopologyWorkHandler({
                    runtime: workRuntime,
                    database: sql,
                    topologyPlanning: topologyManagement.planning,
                    executionRepository
                })
            );
            await workRuntime.publisher.enqueueForGroupSnapshot(durableTerminal);

            await outboxReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );

            const [work] = await sql<ResourceInboxAttemptStatusRow[]>`
      select ri_attempts, ri_status from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
        and ri_topic_id = ${APP_OUTBOX_RTC_TOPOLOGY_TOPIC}
    `;
            assert.equal(retryReleaseCount, 1);
            assert.equal(Number(work?.ri_attempts), 2);
            assert.equal(work?.ri_status, EntityStatus.COMPLETED);
            assert.equal(authorityReadCount, 2);
            const committed = await executionRepository.findSnapshot(groupRef);
            assert.equal(committed?.state, 'removed');
            assert.equal(committed?.version, movedPredecessor.version);
            assert.deepEqual(
                committed?.sourceGroupStateCausalRevision,
                durableTerminal.causalRevision
            );
        });
    }
);

Deno.test('PGlite topology worker classifies exact WS outbox replay as idempotent', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createPGliteTopologyWorkFixture(
            sql,
            'pglite-topology-ws-replay'
        );
        await createPSqlResourceInboxRepository(sql).entries.write(fixture.publicationEntry);

        await fixture.handler.onMessage(fixture.message, fixture.reserved);
        assert.equal(fixture.readReplayWakeCount(), 1);

        const consumed = await fixture.resourceInbox.entries.findAnyByKey(fixture.workEntry.key);
        assert.equal(consumed?.status, EntityStatus.COMPLETED);
        assert.deepEqual(
            await fixture.executionRepository.findPublicationForWork(
                fixture.groupRef,
                fixture.workId
            ),
            fixture.publication
        );
        assert.deepEqual(
            await fixture.executionRepository.findSnapshot(fixture.groupRef),
            fixture.topology
        );
        assert.equal(
            Number(
                (await sql<NumericCountRow[]>`
        select count(*) as count
        from resource_inbox
        where ri_type_id = 'WS_OUTBOX'
      `)[0]?.count
            ),
            1
        );
        assert.deepEqual(
            await readRtcTopologyDeliveryState(sql, fixture.publisherStreamId),
            { headSequence: 1, sequences: [1] }
        );
    });
});

Deno.test(
    'PGlite topology worker revalidates durable delivery on a loaded work claim',
    async () => {
        await withPGliteSql(async (sql) => {
            const fixture = await createPGliteTopologyWorkFixture(
                sql,
                'pglite-topology-loaded-delivery'
            );
            await fixture.handler.onMessage(fixture.message, fixture.reserved);
            assert.equal(fixture.readAppendCount(), 1);
            assert.equal(fixture.readReplayWakeCount(), 1);
            await sql`
      update resource_inbox
      set ri_status = 'RESERVED', ri_attempts = 2,
          start_ts = now() at time zone 'UTC', end_ts = null, next_ts = null
      where ri_topic_id = ${fixture.workEntry.key.topicId}
        and ri_resource_id = ${fixture.workEntry.key.resourceId}
        and fk_ext_bank_id = ${fixture.workEntry.key.contextId}
    `;
            const replayReservation = await fixture.resourceInbox.entries.findAnyByKey(
                fixture.workEntry.key
            );
            assert.ok(replayReservation);

            await fixture.handler.onMessage(fixture.message, replayReservation);

            assert.equal(fixture.readAppendCount(), 2);
            assert.equal(fixture.readReplayWakeCount(), 2);
            assert.deepEqual(
                await readRtcTopologyDeliveryState(sql, fixture.publisherStreamId),
                { headSequence: 1, sequences: [1] }
            );
            assert.equal(
                (await fixture.resourceInbox.entries.findAnyByKey(fixture.workEntry.key))?.status,
                EntityStatus.COMPLETED
            );
        });
    }
);

Deno.test(
    'PGlite topology worker fails closed and rolls back after delivery lease loss',
    async () => {
        await withPGliteSql(async (sql) => {
            const fixture = await createPGliteTopologyWorkFixture(
                sql,
                'pglite-topology-delivery-lease-loss'
            );
            await sql`
      update rtc_topology_delivery_stream
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where stream_id = ${fixture.publisherStreamId}
    `;

            await assert.rejects(
                () => fixture.handler.onMessage(fixture.message, fixture.reserved),
                RtcTopologyDeliveryLeaseLostError
            );

            assert.equal(
                await fixture.executionRepository.findPublicationForWork(
                    fixture.groupRef,
                    fixture.workId
                ),
                undefined
            );
            assert.equal(
                await fixture.resourceInbox.entries.findAnyByKey(fixture.publicationEntry.key),
                null
            );
            assert.deepEqual(
                await readRtcTopologyDeliveryState(sql, fixture.publisherStreamId),
                { headSequence: 0, sequences: [] }
            );
            assert.equal(
                (await fixture.resourceInbox.entries.findAnyByKey(fixture.workEntry.key))?.status,
                EntityStatus.RESERVED
            );
            assert.equal(fixture.readReplayWakeCount(), 0);
        });
    }
);

Deno.test(
    'PGlite topology worker rolls state and receipt back on divergent WS outbox collision',
    async () => {
        await withPGliteSql(async (sql) => {
            const fixture = await createPGliteTopologyWorkFixture(
                sql,
                'pglite-topology-ws-collision'
            );
            const divergentResource = JSON.stringify({
                collision: 'preexisting-divergent-topology-publication'
            });
            await fixture.resourceInbox.entries.write({
                ...fixture.publicationEntry,
                resource: divergentResource
            });

            await assert.rejects(
                () => fixture.handler.onMessage(fixture.message, fixture.reserved),
                ResourceInboxInvariantCorruptionError
            );

            assert.equal(
                await fixture.executionRepository.findPublicationForWork(
                    fixture.groupRef,
                    fixture.workId
                ),
                undefined
            );
            assert.equal(
                await fixture.executionRepository.findSnapshot(fixture.groupRef),
                undefined
            );
            const consumed = await fixture.resourceInbox.entries.findAnyByKey(fixture.workEntry.key);
            assert.equal(consumed?.status, EntityStatus.RESERVED);
            assert.equal(consumed?.dequeueAudit.attempts, 1);
            assert.equal(
                (await fixture.resourceInbox.entries.findAnyByKey(fixture.publicationEntry.key))
                    ?.resource,
                divergentResource
            );
            assert.deepEqual(
                await readRtcTopologyDeliveryState(sql, fixture.publisherStreamId),
                { headSequence: 0, sequences: [] }
            );
            assert.equal(fixture.readReplayWakeCount(), 0);
        });
    }
);

Deno.test(
    'PGlite topology worker rolls every effect back when reservation completion loses its fence',
    async () => {
        await withPGliteSql(async (sql) => {
            const fixture = await createPGliteTopologyWorkFixture(
                sql,
                'pglite-topology-finish-fence'
            );

            await assert.rejects(
                () =>
                    fixture.handler.onMessage(fixture.message, {
                        ...fixture.reserved,
                        dequeueAudit: {
                            ...fixture.reserved.dequeueAudit,
                            attempts: fixture.reserved.dequeueAudit.attempts + 1
                        }
                    }),
                RuntimeStateWriteConflictError
            );

            assert.equal(
                await fixture.executionRepository.findPublicationForWork(
                    fixture.groupRef,
                    fixture.workId
                ),
                undefined
            );
            assert.equal(
                await fixture.executionRepository.findSnapshot(fixture.groupRef),
                undefined
            );
            assert.equal(
                await fixture.resourceInbox.entries.findAnyByKey(fixture.publicationEntry.key),
                null
            );
            const consumed = await fixture.resourceInbox.entries.findAnyByKey(fixture.workEntry.key);
            assert.equal(consumed?.status, EntityStatus.RESERVED);
            assert.equal(consumed?.dequeueAudit.attempts, 1);
            assert.deepEqual(
                await readRtcTopologyDeliveryState(sql, fixture.publisherStreamId),
                { headSequence: 0, sequences: [] }
            );
            assert.equal(fixture.readReplayWakeCount(), 0);
        });
    }
);
