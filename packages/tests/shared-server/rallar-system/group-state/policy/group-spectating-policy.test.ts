import {
    describe,
    expect,
    it
} from 'vitest';

import { toPolicySnapshot } from '@shared-server/rallar-system/group-state/mutation/aggregate/group-aggregate-mutation-policy.ts';
import { canActivateGroupMember, canJoinGroup } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import {
    createRallarGroupDirectorAppointment,
    isRallarGroupDirectorSessionActive,
    resolveRallarGroupDirectorAppointmentEligibility
} from '@shared/api/group-director.ts';
import { readGroupSpectatorCapacity } from '@shared/api/group-spectating.ts';

import { createGroupAuthorityRead } from '../mutation/group-mutation-test-runtime.ts';
import { createGroupSnapshot } from '../snapshot/group-state-snapshot-test-fixtures.ts';

const base = createGroupSnapshot(1, ['watcher']);
const watched = {
    ...base,
    group: { ...base.group, maxMembers: 1, metadata: { rallarSpectatorCapacity: 1 } },
    members: base.members.map((member) =>
        member.principalId === 'principal-watcher'
            ? { ...member, role: 'spectator' as const }
            : member
    )
};

describe('pure spectator role and capacity policies', () => {
    it('checks distinct admission caps while preserving an already active spectator', () => {
        expect(canJoinGroup({ snapshot: watched, actor: { principalId: 'next' } })).toMatchObject({ code: 'group-full' });
        expect(canJoinGroup({ snapshot: watched, actor: { principalId: 'next' }, participation: 'spectator' }))
            .toMatchObject({ code: 'group-full' });
        expect(canJoinGroup({ snapshot: watched, actor: { principalId: 'principal-watcher' } })).toEqual({ allowed: true });
        expect(canJoinGroup({ snapshot: watched, actor: { principalId: 'principal-watcher' }, participation: 'player' }))
            .toMatchObject({ code: 'group-full' });
        expect(canActivateGroupMember({ snapshot: watched, targetPrincipalId: 'principal-watcher', role: 'admin' }))
            .toMatchObject({ code: 'group-full' });
        expect(canJoinGroup({ snapshot: watched, actor: { principalId: 'alice' }, participation: 'spectator' }))
            .toMatchObject({ code: 'forbidden-role' });
    });

    it('treats absent or malformed stored capacity as disabled', () => {
        for (const value of [null, -1, 1.5, 65, '16']) {
            expect(readGroupSpectatorCapacity({ rallarSpectatorCapacity: value })).toBe(0);
        }
        expect(readGroupSpectatorCapacity({})).toBe(0);
        expect(readGroupSpectatorCapacity({ rallarSpectatorCapacity: 64 })).toBe(64);
    });

    it('requires private admission credentials for spectators before admitting them', () => {
        const snapshot = { ...watched, group: { ...watched.group, joinMode: 'code' as const, metadata: { rallarSpectatorCapacity: 2 } } };
        const input = { snapshot, actor: { principalId: 'next' }, participation: 'spectator' as const };
        expect(canJoinGroup(input)).toMatchObject({ code: 'group-code-required' });
        expect(canJoinGroup({ ...input, joinCode: 'wrong', joinCodeVerifier: 'wrong', expectedJoinCodeVerifier: 'right' }))
            .toMatchObject({ code: 'group-code-invalid' });
        expect(canJoinGroup({ ...input, joinCode: 'right', joinCodeVerifier: 'right', expectedJoinCodeVerifier: 'right' }))
            .toEqual({ allowed: true });
    });

    it('rejects a spectator as an appointed director even while its session remains online', () => {
        const appointment = createRallarGroupDirectorAppointment({
            session: { clientId: 'principal-watcher', sessionId: 'watcher' },
            now: 1_000
        });
        expect(isRallarGroupDirectorSessionActive(watched, appointment)).toBe(false);
        expect(resolveRallarGroupDirectorAppointmentEligibility({
            snapshot: watched,
            principalId: 'principal-watcher',
            sessionId: 'watcher'
        })).toMatchObject({ allowed: false, status: 'not-authorized' });
    });
});

describe('policy snapshot membership precedence', () => {
    it('keeps roster roles and order before filling missing point-read members', () => {
        const read = createGroupAuthorityRead({ groupId: 'group-1', activeMemberCount: 4 });
        const [owner, watcher] = watched.members;
        if (!owner || !watcher) {
            throw new Error('The watched fixture requires its owner and spectator');
        }
        const snapshot = toPolicySnapshot(
            {
                ...read,
                activeMembers: [watcher, owner],
                actorMember: { ...watcher, role: 'owner' },
                targetMember: { ...owner, role: 'spectator' },
                authorityMember: { ...owner, principalId: 'new-player', role: 'member' },
                directorMember: { ...owner, principalId: 'director', role: 'admin' }
            },
            watched.group,
            1_000
        );

        expect(snapshot.members.map(({ principalId, role }) => ({ principalId, role }))).toEqual([
            { principalId: 'principal-watcher', role: 'spectator' },
            { principalId: 'alice', role: 'owner' },
            { principalId: 'new-player', role: 'member' },
            { principalId: 'director', role: 'admin' }
        ]);
        expect(snapshot.memberCount).toBe(4);
        expect(snapshot.onlineMemberCount).toBe(0);
    });

    it.each([{ activeMembers: null }, { activeMembers: [] }])('uses first point-read membership when the roster is $activeMembers', ({ activeMembers }) => {
        const read = createGroupAuthorityRead({ groupId: 'group-1', activeMemberCount: 2 });
        const [owner, watcher] = watched.members;
        if (!owner || !watcher) {
            throw new Error('The watched fixture requires its owner and spectator');
        }
        const snapshot = toPolicySnapshot(
            {
                ...read,
                activeMembers,
                actorMember: null,
                targetMember: watcher,
                authorityMember: { ...watcher, role: 'admin' },
                directorMember: owner
            },
            watched.group,
            1_000
        );

        expect(snapshot.members.map(({ principalId, role }) => ({ principalId, role }))).toEqual([
            { principalId: 'principal-watcher', role: 'spectator' },
            { principalId: 'alice', role: 'owner' }
        ]);
        expect(snapshot.memberCount).toBe(2);
    });

    it('keeps an empty roster empty when no point-read members exist', () => {
        const read = createGroupAuthorityRead({ activeMemberCount: 0 }, { actorIsMember: false });
        const snapshot = toPolicySnapshot(read, { ...base.group, groupId: 'pure-room' }, 1_000);

        expect(snapshot.members).toEqual([]);
        expect(snapshot.memberCount).toBe(0);
        expect(snapshot.onlineMemberCount).toBe(0);
    });
});
