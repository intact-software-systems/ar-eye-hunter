import { describe, expect, it } from 'vitest';

import { decodeRelicScenePick } from '../../../apps/relic-hunters-v1/src/game/scene/neon/decode-relic-scene-pick.ts';

describe('Relic scene pick metadata', () => {
    it('gives relic pickup priority over search and room selection', () => {
        expect(decodeRelicScenePick({ relicId: 'relic-1', primeAction: 'search', roomId: 'room-1' }))
            .toEqual({ kind: 'pickup', relicId: 'relic-1' });
        expect(decodeRelicScenePick({ primeAction: 'search', roomId: 'room-1' }))
            .toEqual({ kind: 'search' });
        expect(decodeRelicScenePick({ roomId: 'room-1', decoration: true }))
            .toEqual({ kind: 'room', roomId: 'room-1' });
    });

    it('ignores unusable metadata and admits only checked target identities', () => {
        for (const metadata of [undefined, null, false, 17, 'room-1', [], {}, { relicId: 1 }, { roomId: false }, { primeAction: 'move' }]) {
            expect(decodeRelicScenePick(metadata)).toBeNull();
        }
        expect(decodeRelicScenePick({ relicId: 17, primeAction: 'search' })).toEqual({ kind: 'search' });
        expect(decodeRelicScenePick({ primeAction: 'move', roomId: 'room-2' }))
            .toEqual({ kind: 'room', roomId: 'room-2' });
    });
});
