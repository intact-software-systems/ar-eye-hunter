import type { AuditStamp, Group, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { authorizeRelicCommand, authorizeRelicReset, authorizeRelicSnapshotRead } from '../../../apps/relic-hunter-server-v1/src/relic-rest-auth.ts';
import { createTestGroup } from '../create-test-group.ts';

const SESSION = {
    clientId: 'alice',
    sessionId: 'alice-session'
};

describe('Relic REST auth policy', () => {
    it('allows authenticated mode without group-policy state', () => {
        expect(() =>
            authorizeRelicSnapshotRead({
                mode: 'authenticated',
                gameId: 'room-1',
                session: SESSION
            })
        ).not.toThrow();
        expect(() =>
            authorizeRelicCommand({
                mode: 'authenticated',
                gameId: 'room-1',
                session: SESSION
            })
        ).not.toThrow();
        expect(() =>
            authorizeRelicReset({
                mode: 'authenticated',
                gameId: 'room-1',
                session: SESSION
            })
        ).not.toThrow();
    });

    it('requires full group read permission for snapshot reads in group-policy mode', () => {
        expect(() =>
            authorizeRelicSnapshotRead({
                mode: 'group-policy',
                gameId: 'room-1',
                session: SESSION,
                snapshot: snapshot()
            })
        ).not.toThrow();
        expect(() =>
            authorizeRelicSnapshotRead({
                mode: 'group-policy',
                gameId: 'room-1',
                session: { clientId: 'carol', sessionId: 'carol-session' },
                snapshot: snapshot()
            })
        ).toThrow(/Only active group members can read full group state/);
    });

    it('requires room send permission for commands in group-policy mode', () => {
        expect(() =>
            authorizeRelicCommand({
                mode: 'group-policy',
                gameId: 'room-1',
                session: SESSION,
                snapshot: snapshot({
                    activeSessions: [session('alice-session', 'alice')]
                })
            })
        ).not.toThrow();
        expect(() =>
            authorizeRelicCommand({
                mode: 'group-policy',
                gameId: 'room-1',
                session: SESSION,
                snapshot: snapshot()
            })
        ).toThrow(/live active group session/);
    });

    it('requires active owner/admin permission for reset in group-policy mode', () => {
        expect(() =>
            authorizeRelicReset({
                mode: 'group-policy',
                gameId: 'room-1',
                session: SESSION,
                snapshot: snapshot()
            })
        ).not.toThrow();
        expect(() =>
            authorizeRelicReset({
                mode: 'group-policy',
                gameId: 'room-1',
                session: SESSION,
                snapshot: snapshot({
                    members: [member('alice', { role: 'member' })]
                })
            })
        ).toThrow(/owners\/admins/);
    });
});

function snapshot(
    options: Readonly<{
        members?: readonly GroupMember[];
        activeSessions?: readonly GroupPresenceSession[];
    }> = {}
): GroupSnapshot {
    const members = options.members ?? [member('alice', { role: 'owner' })];
    const activeSessions = options.activeSessions ?? [];
    const groupRevision = 1;
    const presenceRevision = activeSessions.length;
    const group: Group = createTestGroup({
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'room-1',
        displayName: 'Room 1',
        activeMemberCount: members.length,
        ownerPrincipalId: 'alice',
        snapshotVersion: groupRevision,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: presenceRevision,
        created: auditStamp,
        updated: auditStamp
    });

    return {
        causalRevision: { groupRevision, presenceRevision },
        group,
        members,
        activeSessions,
        memberCount: members.filter((entry) => entry.status === 'active').length,
        onlineMemberCount: new Set(activeSessions.map((entry) => entry.principalId)).size
    };
}

function member(
    principalId: string,
    options: Readonly<{ role?: GroupMember['role']; }> = {}
): GroupMember {
    return {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'room-1',
        principalId,
        role: options.role ?? 'member',
        status: 'active',
        joined: auditStamp,
        updated: auditStamp,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function session(
    sessionId: string,
    principalId: string
): GroupPresenceSession {
    return {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'room-1',
        sessionId,
        principalId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: Date.now() + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

const auditStamp: AuditStamp = {
    atEpochMs: 1,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null
};
