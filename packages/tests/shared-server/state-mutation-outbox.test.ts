import { describe, expect, it, vi } from 'vitest';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
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
    toStateMutationOutboxId,
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

const TEST_COMMAND_HASH = `sha256:${'0'.repeat(64)}`;
const ALTERNATE_TEST_COMMAND_HASH = `sha256:${'1'.repeat(64)}`;

describe('StateMutationOutboxRepository', () => {
    it('builds a mandatory immutable intent with canonical SHA-256 command identity', async () => {
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
            commandHash: await hashStateMutationCommand(command),
        });
        const duplicate = createClientRecord(snapshot, {
            commandHash: await hashStateMutationCommand(reorderedCommand),
        });
        const successor = createClientRecord(createClientSnapshot(5), {
            commandHash: first.commandHash,
        });

        expect(first).toEqual({
            outboxId: expect.stringMatching(/^state-mutation-/),
            commandId: 'command-1',
            commandHash: 'sha256:c1a4ee4548686248ec994158b790f39461535d94d63a7e7e31ac440c7049b26d',
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

    it('rejects command values whose meaning cannot survive canonical JSON', async () => {
        class CommandClass {
            readonly requestId = 'command-1';
        }
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const sparse = new Array(2);
        sparse[1] = 'present';
        const accessorRead = vi.fn(() => 'secret');
        const accessor = Object.defineProperty({}, 'secret', {
            enumerable: true,
            get: accessorRead,
        });
        const symbolKey = { requestId: 'command-1' } as Record<
            string | symbol,
            unknown
        >;
        symbolKey[Symbol('hidden')] = 'lost';
        const nonEnumerable = Object.defineProperty({}, 'hidden', {
            enumerable: false,
            value: 'lost',
        });
        const arrayWithProperty = ['item'] as unknown[] & { extra?: string };
        arrayWithProperty.extra = 'lost';
        class CommandArray extends Array<unknown> {}
        const subclassArray = new CommandArray();
        subclassArray.push('value');

        const cases: readonly Readonly<{ name: string; value: unknown }>[] = [
            { name: 'undefined', value: undefined },
            { name: 'function', value: () => undefined },
            { name: 'symbol', value: Symbol('command') },
            { name: 'bigint', value: 1n },
            { name: 'NaN', value: Number.NaN },
            { name: 'positive infinity', value: Number.POSITIVE_INFINITY },
            { name: 'negative infinity', value: Number.NEGATIVE_INFINITY },
            { name: 'negative zero', value: -0 },
            { name: 'date', value: new Date(0) },
            { name: 'map', value: new Map([['key', 'value']]) },
            { name: 'set', value: new Set(['value']) },
            { name: 'class instance', value: new CommandClass() },
            { name: 'prototype object', value: Object.create({ inherited: true }) },
            { name: 'cycle', value: cyclic },
            { name: 'sparse array', value: sparse },
            { name: 'accessor', value: accessor },
            { name: 'symbol key', value: symbolKey },
            { name: 'non-enumerable key', value: nonEnumerable },
            { name: 'array property', value: arrayWithProperty },
            { name: 'array subclass', value: subclassArray },
            {
                name: 'nested undefined',
                value: { payload: { lost: undefined } },
            },
            {
                name: 'nested map',
                value: { payload: [{ lost: new Map() }] },
            },
        ];

        for (const testCase of cases) {
            await expect(
                hashStateMutationCommand(testCase.value),
                testCase.name,
            ).rejects.toThrow('State mutation command must be JSON-safe');
        }
        expect(accessorRead).not.toHaveBeenCalled();
    });

    it('accepts repeated JSON references and null-prototype command objects', async () => {
        const repeated = { value: 7 };
        const nullPrototype = Object.assign(Object.create(null), {
            requestId: 'command-1',
            left: repeated,
            right: repeated,
        });

        const digest = await hashStateMutationCommand(nullPrototype);
        const expandedDigest = await hashStateMutationCommand({
            left: { value: 7 },
            requestId: 'command-1',
            right: { value: 7 },
        });

        expect(digest).toBe(expandedDigest);
        expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(await hashStateMutationCommand({ value: 1 })).not.toBe(
            await hashStateMutationCommand({ value: 2 }),
        );
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
            commandHash: ALTERNATE_TEST_COMMAND_HASH,
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

    it('uses a validated insert-only operation for authoritative writes and never reads a collision winner', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);
        const record = createClientRecord(createClientSnapshot(1));
        const first = await repository.insertForAuthoritativeWrite(record);
        expect(first.record).toEqual(record);

        const findEntry = vi.spyOn(runtime, 'findEntry');
        await expect(repository.insertForAuthoritativeWrite(structuredClone(record)))
            .rejects.toMatchObject({
                code: 'state-mutation-outbox-collision',
            });
        expect(findEntry).not.toHaveBeenCalled();
        expect(await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE))
            .toHaveLength(1);
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
            builderError?: string;
        }>[] = [
            {
                name: 'client event object',
                kind: 'client',
                mutate: () => undefined,
                error: 'Client outbox event is required',
                builderError: 'State mutation outbox input must be JSON-safe',
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
                builderError: 'State mutation outbox input must be JSON-safe',
            },
            {
                name: 'client actor',
                kind: 'client',
                mutate: (event) => ({ ...event, actor: undefined }),
                error: 'Client outbox event fields are invalid',
                builderError: 'State mutation outbox input must be JSON-safe',
            },
            {
                name: 'client empty actor',
                kind: 'client',
                mutate: (event) => ({ ...event, actor: {} }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'group event object',
                kind: 'group',
                mutate: () => undefined,
                error: 'Group outbox event is required',
                builderError: 'State mutation outbox input must be JSON-safe',
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
                error: 'Group outbox event actor shape is invalid',
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

            expect(create).toThrow(testCase.builderError ?? testCase.error);
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

    it('rejects malformed mandatory strings before builder identity derivation', () => {
        const valid = createClientRecord(createClientSnapshot(1), {
            event: { kind: 'client', event: createClientEvent(1) },
        });
        const {
            outboxId: _outboxId,
            attempts: _attempts,
            delivery: _delivery,
            ...validInput
        } = valid;
        const cases: readonly Readonly<{
            name: string;
            mutate(input: typeof validInput): unknown;
            error: string;
        }>[] = [
            {
                name: 'numeric command id',
                mutate: (input) => ({ ...input, commandId: 7 }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'blank command id',
                mutate: (input) => ({ ...input, commandId: ' \t ' }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'object command id',
                mutate: (input) => ({ ...input, commandId: { bad: true } }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'array command id',
                mutate: (input) => ({ ...input, commandId: ['bad'] }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'numeric command hash',
                mutate: (input) => ({ ...input, commandHash: 7 }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'object command hash',
                mutate: (input) => ({
                    ...input,
                    commandHash: { bad: true },
                }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'array command hash',
                mutate: (input) => ({ ...input, commandHash: ['bad'] }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'blank command hash',
                mutate: (input) => ({ ...input, commandHash: '  ' }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'legacy command hash algorithm',
                mutate: (input) => ({
                    ...input,
                    commandHash: 'fnv1a64:legacy',
                }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'uppercase command hash',
                mutate: (input) => ({
                    ...input,
                    commandHash: `sha256:${'A'.repeat(64)}`,
                }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'short command hash',
                mutate: (input) => ({
                    ...input,
                    commandHash: 'sha256:1234',
                }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'blank application id',
                mutate: (input) => ({
                    ...input,
                    aggregateRef: {
                        ...input.aggregateRef,
                        applicationId: ' ',
                    },
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            applicationId: ' ',
                        },
                    },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'blank workspace id',
                mutate: (input) => ({
                    ...input,
                    aggregateRef: {
                        ...input.aggregateRef,
                        workspaceId: '\t',
                    },
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            workspaceId: '\t',
                        },
                    },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'object principal id',
                mutate: (input) => ({
                    ...input,
                    aggregateRef: {
                        ...input.aggregateRef,
                        principalId: { bad: true },
                    },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'numeric principal id',
                mutate: (input) => ({
                    ...input,
                    aggregateRef: { ...input.aggregateRef, principalId: 7 },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'array principal id',
                mutate: (input) => ({
                    ...input,
                    aggregateRef: {
                        ...input.aggregateRef,
                        principalId: ['alice'],
                    },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'numeric event id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: 7 },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'blank event id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: '  ' },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'object event id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: { bad: true } },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'array event id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: ['bad'] },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'array actor principal id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { principalId: ['alice'] },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'blank actor service id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { serviceId: '  ' },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'numeric actor service id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { serviceId: 7 },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'object actor service id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { serviceId: { bad: true } },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'object request id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            requestId: { bad: true },
                        },
                    },
                }),
                error: 'Invalid client outbox event requestId',
            },
            {
                name: 'blank request id',
                mutate: (input) => ({
                    ...input,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            requestId: ' ',
                        },
                    },
                }),
                error: 'Invalid client outbox event requestId',
            },
        ];

        for (const testCase of cases) {
            expect(() => createStateMutationOutboxRecord(
                testCase.mutate(structuredClone(validInput)) as never,
            ), testCase.name).toThrow(testCase.error);
        }

        expect(() => toStateMutationOutboxId({
            ...validInput,
            commandId: 7,
        } as never)).toThrow('Invalid state mutation outbox command id');
    });

    it('rejects malformed mandatory strings from persisted records', async () => {
        const valid = createClientRecord(createClientSnapshot(1), {
            event: { kind: 'client', event: createClientEvent(1) },
        });
        const retryable = {
            ...valid,
            attempts: {
                count: 1,
                last: {
                    status: 'failed',
                    attemptedAtEpochMs: 2_000,
                    error: 'retry delivery',
                },
            },
            delivery: { status: 'retryable' },
        };
        const cases: readonly Readonly<{
            name: string;
            mutate(record: typeof valid): unknown;
            error: string;
        }>[] = [
            {
                name: 'numeric outbox id',
                mutate: (record) => ({ ...record, outboxId: 7 }),
                error: 'Invalid state mutation outbox outbox id',
            },
            {
                name: 'blank outbox id',
                mutate: (record) => ({ ...record, outboxId: '  ' }),
                error: 'Invalid state mutation outbox outbox id',
            },
            {
                name: 'object outbox id',
                mutate: (record) => ({ ...record, outboxId: { bad: true } }),
                error: 'Invalid state mutation outbox outbox id',
            },
            {
                name: 'array outbox id',
                mutate: (record) => ({ ...record, outboxId: ['bad'] }),
                error: 'Invalid state mutation outbox outbox id',
            },
            {
                name: 'numeric command id',
                mutate: (record) => ({ ...record, commandId: 7 }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'object command id',
                mutate: (record) => ({ ...record, commandId: { bad: true } }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'array command id',
                mutate: (record) => ({ ...record, commandId: ['bad'] }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'blank command id',
                mutate: (record) => ({ ...record, commandId: ' \t ' }),
                error: 'Invalid state mutation outbox command id',
            },
            {
                name: 'numeric command hash',
                mutate: (record) => ({ ...record, commandHash: 7 }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'object command hash',
                mutate: (record) => ({
                    ...record,
                    commandHash: { bad: true },
                }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'array command hash',
                mutate: (record) => ({ ...record, commandHash: ['bad'] }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'blank command hash',
                mutate: (record) => ({ ...record, commandHash: ' \t ' }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'legacy command hash algorithm',
                mutate: (record) => ({
                    ...record,
                    commandHash: 'fnv1a64:legacy',
                }),
                error: 'Invalid state mutation outbox command hash',
            },
            {
                name: 'blank matching workspace id',
                mutate: (record) => ({
                    ...record,
                    aggregateRef: {
                        ...record.aggregateRef,
                        workspaceId: ' ',
                    },
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            workspaceId: ' ',
                        },
                    },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'numeric principal id',
                mutate: (record) => ({
                    ...record,
                    aggregateRef: { ...record.aggregateRef, principalId: 7 },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'object principal id',
                mutate: (record) => ({
                    ...record,
                    aggregateRef: {
                        ...record.aggregateRef,
                        principalId: { bad: true },
                    },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'array principal id',
                mutate: (record) => ({
                    ...record,
                    aggregateRef: {
                        ...record.aggregateRef,
                        principalId: ['alice'],
                    },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'blank principal id',
                mutate: (record) => ({
                    ...record,
                    aggregateRef: { ...record.aggregateRef, principalId: ' ' },
                }),
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'numeric event id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: 7 },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'blank event id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: '  ' },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'object event id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: { bad: true } },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'array event id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: { ...createClientEvent(1), eventId: ['bad'] },
                    },
                }),
                error: 'Client outbox event eventId is required',
            },
            {
                name: 'numeric actor service id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { serviceId: 7 },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'blank actor service id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { serviceId: ' ' },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'object actor service id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { serviceId: { bad: true } },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'array actor service id',
                mutate: (record) => ({
                    ...record,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: { serviceId: ['bad'] },
                        },
                    },
                }),
                error: 'Client outbox event actor shape is invalid',
            },
            {
                name: 'numeric retry error',
                mutate: () => ({
                    ...retryable,
                    attempts: {
                        ...retryable.attempts,
                        last: { ...retryable.attempts.last, error: 7 },
                    },
                }),
                error: 'Failed state mutation outbox attempts require an error',
            },
            {
                name: 'object retry error',
                mutate: () => ({
                    ...retryable,
                    attempts: {
                        ...retryable.attempts,
                        last: {
                            ...retryable.attempts.last,
                            error: { bad: true },
                        },
                    },
                }),
                error: 'Failed state mutation outbox attempts require an error',
            },
            {
                name: 'array retry error',
                mutate: () => ({
                    ...retryable,
                    attempts: {
                        ...retryable.attempts,
                        last: { ...retryable.attempts.last, error: ['bad'] },
                    },
                }),
                error: 'Failed state mutation outbox attempts require an error',
            },
            {
                name: 'blank retry error',
                mutate: () => ({
                    ...retryable,
                    attempts: {
                        ...retryable.attempts,
                        last: { ...retryable.attempts.last, error: ' \t ' },
                    },
                }),
                error: 'Failed state mutation outbox attempts require an error',
            },
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            const malformed = testCase.mutate(structuredClone(valid)) as
                Record<string, unknown>;
            const lookupId = typeof malformed.outboxId === 'string'
                ? malformed.outboxId
                : String(malformed.outboxId);
            await insertRawOutboxRecord(runtime, malformed, lookupId);

            await expect(
                new StateMutationOutboxRepository(runtime).find(lookupId),
                testCase.name,
            ).rejects.toThrow(testCase.error);
        }
    });

    it('rejects every malformed group identity string from builders and storage', async () => {
        const valid = createGroupRecord(createGroupSnapshot(1), {
            event: { kind: 'group', event: createGroupEvent(1) },
        });
        const {
            outboxId: _outboxId,
            attempts: _attempts,
            delivery: _delivery,
            ...validInput
        } = valid;
        const malformedStrings: readonly Readonly<{
            name: string;
            value: unknown;
        }>[] = [
            { name: 'number', value: 7 },
            { name: 'object', value: { bad: true } },
            { name: 'array', value: ['bad'] },
            { name: 'blank', value: ' \t ' },
        ];

        for (const malformed of malformedStrings) {
            const invalidAggregate = {
                ...validInput,
                aggregateRef: {
                    ...validInput.aggregateRef,
                    groupId: malformed.value,
                },
            };
            const invalidEvent = {
                ...validInput,
                event: {
                    kind: 'group',
                    event: {
                        ...createGroupEvent(1),
                        groupId: malformed.value,
                    },
                },
            };

            expect(() => createStateMutationOutboxRecord(
                invalidAggregate as never,
            ), `builder aggregate ${malformed.name}`).toThrow(
                'Invalid group aggregate ref',
            );
            expect(() => createStateMutationOutboxRecord(
                invalidEvent as never,
            ), `builder event ${malformed.name}`).toThrow(
                'Invalid group aggregate ref',
            );

            for (const [label, record] of [
                ['aggregate', { ...valid, aggregateRef: invalidAggregate.aggregateRef }],
                ['event', { ...valid, event: invalidEvent.event }],
            ] as const) {
                const runtime = new FakeRuntimeStateRepository();
                await insertRawOutboxRecord(runtime, record, valid.outboxId);
                await expect(
                    new StateMutationOutboxRepository(runtime).find(valid.outboxId),
                    `stored ${label} ${malformed.name}`,
                ).rejects.toThrow('Invalid group aggregate ref');
            }
        }
    });

    it('rejects malformed nested objects and non-numeric authoritative fields', async () => {
        const valid = createClientRecord(createClientSnapshot(1), {
            event: { kind: 'client', event: createClientEvent(1) },
        });
        const {
            outboxId: _outboxId,
            attempts: _attempts,
            delivery: _delivery,
            ...validInput
        } = valid;
        const builderCases: readonly Readonly<{
            name: string;
            input: unknown;
            error: string;
        }>[] = [
            {
                name: 'root',
                input: null,
                error: 'State mutation outbox input is required',
            },
            {
                name: 'aggregate ref',
                input: { ...validInput, aggregateRef: null },
                error: 'Invalid client aggregate ref',
            },
            {
                name: 'causal revision',
                input: { ...validInput, acceptedCausalRevision: [] },
                error: 'Invalid client state mutation outbox intent',
            },
            {
                name: 'event wrapper',
                input: { ...validInput, event: null },
                error: 'Client state mutation outbox event is required',
            },
            {
                name: 'created time boolean',
                input: { ...validInput, createdAtEpochMs: true },
                error: 'Invalid state mutation outbox created time',
            },
            {
                name: 'causal revision string',
                input: {
                    ...validInput,
                    acceptedCausalRevision: {
                        ...validInput.acceptedCausalRevision,
                        stateRevision: '1',
                    },
                },
                error: 'Invalid state mutation outbox client state revision',
            },
        ];

        for (const testCase of builderCases) {
            expect(() => createStateMutationOutboxRecord(testCase.input as never),
                testCase.name).toThrow(testCase.error);
        }

        const persistedCases: readonly Readonly<{
            name: string;
            record: unknown;
            error: string;
        }>[] = [
            {
                name: 'root',
                record: null,
                error: 'State mutation outbox record is required',
            },
            {
                name: 'attempts',
                record: { ...valid, attempts: null },
                error: 'State mutation outbox attempts are required',
            },
            {
                name: 'last attempt',
                record: {
                    ...valid,
                    attempts: { count: 0, last: [] },
                },
                error: 'State mutation outbox last attempt is required',
            },
            {
                name: 'delivery',
                record: { ...valid, delivery: [] },
                error: 'State mutation outbox delivery is required',
            },
            {
                name: 'attempt count boolean',
                record: {
                    ...valid,
                    attempts: { ...valid.attempts, count: true },
                },
                error: 'Invalid state mutation outbox attempt count',
            },
            {
                name: 'event occurred time string',
                record: {
                    ...valid,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            occurredAtEpochMs: '1',
                        },
                    },
                },
                error: 'Invalid client outbox event occurred time',
            },
        ];

        for (const testCase of persistedCases) {
            const runtime = new FakeRuntimeStateRepository();
            await insertRawOutboxRecord(runtime, testCase.record, valid.outboxId);
            await expect(
                new StateMutationOutboxRepository(runtime).find(valid.outboxId),
                testCase.name,
            ).rejects.toThrow(testCase.error);
        }
    });

    it('rejects extra client accepted-causal-revision fields in builders and persisted reads', async () => {
        const snapshot = createClientSnapshot(1);
        const validInput: Extract<
            CreateStateMutationOutboxRecordInput,
            { kind: 'client' }
        > = {
            commandId: 'client-extra-causal-field',
            commandHash: TEST_COMMAND_HASH,
            kind: 'client',
            aggregateRef: snapshot.principal,
            acceptedCausalRevision: toClientStateMutationCausalRevision(snapshot),
            event: { kind: 'none' },
            effects: ['client-state-sync'],
            createdAtEpochMs: 1_000,
        };
        const valid = createStateMutationOutboxRecord(validInput);
        const malformedRevision = {
            ...validInput.acceptedCausalRevision,
            unexpected: true,
        };

        expect(() => createStateMutationOutboxRecord({
            ...validInput,
            acceptedCausalRevision: malformedRevision,
        })).toThrow('Invalid state mutation outbox client accepted causal revision fields');

        const runtime = new FakeRuntimeStateRepository();
        await insertRawOutboxRecord(runtime, {
            ...valid,
            acceptedCausalRevision: malformedRevision,
        }, valid.outboxId);
        await expect(
            new StateMutationOutboxRepository(runtime).find(valid.outboxId),
        ).rejects.toThrow(
            'Invalid state mutation outbox client accepted causal revision fields',
        );
    });

    it('rejects extra group causal-tuple fields in builders and persisted reads', async () => {
        const snapshot = createGroupSnapshot(1);
        const validInput: Extract<
            CreateStateMutationOutboxRecordInput,
            { kind: 'group' }
        > = {
            commandId: 'group-extra-causal-field',
            commandHash: TEST_COMMAND_HASH,
            kind: 'group',
            aggregateRef: snapshot.group,
            acceptedCausalRevision: toGroupStateMutationCausalRevision(snapshot),
            event: { kind: 'none' },
            effects: ['group-state-sync'],
            createdAtEpochMs: 1_000,
        };
        const valid = createStateMutationOutboxRecord(validInput);
        const malformedRevision = {
            ...validInput.acceptedCausalRevision,
            causalRevision: {
                ...validInput.acceptedCausalRevision.causalRevision,
                unexpected: true,
            },
        };

        expect(() => createStateMutationOutboxRecord({
            ...validInput,
            acceptedCausalRevision: malformedRevision,
        })).toThrow('Invalid state mutation outbox group causal revision fields');

        const runtime = new FakeRuntimeStateRepository();
        await insertRawOutboxRecord(runtime, {
            ...valid,
            acceptedCausalRevision: malformedRevision,
        }, valid.outboxId);
        await expect(
            new StateMutationOutboxRepository(runtime).find(valid.outboxId),
        ).rejects.toThrow(
            'Invalid state mutation outbox group causal revision fields',
        );
    });

    it('rejects prototype-bearing or lossy JSON values before building records', () => {
        const valid = createClientRecord(createClientSnapshot(1), {
            event: { kind: 'client', event: createClientEvent(1) },
        });
        const {
            outboxId: _outboxId,
            attempts: _attempts,
            delivery: _delivery,
            ...validInput
        } = valid;
        const cyclicPayload: Record<string, unknown> = {};
        cyclicPayload.self = cyclicPayload;
        const sparsePayload = new Array(2);
        sparsePayload[1] = 'present';
        const getterRead = vi.fn(() => 'client');
        const getterRoot = Object.defineProperty(
            { ...validInput, kind: undefined },
            'kind',
            { enumerable: true, get: getterRead },
        );
        const symbolPayload = { visible: true } as Record<
            string | symbol,
            unknown
        >;
        symbolPayload[Symbol('hidden')] = 'lost';
        const accessorPayload = Object.defineProperty({}, 'hidden', {
            enumerable: true,
            get: () => 'lost',
        });
        class PayloadArray extends Array<unknown> {}
        const subclassPayload = new PayloadArray();
        subclassPayload.push('value');

        const withPayload = (payload: unknown) => ({
            ...validInput,
            event: {
                kind: 'client',
                event: { ...createClientEvent(1), payload },
            },
        });
        const cases: readonly Readonly<{ name: string; input: unknown }>[] = [
            {
                name: 'class-backed root',
                input: Object.assign(new (class {})(), validInput),
            },
            {
                name: 'prototype-bearing root',
                input: Object.assign(Object.create({ inherited: true }), validInput),
            },
            { name: 'root getter', input: getterRoot },
            {
                name: 'prototype-bearing ref',
                input: {
                    ...validInput,
                    aggregateRef: Object.assign(
                        Object.create({ inherited: true }),
                        validInput.aggregateRef,
                    ),
                },
            },
            {
                name: 'class-backed causal revision',
                input: {
                    ...validInput,
                    acceptedCausalRevision: Object.assign(
                        new (class {})(),
                        validInput.acceptedCausalRevision,
                    ),
                },
            },
            {
                name: 'prototype-bearing event wrapper',
                input: {
                    ...validInput,
                    event: Object.assign(
                        Object.create({ inherited: true }),
                        validInput.event,
                    ),
                },
            },
            {
                name: 'class-backed exact event',
                input: {
                    ...validInput,
                    event: {
                        kind: 'client',
                        event: Object.assign(
                            new (class {})(),
                            createClientEvent(1),
                        ),
                    },
                },
            },
            {
                name: 'class-backed actor',
                input: {
                    ...validInput,
                    event: {
                        kind: 'client',
                        event: {
                            ...createClientEvent(1),
                            actor: Object.assign(new (class {})(), {
                                serviceId: 'test',
                            }),
                        },
                    },
                },
            },
            { name: 'map payload', input: withPayload(new Map()) },
            { name: 'set payload', input: withPayload(new Set()) },
            { name: 'date payload', input: withPayload(new Date(0)) },
            { name: 'cyclic payload', input: withPayload(cyclicPayload) },
            { name: 'sparse payload array', input: withPayload(sparsePayload) },
            { name: 'symbol payload key', input: withPayload(symbolPayload) },
            { name: 'payload accessor', input: withPayload(accessorPayload) },
            { name: 'payload array subclass', input: withPayload(subclassPayload) },
            {
                name: 'nested bigint',
                input: withPayload({ nested: [{ value: 1n }] }),
            },
            {
                name: 'nested function',
                input: withPayload({ nested: { value: () => undefined } }),
            },
            {
                name: 'nested undefined',
                input: withPayload({ nested: { value: undefined } }),
            },
            {
                name: 'nested non-finite number',
                input: withPayload({ nested: [Number.NaN] }),
            },
        ];

        for (const testCase of cases) {
            expect(
                () => createStateMutationOutboxRecord(testCase.input as never),
                testCase.name,
            ).toThrow('State mutation outbox input must be JSON-safe');
        }
        expect(getterRead).not.toHaveBeenCalled();
    });

    it('rejects non-JSON-safe raw insert candidates before persistence', async () => {
        const valid = createClientRecord(createClientSnapshot(1), {
            event: { kind: 'client', event: createClientEvent(1) },
        });
        const cyclicPayload: Record<string, unknown> = {};
        cyclicPayload.self = cyclicPayload;
        const withPayload = (record: typeof valid, payload: unknown) => ({
            ...record,
            event: {
                kind: 'client' as const,
                event: { ...createClientEvent(1), payload },
            },
        });
        const cases: readonly Readonly<{
            name: string;
            mutate(record: typeof valid): unknown;
        }>[] = [
            {
                name: 'class-backed root',
                mutate: (record) => Object.assign(new (class {})(), record),
            },
            {
                name: 'prototype-bearing ref',
                mutate: (record) => ({
                    ...record,
                    aggregateRef: Object.assign(
                        Object.create({ inherited: true }),
                        record.aggregateRef,
                    ),
                }),
            },
            {
                name: 'class-backed causal revision',
                mutate: (record) => ({
                    ...record,
                    acceptedCausalRevision: Object.assign(
                        new (class {})(),
                        record.acceptedCausalRevision,
                    ),
                }),
            },
            {
                name: 'prototype-bearing event wrapper',
                mutate: (record) => ({
                    ...record,
                    event: Object.assign(
                        Object.create({ inherited: true }),
                        record.event,
                    ),
                }),
            },
            { name: 'map', mutate: (record) => withPayload(record, new Map()) },
            { name: 'set', mutate: (record) => withPayload(record, new Set()) },
            { name: 'date', mutate: (record) => withPayload(record, new Date(0)) },
            { name: 'cycle', mutate: (record) => withPayload(record, cyclicPayload) },
            { name: 'bigint', mutate: (record) => withPayload(record, { value: 1n }) },
            {
                name: 'function',
                mutate: (record) => withPayload(record, {
                    value: () => undefined,
                }),
            },
            {
                name: 'undefined',
                mutate: (record) => withPayload(record, { value: undefined }),
            },
            {
                name: 'non-finite number',
                mutate: (record) => withPayload(record, {
                    value: Number.POSITIVE_INFINITY,
                }),
            },
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            const repository = new StateMutationOutboxRepository(runtime);
            const candidate = testCase.mutate(valid);

            await expect(
                repository.putOrLoad(candidate as never),
                testCase.name,
            ).rejects.toThrow('State mutation outbox record must be JSON-safe');
            expect(await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE))
                .toEqual([]);
        }
    });

    it('rejects non-plain delivery candidates before reading accessors', async () => {
        const retry = {
            count: 1,
            last: {
                status: 'failed',
                attemptedAtEpochMs: 2_000,
                error: 'retry',
            },
        } as const;
        const delivery = { status: 'retryable' } as const;
        const getterRead = vi.fn(() => retry);

        const cases: readonly Readonly<{
            name: string;
            createInput(
                outboxId: string,
                storageRevision: number,
            ): unknown;
        }>[] = [
            {
                name: 'class-backed root',
                createInput: (outboxId, expectedStorageRevision) =>
                    Object.assign(new (class {})(), {
                        outboxId,
                        expectedStorageRevision,
                        attempts: retry,
                        delivery,
                    }),
            },
            {
                name: 'prototype-bearing attempts',
                createInput: (outboxId, expectedStorageRevision) => ({
                    outboxId,
                    expectedStorageRevision,
                    attempts: Object.assign(
                        Object.create({ inherited: true }),
                        retry,
                    ),
                    delivery,
                }),
            },
            {
                name: 'class-backed last attempt',
                createInput: (outboxId, expectedStorageRevision) => ({
                    outboxId,
                    expectedStorageRevision,
                    attempts: {
                        count: 1,
                        last: Object.assign(new (class {})(), retry.last),
                    },
                    delivery,
                }),
            },
            {
                name: 'prototype-bearing delivery',
                createInput: (outboxId, expectedStorageRevision) => ({
                    outboxId,
                    expectedStorageRevision,
                    attempts: retry,
                    delivery: Object.assign(
                        Object.create({ inherited: true }),
                        delivery,
                    ),
                }),
            },
            {
                name: 'attempts getter',
                createInput: (outboxId, expectedStorageRevision) =>
                    Object.defineProperty({
                        outboxId,
                        expectedStorageRevision,
                        delivery,
                    }, 'attempts', {
                        enumerable: true,
                        get: getterRead,
                    }),
            },
            {
                name: 'cyclic extra value',
                createInput: (outboxId, expectedStorageRevision) => {
                    const input: Record<string, unknown> = {
                        outboxId,
                        expectedStorageRevision,
                        attempts: retry,
                        delivery,
                    };
                    input.extra = input;
                    return input;
                },
            },
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            const repository = new StateMutationOutboxRepository(runtime);
            const inserted = await repository.putOrLoad(
                createClientRecord(createClientSnapshot(1)),
            );

            await expect(repository.writeDelivery(testCase.createInput(
                inserted.record.outboxId,
                inserted.storageRevision,
            ) as never), testCase.name).rejects.toThrow(
                'State mutation outbox delivery input must be JSON-safe',
            );
        }
        expect(getterRead).not.toHaveBeenCalled();
    });

    it('roundtrips every accepted JSON value without changing the record', async () => {
        const repeated = { finite: 1.25, enabled: true, missing: null };
        const nullPrototype = Object.assign(Object.create(null), {
            alpha: 'value',
            nested: [false, 0, repeated],
        });
        const event = {
            ...createClientEvent(1),
            payload: {
                repeatedLeft: repeated,
                repeatedRight: repeated,
                nullPrototype,
            },
        };
        const record = createClientRecord(createClientSnapshot(1), {
            event: { kind: 'client', event },
        });
        const jsonRoundtrip = JSON.parse(JSON.stringify(record));
        const runtime = new FakeRuntimeStateRepository();
        const repository = new StateMutationOutboxRepository(runtime);

        expect(jsonRoundtrip).toEqual(record);
        const inserted = await repository.putOrLoad(record);
        expect(inserted.record).toEqual(record);
        expect((await repository.find(record.outboxId))?.record).toEqual(record);
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

    it('converges summaries before sync and leaves topology to the summary follow-up', async () => {
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
            3,
        ]]);
        expect([...presenceWinners.entries()]).toEqual([[
            `${stored.record.outboxId}:group-presence-summary:snapshot`,
            2,
        ]]);
        expect([...topologyWinners.entries()]).toEqual([]);
        expect(topologyPublisher.enqueueForStateMutation).not.toHaveBeenCalled();
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
        commandHash: TEST_COMMAND_HASH,
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
        commandHash: TEST_COMMAND_HASH,
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
        publishClientSnapshot: vi.fn(async (
            _snapshot: ClientSnapshot,
            _senderId?: string,
            _deliveryId?: string,
        ) => undefined),
        publishClientEvent: vi.fn(async () => undefined),
        publishGroupSnapshot: vi.fn(async () => undefined),
        publishGroupEvent: vi.fn(async () => undefined),
    };
}

function createClientSnapshot(stateRevision: number): ClientSnapshot {
    const created = createAuditStamp(1);
    const updated = createAuditStamp(stateRevision);
    return {
        stateRevision,
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
            snapshotVersion: stateRevision,
            profileVersion: stateRevision,
            presenceVersion: stateRevision,
            created,
            updated,
            lastSeenAtEpochMs: null,
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: null,
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
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: 'command-1',
        clientInstanceId: null,
        sessionId: null,
        payload: {},
    };
}

function createGroupSnapshot(stateRevision: number): GroupSnapshot {
    const created = createAuditStamp(1);
    const updated = createAuditStamp(stateRevision);
    return {
        stateRevision,
        causalRevision: {
            groupRevision: stateRevision,
            presenceRevision: 0,
        },
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            slug: null,
            displayName: 'Room 1',
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            snapshotVersion: stateRevision,
            metadataVersion: stateRevision,
            rosterVersion: stateRevision,
            presenceVersion: 0,
            created,
            updated,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
        },
        members: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'owner',
            role: 'owner',
            status: 'active',
            joined: created,
            updated,
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
        }],
        activeSessions: [],
        memberCount: 1,
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
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: 0,
        },
        occurredAtEpochMs: snapshotVersion,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: 'group-command-1',
        payload: {},
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
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
