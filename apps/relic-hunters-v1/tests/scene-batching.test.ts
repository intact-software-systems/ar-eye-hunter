import { describe, expect, it } from 'vitest';
import { roomStaticBatchKey, summarizeRoomStaticBatchPlan } from '../src/game/scene/sceneBatching.ts';

describe('scene static mesh batching', () => {
    it('groups fully visible non-interactive meshes by material key', () => {
        expect(roomStaticBatchKey({
            materialKey: 'stone',
            visibility: 1,
            metadata: { roomId: 'entrance' }
        })).toBe('stone');
    });

    it('keeps clue and resolved markers out of static batches', () => {
        expect(roomStaticBatchKey({
            materialKey: 'gold',
            metadata: { roomId: 'shrine', clueHotspotId: 'altar' }
        })).toBeUndefined();
        expect(roomStaticBatchKey({
            materialKey: 'portal',
            metadata: { roomId: 'exit', resolvedOnly: true }
        })).toBeUndefined();
    });

    it('summarizes only material groups large enough to merge', () => {
        expect(summarizeRoomStaticBatchPlan([
            { materialKey: 'stone', metadata: { roomId: 'a' } },
            { materialKey: 'stone', metadata: { roomId: 'a' } },
            { materialKey: 'wood', metadata: { roomId: 'a' } },
            { materialKey: 'gold', metadata: { roomId: 'a', primeAction: 'search' } },
            { materialKey: 'paper', visibility: 0.72, metadata: { roomId: 'a' } }
        ])).toEqual({
            batchCount: 1,
            batchedMeshCount: 2,
            unbatchedMeshCount: 3
        });
    });
});
