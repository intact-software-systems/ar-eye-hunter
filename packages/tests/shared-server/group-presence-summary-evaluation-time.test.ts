import { describe, expect, it } from 'vitest';
import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
} from '@shared/api/group-types.ts';
import {
    groupStateGroupStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
    computeGroupPresenceSummary,
    type GroupPresenceSummaryRead,
    validateGroupPresenceSummary,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

const REF: GroupRef = {
    applicationId: 'summary-app',
    workspaceId: 'summary-workspace',
    groupId: 'summary-group',
};

describe('group presence summary evaluation time', () => {
    it('validates an expiry-crossing no-op at the compute observation time', () => {
        const read = createExpiryCrossingRead();
        const computed = computeGroupPresenceSummary({
            ref: REF,
            read,
            nowEpochMs: 2_000,
        });

        expect(computed).toEqual({
            outcome: 'no-op',
            evaluatedAtEpochMs: 2_000,
            summary: read.current?.value,
        });
        expect(() => validateGroupPresenceSummary({
            ref: REF,
            read,
            computed,
        })).not.toThrow();
    });
});

function createExpiryCrossingRead(): GroupPresenceSummaryRead {
    const audit = {
        atEpochMs: 1_000,
        actor: { kind: 'service' as const, serviceId: 'summary-test' },
        reason: null,
        traceId: null,
        requestId: 'summary-test',
    };
    const group: Group = {
        ...REF,
        slug: null,
        displayName: 'Summary group',
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
        ownerPrincipalId: 'alice',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1,
        expiresAtEpochMs: 1_500,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: null,
        created: audit,
        updated: audit,
    };
    const member: GroupMember = {
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
        updated: audit,
    };
    const admitted = {
        sessionId: 'alice-session',
        generationId: 'alice-generation',
        generationVersion: 1_000,
        connectedAtEpochMs: 1_000,
    };
    const admission: GroupPresenceAdmission = {
        ...REF,
        principalId: 'alice',
        admittedSessions: [admitted],
        updatedAtEpochMs: 1_000,
    };
    const session: GroupPresenceSession = {
        ...REF,
        principalId: 'alice',
        ...admitted,
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: 10_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
    const current: GroupPresenceSummary = {
        ...REF,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: 1_000,
    };
    return {
        group: stored(groupStateGroupStorageKey(REF), group),
        members: [stored(groupStateMemberStorageKey({ ...REF, principalId: 'alice' }), member)],
        admissions: [stored(groupStatePresenceAdmissionStorageKey({
            ...REF,
            principalId: 'alice',
        }), admission)],
        presenceSessions: [stored(groupStatePresenceSessionStorageKey({
            ...REF,
            sessionId: 'alice-session',
        }), session)],
        current: stored(groupStatePresenceSummaryStorageKey(REF), current),
    };
}

function stored<T>(key: string, value: T) {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date(0).toISOString(),
            revision: 0,
        },
        value,
    };
}
