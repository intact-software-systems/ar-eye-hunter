import { projectGroupLobbyOccupancy } from '@shared-server/rallar-system/group-state/directory/compute-group-directory-page.ts';
import { changeRoomLobby, createRoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { configureRoomLobbyCapacityClaims } from '@shared/api/room-lobbies/room-lobby-allocation.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import { expect, it } from 'vitest';

import { createGroupSnapshot } from '../snapshot/group-state-snapshot-test-fixtures.ts';

it('keeps queued vacancies occupied across the exact deadline, including scheduled seats', () => {
    const snapshot = createGroupSnapshot(1, []);
    const initial = createRoomLobby({ roomRef: toCanonicalGroupRef(snapshot.group), capacity: 1, policy: { claimWindowMs: 30, returnWindowMs: 60 }, activationId: 'first' });
    const reserved = configureRoomLobbyCapacityClaims(initial, { principalIds: ['player'], dueAtEpochMs: 60 }, 0).lobby;
    const waiting = changeRoomLobby(reserved, { kind: 'wait', principalId: 'next', eligibleUntilEpochMs: null }, 1).lobby;
    expect(projectGroupLobbyOccupancy(snapshot, waiting, 59)).toEqual({ playerCount: 1, onlinePlayerCount: 0 });
    expect(projectGroupLobbyOccupancy(snapshot, waiting, 60)).toEqual({ playerCount: 1, onlinePlayerCount: 0 });
    expect(projectGroupLobbyOccupancy(snapshot, reserved, 60)).toEqual({ playerCount: 0, onlinePlayerCount: 0 });
});
