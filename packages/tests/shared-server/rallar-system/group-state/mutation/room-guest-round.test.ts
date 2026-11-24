import { expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../../../../shared-web/authoritative-group-fixtures.ts';
import { computeGroupClockUpdate } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-group-clock-change.ts';
import { roomGuestAccessMode } from '@shared/api/room-guest-access.ts';

it('pins an admitted participant to the deadline in effect at lease expiry, across extensions and host takeover', () => {
    const snapshot = createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'ws', groupId: 'town', sessionIds: ['bob-session'] });
    const member = { ...snapshot.members[0], guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 1000 } };
    const start = { operation: 'advance-phase', phase: 'playing', name: 'guest-play', expectedRevision: 0, expectedDirectorEpoch: 1,
        durationMs: 800, participantPrincipalIds: [member.principalId] } as const;
    const initial = computeGroupClockUpdate(snapshot.group, start, 500, [member]);
    if ('rejectionCode' in initial) throw new Error(initial.message);
    const extend = { operation: 'extend-phase', name: 'guest-play', expectedRevision: 1, expectedDirectorEpoch: 1, durationMs: 200 } as const;
    const beforeExpiry = computeGroupClockUpdate(initial, extend, 900, [member]);
    if ('rejectionCode' in beforeExpiry) throw new Error(beforeExpiry.message);
    const afterExpiry = computeGroupClockUpdate(beforeExpiry, { ...extend, expectedRevision: 2, expectedDirectorEpoch: 2 }, 1000, [member]);
    if ('rejectionCode' in afterExpiry) throw new Error(afterExpiry.message);
    expect(roomGuestAccessMode(afterExpiry, member, 999)).toBe('room');
    expect(roomGuestAccessMode(afterExpiry, member, 1499)).toBe('finish-round');
    expect(roomGuestAccessMode(afterExpiry, member, 1500)).toBe('expired');
    expect(roomGuestAccessMode(afterExpiry, { ...member, principalId: 'observer' }, 1000)).toBe('expired');
    const finished = computeGroupClockUpdate(afterExpiry, { ...start, phase: 'results', participantPrincipalIds: [], expectedRevision: 3 }, 1100, [member]);
    if ('rejectionCode' in finished) throw new Error(finished.message);
    expect(roomGuestAccessMode(finished, member, 1100)).toBe('expired');
});

it('restores a paused occurrence after restart without giving it a later cutoff on resume', () => {
    const snapshot = createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'ws', groupId: 'town', sessionIds: ['bob-session'] });
    const member = { ...snapshot.members[0], guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 1000 } };
    const start = { name: 'guest-play', operation: 'advance-phase', phase: 'round-one', expectedRevision: 0,
        expectedDirectorEpoch: 1, durationMs: 800, participantPrincipalIds: [member.principalId] } as const;
    const initial = computeGroupClockUpdate(snapshot.group, start, 500, [member]);
    if ('rejectionCode' in initial) throw new Error(initial.message);
    const paused = computeGroupClockUpdate(initial, { name: 'guest-play', operation: 'pause', expectedRevision: 1, expectedDirectorEpoch: 1 }, 800);
    if ('rejectionCode' in paused) throw new Error(paused.message);
    const resumed = computeGroupClockUpdate(structuredClone(paused), {
        name: 'guest-play', operation: 'resume', expectedRevision: 2, expectedDirectorEpoch: 2
    }, 1100);
    if ('rejectionCode' in resumed) throw new Error(resumed.message);
    expect(roomGuestAccessMode(resumed, member, 1299)).toBe('finish-round');
    expect(roomGuestAccessMode(resumed, member, 1300)).toBe('expired');
    expect(computeGroupClockUpdate(resumed, { ...start, phase: 'second', expectedRevision: 3 }, 1100, [member])).toHaveProperty('rejectionCode');
});
