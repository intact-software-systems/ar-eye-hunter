import { describe, expect, it } from 'vitest';
import {
    createRallarGroupDirectorAppointment,
    isRallarGroupDirectorForSession,
    isRallarGroupDirectorSessionActive,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFreshness,
    readRallarGroupDirectorFromSnapshot,
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
