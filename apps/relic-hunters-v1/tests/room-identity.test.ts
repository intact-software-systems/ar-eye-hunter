import { describe, expect, it } from 'vitest';
import {
    allRoomIdentities,
    roomIdentityForKind,
    ROOM_KIND_ORDER,
} from '../src/game/scene/roomIdentity.ts';

describe('room identity mapping', () => {
    it('maps every public room kind to one visual identity', () => {
        expect(ROOM_KIND_ORDER).toEqual([
            'entrance',
            'hallway',
            'storage',
            'shrine',
            'trap',
            'treasure',
            'monster',
            'exit',
        ]);
        expect(allRoomIdentities()).toHaveLength(ROOM_KIND_ORDER.length);
    });

    it('keeps the planned Japanese castle role for each room kind', () => {
        expect(roomIdentityForKind('entrance')).toMatchObject({
            castleRole: 'Gatehouse / front gate',
            silhouette: 'gatehouse',
        });
        expect(roomIdentityForKind('storage')).toMatchObject({
            castleRole: 'Armory / storage room',
            silhouette: 'armory-storage',
        });
        expect(roomIdentityForKind('trap')).toMatchObject({
            castleRole: 'Secret passage / jail-cell trap room',
            silhouette: 'secret-cell',
        });
        expect(roomIdentityForKind('exit')).toMatchObject({
            castleRole: 'Watch tower / garden gate',
            silhouette: 'garden-watchtower',
        });
    });

    it('uses unique silhouettes so rooms can be read before the HUD label', () => {
        const silhouettes = allRoomIdentities().map((identity) => identity.silhouette);

        expect(new Set(silhouettes).size).toBe(silhouettes.length);
    });

    it('does not encode hidden relic spoilers in identity landmarks', () => {
        for (const identity of allRoomIdentities()) {
            expect(identity.landmark.toLowerCase()).not.toContain('relic');
            expect(identity.landmark.toLowerCase()).not.toContain('idol');
        }
    });
});
