import { createRallarAiFunnyRoomName } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

import { RELIC_ROOM_NAME_THEME } from '../src/game/relic-hunters-runtime.ts';

describe('Relic room name theme', () => {
    it('preserves the expedition base phrase and seeded vocabulary', () => {
        expect(createRallarAiFunnyRoomName({
            baseName: '',
            theme: RELIC_ROOM_NAME_THEME,
            seed: 'fixed-seed'
        })).toBe('Relic Hunters Expedition: Laser Teacup #739CF8');
    });
});
