import type { RelicActionKind, RelicCharacterId } from './model.ts';
import { RELIC_CHARACTER_IDS } from './model.ts';

export type RelicCharacterSilhouette =
    | 'vanguard'
    | 'scout'
    | 'scholar'
    | 'trapbreaker'
    | 'duelist'
    | 'trickster'
    | 'bulwark'
    | 'seer'
    | 'hexblade'
    | 'stormrunner';

export type RelicCharacter = Readonly<{
    id: RelicCharacterId;
    name: string;
    epithet: string;
    role: string;
    description: string;
    passive: string;
    skillset: readonly string[];
    silhouette: RelicCharacterSilhouette;
    colors: Readonly<{
        primary: string;
        secondary: string;
        accent: string;
    }>;
    healthBonus?: number;
    escapeBonus?: number;
    relicValueBonus?: number;
    priorityBonusByAction?: Partial<Record<RelicActionKind, number>>;
    noiseReductionByAction?: Partial<Record<RelicActionKind, number>>;
}>;

export const RELIC_CHARACTERS: readonly RelicCharacter[] = [
    {
        id: 'kael-ironstride',
        name: 'Kael Ironstride',
        epithet: 'Gatebreaker Vanguard',
        role: 'Vanguard',
        description: 'A broad-shouldered ruin raider who pushes through stone dust and bad odds.',
        passive: '+1 health and steadier under collapse pressure.',
        skillset: ['heavy armor', 'line breaking', 'shielded escapes'],
        silhouette: 'vanguard',
        colors: { primary: '#475569', secondary: '#0f766e', accent: '#f2c14e' },
        healthBonus: 1,
    },
    {
        id: 'nyra-vale',
        name: 'Nyra Vale',
        epithet: 'Lantern-Quick Scout',
        role: 'Scout',
        description: 'A fast pathfinder with a bright lantern and the nerve to move first.',
        passive: 'Move actions make no noise and resolve earlier.',
        skillset: ['silent movement', 'pathfinding', 'footprint reading'],
        silhouette: 'scout',
        colors: { primary: '#14532d', secondary: '#65a30d', accent: '#fef08a' },
        priorityBonusByAction: { move: 1 },
        noiseReductionByAction: { move: 1 },
    },
    {
        id: 'oryn-starcoil',
        name: 'Oryn Starcoil',
        epithet: 'Astral Ruin Scholar',
        role: 'Scholar',
        description: 'A calm relic expert wrapped in star charts and dangerous theories.',
        passive: 'Search actions are quieter and relics are worth +1 point.',
        skillset: ['relic lore', 'curse reading', 'altar work'],
        silhouette: 'scholar',
        colors: { primary: '#1d4ed8', secondary: '#7c3aed', accent: '#93c5fd' },
        relicValueBonus: 1,
        noiseReductionByAction: { search: 1 },
    },
    {
        id: 'vessa-thornlock',
        name: 'Vessa Thornlock',
        epithet: 'Wire-Sense Trapbreaker',
        role: 'Trapbreaker',
        description: 'A tough mechanic with hooked tools, scarred gloves, and a hatred of old traps.',
        passive: 'Search actions resolve earlier and make less noise.',
        skillset: ['trap sense', 'lock work', 'careful searches'],
        silhouette: 'trapbreaker',
        colors: { primary: '#7c2d12', secondary: '#334155', accent: '#fb923c' },
        priorityBonusByAction: { search: 1 },
        noiseReductionByAction: { search: 1 },
    },
    {
        id: 'tarek-ashmantle',
        name: 'Tarek Ashmantle',
        epithet: 'Emberblade Duelist',
        role: 'Duelist',
        description: 'A precise blade master whose glowing saber makes rival hunters step back.',
        passive: 'Steal actions resolve earlier.',
        skillset: ['close duels', 'satchel cuts', 'pressure tactics'],
        silhouette: 'duelist',
        colors: { primary: '#991b1b', secondary: '#111827', accent: '#f97316' },
        priorityBonusByAction: { steal: 1 },
    },
    {
        id: 'sable-moonhook',
        name: 'Sable Moonhook',
        epithet: 'Velvet Knife Trickster',
        role: 'Trickster',
        description: 'A smiling mischief-maker with moon knives, fake tracks, and fast hands.',
        passive: 'Steal actions make less noise.',
        skillset: ['misdirection', 'sleight of hand', 'ambush routes'],
        silhouette: 'trickster',
        colors: { primary: '#581c87', secondary: '#0f172a', accent: '#f0abfc' },
        noiseReductionByAction: { steal: 1 },
    },
    {
        id: 'bronn-flintward',
        name: 'Bronn Flintward',
        epithet: 'Stonefist Bulwark',
        role: 'Bulwark',
        description: 'A granite-tough guardian with gauntlets built for holding the ceiling up.',
        passive: '+1 health and escape bonus +1.',
        skillset: ['bodyguard work', 'rubble clearing', 'last stands'],
        silhouette: 'bulwark',
        colors: { primary: '#44403c', secondary: '#92400e', accent: '#fde68a' },
        healthBonus: 1,
        escapeBonus: 1,
    },
    {
        id: 'ilyra-dawnshard',
        name: 'Ilyra Dawnshard',
        epithet: 'Sun-Oath Seer',
        role: 'Seer',
        description: 'A radiant oracle who reads warm stone, fading light, and the shape of danger.',
        passive: 'Escape bonus +2 and quiet escape attempts.',
        skillset: ['omen reading', 'light wards', 'exit timing'],
        silhouette: 'seer',
        colors: { primary: '#b45309', secondary: '#1e3a8a', accent: '#fde047' },
        escapeBonus: 2,
        noiseReductionByAction: { escape: 1 },
    },
    {
        id: 'marek-gloomglass',
        name: 'Marek Gloomglass',
        epithet: 'Mirror-Hex Hunter',
        role: 'Hex Hunter',
        description: 'A grim curse-breaker carrying black mirrors and a blade that remembers names.',
        passive: 'Relics are worth +1 point, but escape is still mandatory.',
        skillset: ['curse handling', 'relic dueling', 'shadow reading'],
        silhouette: 'hexblade',
        colors: { primary: '#312e81', secondary: '#111827', accent: '#22d3ee' },
        relicValueBonus: 1,
    },
    {
        id: 'zaya-stormvein',
        name: 'Zaya Stormvein',
        epithet: 'Thunderstep Runner',
        role: 'Stormrunner',
        description: 'A larger-than-life runner with coil boots and a habit of outracing cave-ins.',
        passive: 'Move and escape actions resolve earlier.',
        skillset: ['rapid movement', 'danger sprints', 'exit runs'],
        silhouette: 'stormrunner',
        colors: { primary: '#0e7490', secondary: '#1f2937', accent: '#67e8f9' },
        priorityBonusByAction: { move: 1, escape: 1 },
    },
];

export function defaultRelicCharacterId(index: number): RelicCharacterId {
    return RELIC_CHARACTER_IDS[index % RELIC_CHARACTER_IDS.length];
}

export function findRelicCharacter(characterId: RelicCharacterId): RelicCharacter {
    return RELIC_CHARACTERS.find((character) => character.id === characterId) ??
        RELIC_CHARACTERS[0];
}
