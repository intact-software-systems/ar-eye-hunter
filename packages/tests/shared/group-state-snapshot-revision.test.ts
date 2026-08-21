import { describe, expect, it } from 'vitest';

import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { decideGroupSnapshotCausalRevision, isTuplePreservingGroupLivenessReduction } from '@shared/repository/group-state-snapshot-revision.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';
import { createTestGroup } from '../create-test-group.ts';

describe('decideGroupSnapshotCausalRevision', () => {
    it('orders snapshots by causal tuple', () => {
        const current = createGroupSnapshot({ presenceRevision: 3 });

        expect(decideGroupSnapshotCausalRevision(undefined, current)).toBe('inserted');
        expect(
            decideGroupSnapshotCausalRevision(current, createGroupSnapshot({ presenceRevision: 4 }))
        ).toBe('advanced');
        expect(
            decideGroupSnapshotCausalRevision(current, createGroupSnapshot({ presenceRevision: 2 }))
        ).toBe('stale');
    });

    it('treats lease-only differences at an equal tuple as duplicates', () => {
        const current = createGroupSnapshot({ presenceRevision: 3 });
        const renewed = createGroupSnapshot({
            presenceRevision: 3,
            leaseOffsetMs: 30_000
        });

        expect(decideGroupSnapshotCausalRevision(current, renewed)).toBe('duplicate');
        expect(decideGroupSnapshotCausalRevision(renewed, current)).toBe('duplicate');
    });

    it('treats a tuple-preserving liveness reduction as a duplicate in both directions', () => {
        const full = createGroupSnapshot({ presenceRevision: 3 });
        const reduced: GroupSnapshot = {
            ...full,
            activeSessions: full.activeSessions.slice(0, 1),
            onlineMemberCount: 1
        };

        expect(decideGroupSnapshotCausalRevision(full, reduced)).toBe('duplicate');
        expect(decideGroupSnapshotCausalRevision(reduced, full)).toBe('duplicate');
    });

    it('still fails closed on genuine equal-tuple content divergence', () => {
        const current = createGroupSnapshot({ presenceRevision: 3 });
        const divergent: GroupSnapshot = {
            ...current,
            activeSessions: current.activeSessions.map((session, index) => index === 0 ? { ...session, generationId: 'other-generation' } : session)
        };

        expect(() => decideGroupSnapshotCausalRevision(current, divergent)).toThrow(
            StateSnapshotRevisionConflictError
        );
    });
});

describe('isTuplePreservingGroupLivenessReduction', () => {
    it('accepts an order-preserving lease-insensitive session subset', () => {
        const full = createGroupSnapshot({ presenceRevision: 3 });
        const reduced: GroupSnapshot = {
            ...full,
            activeSessions: [{ ...full.activeSessions[1]!, expiresAtEpochMs: 99 }],
            onlineMemberCount: 1
        };

        expect(isTuplePreservingGroupLivenessReduction(reduced, full)).toBe(true);
    });

    it('rejects a reordered or foreign session set', () => {
        const full = createGroupSnapshot({ presenceRevision: 3 });
        const reordered: GroupSnapshot = {
            ...full,
            activeSessions: [...full.activeSessions].reverse()
        };
        const foreign: GroupSnapshot = {
            ...full,
            activeSessions: [{ ...full.activeSessions[0]!, sessionId: 'session-x' }],
            onlineMemberCount: 1
        };

        expect(isTuplePreservingGroupLivenessReduction(reordered, full)).toBe(false);
        expect(isTuplePreservingGroupLivenessReduction(foreign, full)).toBe(false);
    });
});

function createGroupSnapshot(
    input: Readonly<{ presenceRevision: number; leaseOffsetMs?: number; }>
): GroupSnapshot {
    const audit = createAuditStamp();
    const leaseOffsetMs = input.leaseOffsetMs ?? 0;
    const ref = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1'
    };
    const member = (principalId: string) => ({
        ...ref,
        principalId,
        role: principalId === 'alice' ? ('owner' as const) : ('member' as const),
        status: 'active' as const,
        joined: audit,
        updated: audit,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    });
    const session = (principalId: string, sessionId: string) => ({
        ...ref,
        principalId,
        sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        status: 'active' as const,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1_000 + leaseOffsetMs,
        expiresAtEpochMs: 120_000 + leaseOffsetMs
    });
    return {
        stateRevision: 4 + input.presenceRevision,
        causalRevision: { groupRevision: 4, presenceRevision: input.presenceRevision },
        group: createTestGroup({
            ...ref,
            displayName: 'Room 1',
            activeMemberCount: 2,
            ownerPrincipalId: 'alice',
            snapshotVersion: 4,
            metadataVersion: 4,
            rosterVersion: 4,
            presenceVersion: input.presenceRevision,
            created: audit,
            updated: audit
        }),
        members: [member('alice'), member('bob')],
        activeSessions: [session('alice', 'session-alice'), session('bob', 'session-bob')],
        memberCount: 2,
        onlineMemberCount: 2
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
