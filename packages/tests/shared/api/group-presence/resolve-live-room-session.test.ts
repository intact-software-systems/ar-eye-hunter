import { describe, expect, it } from 'vitest';

import { resolveLiveRoomSession } from '@shared/api/group-presence/resolve-live-room-session.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createGroupSnapshotFixture } from '../../../shared-web/authoritative-group-fixtures.ts';

const ref = { applicationId: 'live-app', workspaceId: 'live-workspace', groupId: 'live-group' };

/** Before every fixture session's lease lapses. */
const NOW_MS = 30_000;

describe('resolveLiveRoomSession', () => {
    it('answers the session the roster lists live', () => {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice', 'bob'] });

        expect(resolveLiveRoomSession(snapshot, 'bob', NOW_MS)?.sessionId).toBe('bob');
    });

    it('answers undefined for a session the roster does not list, a disconnected one, and one whose lease lapsed', () => {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice', 'bob'] });
        const disconnected: GroupSnapshot = {
            ...snapshot,
            activeSessions: snapshot.activeSessions.map((session) => ({
                ...session,
                status: 'disconnected' as const,
                disconnectedAtEpochMs: 1_000,
                disconnectReason: 'closed'
            }))
        };
        const lapsedAtMs = snapshot.activeSessions.find((session) => session.sessionId === 'bob')!.expiresAtEpochMs;

        expect(resolveLiveRoomSession(snapshot, 'carol', NOW_MS)).toBeUndefined();
        expect(resolveLiveRoomSession(disconnected, 'bob', NOW_MS)).toBeUndefined();
        expect(resolveLiveRoomSession(snapshot, 'bob', lapsedAtMs)).toBeUndefined();
    });
});
