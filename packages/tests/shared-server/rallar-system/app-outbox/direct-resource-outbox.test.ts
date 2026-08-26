import { Temporal } from '@js-temporal/polyfill';
import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { CoalescedAppOutboxWorkService } from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work-service.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries,
    type ComputedClientStateSync,
    type ComputedGroupStateSync
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { writeClientStateSync, writeGroupStateSync } from '@shared-server/rallar-system/state-sync/state-sync-transaction-writer.ts';
import { computeRtcTopologyEntry, type ComputedRtcTopologyOutbox } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { AuditStamp, GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { CircuitBreakerPolicy, EnqueuedType, InMemoryQueueBox, ResilienceDto } from '@shared/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { WsOutboxDeliveryOutcome } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer, type EncodedJsonWebSocketMessage } from '@shared/websocket/JsonWebSocketServer.ts';
import { describe, expect, it, vi } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';
import { createDeltaEnvelopeFixture } from '../group-state/presence/group-state-delta-envelope-fixtures.ts';
import { createOpenTestWebSocket } from '../websocket/test-support/open-test-websocket.ts';

const CREATED_AT_EPOCH_MS = 1_800_000_000_000;
const EXPIRE_AT_EPOCH_MS = 1_800_000_060_000;

describe('direct resource outbox writes', () => {
    const topologyOutboxWriter = new RtcTopologyOutboxWriter({ recordWrite: () => undefined });

    it('rejects an incomplete canonical client event payload', async () => {
        const incomplete = {
            ...createComputedClientEventStateSync(createClientEvent()),
            effects: [{
                effectKind: 'principal-state',
                payloadKind: 'event',
                payload: { ...createClientEvent(), eventType: undefined }
            }]
        };
        expect(() => validateUntrustedClientStateSync(incomplete)).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await validateAndWriteUntrustedClientStateSync(transaction, incomplete);
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects an incomplete canonical client snapshot payload', async () => {
        const snapshot = createClientSnapshot();
        const incompleteSnapshot = {
            ...snapshot,
            principal: { ...snapshot.principal, username: undefined }
        };
        const incomplete = {
            ...createComputedClientSnapshotStateSync(snapshot),
            effects: [{
                effectKind: 'principal-state',
                payloadKind: 'snapshot',
                payload: incompleteSnapshot
            }]
        };
        expect(() => validateUntrustedClientStateSync(incomplete)).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await validateAndWriteUntrustedClientStateSync(transaction, incomplete);
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects an incomplete canonical group event payload', async () => {
        const valid = createComputedGroupEventStateSync();
        const effect = valid.effects.find((candidate) => candidate.payloadKind === 'delta-envelope');
        if (effect === undefined || effect.payloadKind !== 'delta-envelope') {
            throw new Error('Expected a group delta-envelope effect');
        }
        const incomplete = {
            ...valid,
            effects: [{
                ...effect,
                payload: {
                    ...effect.payload,
                    event: { ...effect.payload.event, eventType: undefined }
                }
            }]
        };
        expect(() => validateUntrustedGroupStateSync(incomplete)).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await validateAndWriteUntrustedGroupStateSync(transaction, incomplete);
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects an incomplete canonical group snapshot payload', async () => {
        const snapshot = createGroupSnapshot();
        const incompleteSnapshot = {
            ...snapshot,
            group: { ...snapshot.group, displayName: undefined }
        };
        const valid = createComputedGroupStateSync(snapshot);
        const incomplete = {
            ...valid,
            effects: valid.effects.map((effect) => ({ ...effect, payload: incompleteSnapshot }))
        };
        expect(() => validateUntrustedGroupStateSync(incomplete)).toThrow();
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await validateAndWriteUntrustedGroupStateSync(transaction, incomplete);
            })
        ).rejects.toThrow();
        expect(database.rows.size).toBe(0);
    });

    it('rejects a non-canonical state-sync effect kind', () => {
        const computed = createComputedClientEventStateSync(createClientEvent());
        const forged = {
            ...computed,
            effects: [{
                effectKind: 'forged-state',
                payloadKind: 'event',
                payload: createClientEvent()
            }]
        };

        expect(() => validateUntrustedClientStateSync(forged)).toThrow();
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
        };
        const database = createResourceInboxDatabase();

        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await writeGroupStateSync(transaction, wrongAudience, 'server-1');
            })
        ).rejects.toThrow();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await validateAndWriteUntrustedGroupStateSync(transaction, missingCommandId);
            })
        ).rejects.toThrow();
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
                await createPSqlResourceInboxRepository(transaction).entries.writeIfAbsentOrMatch({
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
            await topologyOutboxWriter.write(transaction, computed);
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
        };

        expect(() => validateUntrustedRtcTopologyOutbox(computed)).toThrow(
            'Computed RTC topology outbox facts are invalid'
        );
        const database = createResourceInboxDatabase();
        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                await validateAndWriteUntrustedRtcTopologyOutbox(
                    transaction,
                    topologyOutboxWriter,
                    computed
                );
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
        };

        expect(() => validateUntrustedRtcTopologyOutbox(computed)).toThrow();
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
                await topologyOutboxWriter.write(transaction, forged);
            })
        ).rejects.toThrow('Computed RTC topology outbox facts are invalid');
        expect(database.rows.size).toBe(0);
    });

    it('computes and revalidates RTC topology work inside its public write', async () => {
        const computed = createComputedRtcTopologyOutbox();
        const database = createResourceInboxDatabase();

        const entry = await runInPSqlTransaction(
            database.sql,
            async (transaction) => await topologyOutboxWriter.write(transaction, computed)
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
        const service = new WsQueueBoxServerService({
            inbox: new InMemoryQueueBox(),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: { resolveBroadcastRecipients }
        });

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
        const deliveryOutcomes: WsOutboxDeliveryOutcome[] = [];
        const service = new WsQueueBoxServerService({
            inbox: new InMemoryQueueBox(),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: { resolveBroadcastRecipients },
            outboundDeliveryOutcome: (outcome) => deliveryOutcomes.push(outcome)
        });
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
            await createPSqlResourceInboxRepository(transaction).entries.writeIfAbsentOrMatch(first);
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

function createSocket(): RecordingJsonWebSocketServer {
    const socket = new RecordingJsonWebSocketServer();
    socket.addConnection(
        socket.createConnectionContext(
            'session-alice',
            createOpenTestWebSocket(),
            'generation-alice',
            CREATED_AT_EPOCH_MS
        )
    );
    return socket;
}

class RecordingJsonWebSocketServer extends JsonWebSocketServer {
    readonly sent: string[] = [];

    override sendEncoded(
        connectionId: string,
        _encoded: EncodedJsonWebSocketMessage
    ): void {
        this.sent.push(connectionId);
    }
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

function validateUntrustedClientStateSync(computed: object): void {
    Reflect.apply(computeClientStateSyncEntries, undefined, [computed, 'server-1']);
}

async function validateAndWriteUntrustedClientStateSync(
    transaction: PSqlSql,
    computed: object
): Promise<void> {
    await Reflect.apply(writeClientStateSync, undefined, [transaction, computed, 'server-1']);
}

function validateUntrustedGroupStateSync(computed: object): void {
    Reflect.apply(computeGroupStateSyncEntries, undefined, [computed, 'server-1']);
}

async function validateAndWriteUntrustedGroupStateSync(
    transaction: PSqlSql,
    computed: object
): Promise<void> {
    await Reflect.apply(writeGroupStateSync, undefined, [transaction, computed, 'server-1']);
}

function validateUntrustedRtcTopologyOutbox(computed: object): void {
    Reflect.apply(computeRtcTopologyEntry, undefined, [computed]);
}

async function validateAndWriteUntrustedRtcTopologyOutbox(
    transaction: PSqlSql,
    writer: RtcTopologyOutboxWriter,
    computed: object
): Promise<void> {
    await Reflect.apply(writer.write, writer, [transaction, computed]);
}

interface TestResourceInboxRow {
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
}

interface ResourceInboxTestDatabase {
    readonly sql: PSqlSql;
    readonly rows: Map<string, TestResourceInboxRow>;
    readonly beginCalls: number;
    readonly nestedBeginCalls: number;
    reserve(entry: ResourceEntry): void;
}

function createResourceInboxDatabase(): ResourceInboxTestDatabase {
    let rows = new Map<string, TestResourceInboxRow>();
    let beginCalls = 0;
    let nestedBeginCalls = 0;
    function rootSql(values: readonly PSqlParameter[]): object;
    function rootSql<Result>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<Result>;
    function rootSql(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]
    ): object | Promise<never> {
        if (!('raw' in stringsOrValues)) {
            return { values: stringsOrValues };
        }
        throw new Error('Resource inbox SQL must use the received transaction');
    }
    const sql = Object.assign(rootSql, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            beginCalls += 1;
            const pending = new Map([...rows].map(([key, row]) => [key, { ...row }]));
            const transaction = createResourceInboxTransaction(pending, () => {
                nestedBeginCalls += 1;
            });
            const result = await write(transaction);
            rows = pending;
            return result;
        }
    });

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
    function transaction(values: readonly PSqlParameter[]): object;
    function transaction<Result extends PSqlRows>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function transaction<Result extends PSqlRows>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): object | Promise<Result> {
        if (!('raw' in stringsOrValues)) {
            return { values: stringsOrValues };
        }
        const query = stringsOrValues
            .join('?')
            .replace(/\s+/gu, ' ')
            .trim()
            .toLowerCase();
        const result = executeResourceInboxQuery(rows, query, values);
        return Promise.resolve(result) as Promise<Result>;
    }
    return Object.assign(transaction, {
        begin: async <T>(_write: (sql: PSqlSql) => Promise<T>): Promise<T> => {
            onNestedBegin();
            throw new Error('Nested resource inbox transaction');
        }
    });
}

function executeResourceInboxQuery(
    rows: Map<string, TestResourceInboxRow>,
    query: string,
    values: readonly PSqlParameter[]
): PSqlRows {
    if (query.startsWith('insert into resource_inbox')) {
        return insertResourceInboxTestRow(rows, values);
    }
    if (query.startsWith('select ri_row_id')) {
        return readResourceInboxTestRow(rows, values);
    }
    if (query.startsWith('update resource_inbox')) {
        return updateResourceInboxTestRow(rows, values);
    }
    throw new Error(`Unexpected resource inbox SQL: ${query}`);
}

function insertResourceInboxTestRow(
    rows: Map<string, TestResourceInboxRow>,
    values: readonly PSqlParameter[]
): PSqlRows {
    const row = toTestRow(values, BigInt(rows.size + 1));
    const key = toRowKey(row);
    if (rows.has(key)) {
        return [];
    }
    rows.set(key, row);
    return [row];
}

function readResourceInboxTestRow(
    rows: Map<string, TestResourceInboxRow>,
    values: readonly PSqlParameter[]
): PSqlRows {
    const topicId = readStringParameter(values[0], 'topic id');
    const resourceId = readStringParameter(values[1], 'resource id');
    const contextId = readStringParameter(values[2], 'context id');
    const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
    return row ? [{ ...row }] : [];
}

function updateResourceInboxTestRow(
    rows: Map<string, TestResourceInboxRow>,
    values: readonly PSqlParameter[]
): PSqlRows {
    const resource = readStringParameter(values[0], 'resource');
    const status = readStringParameter(values[1], 'status');
    const nextTimestamp = values[2];
    const topicId = readStringParameter(values[3], 'topic id');
    const resourceId = readStringParameter(values[4], 'resource id');
    const contextId = readStringParameter(values[5], 'context id');
    const typeId = readStringParameter(values[6], 'type id');
    const expectedStatus = readStringParameter(values[7], 'expected status');
    const expectedResource = readStringParameter(values[8], 'expected resource');
    const expectedGeneration = readNumberParameter(values[9], 'expected generation');
    const attempts = readBigIntParameter(values[10], 'attempts');
    const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
    if (
        !row ||
        row.ri_type_id !== typeId ||
        row.ri_status !== expectedStatus ||
        row.ri_resource !== expectedResource ||
        readCoalescedGeneration(row.ri_resource) !== expectedGeneration ||
        row.ri_attempts !== attempts
    ) {
        return [];
    }
    row.ri_resource = resource;
    row.ri_status = status;
    row.next_ts = nextTimestamp === null ? null : withoutZone(String(nextTimestamp));
    return [{ ...row }];
}

function toTestRow(values: readonly PSqlParameter[], rowId: bigint): TestResourceInboxRow {
    return {
        ri_row_id: rowId,
        ri_resource_id: readStringParameter(values[0], 'resource id'),
        ri_topic_id: readStringParameter(values[1], 'topic id'),
        ri_resource: readStringParameter(values[2], 'resource'),
        ri_type_id: readStringParameter(values[3], 'type id'),
        ri_status: readStringParameter(values[4], 'status'),
        fk_ext_bank_id: readStringParameter(values[5], 'context id'),
        system_date: readStringParameter(values[6], 'system date'),
        created_by: readStringParameter(values[7], 'created by'),
        created_ts: withoutZone(String(values[8])),
        expire_ts: withoutZone(String(values[9])),
        start_ts: values[10] === null ? null : withoutZone(String(values[10])),
        end_ts: values[11] === null ? null : withoutZone(String(values[11])),
        next_ts: values[12] === null ? null : withoutZone(String(values[12])),
        ri_attempts: readBigIntParameter(values[13], 'attempts')
    };
}

function readStringParameter(value: PSqlParameter, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`Expected ${label} SQL parameter to be a string`);
    }
    return value;
}

function readNumberParameter(value: PSqlParameter, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`Expected ${label} SQL parameter to be a finite number`);
    }
    return value;
}

function readBigIntParameter(value: PSqlParameter, label: string): bigint {
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        return BigInt(value);
    }
    throw new TypeError(`Expected ${label} SQL parameter to be an integer`);
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
