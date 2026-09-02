import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import {
    computeGroupPresenceSummary,
    validateGroupPresenceSummary,
    type GroupPresenceSummaryRead
} from '@shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts';
import type { Group, GroupMember, GroupPresenceAdmission, GroupPresenceSession, GroupPresenceSummary, GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../../create-test-group.ts';
import { createMutationCommand, createMutationFacts, createMutationRead, rekey } from '../group-state-concurrency-test-fixtures.ts';
import { groupRef, presenceFor } from '../mutation/group-mutation-test-runtime.ts';

const REF: GroupRef = {
    applicationId: 'summary-app',
    workspaceId: 'summary-workspace',
    groupId: 'summary-group'
};

interface ExpiryCrossingPresence {
    readonly admission: GroupPresenceAdmission;
    readonly session: GroupPresenceSession;
}

describe('group presence summary evaluation time', () => {
    it('validates an expiry-crossing no-op at the compute observation time', () => {
        const read = createExpiryCrossingRead();
        const computed = computeGroupPresenceSummary({
            ref: REF,
            read,
            nowEpochMs: 2_000
        });

        expect(computed).toEqual({
            outcome: 'no-op',
            evaluatedAtEpochMs: 2_000,
            summary: read.current?.value
        });
        expect(validateGroupPresenceSummary({
            ref: REF,
            read,
            computed
        })).toEqual([]);
    });

    it('rebases stale presence-summary reads and validates dominating writes', () => {
        const storedGroup = createMutationRead().group!;
        const groupValue = { ...storedGroup.value, displayName: 'After' };
        const group = {
            ...storedGroup,
            value: groupValue,
            entry: { ...storedGroup.entry, value: JSON.stringify(groupValue), revision: 40 }
        };
        const noOp = computeGroupMutation({
            command: createMutationCommand(),
            read: { ...createMutationRead(), group },
            facts: createMutationFacts()
        });
        expect(noOp).toMatchObject({
            outcome: 'no-op',
            receipt: {
                causalRevision: { groupRevision: 1, presenceRevision: 0 }
            }
        });
        const base: GroupPresenceSummary = {
            ...groupRef('pure-room'),
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            activePrincipalIds: [],
            activeSessionIds: [],
            activeSessions: [],
            activePrincipalCount: 0,
            activeSessionCount: 0,
            computedAtEpochMs: 1_000
        };
        const current = {
            entry: {
                ...group.entry,
                key: groupStatePresenceSummaryStorageKey(groupRef('pure-room')),
                value: JSON.stringify(base),
                revision: 0
            },
            value: base
        };
        const member = createMutationRead().actorMemberEntry!;
        const read = {
            group,
            members: [member],
            admissions: [],
            presenceSessions: [],
            current
        };
        const canonical = computeGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read,
            nowEpochMs: 2_000
        });
        expect(canonical).toEqual({ outcome: 'no-op', evaluatedAtEpochMs: 2_000, summary: base });
        expect(validateGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read,
            computed: canonical
        })).toEqual([]);
        const staleSession = presenceFor('alice', 'stale-session', 'stale-generation');
        const divergentValue = {
            ...base,
            activePrincipalIds: ['alice'],
            activeSessionIds: ['stale-session'],
            activeSessions: [staleSession],
            activePrincipalCount: 1,
            activeSessionCount: 1
        };
        const divergent = {
            ...read,
            current: {
                ...current,
                entry: { ...current.entry, value: JSON.stringify(divergentValue) },
                value: divergentValue
            }
        };
        const write = computeGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read: divergent,
            nowEpochMs: 2_000
        });
        expect(write).toMatchObject({
            outcome: 'write',
            summary: {
                causalRevision: { groupRevision: 1, presenceRevision: 1 }
            }
        });
        expect(validateGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read: divergent,
            computed: write
        })).toEqual([]);
        const aheadValue = {
            ...divergentValue,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        };
        const ahead = {
            ...read,
            current: {
                ...current,
                entry: { ...current.entry, value: JSON.stringify(aheadValue) },
                value: aheadValue
            }
        };
        const concurrent = computeGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read: ahead,
            nowEpochMs: 2_000
        });
        expect(concurrent).toEqual({
            outcome: 'no-op',
            evaluatedAtEpochMs: 2_000,
            summary: aheadValue
        });
        expect(validateGroupPresenceSummary({
            ref: groupRef('pure-room'),
            read: ahead,
            computed: concurrent
        })).toEqual([]);
        expect(
            validateGroupPresenceSummary({
                ref: groupRef('pure-room'),
                read: {
                    ...read,
                    current: rekey(
                        current,
                        `${groupStatePresenceSummaryStorageKey(groupRef('pure-room'))}:wrong`
                    )
                },
                computed: { outcome: 'no-op', evaluatedAtEpochMs: 2_000, summary: base }
            }).map((issue) => issue.cause.message)
        ).toEqual(expect.arrayContaining([expect.stringMatching(/canonical|key/i)]));
    });
});

function createExpiryCrossingRead(): GroupPresenceSummaryRead {
    const audit = {
        atEpochMs: 1_000,
        actor: { kind: 'service' as const, serviceId: 'summary-test' },
        reason: null,
        traceId: null,
        requestId: 'summary-test'
    };
    const group = createExpiryCrossingGroup(audit);
    const member = createExpiryCrossingMember(audit);
    const presence = createExpiryCrossingPresence();
    const current = createExpiryCrossingSummary();

    return {
        group: stored(groupStateGroupStorageKey(REF), group),
        members: [stored(groupStateMemberStorageKey({ ...REF, principalId: 'alice' }), member)],
        admissions: [
            stored(
                groupStatePresenceAdmissionStorageKey({
                    ...REF,
                    principalId: 'alice'
                }),
                presence.admission
            )
        ],
        presenceSessions: [
            stored(
                groupStatePresenceSessionStorageKey({
                    ...REF,
                    sessionId: 'alice-session'
                }),
                presence.session
            )
        ],
        current: stored(groupStatePresenceSummaryStorageKey(REF), current)
    };
}

function createExpiryCrossingGroup(audit: Group['created']): Group {
    return createTestGroup({
        ...REF,
        displayName: 'Summary group',
        activeMemberCount: 1,
        ownerPrincipalId: 'alice',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1,
        expiresAtEpochMs: 1_500,
        created: audit,
        updated: audit
    });
}

function createExpiryCrossingMember(audit: GroupMember['updated']): GroupMember {
    return {
        ...REF,
        principalId: 'alice',
        role: 'owner',
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

function createExpiryCrossingPresence(): ExpiryCrossingPresence {
    const admitted = {
        sessionId: 'alice-session',
        generationId: 'alice-generation',
        generationVersion: 1_000,
        connectedAtEpochMs: 1_000
    };
    const admission: GroupPresenceAdmission = {
        ...REF,
        principalId: 'alice',
        admittedSessions: [admitted],
        updatedAtEpochMs: 1_000
    };
    const session: GroupPresenceSession = {
        ...REF,
        principalId: 'alice',
        ...admitted,
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: 10_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };

    return { admission, session };
}

function createExpiryCrossingSummary(): GroupPresenceSummary {
    return {
        ...REF,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: 1_000
    };
}

function stored<T>(key: string, value: T) {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date(0).toISOString(),
            revision: 0
        },
        value
    };
}
