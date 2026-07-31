import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
    AuditStamp,
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
} from '@shared/api/group-types.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
    createGroupStateService as createDurableGroupStateService,
    GroupMutationIdempotencyConflictError,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
    computeGroupMutation,
    computeGroupPresenceSummary,
    type GroupMutationCommand,
    type GroupMutationFacts,
    type GroupMutationIdempotencyRecord,
    type GroupMutationRead,
    type GroupPresenceSummaryWorkData,
    normalizePersistedGroupMember,
    validatePersistedGroupMember,
    validateGroupMutation,
    validateGroupPresenceSummary,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/services/GroupPresenceSummaryWork.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey,
    groupStateScopeStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import {
    createTestGroupStateRuntime,
    createTestGroupStateService,
    type TestAuthenticatedGroupStateService,
} from './group-state-test-runtime.ts';
import {
    SCOPE,
    groupMemberStorageKey,
    groupRef,
    groupSessionStorageKey,
    groupStorageKey,
    presenceFor,
    storagePart,
    storedEntry,
} from './group-state/mutation/group-mutation-test-runtime.ts';
import { GroupBarrierRepository } from './group-state-concurrency-test-runtime.ts';
import {
    admissionFor,
    createMutationCommand,
    createMutationFacts,
    createMutationRead,
    groupAdmissionStorageKey,
    groupIdempotencyStorageKey,
    memberFor,
    rekey,
    requireJoinCodeResult,
} from './group-state-concurrency-test-fixtures.ts';
import {
    createService,
    requireSnapshot,
    seedOpenGroup,
} from './group-state/presence/group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('convergent group and presence state', () => {

    it('refuses to construct a user mutation service without an auth repository', () => {
        expect(() => createDurableGroupStateService({
            runtimeRepository: new GroupBarrierRepository(),
            serviceId: 'missing-auth-service',
        } as never)).toThrow(/auth.*required/i);
    });

    it('builds collision-safe maintenance identities from the complete semantic command', async () => {
        const module = await import(
            '@shared-server/rallar-system/services/group-state-service.ts'
        ) as Record<string, unknown>;
        const requestIdFor = module.groupStateMaintenanceRequestId;
        expect(requestIdFor).toBeTypeOf('function');
        if (typeof requestIdFor !== 'function') return;

        const command = {
            operation: 'disconnectPresence',
            aggregateRef: {
                applicationId: 'app:one',
                workspaceId: 'workspace:one',
                groupId: 'group:one',
            },
            sessionId: 'session:one',
            input: {
                principalId: 'principal:one',
                generationId: 'generation:one',
                generationVersion: 2_000,
                observedExpiresAtEpochMs: 9_000,
                disconnectedAtEpochMs: 10_000,
                lastHeartbeatAtEpochMs: 8_000,
                expiresAtEpochMs: 9_000,
                actorPrincipalId: null,
                actorSessionId: null,
                reason: 'expired',
                traceId: null,
            },
        } as const;
        const variants = [
            ['session-cleanup', command],
            ['expiry', { ...command, aggregateRef: {
                ...command.aggregateRef, applicationId: 'app:two',
            } }],
            ['expiry', { ...command, aggregateRef: {
                ...command.aggregateRef, workspaceId: 'workspace:two',
            } }],
            ['expiry', { ...command, aggregateRef: {
                ...command.aggregateRef, workspaceId: '',
            } }],
            ['expiry', { ...command, aggregateRef: {
                ...command.aggregateRef, groupId: 'group:two',
            } }],
            ['expiry', { ...command, sessionId: 'session:two' }],
            ['expiry', { ...command, input: {
                ...command.input, principalId: 'principal:two',
            } }],
            ['expiry', { ...command, input: {
                ...command.input, generationId: 'generation:two',
            } }],
            ['expiry', { ...command, input: {
                ...command.input, generationVersion: 2_001,
            } }],
            ['expiry', { ...command, input: {
                ...command.input, observedExpiresAtEpochMs: 9_001,
            } }],
            ['expiry', { ...command, input: {
                ...command.input, disconnectedAtEpochMs: 10_001,
            } }],
            ['expiry', { ...command, input: {
                ...command.input, lastHeartbeatAtEpochMs: 8_001,
            } }],
            ['expiry', { ...command, input: {
                ...command.input, expiresAtEpochMs: 9_001,
            } }],
        ] as const;
        const requestIds = [
            requestIdFor('expiry', command),
            ...variants.map(([kind, variant]) => requestIdFor(kind, variant)),
        ];

        expect(new Set(requestIds).size).toBe(requestIds.length);
        expect(requestIdFor('expiry', {
            ...command,
            aggregateRef: { ...command.aggregateRef, groupId: 'a:b' },
            sessionId: 'c',
        })).not.toBe(requestIdFor('expiry', {
            ...command,
            aggregateRef: { ...command.aggregateRef, groupId: 'a' },
            sessionId: 'b:c',
        }));
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

    it('binds every mutation read slot to its canonical storage key and command identity', () => {
        const base = createMutationRead();
        const facts = createMutationFacts();
        const targetCommand = createMutationCommand({
            operation: 'setGroupMemberRole',
            targetPrincipalId: 'bob',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                role: 'admin',
            },
        } as Partial<GroupMutationCommand>);
        const bob = memberFor('bob');
        const targetRead: GroupMutationRead = {
            ...base,
            targetMember: bob,
            targetMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
        };
        const directorGroup = {
            ...base.group!.value,
            metadata: {
                rallarDirector: {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'director-session',
                    principalId: 'director',
                    epoch: 1,
                    appointedAtEpochMs: 1_000,
                    heartbeatTtlMs: 5_000,
                },
            },
        };
        const director = memberFor('director');
        const ownerAdmission = admissionFor('alice', []);
        const directorAdmission = admissionFor('director', [{
            sessionId: 'director-session',
            generationId: 'director-generation',
            generationVersion: 1_000,
            connectedAtEpochMs: 1_000,
        }]);
        const directorSession = presenceFor(
            'director', 'director-session', 'director-generation',
        );
        const directorCommand = createMutationCommand({
            operation: 'appointDirector',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                heartbeatTtlMs: 5_000,
            },
        } as Partial<GroupMutationCommand>);
        const directorRead: GroupMutationRead = {
            ...base,
            group: storedEntry(groupStorageKey(), directorGroup),
            authorityMember: base.actorMember,
            authorityMemberEntry: base.actorMemberEntry,
            directorMember: director,
            directorMemberEntry: storedEntry(groupMemberStorageKey('director'), director),
            authorityAdmission: storedEntry(
                groupAdmissionStorageKey('alice'), ownerAdmission,
            ),
            directorAdmission: storedEntry(
                groupAdmissionStorageKey('director'), directorAdmission,
            ),
            authorityPresenceSessions: [directorSession],
            authorityPresenceSessionEntries: [storedEntry(
                groupSessionStorageKey('director-session'), directorSession,
            )],
        };
        const presenceCommand = createMutationCommand({
            operation: 'connectPresence',
            sessionId: 'bob-session',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                principalId: 'bob',
                generationId: 'bob-generation',
                connectedAtEpochMs: 1_000,
                lastHeartbeatAtEpochMs: 1_000,
                expiresAtEpochMs: 10_000,
            },
        } as Partial<GroupMutationCommand>);
        const bobAdmission = admissionFor('bob', []);
        const presenceRead: GroupMutationRead = {
            ...targetRead,
            targetAdmission: storedEntry(
                groupAdmissionStorageKey('bob'), bobAdmission,
            ),
        };
        const idempotency = {
            aggregateRef: targetCommand.aggregateRef,
            requestId: targetCommand.requestId!,
            commandHash: facts.commandHash,
            receipt: {
                commandId: targetCommand.commandId,
                requestId: targetCommand.requestId,
                commandHash: facts.commandHash,
                aggregateRef: targetCommand.aggregateRef,
                outcome: 'no-op' as const,
                attemptCount: 1,
                acceptedStorageRevision: null,
                stateRevision: 1_000_000,
                snapshotVersion: 1,
                causalRevision: { groupRevision: 1, presenceRevision: 0 },
                eventId: null,
                outboxIds: [],
                joinCode: null,
                joinCodeExpiresAtEpochMs: null,
                rejection: null,
            },
        };

        const cases: readonly [string, GroupMutationCommand, GroupMutationRead][] = [
            ['group key', targetCommand, {
                ...targetRead,
                group: rekey(targetRead.group!, `${groupStorageKey()}:wrong`),
            }],
            ['actor slot value', targetCommand, {
                ...targetRead,
                actorMember: bob,
                actorMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
            }],
            ['actor slot key', targetCommand, {
                ...targetRead,
                actorMemberEntry: rekey(
                    targetRead.actorMemberEntry!, groupMemberStorageKey('bob'),
                ),
            }],
            ['target slot', targetCommand, {
                ...targetRead,
                targetMember: memberFor('charlie'),
                targetMemberEntry: storedEntry(
                    groupMemberStorageKey('charlie'), memberFor('charlie'),
                ),
            }],
            ['owner authority slot', directorCommand, {
                ...directorRead,
                authorityMember: bob,
                authorityMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
            }],
            ['director slot', directorCommand, {
                ...directorRead,
                directorMember: bob,
                directorMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
            }],
            ['target admission', presenceCommand, {
                ...presenceRead,
                targetAdmission: storedEntry(
                    groupAdmissionStorageKey('charlie'), admissionFor('charlie', []),
                ),
            }],
            ['target presence session', presenceCommand, {
                ...presenceRead,
                targetPresence: storedEntry(
                    groupSessionStorageKey('other-session'),
                    presenceFor('bob', 'other-session', 'bob-generation'),
                ),
            }],
            ['authority admission', directorCommand, {
                ...directorRead,
                authorityAdmission: storedEntry(
                    groupAdmissionStorageKey('bob'), admissionFor('bob', []),
                ),
            }],
            ['director admission', directorCommand, {
                ...directorRead,
                directorAdmission: storedEntry(
                    groupAdmissionStorageKey('bob'), admissionFor('bob', []),
                ),
            }],
            ['unreferenced authority session', directorCommand, {
                ...directorRead,
                authorityPresenceSessions: [presenceFor(
                    'director', 'other-session', 'other-generation',
                )],
                authorityPresenceSessionEntries: [storedEntry(
                    groupSessionStorageKey('other-session'),
                    presenceFor('director', 'other-session', 'other-generation'),
                )],
            }],
            ['idempotency key', targetCommand, {
                ...targetRead,
                idempotency: storedEntry(
                    groupIdempotencyStorageKey('other-request'), idempotency,
                ),
            }],
            ['idempotency record request', targetCommand, {
                ...targetRead,
                idempotency: storedEntry(
                    groupIdempotencyStorageKey('other-request'),
                    { ...idempotency, requestId: 'other-request' },
                ),
            }],
        ];

        for (const [label, command, read] of cases) {
            expect(
                () => computeGroupMutation({ command, read, facts }),
                label,
            ).toThrow(/canonical|identity|slot|key|request|principal|session|referenced/i);
        }
    });

    it('binds mutation write candidates to the exact command target', () => {
        const command = createMutationCommand({
            operation: 'setGroupMemberRole',
            targetPrincipalId: 'bob',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                role: 'admin',
            },
        } as Partial<GroupMutationCommand>);
        const bob = memberFor('bob');
        const read: GroupMutationRead = {
            ...createMutationRead(),
            targetMember: bob,
            targetMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
        };
        const facts = createMutationFacts();
        const computed = computeGroupMutation({ command, read, facts });
        if (computed.outcome !== 'write') throw new Error('Expected write');
        const wrongMember = {
            ...computed.members[0]!,
            principalId: 'charlie',
        };
        const malformed = {
            ...computed,
            members: [wrongMember],
            guard: {
                ...computed.guard,
                value: computed.guard.kind === 'group'
                    ? { ...computed.guard.value, activeMemberCount: 2 }
                    : computed.guard.value,
            },
        };

        expect(() => validateGroupMutation({
            command,
            read,
            facts,
            computed: malformed as never,
        })).toThrow(/command target|candidate identity|principal/i);
    });

    it('binds heartbeat and disconnect read principals independently from corrupt rows', () => {
        const bob = memberFor('bob');
        const session = presenceFor('bob', 'alice-session', 'generation-1');
        const admission = admissionFor('bob', [{
            sessionId: session.sessionId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            connectedAtEpochMs: session.connectedAtEpochMs,
        }]);
        const corruptRead: GroupMutationRead = {
            ...createMutationRead(),
            targetMember: bob,
            targetMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
            targetPresence: storedEntry(
                groupSessionStorageKey('alice-session'), session,
            ),
            targetAdmission: storedEntry(
                groupAdmissionStorageKey('bob'), admission,
            ),
        };
        const publicFacts = createMutationFacts();
        const heartbeat = createMutationCommand({
            operation: 'heartbeatPresence',
            sessionId: 'alice-session',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                principalId: null,
                generationId: 'generation-1',
                lastHeartbeatAtEpochMs: 2_000,
                expiresAtEpochMs: 10_000,
            },
        } as Partial<GroupMutationCommand>);
        const disconnect = createMutationCommand({
            operation: 'disconnectPresence',
            sessionId: 'alice-session',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                principalId: null,
                generationId: 'generation-1',
                generationVersion: null,
                observedExpiresAtEpochMs: null,
                disconnectedAtEpochMs: 2_000,
                lastHeartbeatAtEpochMs: null,
                expiresAtEpochMs: null,
            },
        } as Partial<GroupMutationCommand>);
        const internalDisconnect = createMutationCommand({
            ...disconnect,
            commandId: 'cleanup-command',
            requestId: 'cleanup-command',
            input: {
                ...disconnect.input,
                principalId: 'alice',
                actorPrincipalId: null,
                actorSessionId: null,
            },
        } as Partial<GroupMutationCommand>);
        const internalFacts: GroupMutationFacts = {
            ...publicFacts,
            internalAuthority: 'session-cleanup',
            authenticatedAuthority: null,
        };

        for (const [label, command, facts] of [
            ['public heartbeat', heartbeat, publicFacts],
            ['public disconnect', disconnect, publicFacts],
            ['internal disconnect', internalDisconnect, internalFacts],
        ] as const) {
            expect(
                () => computeGroupMutation({ command, read: corruptRead, facts }),
                label,
            ).toThrow(/command slot identity|command principal|canonical principal/i);
        }
    });

    it.each(['heartbeat', 'disconnect'] as const)(
        'reads %s member and admission slots only from the authenticated command principal',
        async (operation) => {
            const runtime = new GroupBarrierRepository();
            const groupId = 'trusted-heartbeat-slot-room';
            const sessionId = 'alice-trusted-slot-session';
            const generationId = 'alice-trusted-slot-generation';
            const service = createService(runtime, 2_000);
            await seedOpenGroup(runtime, groupId);
            await service.connectPresenceSession(SCOPE, groupId, sessionId, {
                principalId: 'alice',
                generationId,
                connectedAtEpochMs: 1_000,
                lastHeartbeatAtEpochMs: 1_000,
                expiresAtEpochMs: 4_102_444_800_000,
                actorPrincipalId: 'alice',
                actorSessionId: sessionId,
                requestId: 'seed-trusted-slot-session',
            });
            const sessionKey = groupStatePresenceSessionStorageKey({
                ...groupRef(groupId),
                sessionId,
            });
            const storedSession = await runtime.findEntry('group-state:sessions', sessionKey);
            if (!storedSession) throw new Error('Expected stored session');
            await runtime.upsert(
                'group-state:sessions',
                sessionKey,
                JSON.stringify({
                    ...(JSON.parse(storedSession.value) as GroupPresenceSession),
                    principalId: 'candidate-principal',
                }),
                storedSession.expireAtTimestamp,
            );
            runtime.entryReadKeys = [];

            const mutation = operation === 'heartbeat'
                ? service.heartbeatPresenceSession(SCOPE, groupId, sessionId, {
                    generationId,
                    lastHeartbeatAtEpochMs: 2_000,
                    expiresAtEpochMs: 4_102_444_801_000,
                    actorPrincipalId: 'alice',
                    actorSessionId: sessionId,
                    requestId: 'trusted-slot-heartbeat',
                })
                : service.disconnectPresenceSession(SCOPE, groupId, sessionId, {
                    generationId,
                    disconnectedAtEpochMs: 2_000,
                    actorPrincipalId: 'alice',
                    actorSessionId: sessionId,
                    requestId: 'trusted-slot-disconnect',
                });
            await expect(mutation).rejects.toThrow(
                /presence principal|command principal|canonical principal/i,
            );

            expect(runtime.entryReadKeys).toContain(groupStateMemberStorageKey({
                ...groupRef(groupId),
                principalId: 'alice',
            }));
            expect(runtime.entryReadKeys).toContain(groupStatePresenceAdmissionStorageKey({
                ...groupRef(groupId),
                principalId: 'alice',
            }));
            expect(runtime.entryReadKeys).not.toContain(groupStateMemberStorageKey({
                ...groupRef(groupId),
                principalId: 'candidate-principal',
            }));
            expect(runtime.entryReadKeys).not.toContain(groupStatePresenceAdmissionStorageKey({
                ...groupRef(groupId),
                principalId: 'candidate-principal',
            }));
        },
    );

    it('rejects one authority session referenced by different principal admissions', () => {
        const base = createMutationRead();
        const group = {
            ...base.group!.value,
            metadata: {
                rallarDirector: {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'shared-session',
                    principalId: 'director',
                    epoch: 1,
                    appointedAtEpochMs: 1_000,
                    heartbeatTtlMs: 5_000,
                },
            },
        };
        const admitted = {
            sessionId: 'shared-session',
            generationId: 'generation-1',
            generationVersion: 1_000,
            connectedAtEpochMs: 1_000,
        } as const;
        const directorSession = presenceFor(
            'director', 'shared-session', 'generation-1',
        );
        const read: GroupMutationRead = {
            ...base,
            group: storedEntry(groupStorageKey(), group),
            authorityAdmission: storedEntry(
                groupAdmissionStorageKey('alice'),
                admissionFor('alice', [admitted]),
            ),
            directorAdmission: storedEntry(
                groupAdmissionStorageKey('director'),
                admissionFor('director', [admitted]),
            ),
            authorityPresenceSessions: [directorSession],
            authorityPresenceSessionEntries: [storedEntry(
                groupSessionStorageKey('shared-session'), directorSession,
            )],
        };
        const command = createMutationCommand({
            operation: 'appointDirector',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                heartbeatTtlMs: 5_000,
            },
        } as Partial<GroupMutationCommand>);

        expect(() => computeGroupMutation({
            command,
            read,
            facts: createMutationFacts(),
        })).toThrow(/multiple principals|different principal admissions|duplicated authority/i);
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

    it('replays omitted join-code defaults by semantic caller intent', async () => {
        const cases = [
            {
                label: 'omit both',
                request: {},
                generatedCode: true,
            },
            {
                label: 'omit code only',
                request: { expiresAtEpochMs: BASE_EPOCH_MS + 90_000 },
                generatedCode: true,
            },
            {
                label: 'omit expiry only',
                request: { joinCode: 'fixed-code' },
                generatedCode: false,
            },
        ] as const;

        for (const [index, testCase] of cases.entries()) {
            const runtime = new GroupBarrierRepository();
            const groupId = `default-code-room-${index}`;
            await seedOpenGroup(runtime, groupId);
            let nowEpochMs = BASE_EPOCH_MS + 2_000;
            let randomCalls = 0;
            let rejectVolatileMaterialization = false;
            const requestId = `default-code-${index}`;
            const service = createService(
                runtime,
                () => nowEpochMs,
                undefined,
                () => {
                    if (rejectVolatileMaterialization) {
                        throw new Error('replay invoked random materialization');
                    }
                    return `generated-${index}-${++randomCalls}`;
                },
            );
            const request = {
                ...testCase.request,
                actorPrincipalId: 'alice',
                requestId,
            };

            const first = requireJoinCodeResult(await service.rotateGroupJoinCode(
                SCOPE,
                groupId,
                request,
            ));
            const firstRandomCalls = randomCalls;
            nowEpochMs = BASE_EPOCH_MS + 8_000;
            rejectVolatileMaterialization = true;
            const replay = requireJoinCodeResult(await service.rotateGroupJoinCode(
                SCOPE,
                groupId,
                request,
            ));

            expect(replay, testCase.label).toEqual(first);
            expect(randomCalls, testCase.label).toBe(firstRandomCalls);
            expect(firstRandomCalls, testCase.label).toBe(0);
            const repository = new GroupStateRepository(runtime);
            const idempotency = await repository.findIdempotentGroupMutationReceipt(
                groupRef(groupId),
                requestId,
            );
            expect(idempotency?.receipt.joinCode).toBe(first.joinCode);
            expect(idempotency?.receipt.joinCodeExpiresAtEpochMs)
                .toBe(first.expiresAtEpochMs);
            expect(idempotency?.receipt.outboxIds).toEqual([expect.any(String)]);
        }
    });

    it('treats explicit and omitted join-code intent as different semantics', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'semantic-code-room');
        let randomCalls = 0;
        let rejectVolatileMaterialization = false;
        const service = createService(
            runtime,
            BASE_EPOCH_MS + 2_000,
            undefined,
            () => {
                if (rejectVolatileMaterialization) {
                    throw new Error('conflict invoked random materialization');
                }
                return `semantic-code-${++randomCalls}`;
            },
        );
        const requestId = 'semantic-code-request';
        const winner = requireJoinCodeResult(await service.rotateGroupJoinCode(
            SCOPE,
            'semantic-code-room',
            { actorPrincipalId: 'alice', requestId },
        ));
        const winnerRandomCalls = randomCalls;
        rejectVolatileMaterialization = true;

        await expect(service.rotateGroupJoinCode(
            SCOPE,
            'semantic-code-room',
            {
                joinCode: winner.joinCode,
                expiresAtEpochMs: winner.expiresAtEpochMs,
                actorPrincipalId: 'alice',
                requestId,
            },
        )).rejects.toBeInstanceOf(GroupMutationIdempotencyConflictError);
        expect(randomCalls).toBe(winnerRandomCalls);
        await expect(service.rotateGroupJoinCode(
            SCOPE,
            'semantic-code-room',
            {
                joinCode: 'different-code',
                actorPrincipalId: 'alice',
                requestId,
            },
        )).rejects.toBeInstanceOf(GroupMutationIdempotencyConflictError);
        expect(randomCalls).toBe(winnerRandomCalls);
    });

    it('converges concurrent omitted join-code rotations on the winning receipt', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'concurrent-default-code-room');
        runtime.armGroupReadBarrier(2);

        const results = await Promise.all([
            createService(runtime, BASE_EPOCH_MS + 2_000).rotateGroupJoinCode(
                SCOPE,
                'concurrent-default-code-room',
                { actorPrincipalId: 'alice', requestId: 'concurrent-default-code' },
            ),
            createService(runtime, BASE_EPOCH_MS + 3_000).rotateGroupJoinCode(
                SCOPE,
                'concurrent-default-code-room',
                { actorPrincipalId: 'alice', requestId: 'concurrent-default-code' },
            ),
        ]);
        const [first, second] = results.map(requireJoinCodeResult);

        expect(second).toEqual(first);
        expect((await new GroupStateRepository(runtime)
            .findIdempotentGroupMutationReceipt(
                groupRef('concurrent-default-code-room'),
                'concurrent-default-code',
            ))?.receipt.outboxIds).toHaveLength(1);
        expect((await new GroupStateRepository(runtime).listEvents(
            groupRef('concurrent-default-code-room'),
        )).filter((event) => event.requestId === 'concurrent-default-code'))
            .toHaveLength(1);
    });

    it('materializes an omitted join code once and keeps its digest across CAS retry', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'retry-default-code-room');
        runtime.failNextGroupCas(1);
        let randomCalls = 0;
        const service = createService(
            runtime,
            BASE_EPOCH_MS + 2_000,
            undefined,
            () => `retry-default-${++randomCalls}`,
        );
        const result = requireJoinCodeResult(await service.rotateGroupJoinCode(
            SCOPE,
            'retry-default-code-room',
            { actorPrincipalId: 'alice', requestId: 'retry-default-code' },
        ));
        const idempotency = await new GroupStateRepository(runtime)
            .findIdempotentGroupMutationReceipt(
                groupRef('retry-default-code-room'),
                'retry-default-code',
            );

        expect(result.joinCode).toMatch(/^[A-F0-9]{12}$/);
        expect(randomCalls).toBe(0);
        expect(idempotency?.receipt.joinCode).toBe(result.joinCode);
        expect(idempotency?.receipt.joinCodeExpiresAtEpochMs)
            .toBe(result.expiresAtEpochMs);
    });

    it('stores compact first-writer receipts and exact canonical digest outbox identity', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'digest-room');
        const service = createService(runtime, 2_000);
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
        expect(stored?.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(stored?.receipt.outboxIds).toEqual([expect.any(String)]);
        expect(JSON.stringify(stored)).not.toContain('activeSessions');
        expect(JSON.stringify(stored)).not.toContain('members');
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
        const sleep = vi.fn((_delayMs: number) => Promise.resolve());
        await expect(createService(runtime, 2_000, sleep).updateGroup(
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

    it('records durable preparation and read phases in the test-only driver', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'group-phase-room');
        const timing: RallarTimingEvent[] = [];
        const service = createService(
            runtime,
            2_000,
            () => Promise.resolve(),
            undefined,
            (event) => timing.push(event),
        );
        const request = {
            displayName: 'Timed write',
            actorPrincipalId: 'alice',
            requestId: 'group-phase-write',
        } as const;

        await service.updateGroup(SCOPE, 'group-phase-room', request);
        expect(timing.map((event) => event.operation)).toEqual(expect.arrayContaining([
            'prepareMutation',
            'read',
        ]));
        expect(timing).toSatisfy((events: RallarTimingEvent[]) =>
            events.every((event) => event.status === 'ok' && event.durationMs >= 0)
        );

        timing.length = 0;
        await service.updateGroup(SCOPE, 'group-phase-room', request);
        expect(timing.map((event) => event.operation)).toEqual(expect.arrayContaining([
            'prepareMutation',
            'read',
        ]));
    });

});

void (null as GroupPresenceSession | null);
