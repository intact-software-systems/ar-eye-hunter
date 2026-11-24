import { describe, expect, it } from 'vitest';
import { townHostCommand } from '../../../apps/cca-2d/src/match/town-host-succession.ts';
import { mergeRallarGroupDirectorMetadata, createRallarGroupDirectorAppointment } from '../../shared/api/group-director.ts';
import { storeRoomDirectorSuccession } from '../../shared/api/room-directors/room-director-succession-record.ts';

const player = { principalId: 'guest', sessionId: 'guest-session', role: 'member' as const };
const appointment = createRallarGroupDirectorAppointment({ session: { clientId: 'owner', sessionId: 'owner-session' }, now: 100 });
const metadata = storeRoomDirectorSuccession(mergeRallarGroupDirectorMetadata({}, appointment), {
    revision: 0, reconnectWindowMs: 30, deputyWindowMs: 10, deputyPrincipalId: 'deputy', spectatorDirectorEpoch: null,
    directorLeaseExpiresAtEpochMs: 200, loss: null
});
const clock = (now: number) => (deadline: number) => now >= deadline ? 'at-or-after' as const : 'before' as const;

describe('town host succession', () => {
    it('starts a new match under its organizer and preserves the room owner after a guest claims the next epoch', () => {
        expect(townHostCommand({}, player, clock(100))).toBeUndefined();
        expect(townHostCommand({}, { ...player, role: 'owner' }, clock(100))).toEqual({
            operation: 'appoint', expectedDirectorEpoch: 0, targetPrincipalId: player.principalId, targetSessionId: player.sessionId
        });
        expect(townHostCommand(metadata, player, clock(229))).toBeUndefined();
        expect(townHostCommand(metadata, player, clock(230))).toBeUndefined();
        expect(townHostCommand(metadata, { ...player, principalId: 'deputy' }, clock(230))).toEqual({
            operation: 'claim-deputy', expectedDirectorEpoch: appointment.epoch
        });
        expect(townHostCommand(metadata, player, clock(240))).toEqual({ operation: 'claim-player', expectedDirectorEpoch: appointment.epoch });
        expect(townHostCommand(metadata, player, () => 'overlaps')).toBeUndefined();
    });
});
