// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { initialTownHostPolicy, townHostCommand } from '../../../apps/cca-2d/src/match/town-host-succession.ts';
import { changeRoomDirectorSuccession } from '@shared/api/room-directors/change-room-director-succession.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { townGroupPresence } from '../../../apps/cca-2d/src/online/town-server.ts';
import { canIssueGroupPresenceLease } from '@shared-web/browser/session/group-presence-policy.ts';

it('keeps room renewals eligible when a clock sample spans the observed 3.2-second server stall', () => {
    expect(canIssueGroupPresenceLease(townGroupPresence, 3_200)).toBe(true);
    expect(canIssueGroupPresenceLease(townGroupPresence, townGroupPresence.leaseMs)).toBe(false);
});

it('lets a survivor claim a silent host inside the 11.5-second recovery budget, with time left to resume', () => {
    let room = createGroupSnapshotFixture({ applicationId: 'cca-2d', workspaceId: 'test', groupId: 'market', sessionIds: ['owner', 'friend'] });
    room = { ...room, activeSessions: room.activeSessions.map(session => ({
        ...session, expiresAtEpochMs: session.sessionId === 'owner' ? townGroupPresence.leaseMs : 30_000
    })) };
    const owner = { principalId: 'owner', sessionId: 'owner', role: 'owner' as const };
    for (const command of [initialTownHostPolicy, townHostCommand(room.group.metadata, owner, () => 'before')!]) {
        const result = changeRoomDirectorSuccession({ snapshot: room, actor: owner, command, nowEpochMs: 0 });
        if (!('metadata' in result)) throw new Error(result.message);
        room = { ...room, group: { ...room.group, metadata: result.metadata } };
    }
    const now = 9_500;
    const friend = { principalId: 'friend', sessionId: 'friend', role: 'member' as const };
    expect(townHostCommand(room.group.metadata, friend, deadline => deadline <= 3_200 ? 'at-or-after' : 'before')).toBeUndefined();
    const claim = townHostCommand(room.group.metadata, friend, deadline => deadline <= now ? 'at-or-after' : 'before');
    expect(claim?.operation).toBe('claim-player');
    expect(changeRoomDirectorSuccession({ snapshot: room, actor: friend, command: claim!, nowEpochMs: now })).toHaveProperty('metadata');
});
