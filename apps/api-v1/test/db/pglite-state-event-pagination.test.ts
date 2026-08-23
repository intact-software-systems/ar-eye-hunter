import assert from 'node:assert/strict';

import { createPSqlResourceInboxRepository, ResourceInboxInvariantCorruptionError, type PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { ClientStateEventCollisionError } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import { groupStateEventWorkspaceKey } from '@shared-server/rallar-system/state-events/postgres/group-state-event-workspace-key.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC as APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';

import { toPersistedAuthSessionFixture, withPGliteSql } from './pglite-auth-test-harness.ts';
import {
    applyPGliteGroupMutation,
    applyPreparedPGliteGroupMutation,
    createClientStateEvent,
    createGroupStateEvent
} from './pglite-state-mutation-test-runtime.ts';

interface NumericCountRow {
    readonly count: string | number;
}

interface StringCountRow {
    readonly count: string;
}

interface GroupEventWorkspaceRow {
    readonly workspace_key: string;
}

Deno.test('PSql state event repositories page by snapshot cursor order', async () => {
    await withPGliteSql(async (sql) => {
        const clientEvents = new PSqlClientStateEventRepository(sql);
        const groupEvents = new PSqlGroupStateEventRepository(sql);
        const clientRef = {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            principalId: 'principal-1'
        };
        const groupRef = {
            applicationId: 'rallar-test',
            workspaceId: 'main',
            groupId: 'room-1'
        };

        await clientEvents.appendClientEvent(
            createClientStateEvent({
                eventId: 'client-late-snapshot',
                occurredAtEpochMs: 1_000,
                snapshotVersion: 30
            })
        );
        await clientEvents.appendClientEvent(
            createClientStateEvent({
                eventId: 'client-early-snapshot',
                occurredAtEpochMs: 2_000,
                snapshotVersion: 10
            })
        );
        await clientEvents.appendClientEvent(
            createClientStateEvent({
                eventId: 'client-middle-snapshot',
                occurredAtEpochMs: 3_000,
                snapshotVersion: 20
            })
        );
        const firstClientDuplicate = createClientStateEvent({
            eventId: 'client-filtered',
            occurredAtEpochMs: 4_000,
            snapshotVersion: 40,
            eventType: 'session-disconnected'
        });
        await clientEvents.appendClientEvent(firstClientDuplicate);
        await clientEvents.appendClientEvent(structuredClone(firstClientDuplicate));
        await assert.rejects(
            () =>
                clientEvents.appendClientEvent(
                    createClientStateEvent({
                        eventId: 'client-filtered',
                        occurredAtEpochMs: 5_000,
                        snapshotVersion: 50,
                        eventType: 'session-disconnected',
                        overrides: { reason: 'updated' }
                    })
                ),
            (error) => error instanceof ClientStateEventCollisionError
        );

        const firstClientPage = await clientEvents.listClientEventPage(
            clientRef,
            { limit: 2 }
        );
        const secondClientPage = await clientEvents.listClientEventPage(
            clientRef,
            {
                limit: 2,
                after: firstClientPage.nextCursor
            }
        );
        const filteredClientPage = await clientEvents.listClientEventPage(
            clientRef,
            {
                eventTypes: ['session-disconnected'],
                limit: 1
            }
        );
        const recentClientEvents = await clientEvents.listRecentClientEvents(
            clientRef,
            { limit: 2 }
        );
        const recentFilteredClientEvents = await clientEvents.listRecentClientEvents(
            clientRef,
            {
                eventTypes: ['session-disconnected'],
                limit: 1,
                after: firstClientPage.nextCursor
            }
        );

        assert.deepEqual(
            firstClientPage.events.map((event) => event.eventId),
            ['client-early-snapshot', 'client-middle-snapshot']
        );
        assert.equal(firstClientPage.hasMore, true);
        assert.deepEqual(
            secondClientPage.events.map((event) => event.eventId),
            ['client-late-snapshot', 'client-filtered']
        );
        assert.equal(secondClientPage.hasMore, false);
        assert.equal(filteredClientPage.events[0].reason, null);
        assert.deepEqual(filteredClientPage.nextCursor, {
            snapshotVersion: 40,
            occurredAtEpochMs: 4_000,
            eventId: 'client-filtered'
        });
        assert.deepEqual(
            (await clientEvents.listClientEvents(clientRef)).map((event) => event.eventId),
            [
                'client-early-snapshot',
                'client-middle-snapshot',
                'client-late-snapshot',
                'client-filtered'
            ]
        );
        assert.deepEqual(
            recentClientEvents.map((event) => event.eventId),
            ['client-late-snapshot', 'client-filtered']
        );
        assert.deepEqual(
            recentFilteredClientEvents.map((event) => event.eventId),
            ['client-filtered']
        );

        await groupEvents.appendGroupEvent(
            createGroupStateEvent({
                eventId: 'group-late-snapshot',
                occurredAtEpochMs: 1_000,
                snapshotVersion: 30
            })
        );
        await groupEvents.appendGroupEvent(
            createGroupStateEvent({
                eventId: 'group-early-snapshot',
                occurredAtEpochMs: 2_000,
                snapshotVersion: 10
            })
        );
        await groupEvents.appendGroupEvent(
            createGroupStateEvent({
                eventId: 'group-middle-snapshot',
                occurredAtEpochMs: 3_000,
                snapshotVersion: 20
            })
        );
        const firstDuplicate = createGroupStateEvent({
            eventId: 'group-duplicate',
            occurredAtEpochMs: 4_000,
            snapshotVersion: 40,
            eventType: 'member-left'
        });
        await groupEvents.appendGroupEvent(firstDuplicate);
        await groupEvents.appendGroupEvent(structuredClone(firstDuplicate));
        await assert.rejects(
            () =>
                groupEvents.appendGroupEvent(
                    createGroupStateEvent({
                        eventId: 'group-duplicate',
                        occurredAtEpochMs: 5_000,
                        snapshotVersion: 50,
                        eventType: 'member-left',
                        overrides: { reason: 'updated' }
                    })
                ),
            (error) =>
                error instanceof Error &&
                'code' in error &&
                error.code === 'group-state-event-collision'
        );

        const firstGroupPage = await groupEvents.listGroupEventPage(groupRef, {
            limit: 2
        });
        const secondGroupPage = await groupEvents.listGroupEventPage(groupRef, {
            limit: 2,
            after: firstGroupPage.nextCursor
        });
        const recentGroupEvents = await groupEvents.listRecentGroupEvents(
            groupRef,
            { limit: 2 }
        );

        assert.deepEqual(
            firstGroupPage.events.map((event) => event.eventId),
            ['group-early-snapshot', 'group-middle-snapshot']
        );
        assert.equal(firstGroupPage.hasMore, true);
        assert.deepEqual(
            secondGroupPage.events.map((event) => event.eventId),
            ['group-late-snapshot', 'group-duplicate']
        );
        assert.equal(secondGroupPage.hasMore, false);
        assert.equal(secondGroupPage.events[1]?.reason, null);
        assert.deepEqual(secondGroupPage.nextCursor, {
            snapshotVersion: 40,
            occurredAtEpochMs: 4_000,
            eventId: 'group-duplicate'
        });
        assert.deepEqual(
            recentGroupEvents.map((event) => event.eventId),
            ['group-late-snapshot', 'group-duplicate']
        );
    });
});

Deno.test(
    'PSql group events isolate ordinary and sentinel workspaces without event-id loss',
    async () => {
        await withPGliteSql(async (sql) => {
            const repository = new PSqlGroupStateEventRepository(sql);
            const ordinaryRef = {
                applicationId: 'group-event-scope-app',
                workspaceId: 'main',
                groupId: 'shared-group'
            };
            const explicitSentinelRef = { ...ordinaryRef, workspaceId: '_' };
            const ordinaryEvent = createGroupStateEvent({
                eventId: 'shared-event',
                occurredAtEpochMs: 1_000,
                snapshotVersion: 1,
                eventType: 'group-updated',
                overrides: { ...ordinaryRef, reason: 'ordinary' }
            });
            const explicitSentinelEvent = createGroupStateEvent({
                eventId: 'shared-event',
                occurredAtEpochMs: 2_000,
                snapshotVersion: 2,
                eventType: 'group-updated',
                overrides: {
                    ...explicitSentinelRef,
                    reason: 'explicit-sentinel'
                }
            });

            await repository.appendGroupEvent(ordinaryEvent);
            await repository.appendGroupEvent(explicitSentinelEvent);

            for (
                const [ref, expected] of [
                    [ordinaryRef, ordinaryEvent],
                    [explicitSentinelRef, explicitSentinelEvent]
                ] as const
            ) {
                assert.deepEqual(await repository.listGroupEvents(ref), [expected]);
                assert.deepEqual(await repository.listRecentGroupEvents(ref), [expected]);
                assert.deepEqual(
                    (await repository.listGroupEventPage(ref, { limit: 1 })).events,
                    [expected]
                );
            }

            const rows = await sql<GroupEventWorkspaceRow[]>`
      select workspace_key
      from group_state_events
      where application_id = ${ordinaryRef.applicationId}
        and group_id = ${ordinaryRef.groupId}
        and event_id = ${ordinaryEvent.eventId}
      order by workspace_key
    `;
            assert.equal(rows.length, 2);
            assert.notEqual(rows[0]?.workspace_key, rows[1]?.workspace_key);
        });
    }
);

Deno.test(
    'PGlite group event collision rolls back the authoritative mutation transaction',
    async () => {
        await withPGliteSql(async (sql) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const authority = {
                clientId: 'alice',
                sessionId: 'alice-session',
                accessToken: 'test-token',
                username: 'alice',
                issuedAtEpochMs: 1,
                expiresAtEpochMs: 100_000
            };
            const persistedAuthority = await toPersistedAuthSessionFixture(authority);
            const service = createGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStore: new PSqlGroupStateEventRepository(sql),
                authSessionRepository: {
                    findBySessionId: (sessionId) =>
                        Promise.resolve(
                            sessionId === authority.sessionId ? persistedAuthority : undefined
                        )
                },
                now: () => 10_000,
                serviceId: 'pglite-group-service'
            });
            const scope = { applicationId: 'collision-app', workspaceId: 'main' };
            const ref = { ...scope, groupId: 'collision-group' };
            await applyPGliteGroupMutation({
                sql,
                service,
                descriptor: mutationDescriptor('createGroup', scope, ref.groupId, {
                    groupId: ref.groupId,
                    displayName: 'Before collision',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'alice',
                    requestId: 'seed-collision-group'
                }),
                authority
            });
            const updateDescriptor = mutationDescriptor('updateGroup', scope, ref.groupId, {
                displayName: 'Must roll back',
                actorPrincipalId: 'alice',
                requestId: 'collision-request'
            });
            const updatePreparation = await service.prepareMutation(updateDescriptor, authority);
            await new PSqlGroupStateEventRepository(sql).appendGroupEvent(
                createGroupStateEvent({
                    eventId: updatePreparation.facts.eventId,
                    occurredAtEpochMs: 9_000,
                    snapshotVersion: 99,
                    eventType: 'group-updated',
                    overrides: { ...ref, requestId: 'preexisting-event' }
                })
            );

            await assert.rejects(
                () => applyPreparedPGliteGroupMutation(sql, service, updatePreparation),
                (error) =>
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'group-state-event-collision'
            );

            const repository = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
            assert.equal((await repository.findGroup(ref))?.displayName, 'Before collision');
            assert.equal(
                await repository.findIdempotentGroupMutationReceipt(ref, 'collision-request'),
                undefined
            );
            const collisionRows = await sql<StringCountRow[]>`
      select count(*) as count
      from group_state_events
      where application_id = ${ref.applicationId}
        and workspace_key = ${groupStateEventWorkspaceKey(ref.workspaceId)}
        and group_id = ${ref.groupId}
        and event_id = ${updatePreparation.facts.eventId}
    `;
            assert.equal(Number(collisionRows[0]?.count), 1);
            const [summaryRows] = await sql<NumericCountRow[]>`
      select count(*) as count
      from resource_inbox
      where ri_topic_id = ${APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC}
        and ri_resource like ${'%collision-request%'}
    `;
            assert.equal(Number(summaryRows?.count ?? 0), 0);
        });
    }
);

Deno.test(
    'PGlite group summary outbox collision rolls back state event and receipt atomically',
    async () => {
        await withPGliteSql(async (sql) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const authority = {
                clientId: 'alice',
                sessionId: 'alice-session',
                accessToken: 'test-token',
                username: 'alice',
                issuedAtEpochMs: 1,
                expiresAtEpochMs: 100_000
            };
            const persistedAuthority = await toPersistedAuthSessionFixture(authority);
            const service = createGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStore: new PSqlGroupStateEventRepository(sql),
                authSessionRepository: {
                    findBySessionId: (sessionId) =>
                        Promise.resolve(
                            sessionId === authority.sessionId ? persistedAuthority : undefined
                        )
                },
                now: () => 10_000,
                serviceId: 'pglite-group-summary-collision'
            });
            const scope = { applicationId: 'summary-collision-app', workspaceId: 'main' };
            const ref = { ...scope, groupId: 'summary-collision-group' };
            await applyPGliteGroupMutation({
                sql,
                service,
                descriptor: mutationDescriptor('createGroup', scope, ref.groupId, {
                    groupId: ref.groupId,
                    displayName: 'Before summary collision',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'alice',
                    requestId: 'seed-summary-collision-group'
                }),
                authority
            });

            const preparation = await service.prepareMutation(
                mutationDescriptor('updateGroup', scope, ref.groupId, {
                    displayName: 'Must roll back at summary outbox',
                    actorPrincipalId: 'alice',
                    requestId: 'summary-collision-request'
                }),
                authority
            );
            const command = {
                ...preparation,
                facts: { ...preparation.facts, attemptCount: 1 }
            };
            const read = await service.read(command);
            const computed = service.compute(command, read);
            service.validate(command, read, computed);
            assert.equal(computed.outcome, 'write');
            if (computed.outcome !== 'write') {
                throw new TypeError('Expected summary collision write');
            }
            const [summaryEntry] = computed.outboxEntries;
            assert.ok(summaryEntry);
            const divergentResource = JSON.stringify({
                collision: 'preexisting-divergent-summary-work'
            });
            await createPSqlResourceInboxRepository(sql).entries.write({
                ...summaryEntry,
                resource: divergentResource
            });

            await assert.rejects(
                () => sql.begin(async (transaction) => await service.write(transaction, computed)),
                ResourceInboxInvariantCorruptionError
            );

            const repository = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
            assert.equal((await repository.findGroup(ref))?.displayName, 'Before summary collision');
            assert.equal(
                await repository.findIdempotentGroupMutationReceipt(ref, 'summary-collision-request'),
                undefined
            );
            const [eventRows] = await sql<NumericCountRow[]>`
      select count(*) as count
      from group_state_events
      where application_id = ${ref.applicationId}
        and workspace_key = ${groupStateEventWorkspaceKey(ref.workspaceId)}
        and group_id = ${ref.groupId}
        and event_id = ${preparation.facts.eventId}
    `;
            assert.equal(Number(eventRows?.count ?? 0), 0);
            const storedCollision = await createPSqlResourceInboxRepository(sql).entries.findAnyByKey(
                summaryEntry.key
            );
            assert.equal(storedCollision?.resource, divergentResource);
        });
    }
);
