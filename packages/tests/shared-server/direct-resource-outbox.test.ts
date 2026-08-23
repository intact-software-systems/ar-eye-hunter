import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { ResourceInboxRepository } from '@shared-server/queuebox/postgres/resource-inbox-repository.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { CoalescedAppOutboxWorkService } from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work-service.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries,
    type ComputedClientStateSync,
    type ComputedGroupStateSync
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { writeClientStateSync, writeGroupStateSync } from '@shared-server/rallar-system/state-sync/state-sync-transaction-writer.ts';
import {
    computeRtcTopologyEntry,
    writeRtcTopologyOutbox,
    type ComputedRtcTopologyOutbox
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { AuditStamp, GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { CircuitBreakerPolicy, EnqueuedType, InMemoryQueueBox, ResilienceDto } from '@shared/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { describe, expect, it, vi } from 'vitest';
import { createTestGroup } from '../create-test-group.ts';
import { createDeltaEnvelopeFixture } from './group-state-delta-envelope-fixtures.ts';

const CREATED_AT_EPOCH_MS = 1_800_000_000_000;
const EXPIRE_AT_EPOCH_MS = 1_800_000_060_000;

describe('direct resource outbox writes', () => {
    it('rejects an incomplete canonical client event payload', async () => {
        const incomplete = {
            ...createClientEvent(),
            eventType: undefined
        } as unknown as ClientEvent;

        const computed = createComputedClientEventStateSync(incomplete);
        expect(() => computeClientStateSyncEntries(computed, 'server-1')).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeClientStateSync(transaction, computed, 'server-1');
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects an incomplete canonical client snapshot payload', async () => {
        const snapshot = createClientSnapshot();
        const principal = {
            ...snapshot.principal,
            username: undefined
        } as unknown as ClientSnapshot['principal'];
        const incomplete = { ...snapshot, principal };

        const computed = createComputedClientSnapshotStateSync(incomplete);
        expect(() => computeClientStateSyncEntries(computed, 'server-1')).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeClientStateSync(transaction, computed, 'server-1');
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects an incomplete canonical group event payload', async () => {
        const computed = createComputedGroupEventStateSync((event) => ({
            ...event,
            eventType: undefined
        } as unknown as GroupEvent));
        expect(() => computeGroupStateSyncEntries(computed, 'server-1')).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeGroupStateSync(transaction, computed, 'server-1');
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects an incomplete canonical group snapshot payload', async () => {
        const snapshot = createGroupSnapshot();
        const group = {
            ...snapshot.group,
            displayName: undefined
        } as unknown as GroupSnapshot['group'];
        const incomplete = { ...snapshot, group };

        const computed = createComputedGroupStateSync(incomplete);
        expect(() => computeGroupStateSyncEntries(computed, 'server-1')).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeGroupStateSync(transaction, computed, 'server-1');
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects a non-canonical state-sync effect kind', () => {
        const computed = createComputedClientEventStateSync(createClientEvent());
        const forged = {
            ...computed,
            effects: [{ ...computed.effects[0], effectKind: 'forged-state' }]
        } as unknown as ComputedClientStateSync;

        expect(() => computeClientStateSyncEntries(forged, 'server-1')).toThrow();
    });

    it('replays all canonical state-sync payload families identically', () => {
        const clientEvent = createComputedClientEventStateSync(createClientEvent());
        const clientSnapshot = createComputedClientSnapshotStateSync(createClientSnapshot());
        const groupEvent = createComputedGroupEventStateSync();
        const groupSnapshot = createComputedGroupStateSync(createGroupSnapshot());

        expect(computeClientStateSyncEntries(clientEvent, 'server-1')).toEqual(
            computeClientStateSyncEntries(clientEvent, 'server-1')
        );
        expect(computeClientStateSyncEntries(clientSnapshot, 'server-1')).toEqual(
            computeClientStateSyncEntries(clientSnapshot, 'server-1')
        );
        expect(computeGroupStateSyncEntries(groupEvent, 'server-1')).toEqual(
            computeGroupStateSyncEntries(groupEvent, 'server-1')
        );
        expect(computeGroupStateSyncEntries(groupSnapshot, 'server-1')).toEqual(
            computeGroupStateSyncEntries(groupSnapshot, 'server-1')
        );
    });

    it('rejects wrong audience and mandatory scalar facts before a write', async () => {
        const valid = createComputedGroupStateSync(createGroupSnapshot());
        const wrongAudience = {
            ...valid,
            audience: { ...valid.audience, resourceId: 'wrong-group' }
        } as ComputedGroupStateSync;
        const missingCommandId = {
            ...valid,
            commandId: undefined
        } as unknown as ComputedGroupStateSync;
        const database = createResourceInboxDatabase();

        for (const computed of [wrongAudience, missingCommandId]) {
            await expect(
                runInPSqlTransaction(database.sql, async (transaction) => {
                    await writeGroupStateSync(transaction, computed, 'server-1');
                })
            ).rejects.toThrow();
        }
        expect(database.rows.size).toBe(0);
    });

    it('rejects a client state sync whose audience contradicts its aggregate', async () => {
        const computed = createComputedClientEventStateSync(createClientEvent());
        const forged: ComputedClientStateSync = {
            ...computed,
            audience: { ...computed.audience, applicationId: 'other-application' }
        };
        const database = createResourceInboxDatabase();

        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeClientStateSync(transaction, forged, 'server-1');
            })
        ).rejects.toThrow('Computed state sync facts are invalid');
        expect(database.rows.size).toBe(0);
    });

    it('rejects a group state sync whose audience contradicts its aggregate', async () => {
        const computed = createComputedGroupStateSync(createGroupSnapshot());
        const forged: ComputedGroupStateSync = {
            ...computed,
            audience: { ...computed.audience, workspaceId: 'other-workspace' }
        };
        const database = createResourceInboxDatabase();

        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeGroupStateSync(transaction, forged, 'server-1');
            })
        ).rejects.toThrow('Computed state sync facts are invalid');
        expect(database.rows.size).toBe(0);
    });

    it('computes and revalidates valid client and group work inside public writes', async () => {
        const database = createResourceInboxDatabase();
        const client = createComputedClientEventStateSync(createClientEvent());
        const group = createComputedGroupStateSync(createGroupSnapshot());

        const clientEntries = await runInPSqlTransaction(
            database.sql,
            async (transaction) => await writeClientStateSync(transaction, client, 'server-1')
        );
        const groupEntries = await runInPSqlTransaction(
            database.sql,
            async (transaction) => await writeGroupStateSync(transaction, group, 'server-1')
        );

        expect(clientEntries).toEqual(computeClientStateSyncEntries(client, 'server-1'));
        expect(groupEntries).toEqual(computeGroupStateSyncEntries(group, 'server-1'));
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeClientStateSync(transaction, client, 'server-1');
            await writeGroupStateSync(transaction, group, 'server-1');
        });
        expect(database.nestedBeginCalls).toBe(0);
    });

    it('computes mandatory client WS_OUTBOX data without clocks, randomness, or routes', async () => {
        const event = createClientEvent();
        const computed: ComputedClientStateSync = {
            commandId: 'client-command-1',
            aggregateRef: {
                applicationId: event.applicationId,
                workspaceId: event.workspaceId,
                principalId: event.principalId
            },
            acceptedCausalRevision: event.snapshotVersion,
            audience: {
                kind: 'principal',
                applicationId: event.applicationId,
                workspaceId: event.workspaceId,
                resourceId: event.principalId
            },
            createdAtEpochMs: CREATED_AT_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            effects: [
                {
                    effectKind: 'principal-state',
                    payloadKind: 'event',
                    payload: event
                }
            ]
        };

        const [entry] = computeClientStateSyncEntries(computed, 'server-1');

        expect(entry.typeId).toBe(EnqueuedType.WS_OUTBOX);
        const message = JSON.parse(entry.resource);
        expect(message).toMatchObject({
            id: {
                msgId: expect.stringContaining('client-command-1'),
                ts: CREATED_AT_EPOCH_MS
            },
            route: entry.key,
            targets: {
                mode: 'broadcast',
                scope: 'principal',
                principalRef: {
                    applicationId: event.applicationId,
                    workspaceId: event.workspaceId,
                    principalId: event.principalId
                }
            },
            ordering: { epoch: 0, seq: event.snapshotVersion },
            payload: { typeId: 'client-state.event' }
        });
        const database = createResourceInboxDatabase();
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeClientStateSync(transaction, computed, 'server-1');
        });
        expect(database.rows.get(toRowKey(entry))?.ri_resource).toBe(entry.resource);
        expect(database.nestedBeginCalls).toBe(0);
    });

    it('writes final WS_OUTBOX entries through the received transaction', async () => {
        const database = createResourceInboxDatabase();
        const computed = createComputedGroupStateSync(createGroupSnapshot());

        const entries = await runInPSqlTransaction(
            database.sql,
            async (transaction) => await writeGroupStateSync(transaction, computed, 'server-1')
        );

        expect(database.beginCalls).toBe(1);
        expect(database.nestedBeginCalls).toBe(0);
        expect(database.rows.size).toBe(entries.length);
        expect(
            [...database.rows.values()].every((row) => row.ri_type_id === EnqueuedType.WS_OUTBOX)
        ).toBe(true);

        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeGroupStateSync(transaction, computed, 'server-1');
        });
        expect(database.rows.size).toBe(entries.length);

        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch({
                    ...entries[0]!,
                    resource: JSON.stringify({ corrupt: true })
                });
            })
        ).rejects.toMatchObject({
            code: 'resource-inbox-invariant-corruption'
        });
        expect(database.rows.get(toRowKey(entries[0]!))?.ri_resource).toBe(entries[0]!.resource);
    });

    it('computes deterministic logical websocket work without a live local route', () => {
        const snapshot = createGroupSnapshot();
        const computed = createComputedGroupStateSync(snapshot);

        const first = computeGroupStateSyncEntries(computed, 'server-1');
        const replay = computeGroupStateSyncEntries(computed, 'server-1');

        expect(first).toEqual(replay);
        expect(first).toHaveLength(2);
        expect(first.every((entry) => entry.typeId === EnqueuedType.WS_OUTBOX)).toBe(true);
        expect(first.every((entry) => entry.audit.createdBy === 'server-1')).toBe(true);
        expect(
            first.every((entry) =>
                entry.audit.createdTs.equals(
                    Temporal.Instant.fromEpochMilliseconds(CREATED_AT_EPOCH_MS)
                        .toZonedDateTimeISO('UTC')
                        .toPlainDateTime()
                )
            )
        ).toBe(true);
        expect(
            first.every((entry) => entry.audit.expiryTs.equals(Temporal.Instant.fromEpochMilliseconds(EXPIRE_AT_EPOCH_MS)))
        ).toBe(true);

        const messages = first.map((entry) => JSON.parse(entry.resource));
        expect(messages.map((message) => message.payload.typeId)).toEqual([
            'group-state.snapshot',
            'group-directory.snapshot'
        ]);
        expect(
            messages.every(
                (message) =>
                    message.targets.mode === 'broadcast' &&
                    message.targets.scope === 'room' &&
                    message.targets.groupRef.applicationId === 'app-1' &&
                    message.ordering.epoch === 4 &&
                    message.ordering.seq === 3 &&
                    message.constraints.expiresAtMs === EXPIRE_AT_EPOCH_MS
            )
        ).toBe(true);
    });

    it('computes immutable APP_OUTBOX topology work from accepted causal data', async () => {
        const groupSnapshot = createGroupSnapshot();
        const computed: ComputedRtcTopologyOutbox = {
            commandId: 'group-command-1',
            aggregateRef: groupSnapshot.group,
            acceptedCausalRevision: groupSnapshot.causalRevision,
            groupSnapshot,
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            senderId: 'server-1',
            resourceId: 'group-command-1:rtc-topology-recompute:group-revision:group=4;presence=3',
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: true,
            createdAtEpochMs: CREATED_AT_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS
        };

        const first = computeRtcTopologyEntry(computed);
        const replay = computeRtcTopologyEntry(computed);

        expect(first).toEqual(replay);
        expect(first.typeId).toBe(EnqueuedType.APP_OUTBOX);
        const message = JSON.parse(first.resource);
        const envelope = JSON.parse(message.payload.resource);
        expect(envelope).toMatchObject({
            senderId: expect.any(String),
            data: {
                kind: 'group-revision',
                sourceGroupStateCausalRevision: groupSnapshot.causalRevision,
                groupSnapshot,
                requestedAtEpochMs: CREATED_AT_EPOCH_MS
            }
        });
        expect(message.id.msgId).toContain('group-command-1');
        const database = createResourceInboxDatabase();
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeRtcTopologyOutbox(transaction, computed);
        });
        expect(database.rows.get(toRowKey(first))?.ri_resource).toBe(first.resource);
        expect(database.nestedBeginCalls).toBe(0);
    });

    it.each([
        ['missing', undefined],
        ['wrong', 'snapshot']
    ])('rejects %s RTC topology payload kind', async (_label, payloadKind) => {
        const { payloadKind: canonicalPayloadKind, ...withoutPayloadKind } = createComputedRtcTopologyOutbox();
        void canonicalPayloadKind;
        const computed = {
            ...withoutPayloadKind,
            ...(payloadKind === undefined ? {} : { payloadKind })
        } as unknown as ComputedRtcTopologyOutbox;

        expect(() => computeRtcTopologyEntry(computed)).toThrow(
            'Computed RTC topology outbox facts are invalid'
        );
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeRtcTopologyOutbox(transaction, computed);
            })
        ).rejects.toThrow('Computed RTC topology outbox facts are invalid');
        expect(database.rows.size).toBe(0);
    });

    it('includes canonical RTC topology payload kind in deterministic identity', () => {
        const computed = createComputedRtcTopologyOutbox();

        const entry = computeRtcTopologyEntry(computed);
        const message = JSON.parse(entry.resource);

        expect(message.id.msgId).toContain(':rtc-topology-recompute:group-revision:group=4;presence=3');
        expect(message.route).toEqual(entry.key);
    });

    it.each([
        ['unknown', { topologyKind: 'tree', unexpected: true }],
        ['wrong type', { topologyKind: 1 }]
    ])('rejects %s durable RTC topology request options', (_label, requestOptions) => {
        const computed = {
            ...createComputedRtcTopologyOutbox(),
            payloadKind: 'group-revision',
            requestOptions
        } as unknown as ComputedRtcTopologyOutbox;

        expect(() => computeRtcTopologyEntry(computed)).toThrow();
    });

    it('rejects RTC topology work whose aggregate contradicts its snapshot', async () => {
        const computed = createComputedRtcTopologyOutbox();
        const forged: ComputedRtcTopologyOutbox = {
            ...computed,
            aggregateRef: { ...computed.aggregateRef, groupId: 'other-group' }
        };
        const database = createResourceInboxDatabase();

        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeRtcTopologyOutbox(transaction, forged);
            })
        ).rejects.toThrow('Computed RTC topology outbox facts are invalid');
        expect(database.rows.size).toBe(0);
    });

    it('computes and revalidates RTC topology work inside its public write', async () => {
        const computed = createComputedRtcTopologyOutbox();
        const database = createResourceInboxDatabase();

        const entry = await runInPSqlTransaction(
            database.sql,
            async (transaction) => await writeRtcTopologyOutbox(transaction, computed)
        );

        expect(entry).toEqual(computeRtcTopologyEntry(computed));
        expect(database.rows.get(toRowKey(entry))?.ri_resource).toBe(entry.resource);
        expect(database.nestedBeginCalls).toBe(0);
    });

    it('resolves logical websocket recipients only while consuming committed work', async () => {
        const snapshot = createGroupSnapshot();
        const [entry] = computeGroupStateSyncEntries(
            createComputedGroupStateSync(snapshot),
            'server-1'
        );
        const outbox = new InMemoryQueueBox();
        const socket = createSocket();
        const resolveBroadcastRecipients = vi.fn(() => [
            {
                peerId: 'alice',
                connectionId: 'session-alice'
            }
        ]);
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(),
            outbox,
            socket,
            'server-1',
            { targetResolver: { resolveBroadcastRecipients } }
        );

        expect(socket.sent).toEqual([]);

        await outbox.enqueue(entry);
        const wake = vi.fn(() => {
            throw new Error('wake failed');
        });
        expect(wake).toThrow('wake failed');
        expect(await outbox.getItem(entry.key)).toBeDefined();
        expect(socket.sent).toEqual([]);

        await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

        expect(socket.sent).toEqual(['session-alice']);
    });

    it('treats no current websocket recipient as a post-commit delivery outcome', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const [entry] = computeGroupStateSyncEntries(
            createComputedGroupStateSync(createGroupSnapshot()),
            'server-1'
        );
        const outbox = new InMemoryQueueBox();
        const socket = createSocket();
        const resolveBroadcastRecipients = vi.fn(() => []);
        const deliveryOutcomes: unknown[] = [];
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(),
            outbox,
            socket,
            'server-1',
            {
                targetResolver: { resolveBroadcastRecipients },
                outboundDeliveryOutcome: (outcome) => deliveryOutcomes.push(outcome)
            }
        );
        await outbox.enqueue(entry);
        await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());
        vi.useRealTimers();
        expect(socket.sent).toEqual([]);
        expect(deliveryOutcomes).toEqual([
            {
                status: 'no-current-recipient',
                messageId: JSON.parse(entry.resource).id.msgId
            }
        ]);
    });
    it('fences coalescing and inserts a deterministic successor instead of overwriting reserved work', async () => {
        const database = createResourceInboxDatabase();
        const stagingService = new CoalescedAppOutboxWorkService(
            new OutboxQueueReader(new InMemoryQueueBox()),
            'server-1',
            () => CREATED_AT_EPOCH_MS
        );
        const coalescedInput = {
            type: 'RTC_TOPOLOGY_RECOMPUTE',
            topicId: 'app-outbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1'
        } as const;
        const first = (
            await stagingService.enqueue({
                ...coalescedInput,
                data: { overlayId: 'overlay-1', snapshotVersion: 1 }
            })
        ).entry;
        const next = (
            await stagingService.enqueue({
                ...coalescedInput,
                data: { overlayId: 'overlay-1', snapshotVersion: 2 }
            })
        ).entry;
        const third = (
            await stagingService.enqueue({
                ...coalescedInput,
                data: { overlayId: 'overlay-1', snapshotVersion: 3 }
            })
        ).entry;
        const successor = (
            await new CoalescedAppOutboxWorkService(
                new OutboxQueueReader(new InMemoryQueueBox()),
                'server-1',
                () => CREATED_AT_EPOCH_MS
            ).enqueue({
                ...coalescedInput,
                resourceId: 'overlay-1-successor-2',
                data: { overlayId: 'overlay-1', snapshotVersion: 3 }
            })
        ).entry;
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(first);
        });
        const updated = await runInPSqlTransaction(
            database.sql,
            async (transaction) =>
                await stagingService.write(transaction, {
                    expectedEntry: first,
                    entry: next,
                    successorEntry: successor
                })
        );
        expect(updated).toMatchObject({
            action: 'updated',
            blockedByReserved: false
        });
        expect(database.rows.get(toRowKey(first))?.ri_resource).toBe(next.resource);

        database.reserve(next);
        const result = await runInPSqlTransaction(
            database.sql,
            async (transaction) =>
                await stagingService.write(transaction, {
                    expectedEntry: next,
                    entry: third,
                    successorEntry: successor
                })
        );

        expect(result).toMatchObject({
            action: 'successor',
            blockedByReserved: true,
            entry: successor
        });
        expect(database.rows.get(toRowKey(next))?.ri_resource).toBe(next.resource);
        expect(database.rows.get(toRowKey(next))?.ri_status).toBe(EntityStatus.RESERVED);
        expect(database.rows.get(toRowKey(successor))?.ri_resource).toBe(successor.resource);
        expect(database.nestedBeginCalls).toBe(0);
    });
});

function createComputedGroupStateSync(snapshot: GroupSnapshot): ComputedGroupStateSync {
    return {
        commandId: 'group-command-1',
        aggregateRef: snapshot.group,
        acceptedCausalRevision: snapshot.causalRevision,
        audience: {
            kind: 'group',
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            resourceId: snapshot.group.groupId
        },
        createdAtEpochMs: CREATED_AT_EPOCH_MS,
        expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
        effects: [
            {
                effectKind: 'member-state',
                payloadKind: 'snapshot',
                payload: snapshot
            },
            {
                effectKind: 'scope-directory',
                payloadKind: 'snapshot',
                payload: snapshot
            }
        ]
    };
}

function createComputedClientEventStateSync(event: ClientEvent): ComputedClientStateSync {
    return {
        commandId: 'client-command-1',
        aggregateRef: {
            applicationId: event.applicationId,
            workspaceId: event.workspaceId,
            principalId: event.principalId
        },
        acceptedCausalRevision: event.snapshotVersion,
        audience: {
            kind: 'principal',
            applicationId: event.applicationId,
            workspaceId: event.workspaceId,
            resourceId: event.principalId
        },
        createdAtEpochMs: CREATED_AT_EPOCH_MS,
        expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
        effects: [
            {
                effectKind: 'principal-state',
                payloadKind: 'event',
                payload: event
            }
        ]
    };
}

function createComputedClientSnapshotStateSync(snapshot: ClientSnapshot): ComputedClientStateSync {
    return {
        commandId: 'client-command-1',
        aggregateRef: {
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            principalId: snapshot.principal.principalId
        },
        acceptedCausalRevision: snapshot.stateRevision,
        audience: {
            kind: 'principal',
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            resourceId: snapshot.principal.principalId
        },
        createdAtEpochMs: CREATED_AT_EPOCH_MS,
        expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
        effects: [
            {
                effectKind: 'principal-state',
                payloadKind: 'snapshot',
                payload: snapshot
            }
        ]
    };
}

// The group event row carries a delta envelope; the bare GroupEvent payload was
// retired with snapshot-per-change. The envelope is internally consistent, so
// the identity comes from it rather than from a separately built event, and a
// corruption is applied to that identity so the only thing under test is the
// corruption itself.
function createComputedGroupEventStateSync(
    corruptEvent?: (event: GroupEvent) => GroupEvent
): ComputedGroupStateSync {
    const fixture = createDeltaEnvelopeFixture({ audienceSessionIds: [] });
    const event = fixture.event;
    const envelope: GroupStateDeltaEnvelope = corruptEvent === undefined
        ? fixture
        : { ...fixture, event: corruptEvent(event) };
    return {
        commandId: 'group-command-1',
        aggregateRef: {
            applicationId: event.applicationId,
            workspaceId: event.workspaceId,
            groupId: event.groupId
        },
        acceptedCausalRevision: event.causalRevision,
        audience: {
            kind: 'group',
            applicationId: event.applicationId,
            workspaceId: event.workspaceId,
            resourceId: event.groupId
        },
        createdAtEpochMs: CREATED_AT_EPOCH_MS,
        expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
        effects: [
            {
                effectKind: 'member-state',
                payloadKind: 'delta-envelope',
                payload: envelope
            }
        ]
    };
}

function createComputedRtcTopologyOutbox(): ComputedRtcTopologyOutbox {
    const groupSnapshot = createGroupSnapshot();
    return {
        commandId: 'group-command-1',
        aggregateRef: groupSnapshot.group,
        acceptedCausalRevision: groupSnapshot.causalRevision,
        groupSnapshot,
        effectKind: 'rtc-topology-recompute' as const,
        payloadKind: 'group-revision' as const,
        senderId: 'server-1',
        resourceId: 'group-command-1:rtc-topology-recompute:group-revision:group=4;presence=3',
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true,
        createdAtEpochMs: CREATED_AT_EPOCH_MS,
        expireAtEpochMs: EXPIRE_AT_EPOCH_MS
    };
}

type TestSocket = JsonWebSocketServer & Readonly<{ sent: readonly string[]; }>;

function createSocket(): TestSocket {
    const sent: string[] = [];
    return {
        connections: new Map([['session-alice', { id: 'session-alice', isOpen: true }]]),
        sent,
        onMessageDo: () => undefined,
        send: (connectionId: string) => {
            sent.push(connectionId);
        },
        encode: (message: unknown) => ({ text: JSON.stringify(message) }),
        sendEncoded: (connectionId: string) => {
            sent.push(connectionId);
        }
    } as unknown as TestSocket;
}

function createResilience(): ResilienceDto {
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(
            10,
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 })
        ),
        1,
        10,
        1,
        1
    );
}

function createGroupSnapshot(): GroupSnapshot {
    const audit = createAuditStamp();
    return {
        causalRevision: { groupRevision: 4, presenceRevision: 3 },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            displayName: 'Room 1',
            activeMemberCount: 1,
            ownerPrincipalId: 'alice',
            snapshotVersion: 4,
            metadataVersion: 4,
            rosterVersion: 4,
            presenceVersion: 3,
            created: audit,
            updated: audit
        }),
        members: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
                principalId: 'alice',
                role: 'owner',
                status: 'active',
                joined: audit,
                updated: audit,
                invitedByPrincipalId: null,
                invitationExpiresAtEpochMs: null,
                left: null,
                removed: null,
                banned: null
            }
        ],
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
                principalId: 'alice',
                sessionId: 'session-alice',
                generationId: 'generation-alice',
                generationVersion: 1,
                status: 'active',
                disconnectedAtEpochMs: null,
                disconnectReason: null,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: EXPIRE_AT_EPOCH_MS
            }
        ],
        memberCount: 1,
        onlineMemberCount: 1
    };
}

function createClientSnapshot(): ClientSnapshot {
    const audit = createAuditStamp();
    return {
        stateRevision: 5,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'alice',
            username: 'alice',
            displayName: 'Alice',
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            snapshotVersion: 5,
            profileVersion: 5,
            presenceVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: null
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: null
    };
}

function createGroupEvent(): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        eventId: 'group-event-1',
        eventType: 'group-updated',
        snapshotVersion: 7,
        causalRevision: { groupRevision: 4, presenceRevision: 3 },
        occurredAtEpochMs: CREATED_AT_EPOCH_MS,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: 'group-command-1',
        payload: {}
    };
}

function createAuditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function createClientEvent(): ClientEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'alice',
        eventId: 'client-event-1',
        eventType: 'principal-updated',
        snapshotVersion: 5,
        clientInstanceId: null,
        sessionId: null,
        occurredAtEpochMs: CREATED_AT_EPOCH_MS,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: 'client-command-1',
        payload: {}
    };
}

type TestResourceInboxRow = {
    ri_row_id: bigint;
    ri_resource_id: string;
    ri_topic_id: string;
    ri_resource: string;
    ri_type_id: string;
    ri_status: string;
    fk_ext_bank_id: string;
    system_date: string;
    created_by: string;
    created_ts: string;
    expire_ts: string;
    start_ts: string | null;
    end_ts: string | null;
    next_ts: string | null;
    ri_attempts: bigint;
};

function createResourceInboxDatabase() {
    let rows = new Map<string, TestResourceInboxRow>();
    let beginCalls = 0;
    let nestedBeginCalls = 0;
    const sql = (() => {
        throw new Error('Resource inbox SQL must use the received transaction');
    }) as unknown as PSqlSql;
    sql.begin = async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
        beginCalls += 1;
        const pending = new Map([...rows].map(([key, row]) => [key, { ...row }]));
        const transaction = createResourceInboxTransaction(pending, () => {
            nestedBeginCalls += 1;
        });
        const result = await write(transaction);
        rows = pending;
        return result;
    };

    return {
        sql,
        get rows() {
            return rows;
        },
        get beginCalls() {
            return beginCalls;
        },
        get nestedBeginCalls() {
            return nestedBeginCalls;
        },
        reserve(entry: ResourceEntry) {
            const row = rows.get(toRowKey(entry));
            if (!row) {
                throw new Error('Cannot reserve missing test row');
            }
            row.ri_status = EntityStatus.RESERVED;
            row.start_ts = row.created_ts;
            row.ri_attempts = 1n;
        }
    };
}

function createResourceInboxTransaction(
    rows: Map<string, TestResourceInboxRow>,
    onNestedBegin: () => void
): PSqlSql {
    const transaction = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ) => {
        if (!Array.isArray(stringsOrValues) || !Object.hasOwn(stringsOrValues, 'raw')) {
            return stringsOrValues;
        }
        const query = (stringsOrValues as unknown as TemplateStringsArray)
            .join('?')
            .replace(/\s+/gu, ' ')
            .trim()
            .toLowerCase();
        if (query.startsWith('insert into resource_inbox')) {
            const row = toTestRow(values, BigInt(rows.size + 1));
            const key = toRowKey(row);
            if (rows.has(key)) {
                return [];
            }
            rows.set(key, row);
            return [row];
        }
        if (query.startsWith('select ri_row_id')) {
            const [topicId, resourceId, contextId] = values as string[];
            const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
            return row ? [{ ...row }] : [];
        }
        if (query.startsWith('update resource_inbox')) {
            const [
                resource,
                status,
                nextTs,
                topicId,
                resourceId,
                contextId,
                typeId,
                expectedStatus,
                expectedResource,
                expectedGeneration,
                attempts
            ] = values;
            const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
            if (
                !row ||
                row.ri_type_id !== typeId ||
                row.ri_status !== expectedStatus ||
                row.ri_resource !== expectedResource ||
                readCoalescedGeneration(row.ri_resource) !== expectedGeneration ||
                row.ri_attempts !== BigInt(attempts as number)
            ) {
                return [];
            }
            row.ri_resource = resource as string;
            row.ri_status = status as string;
            row.next_ts = nextTs === null ? null : withoutZone(String(nextTs));
            return [{ ...row }];
        }
        throw new Error(`Unexpected resource inbox SQL: ${query}`);
    }) as unknown as PSqlSql;
    transaction.begin = () => {
        onNestedBegin();
        throw new Error('Nested resource inbox transaction');
    };
    return transaction;
}

function toTestRow(values: readonly unknown[], rowId: bigint): TestResourceInboxRow {
    return {
        ri_row_id: rowId,
        ri_resource_id: values[0] as string,
        ri_topic_id: values[1] as string,
        ri_resource: values[2] as string,
        ri_type_id: values[3] as string,
        ri_status: values[4] as string,
        fk_ext_bank_id: values[5] as string,
        system_date: values[6] as string,
        created_by: values[7] as string,
        created_ts: withoutZone(String(values[8])),
        expire_ts: withoutZone(String(values[9])),
        start_ts: values[10] === null ? null : withoutZone(String(values[10])),
        end_ts: values[11] === null ? null : withoutZone(String(values[11])),
        next_ts: values[12] === null ? null : withoutZone(String(values[12])),
        ri_attempts: BigInt(values[13] as number)
    };
}

function withoutZone(value: string): string {
    return value.replace(/Z$/u, '');
}

function readCoalescedGeneration(resource: string): number {
    const message = JSON.parse(resource);
    const envelope = JSON.parse(message.payload.resource);
    return envelope.data.__rallarCoalescedWork.generation;
}

function toRowKey(value: ResourceEntry | TestResourceInboxRow): string {
    if ('key' in value) {
        return `${value.key.contextId}::${value.key.topicId}::${value.key.resourceId}`;
    }
    return `${value.fk_ext_bank_id}::${value.ri_topic_id}::${value.ri_resource_id}`;
}
