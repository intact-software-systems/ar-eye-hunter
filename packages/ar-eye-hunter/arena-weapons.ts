import {
    type PlayerLoadoutState,
    type WeaponKind,
    type WeaponStats
} from './arena-contracts.ts';

export const DEFAULT_WEAPON_KIND: WeaponKind = 'pulse-rifle';

export const WEAPON_STATS: Record<WeaponKind, WeaponStats> = {
    'pulse-rifle': {
        kind: 'pulse-rifle',
        label: 'Pulse Rifle',
        tier: 1,
        damage: 24,
        cooldownMs: 120,
        range: 138,
        spreadRadians: 0.012,
        rays: 1,
        knockback: 0.4,
        flavor: 'honest work, suspiciously glowing'
    },
    'spread-shot': {
        kind: 'spread-shot',
        label: 'Spread Shot',
        tier: 2,
        damage: 16,
        cooldownMs: 185,
        range: 87,
        spreadRadians: 0.095,
        rays: 5,
        knockback: 0.65,
        flavor: 'performance review in cone form'
    },
    'rail-lance': {
        kind: 'rail-lance',
        label: 'Rail Lance',
        tier: 3,
        damage: 46,
        cooldownMs: 420,
        range: 195,
        spreadRadians: 0.002,
        rays: 1,
        knockback: 1.1,
        flavor: 'one line item, many regrets'
    },
    'glitch-blaster': {
        kind: 'glitch-blaster',
        label: 'Glitch Blaster',
        tier: 3,
        damage: 32,
        cooldownMs: 210,
        range: 114,
        spreadRadians: 0.045,
        rays: 2,
        knockback: 0.9,
        flavor: 'undefined behavior, but marketable'
    },
    'audit-pea-shooter': {
        kind: 'audit-pea-shooter',
        label: 'Audit Pea Shooter',
        tier: 0,
        damage: 9,
        cooldownMs: 95,
        range: 81,
        spreadRadians: 0.08,
        rays: 1,
        knockback: 0.12,
        flavor: 'downgrade complete, morale retained'
    },
    'confetti-cannon': {
        kind: 'confetti-cannon',
        label: 'Confetti Cannon',
        tier: 2,
        damage: 18,
        cooldownMs: 155,
        range: 72,
        spreadRadians: 0.14,
        rays: 7,
        knockback: 0.35,
        flavor: 'mandatory fun, ballistic edition'
    }
};

export function createInitialLoadoutState(): PlayerLoadoutState {
    return {
        weaponKind: DEFAULT_WEAPON_KIND,
        tier: WEAPON_STATS[DEFAULT_WEAPON_KIND].tier
    };
}

export function getWeaponStats(kind: WeaponKind): WeaponStats {
    return WEAPON_STATS[kind] ?? WEAPON_STATS[DEFAULT_WEAPON_KIND];
}
