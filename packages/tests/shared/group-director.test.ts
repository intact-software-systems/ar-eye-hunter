import { describe, expect, it } from 'vitest';
import {
    createRallarGroupDirectorAppointment,
    isRallarGroupDirectorForSession,
    isRallarGroupDirectorSessionActive,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorAppointment,
    readRallarGroupDirectorFreshness,
    readRallarGroupDirectorFromSnapshot,
    resolveRallarGroupDirectorAppointmentEligibility,
} from '@shared/api/group-director.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

describe('Rallar group director metadata', () => {
    it('creates appointments with incremented epochs and preserves metadata', () => {
        const first = createRallarGroupDirectorAppointment({
            session: { clientId: 'principal-1', sessionId: 'session-1' },
            now: 100,
            heartbeatTtlMs: 5_000,
        });
        const second = createRallarGroupDirectorAppointment({
            session: { clientId: 'principal-2', sessionId: 'session-2' },
            previous: first,
            now: 200,
        });

        expect(first).toMatchObject({
            principalId: 'principal-1',
            sessionId: 'session-1',
            epoch: 1,
            appointedAtEpochMs: 100,
        });
        expect(second).toMatchObject({
            principalId: 'principal-2',
            sessionId: 'session-2',
            epoch: 2,
            heartbeatTtlMs: 5_000,
        });
        expect(mergeRallarGroupDirectorMetadata({ keep: true }, second))
            .toMatchObject({
                keep: true,
                rallarDirector: second,
            });
    });

    it('rejects invalid heartbeat TTL values before storing appointment metadata', () => {
        expect(() =>
            createRallarGroupDirectorAppointment({
                session: { clientId: 'principal-1', sessionId: 'session-1' },
                heartbeatTtlMs: Number.NaN,
            })
        ).toThrow(/Invalid director heartbeat TTL/);

        expect(readRallarGroupDirectorAppointment({
            rallarDirector: {
                version: 1,
                mode: 'appointed-spa',
                sessionId: 'session-1',
                principalId: 'principal-1',
                epoch: 1,
                appointedAtEpochMs: 1_000,
                heartbeatTtlMs: Number.POSITIVE_INFINITY,
            },
        })).toBeUndefined();
    });

    it('reads freshness, ownership, and active session state', () => {
        const appointment = createRallarGroupDirectorAppointment({
            session: { clientId: 'principal-1', sessionId: 'session-1' },
            now: 1_000,
            heartbeatTtlMs: 500,
        });
        const snapshot = createSnapshot(appointment);

        expect(readRallarGroupDirectorFromSnapshot(snapshot)).toEqual(appointment);
        expect(isRallarGroupDirectorForSession(appointment, {
            clientId: 'principal-1',
            sessionId: 'session-1',
        })).toBe(true);
        expect(isRallarGroupDirectorSessionActive(snapshot, appointment)).toBe(true);
        expect(readRallarGroupDirectorFreshness(appointment, 1_200, 1_400))
            .toBe('fresh');
        expect(readRallarGroupDirectorFreshness(appointment, 1_200, 1_800))
            .toBe('stale');
    });

    it('allows active owners and admins to appoint the room director', () => {
        const snapshot = createPolicySnapshot({
            members: [
                { principalId: 'owner-1', role: 'owner', status: 'active' },
                { principalId: 'admin-1', role: 'admin', status: 'active' },
            ],
            activeSessions: [
                { principalId: 'owner-1', sessionId: 'owner-session' },
                { principalId: 'admin-1', sessionId: 'admin-session' },
            ],
        });

        expect(resolveRallarGroupDirectorAppointmentEligibility({
            snapshot,
            principalId: 'owner-1',
            sessionId: 'owner-session',
        })).toMatchObject({
            allowed: true,
            status: 'allowed',
            localRole: 'owner',
            localMemberStatus: 'active',
        });
        expect(resolveRallarGroupDirectorAppointmentEligibility({
            snapshot,
            principalId: 'admin-1',
            sessionId: 'admin-session',
        })).toMatchObject({
            allowed: true,
            status: 'allowed',
            localRole: 'admin',
            localMemberStatus: 'active',
        });
    });

    it('allows active members to appoint only when no owner/admin or director is active', () => {
        const snapshot = createPolicySnapshot({
            members: [
                { principalId: 'owner-1', role: 'owner', status: 'active' },
                { principalId: 'member-1', role: 'member', status: 'active' },
            ],
            activeSessions: [
                { principalId: 'member-1', sessionId: 'member-session' },
            ],
        });

        expect(resolveRallarGroupDirectorAppointmentEligibility({
            snapshot,
            principalId: 'member-1',
            sessionId: 'member-session',
        })).toMatchObject({
            allowed: true,
            status: 'allowed',
            localRole: 'member',
            localMemberStatus: 'active',
        });
    });

    it('denies member fallback while an owner/admin is online or a director is active', () => {
        const ownerOnline = createPolicySnapshot({
            members: [
                { principalId: 'owner-1', role: 'owner', status: 'active' },
                { principalId: 'member-1', role: 'member', status: 'active' },
            ],
            activeSessions: [
                { principalId: 'owner-1', sessionId: 'owner-session' },
                { principalId: 'member-1', sessionId: 'member-session' },
            ],
        });
        const activeDirector = createPolicySnapshot({
            appointment: {
                principalId: 'director-1',
                sessionId: 'director-session',
            },
            members: [
                { principalId: 'owner-1', role: 'owner', status: 'active' },
                { principalId: 'member-1', role: 'member', status: 'active' },
                { principalId: 'director-1', role: 'member', status: 'active' },
            ],
            activeSessions: [
                { principalId: 'member-1', sessionId: 'member-session' },
                { principalId: 'director-1', sessionId: 'director-session' },
            ],
        });

        expect(resolveRallarGroupDirectorAppointmentEligibility({
            snapshot: ownerOnline,
            principalId: 'member-1',
            sessionId: 'member-session',
        })).toMatchObject({
            allowed: false,
            status: 'not-authorized',
            reason: 'Only owners/admins can appoint while an owner/admin is online.',
        });
        expect(resolveRallarGroupDirectorAppointmentEligibility({
            snapshot: activeDirector,
            principalId: 'member-1',
            sessionId: 'member-session',
        })).toMatchObject({
            allowed: false,
            status: 'not-authorized',
            reason: 'Cannot appoint a fallback director while another director is active.',
        });
    });

    it('denies inactive members', () => {
        const snapshot = createPolicySnapshot({
            members: [
                { principalId: 'owner-1', role: 'owner', status: 'active' },
                { principalId: 'member-1', role: 'member', status: 'left' },
            ],
            activeSessions: [
                { principalId: 'member-1', sessionId: 'member-session' },
            ],
        });

        expect(resolveRallarGroupDirectorAppointmentEligibility({
            snapshot,
            principalId: 'member-1',
            sessionId: 'member-session',
        })).toMatchObject({
            allowed: false,
            status: 'not-authorized',
            reason: 'Only active room members can appoint the browser director.',
            localRole: 'member',
            localMemberStatus: 'left',
        });
    });
});

function createSnapshot(
    appointment: ReturnType<typeof createRallarGroupDirectorAppointment>,
): GroupSnapshot {
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            slug: 'room-1',
            displayName: 'room-1',
            metadata: { rallarDirector: appointment },
            activeMemberCount: 1,
            ownerPrincipalId: 'principal-1',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: createAuditStamp(1, 'principal-1'),
            updated: createAuditStamp(1, 'principal-1'),
        }),
        members: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'principal-1',
            role: 'owner',
            status: 'active',
            joined: createAuditStamp(1, 'principal-1'),
            updated: createAuditStamp(1, 'principal-1'),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
        }],
        activeSessions: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-session-1',
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        }],
        memberCount: 1,
        onlineMemberCount: 1,
    };
}

function createPolicySnapshot(
    input: Readonly<{
        appointment?: Readonly<{ principalId: string; sessionId: string }>;
        members: readonly Readonly<{
            principalId: string;
            role: 'owner' | 'admin' | 'member';
            status: 'invited' | 'active' | 'left' | 'removed' | 'banned';
        }>[];
        activeSessions: readonly Readonly<{
            principalId: string;
            sessionId: string;
        }>[];
    }>,
): GroupSnapshot {
    const appointment = input.appointment
        ? createRallarGroupDirectorAppointment({
            session: {
                clientId: input.appointment.principalId,
                sessionId: input.appointment.sessionId,
            },
            now: 1,
        })
        : undefined;
    const owner = input.members.find((member) =>
        member.role === 'owner' && member.status === 'active'
    );
    if (owner === undefined) {
        throw new Error('Policy fixture requires an active owner');
    }
    const activeMemberCount = input.members.filter((member) =>
        member.status === 'active'
    ).length;

    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            slug: 'room-1',
            displayName: 'room-1',
            metadata: appointment ? { rallarDirector: appointment } : {},
            activeMemberCount,
            ownerPrincipalId: owner.principalId,
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: createAuditStamp(1, owner.principalId),
            updated: createAuditStamp(1, owner.principalId),
        }),
        members: input.members.map((member) => createMember(member, owner.principalId)),
        activeSessions: input.activeSessions.map((session): GroupPresenceSession => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: session.principalId,
            sessionId: session.sessionId,
            generationId: `generation-${session.sessionId}`,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: input.members.length,
        onlineMemberCount: input.activeSessions.length,
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null,
    };
}

function createMember(
    member: Readonly<{
        principalId: string;
        role: 'owner' | 'admin' | 'member';
        status: 'invited' | 'active' | 'left' | 'removed' | 'banned';
    }>,
    actorPrincipalId: string,
): GroupMember {
    const base = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId: member.principalId,
        role: member.role,
        joined: createAuditStamp(1, actorPrincipalId),
        updated: createAuditStamp(1, actorPrincipalId),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
    };
    const terminal = createAuditStamp(1, actorPrincipalId);
    switch (member.status) {
        case 'invited':
            return {
                ...base,
                status: 'invited',
                joined: null,
                left: null,
                removed: null,
                banned: null,
            };
        case 'active':
            return { ...base, status: 'active', left: null, removed: null, banned: null };
        case 'left':
            return { ...base, status: 'left', left: terminal, removed: null, banned: null };
        case 'removed':
            return { ...base, status: 'removed', left: null, removed: terminal, banned: null };
        case 'banned':
            return { ...base, status: 'banned', left: null, removed: null, banned: terminal };
    }
}
