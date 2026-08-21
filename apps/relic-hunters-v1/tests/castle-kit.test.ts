import { describe, expect, it } from 'vitest';
import { planCastleWallSegments } from '../src/game/scene/castleKit.ts';

describe('castle kit room shell planning', () => {
    it('plans one full wall segment when there is no doorway', () => {
        const segments = planCastleWallSegments({
            direction: 'north',
            hasDoor: false,
            roomSize: 22.2,
            wallThickness: 0.38,
            doorWidth: 6.3
        });

        expect(segments).toEqual([{
            name: 'north-full',
            direction: 'north',
            hasDoor: false,
            position: { x: 0, z: -11.1 },
            size: { width: 22.58, depth: 0.38 }
        }]);
    });

    it('splits doorway walls into stable left and right segments', () => {
        const segments = planCastleWallSegments({
            direction: 'east',
            hasDoor: true,
            roomSize: 22.2,
            wallThickness: 0.38,
            doorWidth: 6.3
        });

        expect(segments).toEqual([
            {
                name: 'east-left',
                direction: 'east',
                hasDoor: true,
                position: { x: 11.1, z: -7.125 },
                size: { width: 0.38, depth: 7.949999999999999 }
            },
            {
                name: 'east-right',
                direction: 'east',
                hasDoor: true,
                position: { x: 11.1, z: 7.125 },
                size: { width: 0.38, depth: 7.949999999999999 }
            }
        ]);
    });

    it('keeps opposite wall directions mirrored on the same axis', () => {
        const west = planCastleWallSegments({
            direction: 'west',
            hasDoor: false,
            roomSize: 22.2,
            wallThickness: 0.38,
            doorWidth: 6.3
        });
        const south = planCastleWallSegments({
            direction: 'south',
            hasDoor: false,
            roomSize: 22.2,
            wallThickness: 0.38,
            doorWidth: 6.3
        });

        expect(west[0]?.position).toEqual({ x: -11.1, z: 0 });
        expect(south[0]?.position).toEqual({ x: 0, z: 11.1 });
    });
});
