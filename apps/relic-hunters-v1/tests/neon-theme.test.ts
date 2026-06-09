import { describe, expect, it } from 'vitest';
import type { RelicRoom } from '@relic-hunters/mod.ts';
import { RELIC_NEON_THEME, relicNeonAccentForRoom } from '../src/game/scene/neonTheme.ts';

describe('Relic neon theme', () => {
    it('uses bright neon accents for every room kind', () => {
        for (const kind of [
            'entrance',
            'hallway',
            'storage',
            'shrine',
            'trap',
            'treasure',
            'monster',
            'exit',
        ] as const) {
            const accent = relicNeonAccentForRoom(room(kind));

            expect(Object.values(RELIC_NEON_THEME)).toContain(accent.emissive);
            expect(Object.values(RELIC_NEON_THEME)).toContain(accent.secondary);
            expect(accent.base).not.toBe('#000000');
        }
    });

    it('keeps unstable and collapsed rooms readable without switching to black', () => {
        expect(relicNeonAccentForRoom({ ...room('trap'), unstable: true })).toMatchObject({
            emissive: RELIC_NEON_THEME.coral,
            secondary: RELIC_NEON_THEME.magenta,
        });
        expect(relicNeonAccentForRoom({ ...room('hallway'), collapsed: true })).toMatchObject({
            emissive: RELIC_NEON_THEME.coral,
            secondary: RELIC_NEON_THEME.amber,
        });
    });

    it('uses grim graphite surfaces with bright accents instead of a pale wash', () => {
        for (const color of [
            RELIC_NEON_THEME.graphite,
            RELIC_NEON_THEME.graphiteLift,
            RELIC_NEON_THEME.floor,
            RELIC_NEON_THEME.floorPanel,
            RELIC_NEON_THEME.shadow,
        ]) {
            expect(relativeLuminance(color)).toBeLessThan(0.18);
        }
        for (const color of [
            RELIC_NEON_THEME.cyan,
            RELIC_NEON_THEME.cyanSoft,
            RELIC_NEON_THEME.magenta,
            RELIC_NEON_THEME.amber,
            RELIC_NEON_THEME.green,
            RELIC_NEON_THEME.white,
        ]) {
            expect(relativeLuminance(color)).toBeGreaterThan(0.25);
        }
    });
});

function room(kind: RelicRoom['kind']): Pick<RelicRoom, 'kind' | 'collapsed' | 'unstable'> {
    return {
        kind,
        collapsed: false,
        unstable: false,
    };
}

function relativeLuminance(hex: string): number {
    const value = hex.replace('#', '');
    const r = Number.parseInt(value.slice(0, 2), 16) / 255;
    const g = Number.parseInt(value.slice(2, 4), 16) / 255;
    const b = Number.parseInt(value.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
