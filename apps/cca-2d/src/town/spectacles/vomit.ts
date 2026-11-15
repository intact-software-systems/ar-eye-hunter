import type { TownPoint } from '../map.ts';
import { hasTownSight } from '../navigation.ts';
import { splashTown } from '../soiling.ts';
import type { TownState, TownTickInput } from '../state.ts';
import type { TownSpectacleResult } from './rules.ts';
import { TOWN_UMBRELLA } from './state.ts';

export interface TownVomitJet {
    readonly source: TownPoint;
    readonly direction: TownPoint;
    readonly length: number;
}

export function computeTownVomitJets(town: TownState, now: number): readonly TownVomitJet[] {
    const event = town.spectacles.active;
    if (event?.kind !== 'vomit' || event.phase !== 'active') {
        return [];
    }
    if (town.spectacles.umbrellaUntil > now) {
        const dx = TOWN_UMBRELLA.x - event.origin.x;
        const dz = TOWN_UMBRELLA.z - event.origin.z;
        const distance = Math.hypot(dx, dz);
        return [
            { source: event.origin, direction: { x: dx / distance, z: dz / distance }, length: distance - 0.4 },
            { source: { x: TOWN_UMBRELLA.x + 0.7, z: TOWN_UMBRELLA.z }, direction: { x: 1, z: 0 }, length: 5 }
        ];
    }
    const angle = Math.PI / 2 + Math.sin((now - event.startedAt) * 1.1) * 0.6;
    return [{ source: event.origin, direction: { x: Math.sin(angle), z: Math.cos(angle) }, length: 6 }];
}

export function advanceTownDinner(input: TownTickInput): TownSpectacleResult {
    const { now } = input;
    let town = input.town;
    let player = input.player;
    let event = town.spectacles.active!;
    if (event.phase === 'warning' && now >= event.until) {
        event = { ...event, phase: 'active', until: now + 6 };
        town = { ...town, spectacles: { ...town.spectacles, dinners: town.spectacles.dinners + 1, active: event } };
    }
    if (event.phase === 'active' && now >= event.until) {
        event = { ...event, phase: 'cleanup', until: now + 6 };
    }
    if (event.phase === 'cleanup') {
        if (now >= event.until) {
            return { town: { ...town, spectacles: { ...town.spectacles, active: undefined } }, player };
        }
        if (event.nextPatchAt <= now) {
            const mess = town.patches.find((patch) =>
                patch.kind === 'puke' && Math.hypot(patch.x - event.origin.x, patch.z - event.origin.z) < 7
            );
            town = { ...town, patches: town.patches.filter((patch) => patch.id !== mess?.id) };
            event = { ...event, nextPatchAt: now + 0.6 };
        }
    }
    town = { ...town, spectacles: { ...town.spectacles, active: event } };
    for (const jet of computeTownVomitJets(town, now)) {
        const result = applyVomitJet({ ...input, town, player, jet });
        town = result.town;
        player = result.player;
    }
    if (event.phase === 'active' && event.nextPatchAt <= now) {
        town = { ...town, spectacles: { ...town.spectacles, active: { ...event, nextPatchAt: now + 0.6 } } };
    }
    return { town, player };
}

function applyVomitJet(input: TownTickInput & { jet: TownVomitJet; }): TownSpectacleResult {
    const { jet, now } = input;
    let { town, player } = input;
    let endpoint = jet.source;
    for (let distance = 0.5; distance <= jet.length; distance += 0.5) {
        const target = { x: jet.source.x + jet.direction.x * distance, z: jet.source.z + jet.direction.z * distance };
        if (!hasTownSight(town, jet.source, target)) {
            break;
        }
        endpoint = target;
        const splash = splashTown({ town, player, source: jet.source, target, radius: 0.55, kind: 'puke', now });
        town = splash.town;
        player = splash.player;
    }
    if (town.spectacles.active!.nextPatchAt <= now && endpoint !== jet.source) {
        town = {
            ...town,
            nextId: town.nextId + 1,
            patches: [...town.patches, { ...endpoint, id: town.nextId, kind: 'puke', born: now, expires: now + 10 }]
        };
    }
    return { town, player };
}
