import { type GroupMutationCommand, type GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { describe, expect, it } from 'vitest';
import {
    admissionFor,
    createMutationCommand,
    createMutationFacts,
    createMutationRead,
    groupAdmissionStorageKey,
    groupIdempotencyStorageKey,
    memberFor,
    rekey
} from '../group-state-concurrency-test-fixtures.ts';
import { groupMemberStorageKey, groupSessionStorageKey, groupStorageKey, presenceFor, storedEntry } from '../mutation/group-mutation-test-runtime.ts';

describe('convergent group and presence state', () => {
    it('rejects a wrong-scope owner member before it can authorize a mutation', () => {
        const command = createMutationCommand();
        const read = createMutationRead();
        const wrongScopeOwner = {
            ...read.actorMember!,
            groupId: 'another-room'
        };
        const forgedRead: GroupMutationRead = {
            ...read,
            actorMember: wrongScopeOwner,
            actorMemberEntry: {
                ...read.actorMemberEntry!,
                entry: {
                    ...read.actorMemberEntry!.entry,
                    value: JSON.stringify(wrongScopeOwner)
                },
                value: wrongScopeOwner
            }
        };

        expect(() =>
            computeGroupMutation({
                command,
                read: forgedRead,
                facts: createMutationFacts()
            })
        ).toThrow(/scope|groupId|group/i);
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
                    entry: { ...base.group!.entry, revision: -1 }
                }
            },
            {
                ...base,
                actorMemberEntry: {
                    ...base.actorMemberEntry!,
                    entry: {
                        ...base.actorMemberEntry!.entry,
                        value: JSON.stringify({
                            ...base.actorMemberEntry!.value,
                            role: 'admin'
                        })
                    }
                }
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
                            role: 'root'
                        })
                    },
                    value: { ...base.actorMemberEntry!.value, role: 'root' as never }
                }
            }
        ];

        for (const read of cases) {
            expect(() => computeGroupMutation({ command, read, facts })).toThrow(
                /revision|entry|role|stored/i
            );
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
                role: 'admin'
            }
        } as Partial<GroupMutationCommand>);
        const bob = memberFor('bob');
        const targetRead: GroupMutationRead = {
            ...base,
            targetMember: bob,
            targetMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob)
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
                    heartbeatTtlMs: 5_000
                }
            }
        };
        const director = memberFor('director');
        const ownerAdmission = admissionFor('alice', []);
        const directorAdmission = admissionFor('director', [
            {
                sessionId: 'director-session',
                generationId: 'director-generation',
                generationVersion: 1_000,
                connectedAtEpochMs: 1_000
            }
        ]);
        const directorSession = presenceFor('director', 'director-session', 'director-generation');
        const directorCommand = createMutationCommand({
            operation: 'appointDirector',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                heartbeatTtlMs: 5_000
            }
        } as Partial<GroupMutationCommand>);
        const directorRead: GroupMutationRead = {
            ...base,
            group: storedEntry(groupStorageKey(), directorGroup),
            authorityMember: base.actorMember,
            authorityMemberEntry: base.actorMemberEntry,
            directorMember: director,
            directorMemberEntry: storedEntry(groupMemberStorageKey('director'), director),
            authorityAdmission: storedEntry(groupAdmissionStorageKey('alice'), ownerAdmission),
            directorAdmission: storedEntry(groupAdmissionStorageKey('director'), directorAdmission),
            authorityPresenceSessions: [directorSession],
            authorityPresenceSessionEntries: [
                storedEntry(groupSessionStorageKey('director-session'), directorSession)
            ]
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
                expiresAtEpochMs: 10_000
            }
        } as Partial<GroupMutationCommand>);
        const bobAdmission = admissionFor('bob', []);
        const presenceRead: GroupMutationRead = {
            ...targetRead,
            targetAdmission: storedEntry(groupAdmissionStorageKey('bob'), bobAdmission)
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
                snapshotVersion: 1,
                causalRevision: { groupRevision: 1, presenceRevision: 0 },
                eventId: null,
                outboxIds: [],
                joinCode: null,
                joinCodeExpiresAtEpochMs: null,
                rejection: null
            }
        };

        const cases: readonly [string, GroupMutationCommand, GroupMutationRead][] = [
            [
                'group key',
                targetCommand,
                {
                    ...targetRead,
                    group: rekey(targetRead.group!, `${groupStorageKey()}:wrong`)
                }
            ],
            [
                'actor slot value',
                targetCommand,
                {
                    ...targetRead,
                    actorMember: bob,
                    actorMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob)
                }
            ],
            [
                'actor slot key',
                targetCommand,
                {
                    ...targetRead,
                    actorMemberEntry: rekey(targetRead.actorMemberEntry!, groupMemberStorageKey('bob'))
                }
            ],
            [
                'target slot',
                targetCommand,
                {
                    ...targetRead,
                    targetMember: memberFor('charlie'),
                    targetMemberEntry: storedEntry(groupMemberStorageKey('charlie'), memberFor('charlie'))
                }
            ],
            [
                'owner authority slot',
                directorCommand,
                {
                    ...directorRead,
                    authorityMember: bob,
                    authorityMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob)
                }
            ],
            [
                'director slot',
                directorCommand,
                {
                    ...directorRead,
                    directorMember: bob,
                    directorMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob)
                }
            ],
            [
                'target admission',
                presenceCommand,
                {
                    ...presenceRead,
                    targetAdmission: storedEntry(
                        groupAdmissionStorageKey('charlie'),
                        admissionFor('charlie', [])
                    )
                }
            ],
            [
                'target presence session',
                presenceCommand,
                {
                    ...presenceRead,
                    targetPresence: storedEntry(
                        groupSessionStorageKey('other-session'),
                        presenceFor('bob', 'other-session', 'bob-generation')
                    )
                }
            ],
            [
                'authority admission',
                directorCommand,
                {
                    ...directorRead,
                    authorityAdmission: storedEntry(groupAdmissionStorageKey('bob'), admissionFor('bob', []))
                }
            ],
            [
                'director admission',
                directorCommand,
                {
                    ...directorRead,
                    directorAdmission: storedEntry(groupAdmissionStorageKey('bob'), admissionFor('bob', []))
                }
            ],
            [
                'unreferenced authority session',
                directorCommand,
                {
                    ...directorRead,
                    authorityPresenceSessions: [presenceFor('director', 'other-session', 'other-generation')],
                    authorityPresenceSessionEntries: [
                        storedEntry(
                            groupSessionStorageKey('other-session'),
                            presenceFor('director', 'other-session', 'other-generation')
                        )
                    ]
                }
            ],
            [
                'idempotency key',
                targetCommand,
                {
                    ...targetRead,
                    idempotency: storedEntry(groupIdempotencyStorageKey('other-request'), idempotency)
                }
            ],
            [
                'idempotency record request',
                targetCommand,
                {
                    ...targetRead,
                    idempotency: storedEntry(groupIdempotencyStorageKey('other-request'), {
                        ...idempotency,
                        requestId: 'other-request'
                    })
                }
            ]
        ];

        for (const [label, command, read] of cases) {
            expect(() => computeGroupMutation({ command, read, facts }), label).toThrow(
                /canonical|identity|slot|key|request|principal|session|referenced/i
            );
        }
    });
});
