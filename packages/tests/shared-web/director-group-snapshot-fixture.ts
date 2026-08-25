import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createActiveGroupMemberFixture, createActiveGroupPresenceSessionFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

export interface DirectorAppointmentFixture {
    readonly sessionId: string;
    readonly principalId: string;
    readonly epoch: number;
    readonly appointedAtEpochMs: number;
    readonly heartbeatTtlMs: number;
}

export function createDirectorGroupSnapshot(
    appointment?: DirectorAppointmentFixture
): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        sessionIds: ['session-1']
    });
    const activeSessions = toDirectorPresence(snapshot, appointment);
    const members = toDirectorMembers(snapshot, appointment);

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            created: {
                ...snapshot.group.created,
                actor: { kind: 'principal', principalId: 'principal-1' }
            },
            metadata: appointment
                ? { rallarDirector: toDirectorAppointment(appointment) }
                : {}
        },
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: activeSessions.length
    };
}

function toDirectorPresence(
    snapshot: GroupSnapshot,
    appointment: DirectorAppointmentFixture | undefined
): GroupSnapshot['activeSessions'] {
    const activeSessions: GroupSnapshot['activeSessions'][number][] = [{
        ...snapshot.activeSessions[0],
        principalId: 'principal-1',
        sessionId: 'session-1'
    }];
    if (appointment) {
        activeSessions.push(createActiveGroupPresenceSessionFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            sessionId: appointment.sessionId
        }));
    }
    return activeSessions;
}

function toDirectorMembers(
    snapshot: GroupSnapshot,
    appointment: DirectorAppointmentFixture | undefined
): GroupSnapshot['members'] {
    const members: GroupSnapshot['members'][number][] = [{
        ...snapshot.members[0],
        principalId: 'principal-1',
        role: 'owner'
    }];
    if (appointment) {
        members.push(createActiveGroupMemberFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            role: 'member',
            actorPrincipalId: 'principal-1'
        }));
    }
    return members;
}

function toDirectorAppointment(appointment: DirectorAppointmentFixture) {
    return {
        version: 1,
        mode: 'appointed-spa' as const,
        ...appointment
    };
}
