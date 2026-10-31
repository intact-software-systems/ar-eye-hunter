import {
    decodePersistedGroup,
    decodePersistedGroupMember,
    decodePersistedGroupPresenceAdmission,
    decodePersistedGroupPresenceSession,
    decodePersistedGroupPresenceSummary
} from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-codec.ts';
import type { GroupPresenceAdmission, GroupPresenceSession, GroupPresenceSummary, GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import { groupRef } from '../mutation/group-mutation-test-runtime.ts';
import { createPersistenceMutationRead } from './group-state-persistence-mutation-read-fixtures.ts';

describe('group-state persistence codec', () => {
    // A stored value is parsed afresh from its text on every read, so the decoder hands out the
    // validated value itself rather than a copy.
    it('returns the validated stored value itself', () => {
        const read = createPersistenceMutationRead();
        const ref = groupRef('pure-room');
        const group = JSON.parse(JSON.stringify(read.group!.value));
        const member = JSON.parse(JSON.stringify(read.actorMember));
        const session = JSON.parse(JSON.stringify(presenceSession(ref)));
        const summary = JSON.parse(JSON.stringify(presenceSummary(ref)));
        const admission = JSON.parse(JSON.stringify(presenceAdmission(ref)));

        expect(decodePersistedGroup(group, ref)).toBe(group);
        expect(decodePersistedGroupMember(member, ref)).toBe(member);
        expect(decodePersistedGroupPresenceSession(session, ref)).toBe(session);
        expect(decodePersistedGroupPresenceSummary(summary, ref)).toBe(summary);
        expect(decodePersistedGroupPresenceAdmission(admission, ref)).toBe(admission);
    });
});

function presenceSession(ref: GroupRef): GroupPresenceSession {
    return {
        ...ref,
        sessionId: 'session-1',
        principalId: 'alice',
        generationId: 'generation-1',
        connectionGenerationId: 'ws-generation-1',
        generationVersion: 1_000,
        connectedAtEpochMs: 1_000,
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: 10_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function presenceSummary(ref: GroupRef): GroupPresenceSummary {
    return {
        ...ref,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: 1_000
    };
}

function presenceAdmission(ref: GroupRef): GroupPresenceAdmission {
    return {
        ...ref,
        principalId: 'alice',
        admittedSessions: [],
        updatedAtEpochMs: 1_000
    };
}
