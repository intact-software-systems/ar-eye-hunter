import { expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../../../../shared-web/authoritative-group-fixtures.ts';
import { computeGroupClockUpdate } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-group-clock-update.ts';
import { roomGuestCredentialExpiresAt, roomGuestAccessMode } from '@shared/api/room-guests/access.ts';

it.each([
    { extension: 200, cutoff: 1500 },
    { extension: 86_400_000, cutoff: 3_604_000 }
])('pins a participant to the bounded deadline across extensions, takeover and rollover ($extension ms)', ({ extension, cutoff }) => {
    const snapshot = createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'ws', groupId: 'town', sessionIds: ['bob-session'] });
    const member = { ...snapshot.members[0], guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 1000 } };
    const start = { operation: 'advance-phase', phase: 'playing', name: 'guest-play', expectedRevision: 0, expectedDirectorEpoch: 1,
        durationMs: 800, participantPrincipalIds: [member.principalId] } as const;
    const initial = computeGroupClockUpdate({ group: snapshot.group, command: start, now: 500, members: [member] });
    if ('rejectionCode' in initial) throw new Error(initial.message);
    const extend = { operation: 'extend-phase', name: 'guest-play', expectedRevision: 1, expectedDirectorEpoch: 1, durationMs: extension } as const;
    const beforeExpiry = computeGroupClockUpdate({ group: initial, command: extend, now: 900, members: [member] });
    if ('rejectionCode' in beforeExpiry) throw new Error(beforeExpiry.message);
    const afterExpiry = computeGroupClockUpdate({ group: beforeExpiry, command: { ...extend, expectedRevision: 2, expectedDirectorEpoch: 2 }, now: 1000, members: [member] });
    if ('rejectionCode' in afterExpiry) throw new Error(afterExpiry.message);
    expect(roomGuestCredentialExpiresAt(afterExpiry, member)).toBe(cutoff);
    expect(roomGuestAccessMode(afterExpiry, member, 999)).toBe('room');
    expect(roomGuestAccessMode(afterExpiry, member, cutoff - 1)).toBe('finish-round');
    expect(roomGuestAccessMode(afterExpiry, member, cutoff)).toBe('expired');
    expect(roomGuestAccessMode(afterExpiry, { ...member, principalId: 'observer' }, 1000)).toBe('expired');
    const finished = computeGroupClockUpdate({ group: afterExpiry, command: { ...start, phase: 'results', participantPrincipalIds: [], expectedRevision: 3 }, now: 1100, members: [member] });
    if ('rejectionCode' in finished) throw new Error(finished.message);
    expect(roomGuestCredentialExpiresAt(finished, member)).toBe(1000);
    expect(roomGuestAccessMode(finished, member, 1100)).toBe('expired');
});

it('restores a paused occurrence after restart without giving it a later cutoff on resume', () => {
    const snapshot = createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'ws', groupId: 'town', sessionIds: ['bob-session'] });
    const member = { ...snapshot.members[0], guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 1000 } };
    const start = { name: 'guest-play', operation: 'advance-phase', phase: 'round-one', expectedRevision: 0,
        expectedDirectorEpoch: 1, durationMs: 800, participantPrincipalIds: [member.principalId] } as const;
    const initial = computeGroupClockUpdate({ group: snapshot.group, command: start, now: 500, members: [member] });
    if ('rejectionCode' in initial) throw new Error(initial.message);
    const paused = computeGroupClockUpdate({ group: initial, command: { name: 'guest-play', operation: 'pause', expectedRevision: 1, expectedDirectorEpoch: 1 }, now: 800 });
    if ('rejectionCode' in paused) throw new Error(paused.message);
    const resumed = computeGroupClockUpdate({ group: structuredClone(paused), command: {
        name: 'guest-play', operation: 'resume', expectedRevision: 2, expectedDirectorEpoch: 2
    }, now: 1100 });
    if ('rejectionCode' in resumed) throw new Error(resumed.message);
    expect(roomGuestAccessMode(resumed, member, 1299)).toBe('finish-round');
    expect(roomGuestAccessMode(resumed, member, 1300)).toBe('expired');
    expect(computeGroupClockUpdate({ group: resumed, command: { ...start, phase: 'second', expectedRevision: 3 }, now: 1100, members: [member] })).toHaveProperty('rejectionCode');
});

it('a finishing guest director may only close the guest occurrence with an empty successor roster', async () => {
    const { closesGuestPlayOccurrence } = await import('@shared/api/room-guests/access.ts');
    const end = { operation: 'advance-phase', phase: 'results', name: 'guest-play', expectedRevision: 4,
        expectedDirectorEpoch: 2, durationMs: 1 } as const;
    expect(closesGuestPlayOccurrence(end)).toBe(true);
    expect(closesGuestPlayOccurrence({ ...end, participantPrincipalIds: ['guest-bob'] })).toBe(false);
    expect(closesGuestPlayOccurrence({ ...end, successor: { phase: 'next-round', durationMs: 10000 } })).toBe(false);
    expect(closesGuestPlayOccurrence({ ...end, name: 'other' })).toBe(false);
    expect(closesGuestPlayOccurrence({ ...end, operation: 'extend-phase' })).toBe(false);
});
