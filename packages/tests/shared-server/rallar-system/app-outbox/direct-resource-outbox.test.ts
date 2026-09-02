import { Temporal } from '@js-temporal/polyfill';
// dprint-ignore
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

// dprint-ignore
import type {
    PSqlParameter,
    PSqlRows,
    PSqlSql
} from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { computeAppOutboxInsert, writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { validateCoalescedAppOutboxWrite, writeCoalescedAppOutboxWork } from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work.ts';
import { decodeJsonWireText } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries,
    type ComputedClientStateSync,
    type ComputedGroupStateSync
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { computeRtcTopologyEntry, type ComputedRtcTopologyOutbox } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
// dprint-ignore
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot
} from '@shared/api/group-types.ts';
// dprint-ignore
import {
    CircuitBreakerPolicy,
    EnqueuedType,
    InMemoryQueueBox,
    ResilienceDto
} from '@shared/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { WsOutboxDeliveryOutcome } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import {
    createDefaultWsQueueBoxServerService,
    WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer, type EncodedJsonWebSocketMessage } from '@shared/websocket/JsonWebSocketServer.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import { createDeltaEnvelopeFixture } from '../group-state/presence/group-state-delta-envelope-fixtures.ts';
import { createOpenTestWebSocket } from '../websocket/test-support/open-test-websocket.ts';

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

const CREATED_AT_EPOCH_MS = 1_800_000_000_000;
const EXPIRE_AT_EPOCH_MS = 1_800_000_060_000;

describe('direct resource outbox writes', () => {
    it('rejects an incomplete canonical client event payload before producing outbox entries', () => {
        const incomplete = {
            ...createComputedClientEventStateSync(createClientEvent()),
            effects: [{
                effectKind: 'principal-state',
                payloadKind: 'event',
                payload: { ...createClientEvent(), eventType: undefined }
            }]
        };
        expect(() => Reflect.apply(computeClientStateSyncEntries, undefined, [incomplete, 'server-1'])).toThrow();
    });

    it('rejects an incomplete canonical client snapshot payload before producing outbox entries', () => {
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
        expect(() => Reflect.apply(computeClientStateSyncEntries, undefined, [incomplete, 'server-1'])).toThrow();
    });

    it('rejects an incomplete canonical group event payload before producing outbox entries', () => {
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
        expect(() => Reflect.apply(computeGroupStateSyncEntries, undefined, [incomplete, 'server-1'])).toThrow();
    });

    it('rejects an incomplete canonical group snapshot payload before producing outbox entries', () => {
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
        expect(() => Reflect.apply(computeGroupStateSyncEntries, undefined, [incomplete, 'server-1'])).toThrow();
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

        expect(() => Reflect.apply(computeClientStateSyncEntries, undefined, [forged, 'server-1'])).toThrow();
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

    it('rejects wrong audience and mandatory scalar facts before producing outbox entries', () => {
        const valid = createComputedGroupStateSync(createGroupSnapshot());
        const wrongAudience = {
            ...valid,
            audience: { ...valid.audience, resourceId: 'wrong-group' }
        };
        const missingCommandId = {
            ...valid,
            commandId: undefined
        };
        expect(() => computeGroupStateSyncEntries(wrongAudience, 'server-1')).toThrow();
        expect(() => Reflect.apply(computeGroupStateSyncEntries, undefined, [missingCommandId, 'server-1'])).toThrow();
    });

    it('rejects a client state sync whose audience contradicts its aggregate', () => {
        const computed = createComputedClientEventStateSync(createClientEvent());
        const forged: ComputedClientStateSync = {
            ...computed,
            audience: { ...computed.audience, applicationId: 'other-application' }
        };
        expect(() => computeClientStateSyncEntries(forged, 'server-1')).toThrow('Computed state sync facts are invalid');
    });

    it('rejects a group state sync whose audience contradicts its aggregate', () => {
        const computed = createComputedGroupStateSync(createGroupSnapshot());
        const forged: ComputedGroupStateSync = {
            ...computed,
            audience: { ...computed.audience, workspaceId: 'other-workspace' }
        };
        expect(() => computeGroupStateSyncEntries(forged, 'server-1')).toThrow('Computed state sync facts are invalid');
    });

    it('writes the exact precomputed client and group bytes through the received transaction', async () => {
        const database = createResourceInboxDatabase();
        const client = createComputedClientEventStateSync(createClientEvent());
        const group = createComputedGroupStateSync(createGroupSnapshot());

        const entries = [
            ...computeClientStateSyncEntries(client, 'server-1'),
            ...computeGroupStateSyncEntries(group, 'server-1')
        ];
        const inserts = entries.map(computeAppOutboxInsert);
        await runInPSqlTransaction(database.sql, async (transaction) => {
            for (const insert of inserts) {
                await writeAppOutboxInsert(transaction, insert);
            }
        });

        expect([...database.rows.values()].map((row) => row.ri_resource)).toEqual(entries.map((entry) => entry.resource));
        expect([...database.rows.values()].map((row) => row.ri_type_id)).toEqual(['WS_OUTBOX', 'WS_OUTBOX', 'WS_OUTBOX']);
        expect(database.beginCalls).toBe(1);
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
        const message = decodePersistedALMessage(entry.resource);
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
        const insert = computeAppOutboxInsert(entry);
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeAppOutboxInsert(transaction, insert);
        });
        expect(database.rows.get(toRowKey(entry))?.ri_resource).toBe(entry.resource);
        expect(database.nestedBeginCalls).toBe(0);
    });

    it.each(['identical', 'different'] as const)('rolls back a %s WS_OUTBOX collision without reading a winner', async (content) => {
        const database = createResourceInboxDatabase();
        const computed = createComputedGroupStateSync(createGroupSnapshot());
        const entries = computeGroupStateSyncEntries(computed, 'server-1');
        const existing = computeAppOutboxInsert(entries[0]);
        const preceding = computeAppOutboxInsert(entries[1]);
        const collision = computeAppOutboxInsert(
            content === 'identical' ? entries[0] : {
                ...entries[0],
                resource: JSON.stringify({ corrupt: true })
            }
        );
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeAppOutboxInsert(transaction, existing);
        });
        let winnerReads = 0;

        await expect(
            runInPSqlTransaction(database.sql, async (transaction) => {
                const observed = new Proxy(transaction, {
                    apply(target, receiver, argumentsList) {
                        const strings = argumentsList[0];
                        if (Array.isArray(strings) && /\bfrom\s+resource_inbox\b/iu.test(strings.join(' '))) {
                            winnerReads += 1;
                        }
                        return Reflect.apply(target, receiver, argumentsList);
                    }
                });
                await writeAppOutboxInsert(observed, preceding);
                await writeAppOutboxInsert(observed, collision);
            })
        ).rejects.toMatchObject({
            code: 'resource-inbox-invariant-corruption'
        });
        expect(winnerReads).toBe(0);
        expect([...database.rows.values()].map((row) => row.ri_resource)).toEqual([entries[0].resource]);
        expect(database.nestedBeginCalls).toBe(0);
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

        const messages = first.map((entry) => decodePersistedALMessage(entry.resource));
        expect(messages.map((message) => message.payload.typeId)).toEqual([
            'group-state.snapshot',
            'group-directory.snapshot'
        ]);
        for (const message of messages) {
            expect(message).toMatchObject({
                targets: { mode: 'broadcast', scope: 'room', groupRef: { applicationId: 'app-1' } },
                ordering: { epoch: 4, seq: 3 },
                constraints: { expiresAtMs: EXPIRE_AT_EPOCH_MS }
            });
        }
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
        const message = decodePersistedALMessage(first.resource);
        const envelope = decodeJsonWireText(message.payload.resource);
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
        const insert = computeAppOutboxInsert(first);
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeAppOutboxInsert(transaction, insert);
        });
        expect(database.rows.get(toRowKey(first))?.ri_resource).toBe(first.resource);
        expect(database.nestedBeginCalls).toBe(0);
    });

    it.each([
        ['missing', undefined],
        ['wrong', 'snapshot']
    ])('rejects %s RTC topology payload kind', (_label, payloadKind) => {
        const { payloadKind: canonicalPayloadKind, ...withoutPayloadKind } = createComputedRtcTopologyOutbox();
        void canonicalPayloadKind;
        const computed = {
            ...withoutPayloadKind,
            ...(payloadKind === undefined ? {} : { payloadKind })
        };

        expect(() => Reflect.apply(computeRtcTopologyEntry, undefined, [computed]))
            .toThrow('Computed RTC topology outbox facts are invalid');
    });

    it('includes canonical RTC topology payload kind in deterministic identity', () => {
        const computed = createComputedRtcTopologyOutbox();

        const entry = computeRtcTopologyEntry(computed);
        const message = decodePersistedALMessage(entry.resource);

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

        expect(() => Reflect.apply(computeRtcTopologyEntry, undefined, [computed])).toThrow();
    });

    it('rejects RTC topology work whose aggregate contradicts its snapshot', () => {
        const computed = createComputedRtcTopologyOutbox();
        const forged: ComputedRtcTopologyOutbox = {
            ...computed,
            aggregateRef: { ...computed.aggregateRef, groupId: 'other-group' }
        };
        expect(() => computeRtcTopologyEntry(forged)).toThrow(
            'Computed RTC topology outbox facts are invalid'
        );
    });

    it('writes RTC topology work computed before transaction entry', async () => {
        const computed = createComputedRtcTopologyOutbox();
        const database = createResourceInboxDatabase();
        const computedEntry = computeRtcTopologyEntry(computed);
        const insert = computeAppOutboxInsert(computedEntry);

        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeAppOutboxInsert(transaction, insert);
        });

        expect(database.rows.get(toRowKey(computedEntry))?.ri_resource).toBe(computedEntry.resource);
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
        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: { resolveBroadcastRecipients }
        });

        expect(socket.sent).toEqual([]);

        await outbox.enqueue(entry);
        expect(await outbox.getItem(entry.key)).toBeDefined();
        expect(socket.sent).toEqual([]);

        await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

        expect(socket.sent).toEqual(['session-alice']);
    });

    it('treats no current websocket recipient as a post-commit delivery outcome', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const [entry] = computeGroupStateSyncEntries(
                createComputedGroupStateSync(createGroupSnapshot()),
                'server-1'
            );
            const outbox = new InMemoryQueueBox();
            const socket = createSocket();
            const resolveBroadcastRecipients = vi.fn(() => []);
            const deliveryOutcomes: WsOutboxDeliveryOutcome[] = [];
            const service = createDefaultWsQueueBoxServerService({
                inbox: new InMemoryQueueBox(),
                outbox,
                socket,
                name: 'server-1',
                targetResolver: { resolveBroadcastRecipients },
                outboundDeliveryOutcome: (outcome) => deliveryOutcomes.push(outcome)
            });
            await outbox.enqueue(entry);
            await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());
            expect(socket.sent).toEqual([]);
            expect(deliveryOutcomes).toEqual([
                {
                    status: 'no-current-recipient',
                    messageId: decodePersistedALMessage(entry.resource).id.msgId
                }
            ]);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('fences coalescing and inserts a deterministic successor instead of overwriting reserved work', async () => {
        const database = createResourceInboxDatabase();
        const groupSnapshot = createGroupSnapshot();
        const coalescedInput = {
            aggregateRef: groupSnapshot.group,
            groupSnapshot,
            requestedAtEpochMs: CREATED_AT_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            recomputeDebounceMs: 0,
            senderId: 'server-1',
            origin: 'automatic'
        } as const;
        const initial = computeCoalescedRtcTopologyGroupRevisionWork({ ...coalescedInput, previousEntry: null });
        const first = initial.entryWrite.entry;
        const replacement = computeCoalescedRtcTopologyGroupRevisionWork({ ...coalescedInput, previousEntry: first });
        const next = replacement.entryWrite.entry;
        expect(validateCoalescedAppOutboxWrite(null, initial)).toEqual([]);
        expect(validateCoalescedAppOutboxWrite(first, replacement)).toEqual([]);
        await runInPSqlTransaction(database.sql, async (transaction) => {
            await writeCoalescedAppOutboxWork(transaction, initial);
        });
        await runInPSqlTransaction(
            database.sql,
            async (transaction) => await writeCoalescedAppOutboxWork(transaction, replacement)
        );
        expect(database.rows.get(toRowKey(first))?.ri_resource).toBe(next.resource);
        expect(database.rows.get(toRowKey(first))?.ri_status).toBe(EntityStatus.NEW);
        expect(database.rows.size).toBe(1);

        database.reserve(next);
        const reservedReplacement = computeCoalescedRtcTopologyGroupRevisionWork({ ...coalescedInput, previousEntry: next });
        const successor = reservedReplacement.successorWrite.entry;
        expect(validateCoalescedAppOutboxWrite(next, reservedReplacement)).toEqual([]);
        await runInPSqlTransaction(
            database.sql,
            async (transaction) => await writeCoalescedAppOutboxWork(transaction, reservedReplacement)
        );

        expect(database.rows.get(toRowKey(next))?.ri_resource).toBe(next.resource);
        expect(database.rows.get(toRowKey(next))?.ri_status).toBe(EntityStatus.RESERVED);
        expect(database.rows.get(toRowKey(successor))?.ri_resource).toBe(successor.resource);
        expect(database.rows.size).toBe(2);
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

function createComputedGroupEventStateSync(): ComputedGroupStateSync {
    const envelope = createDeltaEnvelopeFixture({ audienceSessionIds: [] });
    const event = envelope.event;
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
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'group-revision',
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
        members: [createGroupMember(audit)],
        activeSessions: [createGroupPresenceSession()],
        memberCount: 1,
        onlineMemberCount: 1
    };
}

function createGroupMember(audit: AuditStamp): GroupMember {
    return {
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
    };
}

function createGroupPresenceSession(): GroupPresenceSession {
    return {
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

function updateResourceInboxTestRow(
    rows: Map<string, TestResourceInboxRow>,
    values: readonly PSqlParameter[]
): PSqlRows {
    const resource = toStringSqlParameter(values[0], 'resource');
    const status = toStringSqlParameter(values[1], 'status');
    const nextTimestamp = values[2];
    const topicId = toStringSqlParameter(values[3], 'topic id');
    const resourceId = toStringSqlParameter(values[4], 'resource id');
    const contextId = toStringSqlParameter(values[5], 'context id');
    const typeId = toStringSqlParameter(values[6], 'type id');
    const expectedStatus = toStringSqlParameter(values[7], 'expected status');
    const expectedResource = toStringSqlParameter(values[8], 'expected resource');
    const expectedGeneration = toNumberSqlParameter(values[9], 'expected generation');
    const attempts = toBigIntSqlParameter(values[10], 'attempts');
    const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
    if (
        !row ||
        row.ri_type_id !== typeId ||
        row.ri_status !== expectedStatus ||
        row.ri_resource !== expectedResource ||
        toCoalescedGeneration(row.ri_resource) !== expectedGeneration ||
        row.ri_attempts !== attempts
    ) {
        return [];
    }
    row.ri_resource = resource;
    row.ri_status = status;
    row.next_ts = nextTimestamp === null ? null : toTimestampWithoutZone(String(nextTimestamp));
    return [{ ...row }];
}

function toTestRow(values: readonly PSqlParameter[], rowId: bigint): TestResourceInboxRow {
    return {
        ri_row_id: rowId,
        ri_resource_id: toStringSqlParameter(values[0], 'resource id'),
        ri_topic_id: toStringSqlParameter(values[1], 'topic id'),
        ri_resource: toStringSqlParameter(values[2], 'resource'),
        ri_type_id: toStringSqlParameter(values[3], 'type id'),
        ri_status: toStringSqlParameter(values[4], 'status'),
        fk_ext_bank_id: toStringSqlParameter(values[5], 'context id'),
        system_date: toStringSqlParameter(values[6], 'system date'),
        created_by: toStringSqlParameter(values[7], 'created by'),
        created_ts: toTimestampWithoutZone(String(values[8])),
        expire_ts: toTimestampWithoutZone(String(values[9])),
        start_ts: values[10] === null ? null : toTimestampWithoutZone(String(values[10])),
        end_ts: values[11] === null ? null : toTimestampWithoutZone(String(values[11])),
        next_ts: values[12] === null ? null : toTimestampWithoutZone(String(values[12])),
        ri_attempts: toBigIntSqlParameter(values[13], 'attempts')
    };
}

function toStringSqlParameter(value: PSqlParameter, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`Expected ${label} SQL parameter to be a string`);
    }
    return value;
}

function toNumberSqlParameter(value: PSqlParameter, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`Expected ${label} SQL parameter to be a finite number`);
    }
    return value;
}

function toBigIntSqlParameter(value: PSqlParameter, label: string): bigint {
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        return BigInt(value);
    }
    throw new TypeError(`Expected ${label} SQL parameter to be an integer`);
}

function toTimestampWithoutZone(value: string): string {
    return value.replace(/Z$/u, '');
}

function toCoalescedGeneration(resource: string): number {
    const message = decodePersistedALMessage(resource);
    const envelope = decodeJsonWireText(message.payload.resource);
    if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
        throw new TypeError('Expected coalesced envelope data');
    }
    const data = envelope.data;
    if (!data || typeof data !== 'object' || !('__rallarCoalescedWork' in data)) {
        throw new TypeError('Expected coalesced work metadata');
    }
    const metadata = data.__rallarCoalescedWork;
    if (!metadata || typeof metadata !== 'object' || !('generation' in metadata) || typeof metadata.generation !== 'number') {
        throw new TypeError('Expected coalesced work generation');
    }
    return metadata.generation;
}

function toRowKey(value: ResourceEntry | TestResourceInboxRow): string {
    if ('key' in value) {
        return `${value.key.contextId}::${value.key.topicId}::${value.key.resourceId}`;
    }
    return `${value.fk_ext_bank_id}::${value.ri_topic_id}::${value.ri_resource_id}`;
}
