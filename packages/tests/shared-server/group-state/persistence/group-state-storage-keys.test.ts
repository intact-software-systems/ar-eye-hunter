import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey,
    groupStateScopeStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { type GroupMutationIdempotencyRecord, type GroupMutationRead } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceAdmission, GroupPresenceSession } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from '../mutation/group-mutation-test-runtime.ts';

describe('GroupStateRepository persistence', () => {
    it('encodes canonical group storage keys including workspace absence and reserved IDs', () => {
        const ref = {
            applicationId: 'app/one',
            workspaceId: 'workspace/one',
            groupId: 'group:one'
        };
        const groupKey = 'app=app%2Fone:ws=workspace%2Fone:group=group%3Aone';
        expect(groupStateGroupStorageKey(ref)).toBe(groupKey);
        expect(groupStatePresenceSummaryStorageKey(ref)).toBe(groupKey);
        expect(groupStateMemberStorageKey({ ...ref, principalId: 'p/a' })).toBe(
            `${groupKey}:member=p%2Fa`
        );
        expect(groupStatePresenceSessionStorageKey({ ...ref, sessionId: 's:a' })).toBe(
            `${groupKey}:session=s%3Aa`
        );
        expect(
            groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: 'p:a'
            })
        ).toBe(`${groupKey}:principal=p%3Aa`);
        expect(groupStateIdempotencyStorageKey(ref, 'r/a')).toBe(`${groupKey}:request=r%2Fa`);
    });

    it('keeps the legacy absent-workspace key while encoding every present workspace injectively', () => {
        const absentRef = {
            applicationId: 'app/one',
            workspaceId: 'workspace/default',
            groupId: 'group:one'
        };
        const explicitSentinelRef = { ...absentRef, workspaceId: '_' };

        expect(groupStateScopeStorageKey(absentRef)).toBe('app=app%2Fone:ws=workspace%2Fdefault');
        expect(groupStateScopeStorageKey(explicitSentinelRef)).toBe('app=app%2Fone:ws=%5F');

        const absentKeys = [
            groupStateGroupStorageKey(absentRef),
            groupStateMemberStorageKey({ ...absentRef, principalId: 'p:a' }),
            groupStatePresenceSessionStorageKey({ ...absentRef, sessionId: 's:a' }),
            groupStatePresenceAdmissionStorageKey({
                ...absentRef,
                principalId: 'p:a'
            }),
            groupStatePresenceSummaryStorageKey(absentRef),
            groupStateIdempotencyStorageKey(absentRef, 'r:a')
        ];
        const explicitSentinelKeys = [
            groupStateGroupStorageKey(explicitSentinelRef),
            groupStateMemberStorageKey({
                ...explicitSentinelRef,
                principalId: 'p:a'
            }),
            groupStatePresenceSessionStorageKey({
                ...explicitSentinelRef,
                sessionId: 's:a'
            }),
            groupStatePresenceAdmissionStorageKey({
                ...explicitSentinelRef,
                principalId: 'p:a'
            }),
            groupStatePresenceSummaryStorageKey(explicitSentinelRef),
            groupStateIdempotencyStorageKey(explicitSentinelRef, 'r:a')
        ];
        for (let index = 0; index < absentKeys.length; index += 1) {
            expect(explicitSentinelKeys[index]).not.toBe(absentKeys[index]);
        }

        const workspaceValues = ['', '_', '%5F', 'a:b', 'a%b', 'a/b'];
        const scopeKeys = workspaceValues.map((workspaceId) =>
            groupStateScopeStorageKey({
                applicationId: 'app/one',
                workspaceId
            })
        );
        expect(new Set(scopeKeys).size).toBe(workspaceValues.length);

        const lookalikeValues = ['a:b', 'a%3Ab', 'a%b', 'a/b'];
        const keyFamilies = [
            lookalikeValues.map((groupId) => groupStateGroupStorageKey({ ...absentRef, groupId })),
            lookalikeValues.map((principalId) => groupStateMemberStorageKey({ ...absentRef, principalId })),
            lookalikeValues.map((sessionId) => groupStatePresenceSessionStorageKey({ ...absentRef, sessionId })),
            lookalikeValues.map((principalId) => groupStatePresenceAdmissionStorageKey({ ...absentRef, principalId })),
            lookalikeValues.map((groupId) => groupStatePresenceSummaryStorageKey({ ...absentRef, groupId })),
            lookalikeValues.map((requestId) => groupStateIdempotencyStorageKey(absentRef, requestId))
        ];
        for (const keys of keyFamilies) {
            expect(new Set(keys).size).toBe(lookalikeValues.length);
        }
    });

    it('rejects noncanonical percent aliases for every derived child key on direct, list, and snapshot reads', async () => {
        const ref = {
            applicationId: 'canonical-child-app',
            workspaceId: 'canonical-child-workspace',
            groupId: 'canonical-child-group'
        };
        const group: Group = {
            ...createMutationRead().group!.value,
            ...ref,
            activeMemberCount: 1
        };
        const member: GroupMember = {
            ...createMutationRead().actorMember!,
            ...ref,
            principalId: 'alice'
        };
        const session: GroupPresenceSession = {
            ...ref,
            sessionId: 'session',
            principalId: 'alice',
            generationId: 'generation',
            generationVersion: 1,
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 10_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        };
        const admission: GroupPresenceAdmission = {
            ...ref,
            principalId: 'alice',
            admittedSessions: [],
            updatedAtEpochMs: 1_000
        };
        const validIdempotency: GroupMutationIdempotencyRecord = {
            aggregateRef: ref,
            requestId: 'request',
            commandHash: `sha256:${'1'.repeat(64)}`,
            receipt: {
                commandId: 'request',
                requestId: 'request',
                commandHash: `sha256:${'1'.repeat(64)}`,
                aggregateRef: ref,
                outcome: 'no-op',
                attemptCount: 1,
                acceptedStorageRevision: 0,
                stateRevision: 1,
                snapshotVersion: 1,
                causalRevision: { groupRevision: 1, presenceRevision: 0 },
                eventId: null,
                outboxIds: [],
                joinCode: null,
                joinCodeExpiresAtEpochMs: null,
                rejection: null
            }
        };
        const cases = [
            {
                namespace: 'group-state:members',
                canonicalKey: groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
                aliasKey: `${groupStateGroupStorageKey(ref)}:member=%61lice`,
                value: member,
                direct: (repository: GroupStateRepository) => repository.findMemberEntry({ ...ref, principalId: 'alice' }),
                lists: (repository: GroupStateRepository) => [
                    () => repository.listMembers(ref),
                    () => repository.listMemberEntries(ref)
                ]
            },
            {
                namespace: 'group-state:sessions',
                canonicalKey: groupStatePresenceSessionStorageKey({ ...ref, sessionId: 'session' }),
                aliasKey: `${groupStateGroupStorageKey(ref)}:session=%73ession`,
                value: session,
                direct: (repository: GroupStateRepository) => repository.findPresenceEntry({ ...ref, sessionId: 'session' }),
                lists: (repository: GroupStateRepository) => [
                    () => repository.listPresenceSessions(ref),
                    () => repository.listPresenceSessionEntries(ref),
                    () => repository.listAllPresenceSessions()
                ]
            },
            {
                namespace: 'group-state:presence-admissions',
                canonicalKey: groupStatePresenceAdmissionStorageKey({
                    ...ref,
                    principalId: 'alice'
                }),
                aliasKey: `${groupStateGroupStorageKey(ref)}:principal=%61lice`,
                value: admission,
                direct: (repository: GroupStateRepository) => repository.findPresenceAdmissionEntry({ ...ref, principalId: 'alice' }),
                lists: (repository: GroupStateRepository) => [
                    () => repository.listPresenceAdmissions(ref),
                    () => repository.listPresenceAdmissionEntries(ref)
                ]
            },
            {
                namespace: 'group-state:idempotent',
                canonicalKey: groupStateIdempotencyStorageKey(ref, 'request'),
                aliasKey: `${groupStateGroupStorageKey(ref)}:request=%72equest`,
                value: validIdempotency,
                direct: (repository: GroupStateRepository) => repository.findIdempotentGroupMutationReceiptEntry(ref, 'request'),
                lists: (_repository: GroupStateRepository) => []
            }
        ] as const;

        for (const testCase of cases) {
            const directRuntime = new FakeRuntimeStateRepository();
            vi.spyOn(directRuntime, 'findEntry').mockResolvedValue({
                key: testCase.aliasKey,
                value: JSON.stringify(testCase.value),
                expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                updatedTimestamp: new Date().toISOString(),
                revision: 0
            });
            await expect(testCase.direct(new GroupStateRepository(directRuntime))).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption'
            });

            const listRuntime = new FakeRuntimeStateRepository();
            await listRuntime.upsert(
                testCase.namespace,
                testCase.aliasKey,
                JSON.stringify(testCase.value),
                Number.MAX_SAFE_INTEGER
            );
            const listRepository = new GroupStateRepository(listRuntime);
            for (const read of testCase.lists(listRepository)) {
                await expect(read()).rejects.toMatchObject({
                    code: 'group-state-repository-invariant-corruption'
                });
            }

            expect(testCase.aliasKey).not.toBe(testCase.canonicalKey);
        }

        const snapshotRuntime = new FakeRuntimeStateRepository();
        await snapshotRuntime.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(ref),
            JSON.stringify(group),
            Number.MAX_SAFE_INTEGER
        );
        await snapshotRuntime.upsert(
            'group-state:members',
            `${groupStateGroupStorageKey(ref)}:member=%61lice`,
            JSON.stringify(member),
            Number.MAX_SAFE_INTEGER
        );
        const snapshotRepository = new GroupStateRepository(snapshotRuntime);
        for (
            const read of [
                () => snapshotRepository.readSnapshot(ref),
                () =>
                    snapshotRepository.listSnapshots({
                        applicationId: ref.applicationId,
                        workspaceId: ref.workspaceId
                    }),
                () =>
                    snapshotRepository.listSnapshotsPage(
                        {
                            applicationId: ref.applicationId,
                            workspaceId: ref.workspaceId
                        },
                        { limit: 10 }
                    )
            ]
        ) {
            await expect(read()).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption'
            });
        }
    });
});

function auditStamp(atEpochMs: number, principalId: string, requestId: string | null): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId
    };
}

function createMutationRead(): GroupMutationRead {
    const audit = auditStamp(1_000, 'alice', 'seed');
    const group = createTestGroup({
        ...groupRef('pure-room'),
        displayName: 'Before',
        activeMemberCount: 1,
        ownerPrincipalId: 'alice',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit
    });
    const actorMember = {
        ...groupRef('pure-room'),
        principalId: 'alice',
        role: 'owner' as const,
        status: 'active' as const,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: audit,
        updated: audit
    };
    return {
        idempotency: null,
        group: storedEntry(groupStorageKey(), group),
        expiredGroupEntry: null,
        actorMember,
        targetMember: null,
        authorityMember: null,
        directorMember: null,
        actorMemberEntry: storedEntry(groupMemberStorageKey('alice'), actorMember),
        targetMemberEntry: null,
        authorityMemberEntry: null,
        directorMemberEntry: null,
        targetPresence: null,
        expiredTargetPresenceEntry: null,
        targetAdmission: null,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: null,
        lifecyclePolicy: null,
        activeMemberPrincipalIds: null
    } as GroupMutationRead;
}
