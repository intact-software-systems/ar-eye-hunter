import type { RelicRoom } from '@relic-hunters/mod.ts';

export const RELIC_NEON_THEME = {
    graphite: '#07111f',
    graphiteLift: '#102236',
    graphiteLight: '#1f3a52',
    floor: '#0b1624',
    floorPanel: '#13283b',
    cyan: '#00e5ff',
    cyanSoft: '#7df9ff',
    magenta: '#ff3df2',
    violet: '#8b5cf6',
    amber: '#facc15',
    green: '#39ff88',
    coral: '#ff5c7a',
    white: '#f8fdff',
    glass: '#67e8f9',
    shadow: '#040915'
} as const;

export type RelicNeonAccent = Readonly<{
    base: string;
    emissive: string;
    secondary: string;
}>;

export function relicNeonAccentForRoom(room: Pick<RelicRoom, 'kind' | 'collapsed' | 'unstable'>): RelicNeonAccent {
    if (room.collapsed) {
        return {
            base: RELIC_NEON_THEME.graphiteLight,
            emissive: RELIC_NEON_THEME.coral,
            secondary: RELIC_NEON_THEME.amber
        };
    }
    if (room.unstable) {
        return {
            base: '#241525',
            emissive: RELIC_NEON_THEME.coral,
            secondary: RELIC_NEON_THEME.magenta
        };
    }

    switch (room.kind) {
        case 'entrance':
            return neonAccent(RELIC_NEON_THEME.cyan, RELIC_NEON_THEME.green);
        case 'hallway':
            return neonAccent(RELIC_NEON_THEME.cyanSoft, RELIC_NEON_THEME.violet);
        case 'storage':
            return neonAccent(RELIC_NEON_THEME.amber, RELIC_NEON_THEME.cyan);
        case 'shrine':
            return neonAccent(RELIC_NEON_THEME.violet, RELIC_NEON_THEME.magenta);
        case 'trap':
            return neonAccent(RELIC_NEON_THEME.coral, RELIC_NEON_THEME.amber);
        case 'treasure':
            return neonAccent(RELIC_NEON_THEME.green, RELIC_NEON_THEME.amber);
        case 'monster':
            return neonAccent(RELIC_NEON_THEME.magenta, RELIC_NEON_THEME.coral);
        case 'exit':
            return neonAccent(RELIC_NEON_THEME.green, RELIC_NEON_THEME.cyanSoft);
    }
}

function neonAccent(emissive: string, secondary: string): RelicNeonAccent {
    return {
        base: RELIC_NEON_THEME.floor,
        emissive,
        secondary
    };
}
