import { canActivateGroupMember, canJoinGroup } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import {
    createRallarGroupDirectorAppointment,
    isRallarGroupDirectorSessionActive,
    resolveRallarGroupDirectorAppointmentEligibility
} from '@shared/api/group-director.ts';
import { readGroupSpectatorCapacity } from '@shared/api/group-spectating.ts';
import { describe, expect, it } from 'vitest';
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
