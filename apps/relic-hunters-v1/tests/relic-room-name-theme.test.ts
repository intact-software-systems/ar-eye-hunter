import { describe, expect, it } from 'vitest';

import { createRelicRoomName } from '../src/game/runtime/create-relic-room-name.ts';

describe('Relic room names', () => {
    it('preserves the expedition base phrase and seeded vocabulary', () => {
        expect(createRelicRoomName('fixed-seed', [])).toBe('Relic Hunters Expedition: Laser Teacup #739CF8');
    });
});
