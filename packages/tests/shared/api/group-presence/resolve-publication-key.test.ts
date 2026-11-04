import { describe, expect, it } from 'vitest';

import { resolvePublicationKey } from '@shared/api/group-presence/resolve-publication-key.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createGroupSnapshotFixture } from '../../../shared-web/authoritative-group-fixtures.ts';
import { RFC_7517_PUBLICATION_KEY } from './group-presence-publication-key-fixtures.ts';

const ref = { applicationId: 'key-app', workspaceId: 'key-workspace', groupId: 'key-group' };

/** Before every fixture session's lease lapses. */
const NOW_MS = 30_000;

describe('resolvePublicationKey', () => {
    it('answers the active session\'s registered key', () => {
        expect(resolvePublicationKey(createKeyedSnapshot(), 'bob', NOW_MS)).toEqual(RFC_7517_PUBLICATION_KEY);
    });

    it('answers null for a session that registered no key and for a session the roster does not list', () => {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice'] });

        expect(resolvePublicationKey(snapshot, 'alice', NOW_MS)).toBeNull();
        expect(resolvePublicationKey(snapshot, 'carol', NOW_MS)).toBeNull();
    });

    it('answers null for a keyed session that is not live: disconnected, or its lease lapsed', () => {
        const snapshot = createKeyedSnapshot();
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

        expect(resolvePublicationKey(disconnected, 'bob', NOW_MS)).toBeNull();
        expect(resolvePublicationKey(snapshot, 'bob', lapsedAtMs)).toBeNull();
    });
});

function createKeyedSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice', 'bob'] });
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) =>
            session.sessionId === 'bob' ? { ...session, publicationKey: RFC_7517_PUBLICATION_KEY } : session
        )
    };
}
