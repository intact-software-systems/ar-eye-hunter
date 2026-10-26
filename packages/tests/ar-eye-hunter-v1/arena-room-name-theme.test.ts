import { createRallarAiFunnyRoomName } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

import { ARENA_ROOM_NAME_THEME } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/actions/arena-room-name-theme.ts';

describe('Arena room name theme', () => {
    it('preserves the arena base phrase and seeded vocabulary', () => {
        expect(createRallarAiFunnyRoomName({
            baseName: '',
            theme: ARENA_ROOM_NAME_THEME,
            seed: 'fixed-seed'
        })).toBe('AR Eye Hunter Arena: Hyper Reticle #0B5270');
    });
});
