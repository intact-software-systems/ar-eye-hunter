import type { TownPoint } from '../map.ts';
import { rewardTownMischief } from '../mischief.ts';
import { hasTownSight } from '../navigation.ts';
import { computeTownTravel } from '../routes.ts';
import { splashTown } from '../soiling.ts';
import type {
    TownPatch,
    TownPlayer,
    TownState,
    TownTickInput
} from '../state.ts';

export interface TownCreature extends TownPoint {
    readonly id: number;
    readonly kind: 'bird' | 'dog' | 'cat';
    readonly home: TownPoint;
    readonly mode: 'roaming' | 'chasing' | 'warning' | 'recovering';
    readonly until: number;
    readonly angryUntil: number;
    readonly provokedUntil: number;
    readonly aim: TownPoint;
    readonly rewardAt: number;
    readonly attacks: number;
}
export interface TownCreaturesComputed {
    readonly town: TownState;
    readonly player: TownPlayer;
}
interface TownCreatureInput extends TownTickInput {
    readonly creature: TownCreature;
}
interface TownCreatureComputed extends TownCreaturesComputed {
    readonly creature: TownCreature;
}

export function createTownCreatures(): readonly TownCreature[] {
    const homes = [
        { kind: 'bird' as const, x: -4, z: -0.5 },
        { kind: 'bird' as const, x: 7, z: 10 },
        { kind: 'dog' as const, x: -8, z: -3 },
        { kind: 'dog' as const, x: 13, z: 4 },
        { kind: 'cat' as const, x: -7, z: 6 },
        { kind: 'cat' as const, x: 6, z: -6 }
    ];
    return homes.map((home, id) => ({
        ...home,
        id,
        home: { x: home.x, z: home.z },
        mode: 'roaming',
        until: 2 + id * 0.3,
        angryUntil: 0,
        provokedUntil: 0,
        aim: { x: home.x, z: home.z },
        rewardAt: 0,
        attacks: 0
    }));
}

export function computeTownCreatures(input: TownTickInput): TownCreaturesComputed {
    let { town, player } = input;
    const creatures: TownCreature[] = [];
    for (const creature of town.creatures) {
        const result = computeTownCreature({ ...input, town, player, creature });
        town = result.town;
        player = result.player;
        creatures.push(result.creature);
    }
    return { town: { ...town, creatures }, player };
}

function computeTownCreature(input: TownCreatureInput): TownCreatureComputed {
    const { town, player, now, step } = input;
    let { creature } = input;
    const distance = Math.hypot(player.x - creature.x, player.z - creature.z);
    const disturbed = town.objects.some((object) =>
        object.disturbedAt > now - step &&
        Math.hypot(object.x - creature.home.x, object.z - creature.home.z) < 6
    );
    if ((input.dash && distance < 4 && hasTownSight(town, creature, player)) || disturbed) {
        creature = { ...creature, provokedUntil: now + 10, angryUntil: now + 8 };
    }
    if (creature.mode === 'warning') {
        return creature.until <= now ? attackTownCreature({ ...input, creature }) : { town, player, creature };
    }
    if (creature.until > now) {
        return { town, player, creature };
    }
    const inTerritory = Math.hypot(player.x - creature.home.x, player.z - creature.home.z) < 6;
    const interested = player.frozenUntil <= now && (inTerritory || creature.angryUntil > now);
    if (interested && distance < 3.5 && hasTownSight(town, creature, player)) {
        return {
            town,
            player,
            creature: { ...creature, mode: 'warning', until: now + 1, aim: { x: player.x, z: player.z } }
        };
    }
    const target = interested ? player : { x: creature.home.x + Math.sin(now * 0.4 + creature.id), z: creature.home.z };
    const position = computeTownTravel({ town, from: creature, target, speed: interested ? 2.5 : 0.8, step });
    return { town, player, creature: { ...creature, ...position, mode: interested ? 'chasing' : 'roaming' } };
}

function attackTownCreature(input: TownCreatureInput): TownCreatureComputed {
    const { creature, now } = input;
    if (!hasTownSight(input.town, creature, creature.aim)) {
        return { town: input.town, player: input.player, creature: { ...creature, mode: 'roaming', until: now + 3 } };
    }
    const kind = creature.kind === 'bird' ? 'poop' : creature.kind === 'dog' ? 'pee' : 'puke';
    const splash = splashTown({
        town: input.town,
        player: input.player,
        source: creature,
        target: creature.aim,
        kind,
        now
    });
    let town = splash.town;
    const credited = splash.hitResident && creature.provokedUntil > now && creature.rewardAt <= now;
    if (credited) {
        town = rewardTownMischief(town);
    }
    const patch: TownPatch = {
        id: town.nextId,
        x: creature.aim.x,
        z: creature.aim.z,
        kind,
        born: now,
        expires: now + 10
    };
    return {
        player: splash.player,
        town: { ...town, nextId: town.nextId + 1, patches: [...town.patches, patch] },
        creature: {
            ...creature,
            mode: 'recovering',
            until: now + 3,
            attacks: creature.attacks + 1,
            rewardAt: credited ? now + 30 : creature.rewardAt
        }
    };
}
