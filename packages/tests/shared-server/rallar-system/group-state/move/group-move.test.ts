import { describe, expect, it } from 'vitest';

import { computeGroupMove } from '@shared-server/rallar-system/group-state/move/compute-group-move.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';

import { createGroupAuthorityRead, groupRef, presenceFor } from '../mutation/group-mutation-test-runtime.ts';

function sourceRoom(): GroupSnapshot {
    const read = createGroupAuthorityRead({ activeMemberCount: 2 }, {
        activeMemberPrincipalIds: ['alice', 'bob']
    });
    if (!read.group || !read.activeMembers) {
        throw new Error('Expected the room fixture');
    }
    return {
        group: read.group.value,
        members: read.activeMembers,
        activeSessions: [presenceFor('alice', 'alice-session', 'alice-generation'), presenceFor('bob', 'bob-session', 'bob-generation')],
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        memberCount: 2,
        onlineMemberCount: 2,
        publicationGrants: []
    };
}

interface MoveActionOptions {
    readonly principalId?: string;
    readonly source?: GroupSnapshot | null;
    readonly nowEpochMs?: number;
}

function applyMove(
    proposal: GroupMove | null,
    action: 'propose' | 'confirm' | 'withdraw' | 'decline' | 'cancel' | 'commit' | 'arrive',
    options: MoveActionOptions = {}
): GroupMove {
    const principalId = options.principalId ?? 'alice';
    return computeGroupMove({
        proposal,
        source: options.source === undefined ? sourceRoom() : options.source,
        sourceRef: groupRef('pure-room'),
        destination: groupRef('next-room'),
        moveId: 'move-1',
        action,
        actor: { principalId, sessionId: `${principalId}-session` },
        nowEpochMs: options.nowEpochMs ?? 2_000,
        admission: action === 'commit' ? { status: 'admitted', mutations: [] } : null
    }).fold((rejection) => {
        throw new Error(rejection.message);
    }, (move) => move);
}

function readyMove(): GroupMove {
    return applyMove(applyMove(applyMove(null, 'propose'), 'confirm'), 'confirm', { principalId: 'bob' });
}

describe('group move consent and lifecycle', () => {
    it('recovers a committed outcome after the source room was deleted', () => {
        const committed = applyMove(readyMove(), 'commit');

        expect(
            applyMove(committed, 'arrive', { principalId: 'bob', source: null, nowEpochMs: 130_000 }).participants.find((participant) =>
                participant.principalId === 'bob'
            )
        )
            .toMatchObject({ arrivedAtEpochMs: 130_000 });
    });

    it('pins the present player sessions and requires the organizer to confirm too', () => {
        const proposal = applyMove(null, 'propose');

        expect(proposal).toMatchObject({
            status: 'proposed',
            source: groupRef('pure-room'),
            destination: groupRef('next-room'),
            organizerSessionId: 'alice-session',
            createdAtEpochMs: 2_000,
            expiresAtEpochMs: 122_000
        });
        expect(proposal.participants.map((participant) => [participant.sessionId, participant.confirmedAtEpochMs]))
            .toEqual([['alice-session', null], ['bob-session', null]]);
    });

    it('requires every participant to confirm before the organizer can commit', () => {
        const onlyAlice = applyMove(applyMove(null, 'propose'), 'confirm');

        expect(() => applyMove(onlyAlice, 'commit')).toThrow('Every player must confirm');
        expect(applyMove(onlyAlice, 'confirm', { principalId: 'bob' }).status).toBe('proposed');
        expect(applyMove(readyMove(), 'commit').status).toBe('committed');
    });

    it('does not give another participant the organizer commit authority', () => {
        expect(() => applyMove(readyMove(), 'commit', { principalId: 'bob' })).toThrow('Only the move organizer');
    });

    it('withdraws just that participant consent and blocks the move', () => {
        const withdrawn = applyMove(readyMove(), 'withdraw', { principalId: 'bob' });

        expect(withdrawn.participants.map((participant) => participant.confirmedAtEpochMs)).toEqual([2_000, null]);
        expect(() => applyMove(withdrawn, 'commit')).toThrow('Every player must confirm');
    });

    it('cancels for everyone when a participant declines', () => {
        expect(applyMove(readyMove(), 'decline', { principalId: 'bob' })).toMatchObject({ status: 'cancelled', reason: 'participant-declined' });
    });

    it('does not inherit consent across a replacement presence generation', () => {
        const source = sourceRoom();
        const changed = {
            ...source,
            activeSessions: source.activeSessions.map((session) =>
                session.principalId === 'bob'
                    ? { ...session, generationId: 'bob-reloaded', generationVersion: 3_000 }
                    : session
            )
        };

        expect(applyMove(readyMove(), 'commit', { source: changed }))
            .toMatchObject({ status: 'cancelled', reason: 'source-roster-changed' });
    });

    it('does not silently drop a departed player from the cohort', () => {
        const source = sourceRoom();
        const changed = { ...source, activeSessions: source.activeSessions.filter((session) => session.principalId !== 'bob') };

        expect(applyMove(readyMove(), 'commit', { source: changed }))
            .toMatchObject({ status: 'cancelled', reason: 'source-roster-changed' });
    });

    it('expires from the server clock even if no expiry worker ran', () => {
        expect(applyMove(readyMove(), 'commit', { nowEpochMs: 122_000 }))
            .toMatchObject({ status: 'expired', reason: 'proposal-expired' });
    });

    it('keeps a committed decision after organizer departure and late cancellation', () => {
        const committed = applyMove(readyMove(), 'commit');
        const empty = { ...sourceRoom(), activeSessions: [] };

        expect(applyMove(committed, 'cancel', { source: empty, nowEpochMs: 130_000 })).toEqual(committed);
        expect(
            applyMove(committed, 'arrive', { principalId: 'bob', source: empty, nowEpochMs: 130_000 }).participants.find((participant) =>
                participant.principalId === 'bob'
            )
        )
            .toMatchObject({ arrivedAtEpochMs: 130_000 });
    });

    it('does not let an unrelated account read a mutation result by guessing its move identity', () => {
        expect(() => applyMove(readyMove(), 'confirm', { principalId: 'mallory' })).toThrow('Only a selected participant');
    });

    it('leaves spectators outside the move without promoting them', () => {
        const source = sourceRoom();
        const spectating = {
            ...source,
            members: source.members.map((member) => member.principalId === 'bob' ? { ...member, role: 'spectator' as const } : member)
        };

        expect(applyMove(null, 'propose', { source: spectating }).participants.map((participant) => participant.principalId)).toEqual(['alice']);
        expect(spectating.members.find((member) => member.principalId === 'bob')?.role).toBe('spectator');
    });
});
