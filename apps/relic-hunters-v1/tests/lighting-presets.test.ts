import { describe, expect, it } from 'vitest';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import {
    RELIC_LIGHTING_PRESETS,
    RELIC_ROOM_LIGHTING_PRESETS,
    selectRelicLightingPreset,
} from '../src/game/scene/lightingPresets.ts';

describe('lighting presets', () => {
    it('maps exterior, interior, danger, and exit rooms to distinct presets', () => {
        expect(RELIC_ROOM_LIGHTING_PRESETS.entrance).toBe('day');
        expect(RELIC_ROOM_LIGHTING_PRESETS.hallway).toBe('lantern');
        expect(RELIC_ROOM_LIGHTING_PRESETS.storage).toBe('lantern');
        expect(RELIC_ROOM_LIGHTING_PRESETS.shrine).toBe('lantern');
        expect(RELIC_ROOM_LIGHTING_PRESETS.trap).toBe('lantern');
        expect(RELIC_ROOM_LIGHTING_PRESETS.treasure).toBe('lantern');
        expect(RELIC_ROOM_LIGHTING_PRESETS.monster).toBe('night');
        expect(RELIC_ROOM_LIGHTING_PRESETS.exit).toBe('sunset');
    });

    it('uses day for opening/lobby, room presets for planning, and sunset for finished', () => {
        expect(selectRelicLightingPreset({ snapshot: undefined, currentRoom: undefined }).id).toBe('day');
        expect(selectRelicLightingPreset({
            snapshot: snapshot('lobby'),
            currentRoom: room('monster', 'monster'),
        }).id).toBe('day');
        expect(selectRelicLightingPreset({
            snapshot: snapshot('planning'),
            currentRoom: room('storage', 'storage'),
        }).id).toBe('lantern');
        expect(selectRelicLightingPreset({
            snapshot: snapshot('planning'),
            currentRoom: room('monster', 'monster'),
        }).id).toBe('night');
        expect(selectRelicLightingPreset({
            snapshot: snapshot('finished'),
            currentRoom: room('storage', 'storage'),
        }).id).toBe('sunset');
    });

    it('keeps every preset readable with modest fog, bounded vignette, and contact shadows', () => {
        for (const preset of Object.values(RELIC_LIGHTING_PRESETS)) {
            expect(preset.fogDensity).toBeLessThanOrEqual(0.006);
            expect(preset.postProcess.exposure).toBeGreaterThanOrEqual(1.1);
            expect(preset.postProcess.vignetteWeight).toBeLessThanOrEqual(1.1);
            expect(preset.shadowDarkness).toBeLessThanOrEqual(0.34);
            expect(preset.shadowBlurKernel).toBeLessThanOrEqual(4);
        }
    });
});

function snapshot(phase: RelicPublicSnapshot['phase']): RelicPublicSnapshot {
    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase,
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: Date.now(),
        map: [room('entrance', 'entrance')],
        relics: [],
        roomInvestigations: [],
        players: [],
        submittedPlayerIds: [],
        events: [],
        winnerIds: [],
    };
}

function room(id: string, kind: RelicRoom['kind']): RelicRoom {
    return {
        id,
        name: id,
        kind,
        x: 0,
        z: 0,
        neighbors: [],
    };
}
