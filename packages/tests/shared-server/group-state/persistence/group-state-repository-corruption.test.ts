import {
    type GroupMutationCommand,
    type GroupMutationFacts,
    type GroupMutationIdempotencyRecord,
    type GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { decodePersistedGroupMember } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-codec.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { validatePersistedGroupMember } from '@shared-server/rallar-system/group-state/persistence/validate-persisted-group.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceAdmission, GroupPresenceSession, GroupPresenceSummary, GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createCorruptionMutationRead } from '../../group-state-persistence-mutation-read-fixtures.ts';
import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from '../mutation/group-mutation-test-runtime.ts';

describe('GroupStateRepository persistence', () => {
    it('rejects contradictory persisted terminal member audits', () => {
        const ref = groupRef('terminal-audit-room');
        const member = {
            ...memberFor('alice'),
            ...ref
        };
        const terminalAudit = auditStamp(2_000, 'alice', 'terminal');
        const contradictoryMembers = [
            {
                ...member,
                status: 'left',
                left: terminalAudit,
                removed: terminalAudit
            },
            {
                ...member,
                status: 'removed',
                removed: terminalAudit,
                banned: terminalAudit
            },
            {
                ...member,
                status: 'banned',
                banned: terminalAudit,
                left: terminalAudit
            }
        ];

        for (const contradictoryMember of contradictoryMembers) {
            expect(() => validatePersistedGroupMember(contradictoryMember, ref)).toThrow(
                /lifecycle|audit/
            );
            expect(() => decodePersistedGroupMember(contradictoryMember, ref)).toThrow(
                /lifecycle|audit/
            );
        }
    });

    it('fails closed instead of filtering a wrong-scope group from list and page reads', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = createTestGroupStateRepository(runtime);
        const absentScope = {
            applicationId: 'wrong-scope-list-app',
            workspaceId: 'wrong-scope-list-workspace'
        };
        const explicitSentinelGroup: Group = {
            ...createCorruptionMutationRead().group!.value,
            ...absentScope,
            workspaceId: '_',
            groupId: 'wrong-scope-list-group',
            activeMemberCount: 0
        };

        await runtime.upsert(
            'group-state:groups',
            groupStateGroupStorageKey({
                ...absentScope,
                groupId: explicitSentinelGroup.groupId
            }),
            JSON.stringify(explicitSentinelGroup),
            Number.MAX_SAFE_INTEGER
        );

        for (
            const read of [
                () => repository.listGroups(absentScope),
                () => repository.listSnapshots(absentScope),
                () => repository.listSnapshotsPage(absentScope, { limit: 10 })
            ]
        ) {
            await expect(read()).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption'
            });
        }
    });

    it('fails closed on wrong member, session, admission, and summary read slots', async () => {
        const ref = {
            applicationId: 'corrupt-child-app',
            workspaceId: 'corrupt-child-workspace',
            groupId: 'corrupt-child-group'
        };
        const cases = [
            {
                namespace: 'group-state:members',
                key: groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
                value: {
                    ...createCorruptionMutationRead().actorMember!,
                    ...ref,
                    principalId: 'mallory'
                } satisfies GroupMember,
                reads: (repository: GroupStateRepository) => [
                    () => repository.findMember({ ...ref, principalId: 'alice' }),
                    () => repository.findMemberEntry({ ...ref, principalId: 'alice' }),
                    () => repository.listMembers(ref),
                    () => repository.listMemberEntries(ref)
                ]
            },
            {
                namespace: 'group-state:sessions',
                key: groupStatePresenceSessionStorageKey({ ...ref, sessionId: 'session-1' }),
                value: {
                    ...ref,
                    sessionId: 'session-2',
                    principalId: 'alice',
                    generationId: 'generation-1',
                    generationVersion: 1,
                    connectedAtEpochMs: 1_000,
                    lastHeartbeatAtEpochMs: 1_000,
                    expiresAtEpochMs: 10_000,
                    status: 'active',
                    disconnectedAtEpochMs: null,
                    disconnectReason: null
                } satisfies GroupPresenceSession,
                reads: (repository: GroupStateRepository) => [
                    () => repository.findPresenceSession({ ...ref, sessionId: 'session-1' }),
                    () => repository.findPresenceEntry({ ...ref, sessionId: 'session-1' }),
                    () => repository.listPresenceSessions(ref),
                    () => repository.listPresenceSessionEntries(ref),
                    () => repository.listAllPresenceSessions()
                ]
            },
            {
                namespace: 'group-state:presence-admissions',
                key: groupStatePresenceAdmissionStorageKey({ ...ref, principalId: 'alice' }),
                value: {
                    ...ref,
                    principalId: 'mallory',
                    admittedSessions: [],
                    updatedAtEpochMs: 1_000
                } satisfies GroupPresenceAdmission,
                reads: (repository: GroupStateRepository) => [
                    () =>
                        repository.findPresenceAdmissionEntry({
                            ...ref,
                            principalId: 'alice'
                        }),
                    () => repository.listPresenceAdmissions(ref),
                    () => repository.listPresenceAdmissionEntries(ref)
                ]
            },
            {
                namespace: 'group-state:presence-summaries',
                key: groupStatePresenceSummaryStorageKey(ref),
                value: {
                    ...ref,
                    workspaceId: '_',
                    causalRevision: { groupRevision: 1, presenceRevision: 1 },
                    activePrincipalIds: [],
                    activeSessionIds: [],
                    activeSessions: [],
                    activePrincipalCount: 0,
                    activeSessionCount: 0,
                    computedAtEpochMs: 1_000
                } satisfies GroupPresenceSummary,
                reads: (repository: GroupStateRepository) => [
                    () => repository.findPresenceSummaryEntry(ref)
                ]
            }
        ];

        for (const testCase of cases) {
            const runtime = new FakeRuntimeStateRepository();
            await runtime.upsert(
                testCase.namespace,
                testCase.key,
                JSON.stringify(testCase.value),
                Number.MAX_SAFE_INTEGER
            );
            const repository = createTestGroupStateRepository(runtime);
            for (const read of testCase.reads(repository)) {
                await expect(read()).rejects.toMatchObject({
                    code: 'group-state-repository-invariant-corruption'
                });
            }
        }
    });

    it('wraps non-object and invalid-JSON stored rows as typed repository corruption', async () => {
        const ref = {
            applicationId: 'malformed-json-app',
            workspaceId: 'malformed-json-workspace',
            groupId: 'malformed-json-group'
        };
        const key = groupStateGroupStorageKey(ref);
        for (
            const [value, read] of [
                ['null', (repository: GroupStateRepository) => repository.findGroup(ref)],
                [
                    '{not-json',
                    (repository: GroupStateRepository) =>
                        repository.listGroups({
                            applicationId: ref.applicationId,
                            workspaceId: ref.workspaceId
                        })
                ]
            ] as const
        ) {
            const runtime = new FakeRuntimeStateRepository();
            await runtime.upsert('group-state:groups', key, value, Number.MAX_SAFE_INTEGER);
            await expect(read(createTestGroupStateRepository(runtime))).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption',
                storageKey: key
            });
        }
    });

    it('requires authoritative identity on compact idempotency reads', async () => {
        expectTypeOf<GroupMutationIdempotencyRecord>()
            .toHaveProperty('aggregateRef')
            .toEqualTypeOf<GroupRef>();
        const ref = {
            applicationId: 'identity-free-receipt-app',
            workspaceId: 'identity-free-receipt-workspace',
            groupId: 'identity-free-receipt-group'
        };
        const requestId = 'identity-free-request';
        const receipt = {
            commandId: requestId,
            commandHash: `sha256:${'1'.repeat(64)}`,
            outcome: 'no-op',
            stateRevision: 1,
            snapshotVersion: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            event: { kind: 'none' },
            joinCode: null,
            joinCodeExpiresAtEpochMs: null,
            rejection: null
        } as const;
        const identityFreeRecord = {
            requestId,
            commandHash: receipt.commandHash,
            receipt
        };

        for (const read of ['value', 'entry'] as const) {
            const runtime = new FakeRuntimeStateRepository();
            await runtime.upsert(
                'group-state:idempotent',
                groupStateIdempotencyStorageKey(ref, requestId),
                JSON.stringify(identityFreeRecord),
                Number.MAX_SAFE_INTEGER
            );
            const repository = createTestGroupStateRepository(runtime);
            const result = read === 'value'
                ? repository.findIdempotentGroupMutationReceipt(ref, requestId)
                : repository.findIdempotentGroupMutationReceiptEntry(ref, requestId);
            await expect(result).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption'
            });
        }
    });

    it('rejects a compact idempotency write whose identity differs from its slot', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = createTestGroupStateRepository(runtime);
        const command = createMutationCommand({
            commandId: 'receipt-write-command',
            requestId: 'receipt-write-command'
        });
        const ref = command.aggregateRef;
        const computed = computeGroupMutation({
            command,
            read: createCorruptionMutationRead(),
            facts: createMutationFacts()
        });
        if (computed.outcome !== 'write' || computed.idempotency === null) {
            throw new Error('Expected an idempotent group write candidate');
        }

        await expect(
            repository.insertIdempotentGroupMutationReceipt(ref, command.requestId!, {
                ...computed.idempotency,
                aggregateRef: { ...ref, groupId: 'wrong-group' }
            })
        ).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });
});

function memberFor(principalId: string): GroupMember {
    const audit = auditStamp(1_000, 'alice', 'seed');
    return {
        ...groupRef('pure-room'),
        principalId,
        role: 'member',
        status: 'active',
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: audit,
        updated: audit
    };
}

function createMutationCommand(
    overrides: Partial<GroupMutationCommand> = {}
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
            traceId: null
        },
        ...overrides
    } as GroupMutationCommand;
}

function auditStamp(atEpochMs: number, principalId: string, requestId: string | null): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId
    };
}

function createMutationFacts(): GroupMutationFacts {
    return {
        nowEpochMs: 2_000,
        expireAtEpochMs: 253_402_300_799_999,
        serviceId: 'group-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: { principalId: 'alice', sessionId: 'alice-session' }
    };
}
