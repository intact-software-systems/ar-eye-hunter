import { describe, expect, it, vi } from 'vitest';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    requireConditionalWrite,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
    type CreateStateMutationOutboxRecordInput,
    STATE_MUTATION_OUTBOX_NAMESPACE,
    StateMutationOutboxInvariantCorruptionError,
    StateMutationOutboxRepository,
    createStateMutationOutboxRecord,
    hashStateMutationCommand,
    toClientStateMutationCausalRevision,
    toGroupStateMutationCausalRevision,
} from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import {
    StateMutationOutboxWork,
    computeStateMutationOutboxDelivery,
    readStateMutationOutboxDelivery,
    validateStateMutationOutboxDelivery,
} from '@shared-server/rallar-system/services/StateMutationOutboxWork.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import type { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import type { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import type { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('StateMutationOutboxRepository', () => {
    it('builds a mandatory immutable intent with deterministic command and causal identity', () => {
        const snapshot = createClientSnapshot(4);
        const command = {
            requestId: 'command-1',
            payload: { displayName: 'Alice', roles: ['member'] },
        };
        const reorderedCommand = {
            payload: { roles: ['member'], displayName: 'Alice' },
            requestId: 'command-1',
        };
        const first = createClientRecord(snapshot, {
            commandHash: hashStateMutationCommand(command),
        });
        const duplicate = createClientRecord(snapshot, {
            commandHash: hashStateMutationCommand(reorderedCommand),
        });
        const successor = createClientRecord(createClientSnapshot(5), {
            commandHash: first.commandHash,
        });

        expect(first).toEqual({
            outboxId: expect.stringMatching(/^state-mutation-/),
            commandId: 'command-1',
            commandHash: expect.stringMatching(/^fnv1a64:/),
            kind: 'client',
            aggregateRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: 'alice',
            },
            acceptedCausalRevision: {
                kind: 'client',
                stateRevision: 4,
                snapshotVersion: 4,
                presenceVersion: 4,
            },
            event: { kind: 'none' },
            effects: ['client-state-sync'],
            createdAtEpochMs: 1_000,
            attempts: {
                count: 0,
                last: { status: 'never-attempted' },
            },
            delivery: { status: 'pending' },
        });
        expect(duplicate.commandHash).toBe(first.commandHash);
        expect(duplicate.outboxId).toBe(first.outboxId);
        expect(successor.outboxId).not.toBe(first.outboxId);
    });

    it('rolls back the domain row when the transaction-local outbox insert fails', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const record = createClientRecord(createClientSnapshot(1));
        runtime.beforeConditionalWrite = (operation, namespace) => {
            if (
                operation === 'insertIfAbsent' &&
                namespace === STATE_MUTATION_OUTBOX_NAMESPACE
            ) {
                throw new Error('outbox insert failed');
            }
        };

        await expect(runtime.begin(async (transaction) => {
            requireConditionalWrite(await transaction.insertIfAbsent(
                'domain:test',
                'client:alice',
                JSON.stringify({ revision: 1 }),
                Number.MAX_SAFE_INTEGER,
            ));
            await new StateMutationOutboxRepository(transaction).putOrLoad(record);
        })).rejects.toThrow('outbox insert failed');

        expect(await runtime.findAllEntries('domain:test')).toEqual([]);
        expect(await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE)).toEqual([]);
    });

    it('writes no outbox row when a domain guard conflicts', async () => {
        const runtime = new FakeRuntimeStateRepository();
        requireConditionalWrite(await runtime.insertIfAbsent(
            'domain:test',
            'client:alice',
            JSON.stringify({ revision: 1 }),
            Number.MAX_SAFE_INTEGER,
        ));

        await expect(runtime.begin(async (transaction) => {
            requireConditionalWrite(await transaction.upsertIfRevision(
                'domain:test',
                'client:alice',
                JSON.stringify({ revision: 2 }),
                Number.MAX_SAFE_INTEGER,
                99,
            ));
            await new StateMutationOutboxRepository(transaction).putOrLoad(
                createClientRecord(createClientSnapshot(2)),
            );
        })).rejects.toThrow('Runtime state conditional write conflict');

        expect(await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE)).toEqual([]);
        expect(JSON.parse((await runtime.findEntry('domain:test', 'client:alice'))!.value))
            .toEqual({ revision: 1 });
    });

    it('loads an equal insert winner and rejects the same id with different immutable content', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const record = createClientRecord(createClientSnapshot(1));

        const inserted = await repository.putOrLoad(record);
        const loaded = await repository.putOrLoad(structuredClone(record));

        expect(inserted.inserted).toBe(true);
        expect(loaded).toEqual({ ...inserted, inserted: false });

        await expect(repository.putOrLoad({
            ...record,
            commandHash: 'fnv1a64:corrupt',
        })).rejects.toBeInstanceOf(StateMutationOutboxInvariantCorruptionError);
        await expect(repository.putOrLoad({
            ...record,
            delivery: {
                status: 'delivered',
                deliveredAtEpochMs: 2_000,
                deliveredSnapshotRevision: 1,
            },
        })).rejects.toThrow('Delivered outbox state requires successful attempt metadata');
    });

    it('rejects retryable or delivered records as initial insert candidates', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const record = createClientRecord(createClientSnapshot(1));

        await expect(repository.putOrLoad({
            ...record,
            attempts: {
                count: 1,
                last: {
                    status: 'failed',
                    attemptedAtEpochMs: 2_000,
                    error: 'retry',
                },
            },
            delivery: { status: 'retryable' },
        })).rejects.toThrow(
            'Initial state mutation outbox records must be pending and never attempted',
        );
        await expect(repository.putOrLoad({
            ...record,
            attempts: {
                count: 1,
                last: {
                    status: 'succeeded',
                    attemptedAtEpochMs: 2_000,
                },
            },
            delivery: {
                status: 'delivered',
                deliveredAtEpochMs: 2_000,
                deliveredSnapshotRevision: 1,
            },
        })).rejects.toThrow(
            'Initial state mutation outbox records must be pending and never attempted',
        );
        expect(await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE))
            .toEqual([]);
    });

    it('loads a lifecycle-advanced persisted winner for an initial duplicate', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const record = createClientRecord(createClientSnapshot(1));
        const inserted = await repository.putOrLoad(record);
        await repository.writeDelivery({
            outboxId: record.outboxId,
            expectedStorageRevision: inserted.storageRevision,
            attempts: {
                count: 1,
                last: {
                    status: 'failed',
                    attemptedAtEpochMs: 2_000,
                    error: 'retry',
                },
            },
            delivery: { status: 'retryable' },
        });

        const loaded = await repository.putOrLoad(record);

        expect(loaded.inserted).toBe(false);
        expect(loaded.record.delivery).toEqual({ status: 'retryable' });
    });

    it('canonicalizes effect order before immutable duplicate comparison', async () => {
        const repository = new StateMutationOutboxRepository(
            new FakeRuntimeStateRepository(),
        );
        const snapshot = createGroupSnapshot(1);
        const first = createGroupRecord(snapshot, {
            effects: ['rtc-topology-recompute', 'group-state-sync'],
        });
        const duplicate = createGroupRecord(snapshot, {
            effects: ['group-state-sync', 'rtc-topology-recompute'],
        });

        const inserted = await repository.putOrLoad(first);
        const loaded = await repository.putOrLoad(duplicate);

        expect(loaded).toEqual({ ...inserted, inserted: false });
    });

    it('rejects exact events without their matching state-sync effect', () => {
        const snapshot = createGroupSnapshot(1);

        expect(() => createGroupRecord(snapshot, {
            event: { kind: 'group', event: createGroupEvent(1) },
            effects: ['rtc-topology-recompute'],
        })).toThrow('Group outbox events require group-state-sync');
    });

    it('rejects unknown, duplicate, and aggregate-inapplicable builder effects', () => {
        const group = createGroupSnapshot(1);
        const client = createClientSnapshot(1);
        const valid = createGroupRecord(group);
        const {
            outboxId: _outboxId,
            attempts: _attempts,
            delivery: _delivery,
            ...validInput
        } = valid;

        expect(() => createStateMutationOutboxRecord({
            ...validInput,
            kind: 'future-kind',
        } as never)).toThrow(
            'Unknown state mutation outbox kind: future-kind',
        );
        expect(() => createGroupRecord(group, {
            effects: ['future-effect' as never],
        })).toThrow('Unknown state mutation outbox effect: future-effect');
        expect(() => createGroupRecord(group, {
            effects: ['group-state-sync', 'group-state-sync'],
        })).toThrow('State mutation outbox effects must be unique');
        expect(() => createClientRecord(client, {
            effects: ['group-state-sync'],
        })).toThrow('Invalid client state mutation outbox intent');
    });

    it('rejects malformed persisted intent discriminants and effects', async () => {
        const cases: readonly Readonly<{
            name: string;
            mutate(record: ReturnType<typeof createGroupRecord>): unknown;
            error: string;
        }>[] = [
            {
                name: 'kind',
                mutate: (record) => ({ ...record, kind: 'future-kind' }),
                error: 'Unknown state mutation outbox kind: future-kind',
            },
            {
                name: 'effect',
                mutate: (record) => ({
                    ...record,
                    effects: ['future-effect'],
                }),
                error: 'Unknown state mutation outbox effect: future-effect',
            },
            {
                name: 'duplicate effect',
                mutate: (record) => ({
                    ...record,
                    effects: ['group-state-sync', 'group-state-sync'],
                }),
                error: 'State mutation outbox effects must be unique',
            },
            {
                name: 'inapplicable effect',
                mutate: (record) => ({
                    ...record,
                    effects: ['client-state-sync'],
                }),
                error: 'Invalid group state mutation outbox intent',
            },
            {
                name: 'event kind',
                mutate: (record) => ({
                    ...record,
                    event: { kind: 'future-event' },
                }),
                error: 'Invalid group state mutation outbox event kind',
            },
            {
                name: 'delivery kind',
                mutate: (record) => ({
                    ...record,
                    delivery: { status: 'future-delivery' },
                }),
                error: 'Unknown state mutation outbox delivery status: future-delivery',
            },
            {
                name: 'attempt kind',
                mutate: (record) => ({
                    ...record,
                    attempts: {
                        count: 1,
                        last: { status: 'future-attempt' },
                    },
                }),
                error: 'Unknown state mutation outbox attempt status: future-attempt',
            },
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            const valid = createGroupRecord(createGroupSnapshot(1), {
                commandId: `malformed-${testCase.name}`,
            });
            await insertRawOutboxRecord(runtime, testCase.mutate(valid), valid.outboxId);

            await expect(
                new StateMutationOutboxRepository(runtime).find(valid.outboxId),
            ).rejects.toThrow(testCase.error);
        }
    });

    it('rejects exact events with a mismatched aggregate identity or version', async () => {
        const cases: readonly Readonly<{
            name: string;
            event: GroupEvent;
            error: string;
        }>[] = [
            {
                name: 'identity',
                event: {
                    ...createGroupEvent(1),
                    groupId: 'other-room',
                },
                error: 'Group outbox event does not match its aggregate ref',
            },
            {
                name: 'version',
                event: createGroupEvent(2),
                error: 'Group outbox event does not match its accepted version',
            },
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            const valid = createGroupRecord(createGroupSnapshot(1), {
                commandId: `event-${testCase.name}`,
            });
            const malformed = {
                ...valid,
                event: { kind: 'group' as const, event: testCase.event },
            };
            await insertRawOutboxRecord(runtime, malformed, valid.outboxId);

            await expect(
                new StateMutationOutboxRepository(runtime).find(valid.outboxId),
            ).rejects.toThrow(testCase.error);
            expect(() => createGroupRecord(createGroupSnapshot(1), {
                commandId: `builder-event-${testCase.name}`,
                event: { kind: 'group', event: testCase.event },
            })).toThrow(testCase.error);
        }
    });

    it('accepts every known exact client and group event variant', () => {
        const clientEventTypes = [
            'principal-created',
            'principal-updated',
            'principal-disabled',
            'principal-deleted',
            'instance-registered',
            'instance-updated',
            'instance-revoked',
            'session-authenticated',
            'session-connected',
            'session-heartbeat',
            'session-disconnected',
            'session-expired',
        ] as const;
        const groupEventTypes = [
            'group-created',
            'group-updated',
            'group-archived',
            'group-deleted',
            'member-invited',
            'member-joined',
            'member-left',
            'member-removed',
            'member-banned',
            'member-unbanned',
            'member-role-changed',
            'ownership-transferred',
            'session-connected',
            'session-heartbeat',
            'session-disconnected',
        ] as const;

        for (const eventType of clientEventTypes) {
            expect(() => createClientRecord(createClientSnapshot(1), {
                event: {
                    kind: 'client',
                    event: { ...createClientEvent(1), eventType },
                },
            })).not.toThrow();
        }
        for (const eventType of groupEventTypes) {
            expect(() => createGroupRecord(createGroupSnapshot(1), {
                event: {
                    kind: 'group',
                    event: { ...createGroupEvent(1), eventType },
                },
            })).not.toThrow();
        }
    });

    it('rejects malformed required exact-event fields from builders and storage', async () => {
        const cases: readonly Readonly<{
            name: string;
            kind: 'client' | 'group';
            mutate(event: ClientEvent | GroupEvent): unknown;
            error: string;
        }>[] = [
            {
                name: 'client event object',
                kind: 'client',
                mutate: () => undefined,
                error: 'Client outbox event is required',
            },
            {
                name: 'client event id',
                kind: 'client',
                mutate: (event) => ({ ...event, eventId: '' }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'client event type',
                kind: 'client',
                mutate: (event) => ({ ...event, eventType: 'future-client-event' }),
                error: 'Unknown client outbox event type: future-client-event',
            },
            {
                name: 'client occurred time',
                kind: 'client',
                mutate: (event) => ({ ...event, occurredAtEpochMs: Number.POSITIVE_INFINITY }),
                error: 'Invalid client outbox event occurred time',
            },
            {
                name: 'client actor',
                kind: 'client',
                mutate: (event) => ({ ...event, actor: undefined }),
                error: 'Client outbox event actor is required',
            },
            {
                name: 'client empty actor',
                kind: 'client',
                mutate: (event) => ({ ...event, actor: {} }),
                error: 'Client outbox event actor identity is required',
            },
            {
                name: 'group event object',
                kind: 'group',
                mutate: () => undefined,
                error: 'Group outbox event is required',
            },
            {
                name: 'group event id',
                kind: 'group',
                mutate: (event) => ({ ...event, eventId: '' }),
                error: 'Group outbox event eventId is required',
            },
            {
                name: 'group event type',
                kind: 'group',
                mutate: (event) => ({ ...event, eventType: 'future-group-event' }),
                error: 'Unknown group outbox event type: future-group-event',
            },
            {
                name: 'group occurred time',
                kind: 'group',
                mutate: (event) => ({ ...event, occurredAtEpochMs: -1 }),
                error: 'Invalid group outbox event occurred time',
            },
            {
                name: 'group actor field',
                kind: 'group',
                mutate: (event) => ({
                    ...event,
                    actor: { serviceId: '' },
                }),
                error: 'Invalid group outbox event actor serviceId',
            },
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            const snapshot = testCase.kind === 'client'
                ? createClientSnapshot(1)
                : createGroupSnapshot(1);
            const valid = testCase.kind === 'client'
                ? createClientRecord(snapshot as ClientSnapshot, {
                    commandId: `malformed-builder-${testCase.name}`,
                })
                : createGroupRecord(snapshot as GroupSnapshot, {
                    commandId: `malformed-builder-${testCase.name}`,
                });
            const validEvent = testCase.kind === 'client'
                ? createClientEvent(1)
                : createGroupEvent(1);
            const malformedEvent = testCase.mutate(validEvent);
            const create = () => testCase.kind === 'client'
                ? createClientRecord(snapshot as ClientSnapshot, {
                    commandId: `malformed-builder-${testCase.name}`,
                    event: { kind: 'client', event: malformedEvent as ClientEvent },
                })
                : createGroupRecord(snapshot as GroupSnapshot, {
                    commandId: `malformed-builder-${testCase.name}`,
                    event: { kind: 'group', event: malformedEvent as GroupEvent },
                });

            expect(create).toThrow(testCase.error);
            await insertRawOutboxRecord(runtime, {
                ...valid,
                event: {
                    kind: testCase.kind,
                    event: malformedEvent,
                },
            }, valid.outboxId);
            await expect(
                new StateMutationOutboxRepository(runtime).find(valid.outboxId),
            ).rejects.toThrow(testCase.error);
        }
    });

    it('rejects non-string exact-event scope identities even when the aggregate matches', () => {
        const client = createClientRecord(createClientSnapshot(1));
        const group = createGroupRecord(createGroupSnapshot(1));

        expect(() => createStateMutationOutboxRecord({
            ...client,
            aggregateRef: {
                ...client.aggregateRef,
                applicationId: 7,
            },
            event: {
                kind: 'client',
                event: {
                    ...createClientEvent(1),
                    applicationId: 7,
                },
            },
        } as never)).toThrow('Invalid client aggregate ref');
        expect(() => createStateMutationOutboxRecord({
            ...group,
            aggregateRef: {
                ...group.aggregateRef,
                workspaceId: 7,
            },
            event: {
                kind: 'group',
                event: {
                    ...createGroupEvent(1),
                    workspaceId: 7,
                },
            },
        } as never)).toThrow('Invalid group aggregate ref');
    });

    it('rejects pending and internally inconsistent delivery transitions', async () => {
        const cases: readonly Readonly<{
            name: string;
            attempts: Record<string, unknown>;
            delivery: Record<string, unknown>;
        }>[] = [
            {
                name: 'pending transition',
                attempts: {
                    count: 1,
                    last: {
                        status: 'failed',
                        attemptedAtEpochMs: 2_000,
                        error: 'retry',
                    },
                },
                delivery: { status: 'pending' },
            },
            {
                name: 'older delivered revision',
                attempts: {
                    count: 1,
                    last: {
                        status: 'succeeded',
                        attemptedAtEpochMs: 2_000,
                    },
                },
                delivery: {
                    status: 'delivered',
                    deliveredAtEpochMs: 2_000,
                    deliveredSnapshotRevision: 0,
                },
            },
            {
                name: 'failed attempt without an error',
                attempts: {
                    count: 1,
                    last: {
                        status: 'failed',
                        attemptedAtEpochMs: 2_000,
                        error: '',
                    },
                },
                delivery: { status: 'retryable' },
            },
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            const repository = new StateMutationOutboxRepository(runtime);
            const inserted = await repository.putOrLoad(
                createClientRecord(createClientSnapshot(1), {
                    commandId: `transition-${testCase.name}`,
                }),
            );

            await expect(repository.writeDelivery({
                outboxId: inserted.record.outboxId,
                expectedStorageRevision: inserted.storageRevision,
                attempts: testCase.attempts as never,
                delivery: testCase.delivery as never,
            })).rejects.toThrow();
            expect((await repository.find(inserted.record.outboxId))?.record)
                .toMatchObject({
                    attempts: {
                        count: 0,
                        last: { status: 'never-attempted' },
                    },
                    delivery: { status: 'pending' },
                });
        }
    });

    it('pages only pending and retryable rows without locks', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const first = await repository.putOrLoad(
            createClientRecord(createClientSnapshot(1), { commandId: 'command-1' }),
        );
        await repository.putOrLoad(
            createClientRecord(createClientSnapshot(2), { commandId: 'command-2' }),
        );
        await repository.writeDelivery({
            outboxId: first.record.outboxId,
            expectedStorageRevision: first.storageRevision,
            attempts: {
                count: 1,
                last: { status: 'succeeded', attemptedAtEpochMs: 2_000 },
            },
            delivery: {
                status: 'delivered',
                deliveredAtEpochMs: 2_000,
                deliveredSnapshotRevision: 1,
            },
        });

        const page = await repository.listPendingPage({ limit: 1 });

        expect(page.records).toHaveLength(1);
        expect(page.records[0]?.record.commandId).toBe('command-2');
        expect(runtime.locks).toEqual([]);
    });
});

describe('StateMutationOutboxWork', () => {
    it('keeps a committed intent drainable after a process restart', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const snapshot = createClientSnapshot(1);
        await runtime.begin(async (transaction) => {
            requireConditionalWrite(await transaction.insertIfAbsent(
                'domain:test',
                'client:alice',
                JSON.stringify(snapshot.principal),
                Number.MAX_SAFE_INTEGER,
            ));
            await new StateMutationOutboxRepository(transaction).putOrLoad(
                createClientRecord(snapshot),
            );
        });
        const publisher = createStateSyncPublisher();
        const restartedWork = createWork(runtime, {
            clientSnapshot: snapshot,
            publisher,
            now: () => 2_000,
        });

        expect(await restartedWork.hasPending()).toBe(true);
        expect(await restartedWork.drainPending()).toEqual({
            scanned: 1,
            delivered: 1,
            retryable: 0,
        });

        const stored = await findOnlyRecord(runtime);
        expect(stored.record.delivery).toEqual({
            status: 'delivered',
            deliveredAtEpochMs: 2_000,
            deliveredSnapshotRevision: 1,
        });
        expect(publisher.publishClientSnapshot).toHaveBeenCalledWith(
            snapshot,
            'state-mutation-outbox',
            expect.stringMatching(
                /^state-mutation-.*:client-state-sync:snapshot$/,
            ),
        );
    });

    it('retains retryable state when a downstream enqueue fails and later drains it', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const snapshot = createClientSnapshot(1);
        await insertRecord(runtime, createClientRecord(snapshot));
        const publisher = createStateSyncPublisher();
        publisher.publishClientSnapshot
            .mockRejectedValueOnce(new Error('WS enqueue failed'))
            .mockResolvedValue(undefined);
        let now = 2_000;
        const work = createWork(runtime, {
            clientSnapshot: snapshot,
            publisher,
            now: () => now,
        });

        expect(await work.drainPending()).toEqual({
            scanned: 1,
            delivered: 0,
            retryable: 1,
        });
        expect((await findOnlyRecord(runtime)).record).toMatchObject({
            attempts: {
                count: 1,
                last: {
                    status: 'failed',
                    attemptedAtEpochMs: 2_000,
                    error: 'WS enqueue failed',
                },
            },
            delivery: { status: 'retryable' },
        });

        now = 3_000;
        expect(await work.drainPending()).toMatchObject({ delivered: 1 });
        expect((await findOnlyRecord(runtime)).record).toMatchObject({
            attempts: {
                count: 2,
                last: { status: 'succeeded', attemptedAtEpochMs: 3_000 },
            },
            delivery: {
                status: 'delivered',
                deliveredSnapshotRevision: 1,
            },
        });
    });

    it('continues through later pages when an earlier intent remains retryable', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const first = createClientRecord(createClientSnapshot(1), {
            commandId: 'fairness-command-1',
        });
        const second = createClientRecord(createClientSnapshot(2), {
            commandId: 'fairness-command-2',
        });
        await repository.putOrLoad(first);
        await repository.putOrLoad(second);
        const publisher = createStateSyncPublisher();
        publisher.publishClientSnapshot
            .mockRejectedValueOnce(new Error('first intent remains retryable'))
            .mockResolvedValue(undefined);
        const work = new StateMutationOutboxWork({
            repository,
            readClientSnapshot: async () => createClientSnapshot(2),
            readGroupSnapshot: async () => undefined,
            stateSyncPublisher: publisher,
            pageSize: 1,
        });

        expect(await work.drainPending()).toEqual({
            scanned: 2,
            delivered: 1,
            retryable: 1,
        });
        expect(publisher.publishClientSnapshot).toHaveBeenCalledTimes(2);
        const states = await Promise.all([
            repository.find(first.outboxId),
            repository.find(second.outboxId),
        ]);
        expect(states.map((stored) => stored?.record.delivery.status).sort())
            .toEqual(['delivered', 'retryable']);
    });

    it('lets two drainers race without losing or corrupting delivery', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const snapshot = createClientSnapshot(1);
        await insertRecord(runtime, createClientRecord(snapshot));
        let entered = 0;
        let release!: () => void;
        const bothEntered = new Promise<void>((resolve) => {
            release = resolve;
        });
        const publisher = createStateSyncPublisher();
        publisher.publishClientSnapshot.mockImplementation(async () => {
            entered += 1;
            if (entered === 2) {
                release();
            }
            await bothEntered;
        });
        const first = createWork(runtime, { clientSnapshot: snapshot, publisher });
        const second = createWork(runtime, { clientSnapshot: snapshot, publisher });

        await Promise.all([first.drainPending(), second.drainPending()]);

        expect(publisher.publishClientSnapshot).toHaveBeenCalledTimes(2);
        expect((await findOnlyRecord(runtime)).record).toMatchObject({
            attempts: { count: 1 },
            delivery: {
                status: 'delivered',
                deliveredSnapshotRevision: 1,
            },
        });
        expect(runtime.locks).toEqual([]);
    });

    it('reuses the shared retry policy and rereads/recomputes after delivery CAS conflicts', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const accepted = createClientSnapshot(1);
        const stored = await repository.putOrLoad(createClientRecord(accepted));
        const snapshots = [
            createClientSnapshot(1),
            createClientSnapshot(2),
            createClientSnapshot(3),
        ];
        const readRevisions: number[] = [];
        const publishedRevisions: number[] = [];
        const deliveryIds: string[] = [];
        const sleeps: number[] = [];
        const timingEvents: RallarTimingEvent[] = [];
        let forcedConflicts = 0;
        runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                operation === 'upsertIfRevision' &&
                namespace === STATE_MUTATION_OUTBOX_NAMESPACE &&
                forcedConflicts < 2
            ) {
                forcedConflicts += 1;
                await advanceOutboxAsCompetingRetry(runtime, namespace, key);
            }
        };
        const publisher = createStateSyncPublisher();
        publisher.publishClientSnapshot.mockImplementation(async (
            snapshot,
            _senderId,
            deliveryId,
        ) => {
            publishedRevisions.push(snapshot.stateRevision);
            deliveryIds.push(deliveryId!);
        });
        let reads = 0;
        const work = new StateMutationOutboxWork({
            repository,
            readClientSnapshot: async () => {
                const snapshot = snapshots[reads++]!;
                readRevisions.push(snapshot.stateRevision);
                return snapshot;
            },
            readGroupSnapshot: async () => undefined,
            stateSyncPublisher: publisher,
            sleep: async (delayMs) => {
                sleeps.push(delayMs);
            },
            timing: (event) => timingEvents.push(event),
        });

        await expect(work.drainPending()).resolves.toEqual({
            scanned: 1,
            delivered: 1,
            retryable: 0,
        });

        expect(readRevisions).toEqual([1, 2, 3]);
        expect(publishedRevisions).toEqual([1, 2, 3]);
        expect(new Set(deliveryIds)).toEqual(new Set([
            `${stored.record.outboxId}:client-state-sync:snapshot`,
        ]));
        expect(sleeps).toEqual([2, 8]);
        expect(timingEvents.map((event) => ({
            component: event.component,
            operation: event.operation,
            status: event.status,
            attempt: event.details?.attempt,
            delayMs: event.details?.delayMs,
            outcome: event.details?.outcome,
            terminal: event.details?.terminal,
        }))).toEqual([
            {
                component: 'state-mutation-outbox',
                operation: 'delivery-cas-attempt',
                status: 'ok',
                attempt: 1,
                delayMs: 0,
                outcome: 'conflicted',
                terminal: false,
            },
            {
                component: 'state-mutation-outbox',
                operation: 'delivery-cas-attempt',
                status: 'ok',
                attempt: 2,
                delayMs: 2,
                outcome: 'conflicted',
                terminal: false,
            },
            {
                component: 'state-mutation-outbox',
                operation: 'delivery-cas-attempt',
                status: 'ok',
                attempt: 3,
                delayMs: 8,
                outcome: 'delivered',
                terminal: true,
            },
        ]);
    });

    it('throws the shared retry-exhausted error after three delivery CAS conflicts', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const snapshot = createClientSnapshot(1);
        await repository.putOrLoad(createClientRecord(snapshot));
        const sleeps: number[] = [];
        const timingEvents: RallarTimingEvent[] = [];
        let forcedConflicts = 0;
        let reads = 0;
        runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                operation === 'upsertIfRevision' &&
                namespace === STATE_MUTATION_OUTBOX_NAMESPACE
            ) {
                forcedConflicts += 1;
                await advanceOutboxAsCompetingRetry(runtime, namespace, key);
            }
        };
        const work = new StateMutationOutboxWork({
            repository,
            readClientSnapshot: async () => {
                reads += 1;
                return snapshot;
            },
            readGroupSnapshot: async () => undefined,
            stateSyncPublisher: createStateSyncPublisher(),
            sleep: async (delayMs) => {
                sleeps.push(delayMs);
            },
            timing: (event) => timingEvents.push(event),
        });

        let thrown: unknown;
        try {
            await work.drainPending();
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(RuntimeStateRetryExhaustedError);
        expect(thrown).toMatchObject({
            status: 503,
            code: 'runtime-state-write-conflict',
            attempts: 3,
            cause: expect.any(RuntimeStateWriteConflictError),
        });
        expect(forcedConflicts).toBe(3);
        expect(reads).toBe(3);
        expect(sleeps).toEqual([2, 8]);
        expect(timingEvents.map((event) => event.details)).toMatchObject([
            { attempt: 1, delayMs: 0, outcome: 'conflicted', terminal: false },
            { attempt: 2, delayMs: 2, outcome: 'conflicted', terminal: false },
            { attempt: 3, delayMs: 8, outcome: 'exhausted', terminal: true },
        ]);
    });

    it('publishes a superseding compatible snapshot and the exact event carried by the intent', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const accepted = createClientSnapshot(1);
        const superseding = createClientSnapshot(3);
        const event = createClientEvent(1);
        await insertRecord(runtime, createClientRecord(accepted, {
            event: { kind: 'client', event },
        }));
        const publisher = createStateSyncPublisher();
        const work = createWork(runtime, {
            clientSnapshot: superseding,
            publisher,
        });

        await work.drainPending();

        expect(publisher.publishClientSnapshot).toHaveBeenCalledWith(
            superseding,
            'state-mutation-outbox',
            expect.stringMatching(
                /^state-mutation-.*:client-state-sync:snapshot$/,
            ),
        );
        expect(publisher.publishClientEvent).toHaveBeenCalledWith(
            event,
            'state-mutation-outbox',
            expect.stringMatching(
                /^state-mutation-.*:client-state-sync:event:client-event-1$/,
            ),
        );
        expect((await findOnlyRecord(runtime)).record.delivery).toMatchObject({
            status: 'delivered',
            deliveredSnapshotRevision: 1,
        });
    });

    it('does not publish a snapshot older than the accepted intent', async () => {
        const runtime = new FakeRuntimeStateRepository();
        await insertRecord(runtime, createClientRecord(createClientSnapshot(2)));
        const publisher = createStateSyncPublisher();
        const work = createWork(runtime, {
            clientSnapshot: createClientSnapshot(1),
            publisher,
        });

        expect(await work.drainPending()).toMatchObject({ retryable: 1 });
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect((await findOnlyRecord(runtime)).record).toMatchObject({
            attempts: {
                last: {
                    status: 'failed',
                    error: expect.stringContaining('older than intent'),
                },
            },
            delivery: { status: 'retryable' },
        });
    });

    it('keeps pure compute and validation between snapshot read and enqueue', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const accepted = createGroupSnapshot(2);
        const latest = createGroupSnapshot(4);
        const stored = await insertRecord(runtime, createGroupRecord(accepted));
        const read = await readStateMutationOutboxDelivery(stored, {
            readClientSnapshot: async () => undefined,
            readGroupSnapshot: async () => latest,
        });

        const computed = computeStateMutationOutboxDelivery(read);
        expect(() => validateStateMutationOutboxDelivery(computed)).not.toThrow();
        expect(computed.deliveredSnapshotRevision).toBe(4);
        expect(computed.snapshot).toEqual(latest);
    });

    it('dispatches presence summaries through their distinct durable adapter', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const snapshot = createGroupSnapshot(2);
        const stored = await insertRecord(runtime, createGroupRecord(snapshot, {
            effects: ['group-presence-summary'],
        }));
        const stateSyncPublisher = createStateSyncPublisher();
        const presenceSummaryPublisher = {
            enqueueForGroupSnapshot: vi.fn(async () => undefined),
        };
        const work = new StateMutationOutboxWork({
            repository: new StateMutationOutboxRepository(runtime),
            readClientSnapshot: async () => undefined,
            readGroupSnapshot: async () => snapshot,
            stateSyncPublisher,
            groupPresenceSummaryPublisher: presenceSummaryPublisher,
        });

        expect(await work.drainPending()).toMatchObject({ delivered: 1 });
        expect(stateSyncPublisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(presenceSummaryPublisher.enqueueForGroupSnapshot).toHaveBeenCalledWith(
            snapshot,
            `${stored.record.outboxId}:group-presence-summary:snapshot`,
        );
    });

    it('keeps a requested effect retryable when its adapter is unavailable', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const snapshot = createGroupSnapshot(1);
        await insertRecord(runtime, createGroupRecord(snapshot, {
            effects: ['group-presence-summary'],
        }));
        const work = new StateMutationOutboxWork({
            repository: new StateMutationOutboxRepository(runtime),
            readClientSnapshot: async () => undefined,
            readGroupSnapshot: async () => snapshot,
            stateSyncPublisher: createStateSyncPublisher(),
        });

        expect(await work.drainPending()).toEqual({
            scanned: 1,
            delivered: 0,
            retryable: 1,
        });
        expect((await findOnlyRecord(runtime)).record).toMatchObject({
            attempts: {
                last: {
                    status: 'failed',
                    error: expect.stringContaining(
                        'Group presence summary outbox adapter is unavailable',
                    ),
                },
            },
            delivery: { status: 'retryable' },
        });
    });

    it('keeps a requested topology effect retryable when its adapter is unavailable', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const snapshot = createGroupSnapshot(1);
        await insertRecord(runtime, createGroupRecord(snapshot, {
            effects: ['rtc-topology-recompute'],
        }));
        const work = new StateMutationOutboxWork({
            repository: new StateMutationOutboxRepository(runtime),
            readClientSnapshot: async () => undefined,
            readGroupSnapshot: async () => snapshot,
            stateSyncPublisher: createStateSyncPublisher(),
        });

        expect(await work.drainPending()).toEqual({
            scanned: 1,
            delivered: 0,
            retryable: 1,
        });
        expect((await findOnlyRecord(runtime)).record).toMatchObject({
            attempts: {
                last: {
                    status: 'failed',
                    error: expect.stringContaining(
                        'RTC topology outbox adapter is unavailable',
                    ),
                },
            },
            delivery: { status: 'retryable' },
        });
    });

    it('keeps effect identities stable and records the oldest durable winner', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const accepted = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);
        const revision3 = createGroupSnapshot(3);
        const stored = await insertRecord(runtime, createGroupRecord(accepted, {
            effects: [
                'group-state-sync',
                'group-presence-summary',
                'rtc-topology-recompute',
            ],
        }));
        let latest = revision2;
        const stateWinners = new Map<string, number>();
        const presenceWinners = new Map<string, number>();
        const topologyWinners = new Map<string, number>();
        let presenceAttempts = 0;
        const stateSyncPublisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async (
                snapshot: GroupSnapshot,
                _senderId?: string,
                deliveryId?: string,
            ) => {
                expect(deliveryId).toBeDefined();
                const winner = stateWinners.get(deliveryId!) ??
                    snapshot.stateRevision;
                stateWinners.set(deliveryId!, winner);
                return { effectiveSnapshotRevision: winner };
            }),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const presencePublisher = {
            enqueueForGroupSnapshot: vi.fn(async (
                snapshot: GroupSnapshot,
                deliveryId: string,
            ) => {
                const winner = presenceWinners.get(deliveryId) ??
                    snapshot.stateRevision;
                presenceWinners.set(deliveryId, winner);
                presenceAttempts += 1;
                if (presenceAttempts === 1) {
                    throw new Error('failed after durable presence enqueue');
                }
                return { effectiveSnapshotRevision: winner };
            }),
        };
        const topologyPublisher = {
            enqueueForStateMutation: vi.fn(async (
                snapshot: GroupSnapshot,
                deliveryId: string,
            ) => {
                const winner = topologyWinners.get(deliveryId) ??
                    snapshot.stateRevision;
                topologyWinners.set(deliveryId, winner);
                return { effectiveSnapshotRevision: winner };
            }),
        };
        const work = new StateMutationOutboxWork({
            repository: new StateMutationOutboxRepository(runtime),
            readClientSnapshot: async () => undefined,
            readGroupSnapshot: async () => latest,
            stateSyncPublisher,
            groupPresenceSummaryPublisher: presencePublisher,
            rtcTopologyPublisher: topologyPublisher,
        });

        expect(await work.drainPending()).toMatchObject({ retryable: 1 });
        latest = revision3;
        expect(await work.drainPending()).toMatchObject({ delivered: 1 });

        expect([...stateWinners.entries()]).toEqual([[
            `${stored.record.outboxId}:group-state-sync:snapshot`,
            2,
        ]]);
        expect([...presenceWinners.entries()]).toEqual([[
            `${stored.record.outboxId}:group-presence-summary:snapshot`,
            2,
        ]]);
        expect([...topologyWinners.entries()]).toEqual([[
            `${stored.record.outboxId}:rtc-topology-recompute:snapshot`,
            3,
        ]]);
        expect((await findOnlyRecord(runtime)).record.delivery).toEqual({
            status: 'delivered',
            deliveredAtEpochMs: expect.any(Number),
            deliveredSnapshotRevision: 2,
        });
    });

    it('uses deterministic WS and APP_OUTBOX keys across repeated drain attempts', async () => {
        configureTestCacheRepositories();
        const runtime = new FakeRuntimeStateRepository();
        const snapshot = createGroupSnapshot(2);
        const event = createGroupEvent(2);
        await insertRecord(runtime, createGroupRecord(snapshot, {
            event: { kind: 'group', event },
            effects: [
                'group-state-sync',
                'rtc-topology-recompute',
            ],
        }));
        const wsMessages = new Map<string, ALMessage>();
        const stateSyncPublisher = createWsStateSyncPublisher(
            {
                enqueueOutboxIfAbsent: vi.fn(async (message: ALMessage) => {
                    const key = message.id.msgId;
                    const status = wsMessages.has(key) ? 'duplicate' : 'enqueued';
                    wsMessages.set(key, message);
                    return { status, message, entries: [] } as const;
                }),
            } as unknown as WsQueueBoxServerService,
            { serverId: 'server-a' },
        );
        const appOutbox = new InMemoryQueueBox();
        const topology = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(appOutbox),
            senderId: 'server-a',
            now: () => 2_000,
        });
        const work = new StateMutationOutboxWork({
            repository: new StateMutationOutboxRepository(runtime),
            readClientSnapshot: async () => undefined,
            readGroupSnapshot: async () => snapshot,
            stateSyncPublisher,
            rtcTopologyPublisher: topology.publisher,
            now: () => 2_000,
        });

        await Promise.all([
            work.drainPending(),
            new StateMutationOutboxWork({
                repository: new StateMutationOutboxRepository(runtime),
                readClientSnapshot: async () => undefined,
                readGroupSnapshot: async () => snapshot,
                stateSyncPublisher,
                rtcTopologyPublisher: topology.publisher,
                now: () => 2_000,
            }).drainPending(),
        ]);

        expect(wsMessages.size).toBe(3);
        expect(
            [...wsMessages.keys()].every((messageId) =>
                messageId.startsWith('state-sync-')
            ),
        ).toBe(true);
        expect([...wsMessages.values()].filter((message) =>
            message.route.resourceId === event.eventId
        )).toHaveLength(1);
        expect(await appOutbox.getAllKeys()).toHaveLength(1);
        expect((await findOnlyRecord(runtime)).record.delivery).toMatchObject({
            status: 'delivered',
            deliveredSnapshotRevision: 2,
        });
    });
});

describe('state mutation outbox middleware work', () => {
    it('constructs and registers a restart-safe drainer from explicit dependencies', async () => {
        const repository = new StateMutationOutboxRepository(
            new FakeRuntimeStateRepository(),
        );
        const hasPending = vi.spyOn(repository, 'listPendingPage');
        const runtime = createRallarMiddleware({
            inbox: new InMemoryQueueBox(),
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            resilience: {
                inbox: createResilienceStub(),
                appOutbox: createResilienceStub(),
            },
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
            stateMutationOutbox: {
                repository,
                readClientSnapshot: async () => undefined,
                readGroupSnapshot: async () => undefined,
                stateSyncPublisher: createStateSyncPublisher(),
            },
        });
        const task = readEngineTask(runtime.qboxEngine, AppOutboxType.STATE_MUTATION_OUTBOX_DRAIN);

        expect(task).toBeDefined();
        expect(runtime.stateMutationOutboxWork).toBeInstanceOf(
            StateMutationOutboxWork,
        );
        expect(await task!.isWork()).toBe(false);
        await task!.runnable();
        expect(hasPending).toHaveBeenCalled();
    });

    it('forwards injected retry sleep and timing through middleware construction', async () => {
        const backing = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(backing);
        const snapshot = createClientSnapshot(1);
        await repository.putOrLoad(createClientRecord(snapshot));
        const sleeps: number[] = [];
        const timingEvents: RallarTimingEvent[] = [];
        let forcedConflict = false;
        backing.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                operation === 'upsertIfRevision' &&
                namespace === STATE_MUTATION_OUTBOX_NAMESPACE &&
                !forcedConflict
            ) {
                forcedConflict = true;
                await advanceOutboxAsCompetingRetry(backing, namespace, key);
            }
        };
        const runtime = createRallarMiddleware({
            inbox: new InMemoryQueueBox(),
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            resilience: {
                inbox: createResilienceStub(),
                appOutbox: createResilienceStub(),
            },
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
            stateMutationOutbox: {
                repository,
                readClientSnapshot: async () => snapshot,
                readGroupSnapshot: async () => undefined,
                stateSyncPublisher: createStateSyncPublisher(),
                sleep: async (delayMs) => {
                    sleeps.push(delayMs);
                },
                timing: (event) => timingEvents.push(event),
            },
        });

        await runtime.stateMutationOutboxWork!.drainPending();

        expect(sleeps).toEqual([2]);
        expect(timingEvents.map((event) => event.details?.outcome)).toEqual([
            'conflicted',
            'delivered',
        ]);
    });

    it('leaves drainer activation to the Task 3/4 mutation producer wiring', () => {
        const runtime = createRallarMiddleware({
            inbox: new InMemoryQueueBox(),
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            resilience: {
                inbox: createResilienceStub(),
                appOutbox: createResilienceStub(),
            },
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
        });

        expect(runtime.stateMutationOutboxWork).toBeUndefined();
        expect(readEngineTask(
            runtime.qboxEngine,
            AppOutboxType.STATE_MUTATION_OUTBOX_DRAIN,
        )).toBeUndefined();
    });

    it('exposes the coalesced topology publisher as a post-commit adapter', async () => {
        const queue = new InMemoryQueueBox();
        const outboxQueueReader = new OutboxQueueReader(queue);
        const ws = new WsQueueBoxServerService(
            queue,
            queue,
            new JsonWebSocketServer(),
            'server-a',
        );
        const installed = initRallarSystemWsTopics(ws, {
            initDynamicTopics: false,
            rtcTopologyAppOutbox: {
                outboxQueueReader,
                executionRepository: new RtcTopologyExecutionRepository(
                    new FakeRuntimeStateRepository(),
                ),
                publicationFanout: {
                    readiness: Promise.resolve(),
                    publish: async () => 0,
                    deliverLocal: () => 0,
                },
            },
        });

        await installed.rtcTopologyWorkPublisher!.enqueueForGroupSnapshot(
            createGroupSnapshot(1),
        );

        expect(await queue.getAllKeys()).toHaveLength(1);
    });
});

function createClientRecord(
    snapshot: ClientSnapshot,
    overrides: Partial<Extract<
        CreateStateMutationOutboxRecordInput,
        { kind: 'client' }
    >> = {},
) {
    return createStateMutationOutboxRecord({
        commandId: 'command-1',
        commandHash: hashStateMutationCommand({ requestId: 'command-1' }),
        kind: 'client',
        aggregateRef: {
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            principalId: snapshot.principal.principalId,
        },
        acceptedCausalRevision: toClientStateMutationCausalRevision(snapshot),
        event: { kind: 'none' },
        effects: ['client-state-sync'],
        createdAtEpochMs: 1_000,
        ...overrides,
    });
}

function createGroupRecord(
    snapshot: GroupSnapshot,
    overrides: Partial<Extract<
        CreateStateMutationOutboxRecordInput,
        { kind: 'group' }
    >> = {},
) {
    return createStateMutationOutboxRecord({
        commandId: 'group-command-1',
        commandHash: hashStateMutationCommand({ requestId: 'group-command-1' }),
        kind: 'group',
        aggregateRef: snapshot.group,
        acceptedCausalRevision: toGroupStateMutationCausalRevision(snapshot),
        event: { kind: 'none' },
        effects: ['group-state-sync'],
        createdAtEpochMs: 1_000,
        ...overrides,
    });
}

async function insertRecord(
    runtime: FakeRuntimeStateRepository,
    record: ReturnType<typeof createStateMutationOutboxRecord>,
) {
    return await new StateMutationOutboxRepository(runtime).putOrLoad(record);
}

async function insertRawOutboxRecord(
    runtime: FakeRuntimeStateRepository,
    record: unknown,
    outboxId: string,
): Promise<void> {
    requireConditionalWrite(await runtime.insertIfAbsent(
        STATE_MUTATION_OUTBOX_NAMESPACE,
        `intent:${outboxId}`,
        JSON.stringify(record),
        Number.MAX_SAFE_INTEGER,
    ));
}

async function advanceOutboxAsCompetingRetry(
    runtime: FakeRuntimeStateRepository,
    namespace: string,
    key: string,
): Promise<void> {
    const current = await runtime.findEntry(namespace, key);
    if (!current) {
        throw new Error(`Missing competing outbox row: ${key}`);
    }
    const record = JSON.parse(current.value) as ReturnType<
        typeof createStateMutationOutboxRecord
    >;
    await runtime.upsert(
        namespace,
        key,
        JSON.stringify({
            ...record,
            attempts: {
                count: record.attempts.count + 1,
                last: {
                    status: 'failed',
                    attemptedAtEpochMs: 9_000 + record.attempts.count,
                    error: 'competing delivery retry',
                },
            },
            delivery: { status: 'retryable' },
        }),
        current.expireAtTimestamp,
    );
}

async function findOnlyRecord(runtime: FakeRuntimeStateRepository) {
    const entries = await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    return {
        record: JSON.parse(entry.value) as ReturnType<
            typeof createStateMutationOutboxRecord
        >,
        storageRevision: entry.revision,
    };
}

function createWork(
    runtime: FakeRuntimeStateRepository,
    options: Readonly<{
        clientSnapshot: ClientSnapshot;
        publisher?: ReturnType<typeof createStateSyncPublisher>;
        now?: () => number;
    }>,
) {
    return new StateMutationOutboxWork({
        repository: new StateMutationOutboxRepository(runtime),
        readClientSnapshot: async () => options.clientSnapshot,
        readGroupSnapshot: async () => undefined,
        stateSyncPublisher: options.publisher ?? createStateSyncPublisher(),
        now: options.now,
    });
}

function createStateSyncPublisher() {
    return {
        publishClientSnapshot: vi.fn(async () => undefined),
        publishClientEvent: vi.fn(async () => undefined),
        publishGroupSnapshot: vi.fn(async () => undefined),
        publishGroupEvent: vi.fn(async () => undefined),
    };
}

function createClientSnapshot(stateRevision: number): ClientSnapshot {
    return {
        stateRevision,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'alice',
            username: 'alice',
            displayName: 'Alice',
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: stateRevision,
            profileVersion: stateRevision,
            presenceVersion: stateRevision,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: stateRevision, byServiceId: 'test' },
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
    };
}

function createClientEvent(snapshotVersion: number): ClientEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'alice',
        eventId: `client-event-${snapshotVersion}`,
        eventType: 'principal-updated',
        snapshotVersion,
        occurredAtEpochMs: snapshotVersion,
        actor: { serviceId: 'test' },
        requestId: 'command-1',
    };
}

function createGroupSnapshot(stateRevision: number): GroupSnapshot {
    return {
        stateRevision,
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            displayName: 'Room 1',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: stateRevision,
            metadataVersion: stateRevision,
            rosterVersion: stateRevision,
            presenceVersion: stateRevision,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: stateRevision, byServiceId: 'test' },
        },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0,
    };
}

function createGroupEvent(snapshotVersion: number): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        eventId: `group-event-${snapshotVersion}`,
        eventType: 'group-updated',
        snapshotVersion,
        occurredAtEpochMs: snapshotVersion,
        actor: { serviceId: 'test' },
        requestId: 'group-command-1',
    };
}

function readEngineTask(
    engine: unknown,
    name: string,
): Readonly<{
    isWork(): boolean | Promise<boolean>;
    runnable(): void | Promise<void>;
}> | undefined {
    return (engine as {
        tasks: Map<string, Readonly<{
            isWork(): boolean | Promise<boolean>;
            runnable(): void | Promise<void>;
        }>>;
    }).tasks.get(name);
}

function createResilienceStub() {
    return {
        checkReserveTimeouts: { isEntryRateLimiter: () => false },
        checkFailed: { isEntryRateLimiter: () => false },
    } as never;
}
