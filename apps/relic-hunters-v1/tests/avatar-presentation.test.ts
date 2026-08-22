import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import { AVATAR_ARRIVAL_SETTLE_MS, avatarPoseOffsets, deriveRelicAvatarPresentation } from '../src/game/scene/avatarPresentation.ts';

describe('avatar presentation', () => {
    it('uses faster arrival timing for snappier hunters', () => {
        expect(AVATAR_ARRIVAL_SETTLE_MS).toBe(420);
    });

    it('keeps lobby hunters visible and neutral', () => {
        expect(deriveRelicAvatarPresentation({
            phase: 'lobby',
            player: player(),
            submittedPlayerIds: ['alice-session'],
            isMoving: true
        })).toMatchObject({
            status: 'lobby',
            visible: true,
            opacity: 1,
            emissiveRole: 'idle'
        });
    });

    it('prioritizes defeated and escaped states over planning activity', () => {
        expect(deriveRelicAvatarPresentation({
            phase: 'planning',
            player: player({ defeated: true }),
            submittedPlayerIds: ['alice-session'],
            isMoving: true
        })).toMatchObject({
            status: 'defeated',
            visible: true,
            opacity: 0.48,
            emissiveRole: 'defeated'
        });

        expect(deriveRelicAvatarPresentation({
            phase: 'planning',
            player: player({ escaped: true }),
            submittedPlayerIds: ['alice-session'],
            isMoving: true
        })).toMatchObject({
            status: 'escaped',
            visible: true,
            opacity: 0.56,
            emissiveRole: 'escaped'
        });
    });

    it('uses locked, moving, arriving, and idle states for active hunters', () => {
        expect(
            deriveRelicAvatarPresentation({
                phase: 'planning',
                player: player(),
                submittedPlayerIds: ['alice-session'],
                isMoving: true
            }).status
        ).toBe('locked');

        expect(
            deriveRelicAvatarPresentation({
                phase: 'planning',
                player: player(),
                submittedPlayerIds: [],
                isMoving: true
            }).status
        ).toBe('moving');

        expect(
            deriveRelicAvatarPresentation({
                phase: 'planning',
                player: player(),
                submittedPlayerIds: [],
                isMoving: false,
                lastMovedAgoMs: AVATAR_ARRIVAL_SETTLE_MS - 1
            }).status
        ).toBe('arriving');

        expect(
            deriveRelicAvatarPresentation({
                phase: 'planning',
                player: player(),
                submittedPlayerIds: [],
                isMoving: false,
                lastMovedAgoMs: AVATAR_ARRIVAL_SETTLE_MS
            }).status
        ).toBe('idle');
    });

    it('returns larger motion offsets while moving and downed offsets when defeated', () => {
        const moving = avatarPoseOffsets({
            presentation: deriveRelicAvatarPresentation({
                phase: 'planning',
                player: player(),
                submittedPlayerIds: [],
                isMoving: true
            }),
            nowMs: 125
        });
        expect(moving.yOffset).toBeGreaterThan(0.04);
        expect(moving.pitch).toBeLessThanOrEqual(-0.16);
        expect(Math.abs(moving.roll)).toBeGreaterThan(0.04);

        const defeated = avatarPoseOffsets({
            presentation: deriveRelicAvatarPresentation({
                phase: 'planning',
                player: player({ defeated: true }),
                submittedPlayerIds: [],
                isMoving: false
            }),
            nowMs: 250
        });
        expect(defeated.yOffset).toBeLessThan(0);
        expect(defeated.scaleY).toBeLessThan(1);
    });
});

function player(
    overrides: Partial<Pick<RelicPublicSnapshot['players'][number], 'escaped' | 'defeated'>> = {}
): Pick<RelicPublicSnapshot['players'][number], 'playerId' | 'escaped' | 'defeated'> {
    return {
        playerId: 'alice-session',
        escaped: false,
        defeated: false,
        ...overrides
    };
}
