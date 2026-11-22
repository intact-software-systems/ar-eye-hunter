import { projectRoomLobbyOccupancy } from '@shared-server/rallar-system/group-state/directory/compute-group-directory-page.ts';
import { changeRoomLobby, configureRoomLobbyCapacityClaims, createRoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import { expect, it } from 'vitest';

import { createGroupSnapshot } from '../snapshot/group-state-snapshot-test-fixtures.ts';

it('keeps queued vacancies occupied across the exact deadline, including scheduled seats', () => {
    const snapshot = createGroupSnapshot(1, []);
    const initial = createRoomLobby(toCanonicalGroupRef(snapshot.group), 1, { claimWindowMs: 30, returnWindowMs: 60 }, 'first');
    const reserved = configureRoomLobbyCapacityClaims(initial, { principalIds: ['player'], dueAtEpochMs: 60 }, 0).lobby;
    const waiting = changeRoomLobby(reserved, { kind: 'wait', principalId: 'next', eligibleUntilEpochMs: null }, 1).lobby;
    expect(projectRoomLobbyOccupancy(snapshot, waiting, 59)).toEqual({ playerCount: 1, onlinePlayerCount: 0 });
    expect(projectRoomLobbyOccupancy(snapshot, waiting, 60)).toEqual({ playerCount: 1, onlinePlayerCount: 0 });
    expect(projectRoomLobbyOccupancy(snapshot, reserved, 60)).toEqual({ playerCount: 0, onlinePlayerCount: 0 });
});
