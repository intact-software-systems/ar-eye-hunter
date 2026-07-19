import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
} from '@shared/api/group-types.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    StateScope,
} from '@shared/api/state-types.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { STATE_MUTATION_OUTBOX_NAMESPACE } from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import {
    createGroupStateService,
    createGroupStateRuntime,
    type GroupMutationAuthority,
    GroupMutationIdempotencyConflictError,
    type GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
    computeGroupMutation,
    computeGroupPresenceSummary,
    type GroupMutationCommand,
    type GroupMutationFacts,
    type GroupMutationRead,
    validateGroupMutation,
    validateGroupMutationCommand,
    validateGroupPresenceSummary,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/services/GroupPresenceSummaryWork.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateRetryExhaustedError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};
const BASE_EPOCH_MS = Date.now();

describe('convergent group and presence state', () => {
    it('refuses to construct a user mutation service without an auth repository', () => {
        expect(() => createGroupStateService({
            runtimeRepository: new GroupBarrierRepository(),
            serviceId: 'missing-auth-service',
        } as never)).toThrow(/auth.*required/i);
    });

    it('makes generation identity mandatory and rejects caller-controlled command hashes', () => {
        expectTypeOf<ConnectGroupPresenceSessionRequest>()
            .toHaveProperty('generationId').toEqualTypeOf<string>();
        expectTypeOf<HeartbeatGroupPresenceSessionRequest>()
            .toHaveProperty('generationId').toEqualTypeOf<string>();
        expectTypeOf<ConnectGroupPresenceSessionRequest>()
            .not.toHaveProperty('commandHash');

        const command = createMutationCommand({
            input: {
                displayName: 'After',
                actorPrincipalId: 'alice',
                actorSessionId: null,
                reason: null,
                traceId: null,
            },
            commandHash: `sha256:${'0'.repeat(64)}`,
        } as never);
        expect(() => validateGroupMutationCommand(command)).toThrow(
            /command|key|hash/i,
        );

        expect(() => validateGroupMutationCommand(createMutationCommand({
            input: {
                ...createMutationCommand().input,
                unexpected: true,
            },
        } as never))).toThrow(/unexpected|key/i);
    });

    it('re-authorizes group mutation actors from the current retry read', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'authorization-room');

        await expect(createService(runtime, 2_000).updateGroup(
            SCOPE,
            'authorization-room',
            {
                displayName: 'Unauthorized',
                actorPrincipalId: 'mallory',
                requestId: 'unauthorized-update',
            },
        )).rejects.toMatchObject({ status: 403 });
        expect((await requireSnapshot(runtime, 'authorization-room')).group.displayName)
            .toBe('authorization-room');
    });

    it('does not make a stale no-op receipt durable', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'ephemeral-no-op-room');
        const service = createService(runtime, 2_000);
        await service.updateGroup(SCOPE, 'ephemeral-no-op-room', {
            displayName: 'ephemeral-no-op-room',
            actorPrincipalId: 'alice',
            requestId: 'retry-after-no-op',
        });
        await service.updateGroup(SCOPE, 'ephemeral-no-op-room', {
            displayName: 'Changed',
            actorPrincipalId: 'alice',
            requestId: 'change-between-retries',
        });
        await service.updateGroup(SCOPE, 'ephemeral-no-op-room', {
            displayName: 'ephemeral-no-op-room',
            actorPrincipalId: 'alice',
            requestId: 'retry-after-no-op',
        });

        expect((await requireSnapshot(runtime, 'ephemeral-no-op-room')).group.displayName)
            .toBe('ephemeral-no-op-room');
        expect(await new GroupStateRepository(runtime)
            .findIdempotentGroupMutationReceipt(
                groupRef('ephemeral-no-op-room'),
                'retry-after-no-op',
            )).toMatchObject({ receipt: { outcome: 'applied' } });
    });

    it('does not persist a rejected receipt, event, or outbox effect', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'ephemeral-rejection-room');
        const result = await createService(runtime, 2_000).createGroup(SCOPE, {
            groupId: 'ephemeral-rejection-room',
            displayName: 'Duplicate',
            kind: 'room',
            createdByPrincipalId: 'alice',
            actorPrincipalId: 'alice',
            requestId: 'rejected-duplicate-create',
        });
        expect(result).toMatchObject({ status: 'error' });
        const repository = new GroupStateRepository(runtime);
        expect(await repository.findIdempotentGroupMutationReceipt(
            groupRef('ephemeral-rejection-room'),
            'rejected-duplicate-create',
        )).toBeUndefined();
        expect(await outboxFor(runtime, 'rejected-duplicate-create')).toEqual([]);
        expect((await repository.listEvents(groupRef('ephemeral-rejection-room')))
            .filter((event) => event.requestId === 'rejected-duplicate-create'))
            .toEqual([]);
    });

    it('keeps pure mutation computation synchronous, deterministic, and input preserving', () => {
        const command = deepFreeze(createMutationCommand());
        const read = deepFreeze(createMutationRead());
        const facts = deepFreeze(createMutationFacts());

        const first = computeGroupMutation({ command, read, facts });
        const second = computeGroupMutation({ command, read, facts });
        validateGroupMutation({ command, read, facts, computed: first });
        validateGroupMutation({ command, read, facts, computed: second });

        expect(first).toEqual(second);
        expect(command).toEqual(createMutationCommand());
        expect(read).toEqual(createMutationRead());
    });

    it('rejects a wrong-scope owner member before it can authorize a mutation', () => {
        const command = createMutationCommand();
        const read = createMutationRead();
        const wrongScopeOwner = {
            ...read.actorMember!,
            groupId: 'another-room',
        };
        const forgedRead: GroupMutationRead = {
            ...read,
            actorMember: wrongScopeOwner,
            actorMemberEntry: {
                ...read.actorMemberEntry!,
                entry: {
                    ...read.actorMemberEntry!.entry,
                    value: JSON.stringify(wrongScopeOwner),
                },
                value: wrongScopeOwner,
            },
        };

        expect(() => computeGroupMutation({
            command,
            read: forgedRead,
            facts: createMutationFacts(),
        })).toThrow(/scope|groupId|group/i);
    });

    it('rejects corrupt persisted entry envelopes and domain values before compute', () => {
        const command = createMutationCommand();
        const facts = createMutationFacts();
        const base = createMutationRead();
        const cases: readonly GroupMutationRead[] = [
            {
                ...base,
                group: {
                    ...base.group!,
                    entry: { ...base.group!.entry, revision: -1 },
                },
            },
            {
                ...base,
                actorMemberEntry: {
                    ...base.actorMemberEntry!,
                    entry: {
                        ...base.actorMemberEntry!.entry,
                        value: JSON.stringify({
                            ...base.actorMemberEntry!.value,
                            role: 'admin',
                        }),
                    },
                },
            },
            {
                ...base,
                actorMember: { ...base.actorMember!, role: 'root' as never },
                actorMemberEntry: {
                    ...base.actorMemberEntry!,
                    entry: {
                        ...base.actorMemberEntry!.entry,
                        value: JSON.stringify({
                            ...base.actorMemberEntry!.value,
                            role: 'root',
                        }),
                    },
                    value: { ...base.actorMemberEntry!.value, role: 'root' as never },
                },
            },
        ];

        for (const read of cases) {
            expect(() => computeGroupMutation({ command, read, facts }))
                .toThrow(/revision|entry|role|stored/i);
        }
    });

    it('rejects malformed computed guards, receipts, and outbox projections', () => {
        const command = createMutationCommand();
        const read = createMutationRead();
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command, read, facts });
        if (computed.outcome !== 'write') throw new Error('Expected write computation');
        const cases = [
            {
                ...computed,
                guard: {
                    ...computed.guard,
                    value: { ...computed.guard.value, groupId: 'wrong-room' },
                },
            },
            {
                ...computed,
                receipt: { ...computed.receipt, stateRevision: -1 },
            },
            {
                ...computed,
                outbox: {
                    ...computed.outbox,
                    acceptedCausalRevision: {
                        ...computed.outbox.acceptedCausalRevision,
                        snapshotVersion:
                            computed.outbox.acceptedCausalRevision.snapshotVersion + 1,
                    },
                },
            },
            {
                ...computed,
                outbox: { ...computed.outbox, effects: ['unknown-effect'] },
            },
        ] as const;

        for (const malformed of cases) {
            expect(() => validateGroupMutation({
                command,
                read,
                facts,
                computed: malformed as never,
            })).toThrow(/scope|revision|snapshot|effect|outbox|receipt/i);
        }
    });

    it('rejects equal-content corruption and non-dominating presence summary writes', () => {
        const group = createMutationRead().group!;
        const base: GroupPresenceSummary = {
            ...groupRef('pure-room'),
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            activePrincipalIds: [],
            activeSessionIds: [],
            activeSessions: [],
            activePrincipalCount: 0,
            activeSessionCount: 0,
            computedAtEpochMs: 1_000,
        };
        const current = {
            entry: {
                ...group.entry,
                key: 'presence-summary',
                value: JSON.stringify(base),
                revision: 0,
            },
            value: base,
        };
        const member = createMutationRead().actorMemberEntry!;
        const read = {
            group,
            members: [member],
            admissions: [],
            presenceSessions: [],
            current,
        };

        expect(() => validateGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read,
            computed: {
                outcome: 'no-op',
                summary: {
                    ...base,
                    activePrincipalIds: ['corrupt'],
                    activePrincipalCount: 1,
                },
            },
        })).toThrow(/equal.*different content|facts are inconsistent|canonical/i);

        const aheadValue = {
            ...base,
            causalRevision: { groupRevision: 2, presenceRevision: 0 },
        };
        const ahead = {
            ...read,
            current: {
                ...current,
                entry: {
                    ...current.entry,
                    value: JSON.stringify(aheadValue),
                },
                value: aheadValue,
            },
        };
        const concurrent = computeGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read: ahead,
            nowEpochMs: 2_000,
        });
        expect(concurrent).toMatchObject({
            outcome: 'write',
            summary: {
                causalRevision: { groupRevision: 1, presenceRevision: 1 },
            },
        });
        expect(() => validateGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read: ahead,
            computed: concurrent,
        })).toThrow(/advance.*causal tuple|incomparable/i);
    });

    it('rebases simultaneous create and last-slot joins through the group guard', async () => {
        const runtime = new GroupBarrierRepository();
        const firstCreate = createService(runtime, 1_000).createGroup(SCOPE, {
            groupId: 'capacity-room',
            displayName: 'Capacity Room',
            kind: 'room',
            joinMode: 'open',
            maxMembers: 2,
            createdByPrincipalId: 'alice',
            requestId: 'create-capacity-a',
        });
        const secondCreate = createService(runtime, 1_001).createGroup(SCOPE, {
            groupId: 'capacity-room',
            displayName: 'Capacity Room',
            kind: 'room',
            joinMode: 'open',
            maxMembers: 2,
            createdByPrincipalId: 'alice',
            requestId: 'create-capacity-b',
        });
        const creates = await Promise.allSettled([firstCreate, secondCreate]);
        expect(creates.filter((result) =>
            result.status === 'fulfilled' && result.value.status === 'created'
        )).toHaveLength(1);

        runtime.armGroupReadBarrier(2);
        const joins = await Promise.allSettled([
            createService(runtime, 2_000).joinGroup(SCOPE, 'capacity-room', {
                actorPrincipalId: 'bob',
                requestId: 'join-bob',
            }),
            createService(runtime, 2_001).joinGroup(SCOPE, 'capacity-room', {
                actorPrincipalId: 'carol',
                requestId: 'join-carol',
            }),
        ]);
        expect(joins.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const snapshot = await requireSnapshot(runtime, 'capacity-room');
        expect(snapshot.memberCount).toBe(2);
        expect(snapshot.group.snapshotVersion).toBe(2);
        expect(runtime.locks).toEqual([]);
    });

    it('converges join versus ban under either valid serialization order', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'join-ban-room');
        await createService(runtime, 1_100).upsertMember(
            SCOPE,
            'join-ban-room',
            'bob',
            {
                status: 'invited',
                actorPrincipalId: 'alice',
                requestId: 'invite-bob',
            },
        );
        runtime.armGroupReadBarrier(2);
        const results = await Promise.allSettled([
            createService(runtime, 2_000).joinGroup(SCOPE, 'join-ban-room', {
                actorPrincipalId: 'bob',
                requestId: 'join-bob-race',
            }),
            createService(runtime, 2_001).banGroupMember(
                SCOPE,
                'join-ban-room',
                'bob',
                {
                    actorPrincipalId: 'alice',
                    requestId: 'ban-bob-race',
                },
            ),
        ]);

        expect(results[1]).toMatchObject({ status: 'fulfilled' });
        const snapshot = await requireSnapshot(runtime, 'join-ban-room');
        expect(snapshot.members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ status: 'banned' });
        expect(snapshot.group.snapshotVersion).toBe(
            2 + results.filter((result) => result.status === 'fulfilled').length,
        );
    });

    it('rebases ownership transfer versus target removal without losing a winner', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'owner-race-room');
        await createService(runtime, 1_100).upsertMember(
            SCOPE,
            'owner-race-room',
            'bob',
            {
                status: 'active',
                actorPrincipalId: 'alice',
                requestId: 'activate-bob',
            },
        );
        runtime.armGroupReadBarrier(2);
        const results = await Promise.allSettled([
            createService(runtime, 2_000).transferGroupOwnership(
                SCOPE,
                'owner-race-room',
                {
                    newOwnerPrincipalId: 'bob',
                    actorPrincipalId: 'alice',
                    requestId: 'transfer-to-bob',
                },
            ),
            createService(runtime, 2_001).removeGroupMember(
                SCOPE,
                'owner-race-room',
                'bob',
                {
                    actorPrincipalId: 'alice',
                    requestId: 'remove-bob-race',
                },
            ),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled'))
            .toHaveLength(1);
        const snapshot = await requireSnapshot(runtime, 'owner-race-room');
        const owners = snapshot.members.filter((member) =>
            member.role === 'owner' && member.status === 'active'
        );
        expect(owners).toHaveLength(1);
        const bob = snapshot.members.find((member) => member.principalId === 'bob');
        expect(
            (owners[0]?.principalId === 'bob' && bob?.status === 'active') ||
                (owners[0]?.principalId === 'alice' && bob?.status === 'removed'),
        ).toBe(true);
    });

    it('re-authorizes a queued admin update after a concurrent demotion', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'demotion-race-room');
        await createService(runtime, 1_100).upsertMember(
            SCOPE,
            'demotion-race-room',
            'bob',
            {
                status: 'active',
                role: 'admin',
                actorPrincipalId: 'alice',
                requestId: 'activate-admin-bob',
            },
        );
        runtime.conflictNextGroupDisplayName('Must not commit after demotion');
        runtime.armGroupReadBarrier(2);
        const [demotion, staleUpdate] = await Promise.allSettled([
            createService(runtime, 2_000).setGroupMemberRole(
                SCOPE,
                'demotion-race-room',
                'bob',
                {
                    role: 'member',
                    actorPrincipalId: 'alice',
                    requestId: 'demote-bob',
                },
            ),
            createService(runtime, 2_001).updateGroup(
                SCOPE,
                'demotion-race-room',
                {
                    displayName: 'Must not commit after demotion',
                    actorPrincipalId: 'bob',
                    requestId: 'queued-admin-update',
                },
            ),
        ]);
        expect(demotion.status).toBe('fulfilled');
        expect(staleUpdate).toMatchObject({
            status: 'rejected',
            reason: { status: 403 },
        });
        const snapshot = await requireSnapshot(runtime, 'demotion-race-room');
        expect(snapshot.group.displayName).toBe('demotion-race-room');
        expect(snapshot.members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ role: 'member', status: 'active' });
    });

    it('accepts two independent presence sessions without a group aggregate guard', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'two-session-room');
        runtime.resetGuards();
        const results = await Promise.all([
            createService(runtime, 2_000).connectPresenceSession(
                SCOPE,
                'two-session-room',
                'session-a',
                {
                    principalId: 'alice',
                    generationId: 'generation-a',
                    expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                    requestId: 'connect-session-a',
                },
            ),
            createService(runtime, 2_001).connectPresenceSession(
                SCOPE,
                'two-session-room',
                'session-b',
                {
                    principalId: 'alice',
                    generationId: 'generation-b',
                    expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                    requestId: 'connect-session-b',
                },
            ),
        ]);

        expect(results).toHaveLength(2);
        expect(runtime.groupGuards).toBe(0);
        expect(runtime.presenceGuards).toBe(2);
        expect(await new GroupStateRepository(runtime).listPresenceSessions(
            groupRef('two-session-room'),
        )).toEqual(expect.arrayContaining([
            expect.objectContaining({
                sessionId: 'session-a',
                generationId: 'generation-a',
                generationVersion: 2_000,
            }),
            expect.objectContaining({
                sessionId: 'session-b',
                generationId: 'generation-b',
                generationVersion: 2_001,
            }),
        ]));
    });

    it('rebases metadata and join-code rotation without losing either update', async () => {
        const runtime = new GroupBarrierRepository();
        await createService(runtime, 1_000).createGroup(SCOPE, {
            groupId: 'metadata-code-room',
            displayName: 'Metadata Code Room',
            kind: 'room',
            joinMode: 'code',
            createdByPrincipalId: 'alice',
            requestId: 'seed-metadata-code-room',
        });
        runtime.armGroupReadBarrier(2);
        const results = await Promise.allSettled([
            createService(runtime, 2_000).updateGroup(
                SCOPE,
                'metadata-code-room',
                {
                    metadata: { map: 'fjord' },
                    actorPrincipalId: 'alice',
                    requestId: 'update-metadata-race',
                },
            ),
            createService(runtime, 2_001).rotateGroupJoinCode(
                SCOPE,
                'metadata-code-room',
                {
                    joinCode: 'fjord-code',
                    actorPrincipalId: 'alice',
                    requestId: 'rotate-code-race',
                },
            ),
        ]);

        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
        const snapshot = await requireSnapshot(runtime, 'metadata-code-room');
        expect(snapshot.group.metadata).toEqual({ map: 'fjord' });
        expect(snapshot.group.snapshotVersion).toBe(3);
        expect(JSON.stringify(snapshot.group)).not.toContain('fjord-code');
        expect(await outboxFor(runtime, 'update-metadata-race')).toHaveLength(1);
        expect(await outboxFor(runtime, 'rotate-code-race')).toHaveLength(1);
    });

    it('fences heartbeat/disconnect and stale expiry across presence generations without a group write', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'presence-room');
        const service = createService(runtime, BASE_EPOCH_MS + 2_000);
        await service.connectPresenceSession(SCOPE, 'presence-room', 'session-a', {
            principalId: 'alice',
            generationId: 'generation-1',
            connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
            lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
            expiresAtEpochMs: BASE_EPOCH_MS + 3_000,
            requestId: 'connect-generation-1',
        });
        const groupRevision = await new GroupStateRepository(runtime)
            .findGroupEntry(groupRef('presence-room'));
        runtime.resetGuards();
        runtime.armPresenceReadBarrier(2);
        await Promise.allSettled([
            createService(runtime, BASE_EPOCH_MS + 2_500).heartbeatPresenceSession(
                SCOPE,
                'presence-room',
                'session-a',
                {
                    generationId: 'generation-1',
                    actorPrincipalId: 'alice',
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_500,
                    expiresAtEpochMs: BASE_EPOCH_MS + 5_000,
                    requestId: 'heartbeat-generation-1',
                },
            ),
            createService(runtime, BASE_EPOCH_MS + 2_501).disconnectPresenceSession(
                SCOPE,
                'presence-room',
                'session-a',
                {
                    generationId: 'generation-1',
                    actorPrincipalId: 'alice',
                    disconnectedAtEpochMs: BASE_EPOCH_MS + 2_501,
                    requestId: 'disconnect-generation-1',
                },
            ),
        ]);
        const disconnected = await new GroupStateRepository(runtime)
            .findPresenceSession({ ...groupRef('presence-room'), sessionId: 'session-a' });
        expect(disconnected).toMatchObject({
            generationId: 'generation-1',
            generationVersion: BASE_EPOCH_MS + 2_000,
            disconnectedAtEpochMs: BASE_EPOCH_MS + 2_501,
        });
        expect(runtime.groupGuards).toBe(0);
        expect((await new GroupStateRepository(runtime)
            .findGroupEntry(groupRef('presence-room')))?.entry.revision)
            .toBe(groupRevision?.entry.revision);

        await createService(runtime, BASE_EPOCH_MS + 3_001).connectPresenceSession(
            SCOPE,
            'presence-room',
            'session-a',
            {
                principalId: 'alice',
                generationId: 'generation-2',
                connectedAtEpochMs: BASE_EPOCH_MS + 3_001,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 3_001,
                expiresAtEpochMs: BASE_EPOCH_MS + 9_000,
                requestId: 'connect-generation-2',
            },
        );
        await createMaintenance(runtime, BASE_EPOCH_MS + 4_000)
            .expireExpiredPresenceSessions(BASE_EPOCH_MS + 4_000);
        const reconnected = await new GroupStateRepository(runtime).findPresenceSession({
            ...groupRef('presence-room'),
            sessionId: 'session-a',
        });
        expect(reconnected).toMatchObject({
            generationId: 'generation-2',
            generationVersion: BASE_EPOCH_MS + 3_001,
        });
        expect(reconnected?.disconnectedAtEpochMs).toBeUndefined();
    });

    it('converges generation and heartbeat order for AB and BA delivery', async () => {
        const run = async (reverse: boolean) => {
            const runtime = new GroupBarrierRepository();
            await seedOpenGroup(runtime, `ordered-${reverse}`);
            const service = createService(runtime, BASE_EPOCH_MS + 1_000);
            const connects = [
                {
                    generationId: 'generation-a',
                    connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                    expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                    requestId: `connect-a-${reverse}`,
                },
                {
                    generationId: 'generation-z',
                    connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                    expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                    requestId: `connect-z-${reverse}`,
                },
            ];
            for (const request of reverse ? connects.toReversed() : connects) {
                await service.connectPresenceSession(
                    SCOPE,
                    `ordered-${reverse}`,
                    'session-a',
                    { principalId: 'alice', ...request },
                );
            }
            const heartbeats = [
                { expiresAtEpochMs: BASE_EPOCH_MS + 12_000, requestId: `hb-a-${reverse}` },
                { expiresAtEpochMs: BASE_EPOCH_MS + 14_000, requestId: `hb-z-${reverse}` },
            ];
            for (const request of reverse ? heartbeats.toReversed() : heartbeats) {
                await service.heartbeatPresenceSession(
                    SCOPE,
                    `ordered-${reverse}`,
                    'session-a',
                    {
                        generationId: 'generation-z',
                        actorPrincipalId: 'alice',
                        lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 3_000,
                        ...request,
                    },
                );
            }
            return await new GroupStateRepository(runtime).findPresenceSession({
                ...groupRef(`ordered-${reverse}`),
                sessionId: 'session-a',
            });
        };

        const [ab, ba] = await Promise.all([run(false), run(true)]);
        expect(ab).toMatchObject({
            generationId: 'generation-z',
            generationVersion: BASE_EPOCH_MS + 2_000,
            expiresAtEpochMs: BASE_EPOCH_MS + 14_000,
        });
        expect(ba && { ...ba, groupId: ab?.groupId }).toEqual(ab);
    });

    it('admits only one concurrent last session for a member', async () => {
        const runtime = new GroupBarrierRepository();
        await createService(runtime, 1_000).createGroup(SCOPE, {
            groupId: 'session-cap-room',
            displayName: 'Session cap',
            kind: 'room',
            joinMode: 'open',
            maxSessionsPerMember: 1,
            createdByPrincipalId: 'alice',
            requestId: 'seed-session-cap',
        });
        runtime.armPresenceReadBarrier(2);
        const results = await Promise.allSettled([
            createService(runtime, BASE_EPOCH_MS + 2_000).connectPresenceSession(
                SCOPE, 'session-cap-room', 'session-a', {
                    principalId: 'alice', generationId: 'generation-a',
                    requestId: 'session-cap-a',
                },
            ),
            createService(runtime, BASE_EPOCH_MS + 2_001).connectPresenceSession(
                SCOPE, 'session-cap-room', 'session-b', {
                    principalId: 'alice', generationId: 'generation-b',
                    requestId: 'session-cap-b',
                },
            ),
        ]);
        expect(results.filter((result) =>
            result.status === 'fulfilled' && result.value.status === 'ok'
        )).toHaveLength(1);
        const admission = await new GroupStateRepository(runtime)
            .findPresenceAdmissionEntry({
                ...groupRef('session-cap-room'),
                principalId: 'alice',
            });
        expect(admission?.value.admittedSessions).toHaveLength(1);
    });

    it.each([
        ['ban', 'connect-first'],
        ['ban', 'membership-first'],
        ['remove', 'connect-first'],
        ['remove', 'membership-first'],
    ] as const)(
        'fences a first connect racing %s with forced %s commit ordering',
        async (operation, order) => {
            const runtime = new GroupBarrierRepository();
            const seed = createService(runtime, BASE_EPOCH_MS);
            await seed.createGroup(SCOPE, {
                groupId: `${operation}-${order}`,
                displayName: 'Admission fence',
                kind: 'room',
                joinMode: 'open',
                maxSessionsPerMember: 1,
                createdByPrincipalId: 'alice',
                requestId: `seed-${operation}-${order}`,
            });
            await seed.upsertMember(SCOPE, `${operation}-${order}`, 'bob', {
                status: 'active',
                actorPrincipalId: 'alice',
                requestId: `activate-bob-${operation}-${order}`,
            });

            runtime.armAdmissionReadBarrier(2);
            const connect = () => createService(runtime, BASE_EPOCH_MS + 2_000)
                .connectPresenceSession(
                    SCOPE,
                    `${operation}-${order}`,
                    'bob-session-old',
                    {
                        principalId: 'bob',
                        generationId: 'bob-generation-old',
                        actorPrincipalId: 'bob',
                        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                        requestId: `connect-old-${operation}-${order}`,
                    },
                );
            const changeMembership = () => {
                const service = createService(runtime, BASE_EPOCH_MS + 2_001);
                const request = {
                    actorPrincipalId: 'alice',
                    requestId: `${operation}-bob-${order}`,
                };
                return operation === 'ban'
                    ? service.banGroupMember(
                        SCOPE, `${operation}-${order}`, 'bob', request,
                    )
                    : service.removeGroupMember(
                        SCOPE, `${operation}-${order}`, 'bob', request,
                    );
            };

            const results = order === 'connect-first'
                ? await Promise.allSettled([changeMembership(), connect()])
                : await Promise.allSettled([connect(), changeMembership()]);
            const membershipResult = results[order === 'connect-first' ? 0 : 1];
            const connectResult = results[order === 'connect-first' ? 1 : 0];
            expect(membershipResult).toMatchObject({ status: 'fulfilled' });
            if (connectResult?.status === 'rejected') {
                expect(connectResult.reason).toMatchObject({
                    message: expect.stringMatching(/active group member required/i),
                });
            }

            const repository = new GroupStateRepository(runtime);
            const ref = groupRef(`${operation}-${order}`);
            const snapshot = await repository.readSnapshot(ref);
            expect(snapshot?.members.find((member) => member.principalId === 'bob'))
                .toMatchObject({ status: operation === 'ban' ? 'banned' : 'removed' });
            const admission = await repository.findPresenceAdmissionEntry({
                ...ref,
                principalId: 'bob',
            });
            expect(admission?.value.admittedSessions).toEqual([]);

            const work = new GroupPresenceSummaryWork({
                runtimeRepository: runtime,
                now: () => BASE_EPOCH_MS + 3_000,
                sleep: () => Promise.resolve(),
                serviceId: 'summary-worker',
            });
            await work.converge(ref, `inactive-summary-${operation}-${order}`);
            expect((await repository.findPresenceSummaryEntry(ref))?.value)
                .toMatchObject({ activePrincipalIds: [], activeSessionIds: [] });

            await createService(runtime, BASE_EPOCH_MS + 4_000).upsertMember(
                SCOPE,
                `${operation}-${order}`,
                'bob',
                {
                    status: 'active',
                    actorPrincipalId: 'alice',
                    requestId: `reactivate-bob-${operation}-${order}`,
                },
            );
            await work.converge(ref, `reactivated-summary-${operation}-${order}`);
            expect((await repository.findPresenceSummaryEntry(ref))?.value)
                .toMatchObject({ activePrincipalIds: [], activeSessionIds: [] });

            const fresh = await createService(runtime, BASE_EPOCH_MS + 5_000)
                .connectPresenceSession(
                    SCOPE,
                    `${operation}-${order}`,
                    'bob-session-fresh',
                    {
                        principalId: 'bob',
                        generationId: 'bob-generation-fresh',
                        actorPrincipalId: 'bob',
                        expiresAtEpochMs: BASE_EPOCH_MS + 70_000,
                        requestId: `connect-fresh-${operation}-${order}`,
                    },
                );
            expect(fresh.status).toBe('ok');
            expect((await repository.findPresenceAdmissionEntry({
                ...ref,
                principalId: 'bob',
            }))?.value.admittedSessions.map((session) => session.sessionId))
                .toEqual(['bob-session-fresh']);
        },
    );

    it('filters a stale admitted generation through the latest inactive membership', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, BASE_EPOCH_MS);
        await service.createGroup(SCOPE, {
            groupId: 'inactive-summary-filter',
            displayName: 'Inactive summary filter',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'seed-inactive-summary-filter',
        });
        await service.upsertMember(SCOPE, 'inactive-summary-filter', 'bob', {
            status: 'active',
            actorPrincipalId: 'alice',
            requestId: 'activate-filter-bob',
        });
        await service.connectPresenceSession(
            SCOPE,
            'inactive-summary-filter',
            'filter-bob-session',
            {
                principalId: 'bob',
                generationId: 'filter-bob-generation',
                actorPrincipalId: 'bob',
                expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                requestId: 'connect-filter-bob',
            },
        );
        const repository = new GroupStateRepository(runtime);
        const ref = groupRef('inactive-summary-filter');
        const admitted = await repository.findPresenceAdmissionEntry({
            ...ref,
            principalId: 'bob',
        });
        if (!admitted) throw new Error('Expected admitted bob generation');

        await service.banGroupMember(SCOPE, 'inactive-summary-filter', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'ban-filter-bob',
        });
        await corruptFirstEntry(runtime, 'group-state:presence-admissions', (value) => ({
            ...value,
            admittedSessions: admitted.value.admittedSessions,
        }));

        await new GroupPresenceSummaryWork({
            runtimeRepository: runtime,
            now: () => BASE_EPOCH_MS + 3_000,
            sleep: () => Promise.resolve(),
            serviceId: 'summary-worker',
        }).converge(ref, 'inactive-summary-filter');

        expect((await repository.findPresenceSummaryEntry(ref))?.value).toMatchObject({
            activePrincipalIds: [],
            activeSessionIds: [],
        });
    });

    it.each([
        ['wrong-scope member', 'group-state:members', (value: Record<string, unknown>) => ({
            ...value,
            groupId: 'wrong-group',
        })],
        ['wrong-scope admission', 'group-state:presence-admissions',
            (value: Record<string, unknown>) => ({ ...value, groupId: 'wrong-group' })],
        ['impossible session lifecycle', 'group-state:sessions',
            (value: Record<string, unknown>) => ({
                ...value,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 50_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 40_000,
            })],
        ['malformed current summary', 'group-state:presence-summaries',
            (value: Record<string, unknown>) => ({ ...value, unexpected: true })],
    ] as const)(
        'rejects %s before the summary CAS',
        async (_label, namespace, corrupt) => {
            const runtime = new GroupBarrierRepository();
            const service = createService(runtime, BASE_EPOCH_MS);
            await service.createGroup(SCOPE, {
                groupId: `corrupt-summary-${namespace}`,
                displayName: 'Corrupt summary',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId: `seed-corrupt-summary-${namespace}`,
            });
            await service.connectPresenceSession(
                SCOPE,
                `corrupt-summary-${namespace}`,
                'alice-corrupt-session',
                {
                    principalId: 'alice',
                    generationId: 'alice-corrupt-generation',
                    actorPrincipalId: 'alice',
                    expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                    requestId: `connect-corrupt-summary-${namespace}`,
                },
            );
            await corruptFirstEntry(runtime, namespace, corrupt);
            runtime.resetGuards();

            await expect(new GroupPresenceSummaryWork({
                runtimeRepository: runtime,
                now: () => BASE_EPOCH_MS + 3_000,
                sleep: () => Promise.resolve(),
                serviceId: 'summary-worker',
            }).converge(
                groupRef(`corrupt-summary-${namespace}`),
                `corrupt-${namespace}`,
            )).rejects.toThrow(/scope|lifecycle|timestamp|unexpected|serialized|summary/i);
            expect(runtime.presenceSummaryGuards).toBe(0);
        },
    );

    it('advances 100 independent heartbeats without acquiring the group guard', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'heartbeat-room', 200);
        const service = createService(runtime, BASE_EPOCH_MS + 2_000);
        for (let index = 0; index < 100; index += 1) {
            const principalId = `member-${index}`;
            await service.upsertMember(SCOPE, 'heartbeat-room', principalId, {
                status: 'active',
                actorPrincipalId: principalId,
                requestId: `member-${index}`,
            });
            await service.connectPresenceSession(
                SCOPE,
                'heartbeat-room',
                `session-${index}`,
                {
                    principalId,
                    generationId: `generation-${index}`,
                    actorPrincipalId: `member-${index}`,
                    expiresAtEpochMs: BASE_EPOCH_MS + 50_000,
                    requestId: `connect-${index}`,
                },
            );
        }
        runtime.resetGuards();
        await Promise.all(Array.from({ length: 100 }, (_, index) =>
            createService(runtime, BASE_EPOCH_MS + 3_000 + index)
                .heartbeatPresenceSessionReceipt(
                SCOPE,
                'heartbeat-room',
                `session-${index}`,
                {
                    generationId: `generation-${index}`,
                    actorPrincipalId: `member-${index}`,
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 3_000 + index,
                    expiresAtEpochMs: BASE_EPOCH_MS + 60_000 + index,
                    requestId: `heartbeat-${index}`,
                },
            )
        ));
        expect(runtime.groupGuards).toBe(0);
        expect(runtime.presenceGuards).toBe(100);
        expect(runtime.hotPathListReads).toBe(0);
        expect(runtime.compatibilitySnapshotListReads).toBe(0);

        await createService(runtime, BASE_EPOCH_MS + 4_000)
            .heartbeatPresenceSession(
                SCOPE,
                'heartbeat-room',
                'session-0',
                {
                    generationId: 'generation-0',
                    actorPrincipalId: 'member-0',
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 4_000,
                    expiresAtEpochMs: BASE_EPOCH_MS + 70_000,
                    requestId: 'compatibility-heartbeat',
                },
            );
        expect(runtime.compatibilitySnapshotListReads).toBeGreaterThan(0);
    });

    it('stores compact first-writer receipts and exact canonical digest outbox identity', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'digest-room');
        const wake = vi.fn();
        const service = createService(runtime, 2_000, wake);
        await service.updateGroup(SCOPE, 'digest-room', {
            displayName: 'After',
            metadata: { alpha: 1, beta: 2 },
            actorPrincipalId: 'alice',
            requestId: 'same-request',
        });
        await service.updateGroup(SCOPE, 'digest-room', {
            metadata: { beta: 2, alpha: 1 },
            displayName: 'After',
            actorPrincipalId: 'alice',
            requestId: 'same-request',
        });
        await expect(service.updateGroup(SCOPE, 'digest-room', {
            displayName: 'Different',
            metadata: { alpha: 1, beta: 2 },
            actorPrincipalId: 'alice',
            requestId: 'same-request',
        })).rejects.toBeInstanceOf(GroupMutationIdempotencyConflictError);

        const repository = new GroupStateRepository(runtime);
        const stored = await repository.findIdempotentGroupMutationReceipt(
            groupRef('digest-room'),
            'same-request',
        );
        const outbox = await outboxFor(runtime, 'same-request');
        expect(stored?.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(outbox).toHaveLength(1);
        expect(outbox[0]?.commandHash).toBe(stored?.commandHash);
        expect(outbox[0]?.effects).toEqual([
            'group-state-sync',
            'group-presence-summary',
        ]);
        expect(JSON.stringify(stored)).not.toContain('activeSessions');
        expect(JSON.stringify(stored)).not.toContain('members');
        expect(wake).toHaveBeenCalledTimes(1);
    });

    it('allows only one semantic command for a concurrent shared request id', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'same-request-race');
        runtime.armGroupReadBarrier(2);
        const results = await Promise.allSettled([
            createService(runtime, 2_000).updateGroup(SCOPE, 'same-request-race', {
                displayName: 'Winner A',
                actorPrincipalId: 'alice',
                requestId: 'shared-semantic-request',
            }),
            createService(runtime, 2_001).updateGroup(SCOPE, 'same-request-race', {
                displayName: 'Winner B',
                actorPrincipalId: 'alice',
                requestId: 'shared-semantic-request',
            }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) =>
            result.status === 'rejected' &&
            result.reason instanceof GroupMutationIdempotencyConflictError
        )).toHaveLength(1);
        expect(['Winner A', 'Winner B']).toContain(
            (await requireSnapshot(runtime, 'same-request-race')).group.displayName,
        );
    });

    it('uses bounded retry delays and exposes exhaustion after forced conflicts', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'retry-exhaustion-room');
        runtime.failNextGroupCas(3);
        const sleep = vi.fn(() => Promise.resolve());
        await expect(createService(runtime, 2_000, undefined, sleep).updateGroup(
            SCOPE,
            'retry-exhaustion-room',
            {
                displayName: 'Never committed',
                actorPrincipalId: 'alice',
                requestId: 'retry-exhaustion',
            },
        )).rejects.toBeInstanceOf(RuntimeStateRetryExhaustedError);
        expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2, 8]);
        expect((await requireSnapshot(runtime, 'retry-exhaustion-room')).group.displayName)
            .toBe('retry-exhaustion-room');
    });

    it('retries summary CAS and restart without duplicating the sole topology follow-up', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'summary-room');
        await createService(runtime, BASE_EPOCH_MS + 2_000).connectPresenceSession(
            SCOPE,
            'summary-room',
            'session-a',
            {
                principalId: 'alice',
                generationId: 'generation-a',
                expiresAtEpochMs: BASE_EPOCH_MS + 10_000,
                requestId: 'connect-summary',
            },
        );
        const before = await requireSnapshot(runtime, 'summary-room');
        const wake = vi.fn();
        const work = new GroupPresenceSummaryWork({
            runtimeRepository: runtime,
            now: () => BASE_EPOCH_MS + 3_000,
            sleep: () => Promise.resolve(),
            serviceId: 'summary-worker',
            wakeStateMutationOutbox: wake,
        });
        runtime.failNextPresenceSummaryCas();
        await work.enqueueForGroupSnapshot(before, 'summary-delivery');
        await work.enqueueForGroupSnapshot(before, 'summary-delivery');

        const repository = new GroupStateRepository(runtime);
        const summary = await repository.findPresenceSummaryEntry(
            groupRef('summary-room'),
        );
        expect(Object.keys(summary?.value ?? {}).toSorted()).toEqual([
            'activePrincipalCount',
            'activePrincipalIds',
            'activeSessionCount',
            'activeSessionIds',
            'activeSessions',
            'applicationId',
            'causalRevision',
            'computedAtEpochMs',
            'groupId',
            'workspaceId',
        ]);
        expect(summary?.value).toMatchObject({
            causalRevision: {
                groupRevision: expect.any(Number),
                presenceRevision: 1,
            },
            activePrincipalIds: ['alice'],
            activeSessionCount: 1,
        });
        const topologyFollowUps = await outboxFor(
            runtime,
            'group-presence-summary:summary-delivery',
        );
        expect(topologyFollowUps).toHaveLength(1);
        expect(topologyFollowUps[0]).toMatchObject({
            commandId: 'group-presence-summary:summary-delivery',
            effects: ['rtc-topology-recompute'],
        });
        expect(wake).toHaveBeenCalledTimes(1);
    });
});

function createMutationCommand(
    overrides: Partial<GroupMutationCommand> = {},
): GroupMutationCommand {
    return {
        operation: 'updateGroup',
        aggregateRef: groupRef('pure-room'),
        commandId: 'pure-command',
        requestId: 'pure-command',
        input: {
            slug: null,
            displayName: 'After',
            description: null,
            kind: null,
            status: null,
            joinMode: null,
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: null,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null,
        },
        ...overrides,
    } as GroupMutationCommand;
}

function createMutationRead(): GroupMutationRead {
    const audit = {
        atEpochMs: 1_000,
        byPrincipalId: 'alice',
        byServiceId: 'group-service',
        requestId: 'seed',
    } as const;
    const group = {
        ...groupRef('pure-room'),
        displayName: 'Before',
        kind: 'room' as const,
        status: 'active' as const,
        joinMode: 'open' as const,
        metadata: {},
        activeMemberCount: 1,
        ownerPrincipalId: 'alice',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit,
    };
    const actorMember = {
        ...groupRef('pure-room'),
        principalId: 'alice',
        role: 'owner' as const,
        status: 'active' as const,
        joined: audit,
        updated: audit,
    };
    const entry = (key: string, value: unknown) => ({
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date(0).toISOString(),
            revision: 0,
        },
        value,
    });
    return {
        idempotency: null,
        group: entry('group', group),
        actorMember,
        targetMember: null,
        authorityMember: null,
        directorMember: null,
        actorMemberEntry: entry('member:alice', actorMember),
        targetMemberEntry: null,
        authorityMemberEntry: null,
        directorMemberEntry: null,
        targetPresence: null,
        targetAdmission: null,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: null,
    } as GroupMutationRead;
}

function createMutationFacts(): GroupMutationFacts {
    return {
        nowEpochMs: 2_000,
        serviceId: 'group-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: {
            principalId: 'alice',
            sessionId: 'alice-session',
        },
    };
}

class GroupBarrierRepository extends FakeRuntimeStateRepository {
    groupGuards = 0;
    presenceGuards = 0;
    presenceSummaryGuards = 0;
    hotPathListReads = 0;
    compatibilitySnapshotListReads = 0;
    private groupReadsRemaining = 0;
    private groupReadsArrived = 0;
    private releaseGroupReads: (() => void) | undefined;
    private presenceReadsRemaining = 0;
    private presenceReadsArrived = 0;
    private releasePresenceReads: (() => void) | undefined;
    private admissionReadsRemaining = 0;
    private admissionReadsArrived = 0;
    private releaseAdmissionReads: (() => void) | undefined;
    private transactionTail: Promise<void> = Promise.resolve();
    private presenceSummaryConflictsRemaining = 0;
    private groupConflictsRemaining = 0;
    private conflictingGroupDisplayName: string | undefined;

    failNextPresenceSummaryCas(): void {
        this.presenceSummaryConflictsRemaining = 1;
    }

    failNextGroupCas(count: number): void {
        this.groupConflictsRemaining = count;
    }

    conflictNextGroupDisplayName(displayName: string): void {
        this.conflictingGroupDisplayName = displayName;
    }

    armGroupReadBarrier(readers: number): void {
        this.groupReadsRemaining = readers;
        this.groupReadsArrived = 0;
    }

    armPresenceReadBarrier(readers: number): void {
        this.presenceReadsRemaining = readers;
        this.presenceReadsArrived = 0;
    }

    armAdmissionReadBarrier(readers: number): void {
        this.admissionReadsRemaining = readers;
        this.admissionReadsArrived = 0;
    }

    resetGuards(): void {
        this.groupGuards = 0;
        this.presenceGuards = 0;
        this.presenceSummaryGuards = 0;
        this.hotPathListReads = 0;
        this.compatibilitySnapshotListReads = 0;
    }

    override findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        if (
            (namespace === 'group-state:members' || namespace === 'group-state:sessions') &&
            new Error().stack?.includes('readGroupMutation')
        ) {
            this.hotPathListReads += 1;
        }
        if (
            (namespace === 'group-state:members' || namespace === 'group-state:sessions') &&
            new Error().stack?.includes('readStableStateSnapshot')
        ) {
            this.compatibilitySnapshotListReads += 1;
        }
        return super.findEntriesByPrefix(namespace, keyPrefix);
    }

    override async findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        const value = await super.findEntry(namespace, key);
        if (namespace === 'group-state:groups' && this.groupReadsRemaining > 0) {
            await this.waitAtBarrier('group');
        }
        if (namespace === 'group-state:sessions' && this.presenceReadsRemaining > 0) {
            await this.waitAtBarrier('presence');
        }
        if (
            namespace === 'group-state:presence-admissions' &&
            this.admissionReadsRemaining > 0
        ) {
            await this.waitAtBarrier('admission');
        }
        return value;
    }

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        let release!: () => void;
        const previous = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await super.begin(fn);
        } finally {
            release();
        }
    }

    override insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.recordGuard(namespace);
        return super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }

    override upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.recordGuard(namespace);
        if (
            namespace === 'group-state:groups' &&
            this.conflictingGroupDisplayName !== undefined &&
            JSON.parse(value).displayName === this.conflictingGroupDisplayName
        ) {
            this.conflictingGroupDisplayName = undefined;
            return Promise.resolve({ status: 'conflict' });
        }
        if (
            namespace === 'group-state:groups' &&
            this.groupConflictsRemaining > 0
        ) {
            this.groupConflictsRemaining -= 1;
            return Promise.resolve({ status: 'conflict' });
        }
        if (
            namespace === 'group-state:presence-summaries' &&
            this.presenceSummaryConflictsRemaining > 0
        ) {
            this.presenceSummaryConflictsRemaining -= 1;
            return Promise.resolve({ status: 'conflict' });
        }
        return super.upsertIfRevision(
            namespace,
            key,
            value,
            expireAtTimestamp,
            expectedRevision,
        );
    }

    private recordGuard(namespace: string): void {
        if (namespace === 'group-state:groups') this.groupGuards += 1;
        if (namespace === 'group-state:sessions') this.presenceGuards += 1;
        if (namespace === 'group-state:presence-summaries') {
            this.presenceSummaryGuards += 1;
        }
    }

    private async waitAtBarrier(kind: 'group' | 'presence' | 'admission'): Promise<void> {
        if (kind === 'group') {
            this.groupReadsArrived += 1;
            if (this.groupReadsArrived === this.groupReadsRemaining) {
                this.groupReadsRemaining = 0;
                this.releaseGroupReads?.();
                return;
            }
            await new Promise<void>((resolve) => {
                this.releaseGroupReads = resolve;
            });
            return;
        }
        if (kind === 'admission') {
            this.admissionReadsArrived += 1;
            if (this.admissionReadsArrived === this.admissionReadsRemaining) {
                this.admissionReadsRemaining = 0;
                this.releaseAdmissionReads?.();
                return;
            }
            await new Promise<void>((resolve) => {
                this.releaseAdmissionReads = resolve;
            });
            return;
        }
        this.presenceReadsArrived += 1;
        if (this.presenceReadsArrived === this.presenceReadsRemaining) {
            this.presenceReadsRemaining = 0;
            this.releasePresenceReads?.();
            return;
        }
        await new Promise<void>((resolve) => {
            this.releasePresenceReads = resolve;
        });
    }
}

async function corruptFirstEntry(
    runtime: GroupBarrierRepository,
    namespace: string,
    corrupt: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
    const entry = (await runtime.findAllEntries(namespace))[0];
    if (!entry) throw new Error(`Missing ${namespace} entry to corrupt`);
    await runtime.upsert(
        namespace,
        entry.key,
        JSON.stringify(corrupt(JSON.parse(entry.value) as Record<string, unknown>)),
        entry.expireAtTimestamp,
    );
}

function createService(
    runtimeRepository: GroupBarrierRepository,
    nowEpochMs: number,
    wakeStateMutationOutbox?: () => void,
    sleep: (delayMs: number) => Promise<void> = () => Promise.resolve(),
) {
    let id = 0;
    const issued = new Map<string, IssuedAuthSession>();
    const durable = createGroupStateService({
        runtimeRepository,
        syncPublisher: createPublisher(),
        now: () => nowEpochMs,
        randomId: () => `id-${nowEpochMs}-${++id}`,
        sleep,
        serviceId: 'group-service',
        wakeStateMutationOutbox,
        authSessionRepository: {
            findBySessionId: (sessionId) => Promise.resolve(issued.get(sessionId)),
        },
    });
    return new Proxy(durable, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function' || !TEST_USER_MUTATIONS.has(String(property))) {
                return value;
            }
            return (...args: unknown[]) => {
                const request = args.at(-1) as Record<string, unknown>;
                const principalId = String(
                    request.actorPrincipalId ??
                    request.createdByPrincipalId ??
                    request.principalId ??
                    'alice',
                );
                const sessionId = TEST_PRESENCE_MUTATIONS.has(String(property))
                    ? String(args[2])
                    : String(request.actorSessionId ?? `${principalId}-session`);
                const authority: IssuedAuthSession = {
                    clientId: principalId,
                    sessionId,
                    accessToken: `test-token:${principalId}:${sessionId}`,
                    username: principalId,
                    issuedAtEpochMs: Math.max(0, nowEpochMs - 1_000),
                    expiresAtEpochMs: nowEpochMs + 600_000,
                };
                issued.set(sessionId, authority);
                return Reflect.apply(value, target, [...args, authority]);
            };
        },
    }) as TestAuthenticatedGroupStateService;
}

type TestAuthenticatedGroupStateService = {
    [K in keyof GroupStateService]: GroupStateService[K] extends (
        ...args: [...infer Inputs, GroupMutationAuthority]
    ) => infer Result
        ? (...args: Inputs) => Result
        : GroupStateService[K];
};

const TEST_USER_MUTATIONS = new Set([
    'createGroup', 'updateGroup', 'appointDirector', 'joinGroup',
    'createGroupInvite', 'revokeGroupInvite', 'acceptGroupInvite',
    'rotateGroupJoinCode', 'removeGroupMember', 'banGroupMember',
    'unbanGroupMember', 'setGroupMemberRole', 'transferGroupOwnership',
    'upsertMember', 'connectPresenceSession', 'connectPresenceSessionReceipt',
    'heartbeatPresenceSession', 'heartbeatPresenceSessionReceipt',
    'disconnectPresenceSession', 'disconnectPresenceSessionReceipt',
]);

const TEST_PRESENCE_MUTATIONS = new Set([
    'connectPresenceSession', 'connectPresenceSessionReceipt',
    'heartbeatPresenceSession', 'heartbeatPresenceSessionReceipt',
    'disconnectPresenceSession', 'disconnectPresenceSessionReceipt',
]);

function createMaintenance(
    runtimeRepository: GroupBarrierRepository,
    nowEpochMs: number,
) {
    return createGroupStateRuntime({
        runtimeRepository,
        authSessionRepository: {
            findBySessionId: () => Promise.resolve(undefined),
        },
        now: () => nowEpochMs,
        randomId: () => `maintenance-${nowEpochMs}`,
        sleep: () => Promise.resolve(),
        serviceId: 'group-maintenance',
    }).maintenance;
}

async function seedOpenGroup(
    runtime: GroupBarrierRepository,
    groupId: string,
    maxMembers = 10,
): Promise<void> {
    await createService(runtime, 1_000).createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers,
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`,
    });
}

async function requireSnapshot(runtime: GroupBarrierRepository, groupId: string) {
    const snapshot = await new GroupStateRepository(runtime).readSnapshot(groupRef(groupId));
    if (!snapshot) throw new Error(`Missing group snapshot: ${groupId}`);
    return snapshot;
}

async function outboxFor(runtime: GroupBarrierRepository, commandIdPrefix: string) {
    return (await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE))
        .map((entry) => JSON.parse(entry.value))
        .filter((record) => String(record.commandId).startsWith(commandIdPrefix));
}

function groupRef(groupId: string): GroupRef {
    return { ...SCOPE, groupId };
}

function createPublisher(): StateSyncPublisher {
    return {
        publishClientSnapshot: vi.fn(() => Promise.resolve()),
        publishClientEvent: vi.fn(() => Promise.resolve()),
        publishGroupSnapshot: vi.fn(() => Promise.resolve()),
        publishGroupEvent: vi.fn(() => Promise.resolve()),
    };
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}

void (null as GroupPresenceSession | null);
