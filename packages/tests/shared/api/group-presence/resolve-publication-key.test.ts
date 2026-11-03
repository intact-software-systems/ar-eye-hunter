import { describe, expect, it } from 'vitest';

import { resolvePublicationKey } from '@shared/api/group-presence/resolve-publication-key.ts';
import { createGroupSnapshotFixture } from '../../../shared-web/authoritative-group-fixtures.ts';
import { RFC_7517_PUBLICATION_KEY } from './group-presence-publication-key-fixtures.ts';

const ref = { applicationId: 'key-app', workspaceId: 'key-workspace', groupId: 'key-group' };

describe('resolvePublicationKey', () => {
    it('answers the active session\'s registered key', () => {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice', 'bob'] });
        const withKey = {
            ...snapshot,
            activeSessions: snapshot.activeSessions.map((session) =>
                session.sessionId === 'bob' ? { ...session, publicationKey: RFC_7517_PUBLICATION_KEY } : session
            )
        };

        expect(resolvePublicationKey(withKey, 'bob')).toEqual(RFC_7517_PUBLICATION_KEY);
    });

    it('answers null for a session that registered no key and for a session that is not active', () => {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice'] });

        expect(resolvePublicationKey(snapshot, 'alice')).toBeNull();
        expect(resolvePublicationKey(snapshot, 'carol')).toBeNull();
    });
});
