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
import type { GroupSnapshot } from '@shared/api/group-types.ts';

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
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            displayName: 'room-1',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: { rallarDirector: appointment },
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1, byPrincipalId: 'principal-1' },
            updated: { atEpochMs: 1, byPrincipalId: 'principal-1' },
        },
        members: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'principal-1',
            role: 'owner',
            status: 'active',
            joined: { atEpochMs: 1, byPrincipalId: 'principal-1' },
            updated: { atEpochMs: 1, byPrincipalId: 'principal-1' },
        }],
        activeSessions: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
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

    return {
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            displayName: 'room-1',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: appointment ? { rallarDirector: appointment } : {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1, byPrincipalId: 'owner-1' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner-1' },
        },
        members: input.members.map((member) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: member.principalId,
            role: member.role,
            status: member.status,
            joined: { atEpochMs: 1, byPrincipalId: 'owner-1' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner-1' },
        })),
        activeSessions: input.activeSessions.map((session) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: session.principalId,
            sessionId: session.sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: input.members.length,
        onlineMemberCount: input.activeSessions.length,
    };
}
