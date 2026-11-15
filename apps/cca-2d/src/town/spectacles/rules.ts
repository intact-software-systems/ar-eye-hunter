import type { TownPoint } from '../map.ts';
import { rewardTownMischief } from '../mischief.ts';
import { hasTownSight } from '../navigation.ts';
import { splashTownActors, type TownCoat } from '../soiling.ts';
import type {
    TownState,
    TownStepInput,
    TownTickInput
} from '../state.ts';
import { advanceTownFire } from './fire.ts';
import {
    TOWN_BARBECUE,
    TOWN_UMBRELLA,
    type TownSpectacleRequest
} from './state.ts';
import { advanceTownDinner } from './vomit.ts';

export interface TownSpectacleActors<T extends TownPoint & TownCoat> {
    readonly town: TownState;
    readonly players: readonly T[];
}
export interface TownSpectacleTrigger extends TownTickInput {
    readonly playerId: string;
}

export function requestTownSpectacle(town: TownState, request: TownSpectacleRequest): TownState {
    if (
        town.spectacles.active?.kind === request.kind ||
        town.spectacles.queue.some((event) => event.kind === request.kind)
    ) {
        return town;
    }
    return {
        ...rewardTownMischief(town, 20),
        spectacles: { ...town.spectacles, queue: [...town.spectacles.queue, request] }
    };
}

export function advanceTownSpectacles<T extends TownPoint & TownCoat>(
    input: TownStepInput,
    players: readonly T[]
): TownSpectacleActors<T> {
    let town = input.town;
    if (!town.spectacles.active && town.spectacles.queue.length > 0) {
        const [request, ...queue] = town.spectacles.queue;
        town = {
            ...town,
            spectacles: {
                ...town.spectacles,
                queue,
                active: {
                    ...request,
                    startedAt: input.now,
                    until: input.now + 2,
                    phase: 'warning',
                    progress: 0,
                    nextPatchAt: input.now + 2
                }
            }
        };
    }
    const event = town.spectacles.active;
    if (!event) {
        return { town, players };
    }
    if (event.kind === 'fire') {
        return { town: advanceTownFire({ ...input, town }), players };
    }
    if (event.kind === 'vomit') {
        return advanceTownDinner({ ...input, town }, players);
    }
    if (event.phase === 'warning' && input.now >= event.until) {
        return burstTownBomb({ ...input, town }, players);
    }
    if (event.phase === 'cleanup' && input.now >= event.until) {
        town = { ...town, spectacles: { ...town.spectacles, active: undefined } };
    }
    return { town, players };
}

export function triggerTownSpectacles(input: TownSpectacleTrigger): TownState {
    const { player, now } = input;
    let town = input.town;
    if (player.dashTime <= 0) {
        return town;
    }
    if (Math.hypot(player.x - TOWN_UMBRELLA.x, player.z - TOWN_UMBRELLA.z) < 1.2) {
        town = { ...town, spectacles: { ...town.spectacles, umbrellaUntil: now + 6 } };
    }
    if (
        Math.hypot(player.x - TOWN_BARBECUE.x, player.z - TOWN_BARBECUE.z) < 1.3 && town.spectacles.fireReadyAt <= now
    ) {
        const witnesses = town.npcs.filter((npc) =>
            Math.hypot(npc.x - player.x, npc.z - player.z) < 12 &&
            hasTownSight(town, npc, player)
        ).map((npc) => npc.shopId);
        town = requestTownSpectacle(town, { kind: 'fire', origin: TOWN_BARBECUE, witnesses });
        town = {
            ...town,
            spectacles: { ...town.spectacles, fireReadyAt: now + 45 },
            personalities: town.personalities.map((resident) =>
                resident.phase === 'idle' && resident.kind !== 'inspector' &&
                    Math.hypot(resident.x - player.x, resident.z - player.z) < 12 &&
                    hasTownSight(town, resident, player)
                    ? {
                        ...resident,
                        phase: 'chasing',
                        until: now + 8,
                        target: { x: player.x, z: player.z },
                        targetId: input.playerId
                    }
                    : resident
            )
        };
    }
    const inspector = town.personalities.find((resident) => resident.kind === 'inspector');
    if (
        inspector && Math.hypot(player.x - inspector.prop.x, player.z - inspector.prop.z) < 1.2 &&
        town.spectacles.vomitReadyAt <= now
    ) {
        town = requestTownSpectacle(town, { kind: 'vomit', origin: inspector.home, witnesses: [] });
        town = { ...town, spectacles: { ...town.spectacles, vomitReadyAt: now + 45 } };
    }
    return town;
}

function burstTownBomb<T extends TownPoint & TownCoat>(
    input: TownStepInput,
    players: readonly T[]
): TownSpectacleActors<T> {
    const event = input.town.spectacles.active!;
    const splash = splashTownActors({
        town: input.town,
        source: event.origin,
        target: event.origin,
        radius: 6,
        kind: 'poop',
        now: input.now
    }, players);
    const positions = Array.from({ length: 12 }, (_, index) => {
        const angle = index * Math.PI / 6;
        const radius = index % 2 ? 4.5 : 2.5;
        return { x: event.origin.x + Math.sin(angle) * radius, z: event.origin.z + Math.cos(angle) * radius };
    }).filter((point) => hasTownSight(input.town, event.origin, point));
    const patches = positions.map((point, index) => ({
        ...point,
        id: splash.town.nextId + index,
        kind: 'poop' as const,
        born: input.now,
        expires: input.now + 10
    }));
    return {
        players: splash.actors,
        town: {
            ...splash.town,
            nextId: splash.town.nextId + patches.length,
            patches: [...splash.town.patches, ...patches],
            spectacles: {
                ...splash.town.spectacles,
                bombs: splash.town.spectacles.bombs + 1,
                active: { ...event, phase: 'cleanup', until: input.now + 3 }
            }
        }
    };
}
