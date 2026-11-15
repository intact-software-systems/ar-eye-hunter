import type { TownPoint } from '../map.ts';
import { rewardTownMischief } from '../mischief.ts';
import { hasTownSight } from '../navigation.ts';
import type { TownRoutes } from '../routes.ts';
import { splashTownActors } from '../soiling.ts';
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
    readonly provokerId: string | undefined;
    readonly aim: TownPoint;
    readonly rewardAt: number;
    readonly attacks: number;
}
export interface TownCreaturesComputed {
    readonly town: TownState;
    readonly player: TownPlayer;
}
export interface TownCreaturePlayer extends TownPlayer {
    readonly id: string;
    readonly score: number;
    readonly dash: boolean;
}
export interface TownCreatureDisturbance extends TownPoint {
    readonly playerId: string;
}
export interface TownCreatureRosterInput {
    readonly town: TownState;
    readonly players: readonly TownCreaturePlayer[];
    readonly disturbances: readonly TownCreatureDisturbance[];
    readonly routes: TownRoutes;
    readonly now: number;
    readonly step: number;
}
export interface TownCreatureRosterComputed {
    readonly town: TownState;
    readonly players: readonly TownCreaturePlayer[];
}
interface TownCreatureInput extends TownCreatureRosterInput {
    readonly creature: TownCreature;
}
interface TownCreatureComputed extends TownCreatureRosterComputed {
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
        provokerId: undefined,
        aim: { x: home.x, z: home.z },
        rewardAt: 0,
        attacks: 0
    }));
}

export function computeTownCreatures(input: TownTickInput): TownCreaturesComputed {
    const result = computeTownCreaturesForPlayers({
        ...input,
        players: [{ ...input.player, id: 'player', score: input.town.score, dash: input.dash }],
        disturbances: input.town.objects.filter((object) => object.disturbedAt > input.now - input.step)
            .map((object) => ({ x: object.x, z: object.z, playerId: 'player' }))
    });
    return { town: { ...result.town, score: result.players[0].score }, player: result.players[0] };
}

export function computeTownCreaturesForPlayers(input: TownCreatureRosterInput): TownCreatureRosterComputed {
    let { town, players } = input;
    const creatures: TownCreature[] = [];
    for (const creature of town.creatures) {
        const result = computeTownCreature({ ...input, town, players, creature });
        town = result.town;
        players = result.players;
        creatures.push(result.creature);
    }
    return { town: { ...town, creatures }, players };
}

function computeTownCreature(input: TownCreatureInput): TownCreatureComputed {
    const { town, players, now, step } = input;
    let { creature } = input;
    const rival = town.personalities.find((resident) =>
        resident.phase === 'rivalry' && resident.rivalCreature === creature.id
    );
    if (rival) {
        const target = now - rival.startedAt < 2
            ? rival.home
            : { x: creature.home.x + Math.sin(now) * 2, z: creature.home.z + Math.cos(now) * 2 };
        const position = input.routes.travel({
            town,
            from: creature,
            target,
            speed: creature.kind === 'bird' ? 6 : 2.5,
            step
        });
        return {
            town,
            players,
            creature: { ...creature, ...position, mode: 'roaming', aim: target, until: now + 0.5 }
        };
    }
    creature = computeTownProvocation({ ...input, creature });
    if (creature.mode === 'warning') {
        return creature.until <= now ? attackTownCreature({ ...input, creature }) : { town, players, creature };
    }
    if (creature.until > now) {
        return { town, players, creature };
    }
    const player = players.filter((actor) =>
        actor.frozenUntil <= now &&
        (Math.hypot(actor.x - creature.home.x, actor.z - creature.home.z) < 6 || creature.angryUntil > now)
    )
        .toSorted((left, right) =>
            Math.hypot(left.x - creature.x, left.z - creature.z) -
                Math.hypot(right.x - creature.x, right.z - creature.z) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        )[0];
    const interested = player !== undefined;
    const distance = player ? Math.hypot(player.x - creature.x, player.z - creature.z) : Infinity;
    if (interested && distance < 3.5 && hasTownSight(town, creature, player)) {
        return {
            town,
            players,
            creature: { ...creature, mode: 'warning', until: now + 1, aim: { x: player.x, z: player.z } }
        };
    }
    const target = interested ? player : { x: creature.home.x + Math.sin(now * 0.4 + creature.id), z: creature.home.z };
    const position = input.routes.travel({ town, from: creature, target, speed: interested ? 2.5 : 0.8, step });
    return { town, players, creature: { ...creature, ...position, mode: interested ? 'chasing' : 'roaming' } };
}

function computeTownProvocation(input: TownCreatureInput): TownCreature {
    const { town, players, creature, now } = input;
    const provoker = players.filter((player) =>
        player.dash &&
        Math.hypot(player.x - creature.x, player.z - creature.z) < 4 && hasTownSight(town, creature, player)
    )
        .toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)[0];
    const disturbance =
        input.disturbances.filter((event) => Math.hypot(event.x - creature.home.x, event.z - creature.home.z) < 6)
            .toSorted((left, right) => left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0)[0];
    const provokerId = provoker?.id ?? disturbance?.playerId;
    if (provokerId !== undefined) {
        return { ...creature, provokedUntil: now + 10, angryUntil: now + 8, provokerId };
    }
    return creature;
}

function attackTownCreature(input: TownCreatureInput): TownCreatureComputed {
    const { creature, now } = input;
    if (!hasTownSight(input.town, creature, creature.aim)) {
        return { town: input.town, players: input.players, creature: { ...creature, mode: 'roaming', until: now + 3 } };
    }
    const kind = creature.kind === 'bird' ? 'poop' : creature.kind === 'dog' ? 'pee' : 'puke';
    const splash = splashTownActors({
        radius: 1.25,
        town: input.town,
        source: creature,
        target: creature.aim,
        kind,
        now
    }, input.players);
    let town = splash.town;
    const credited = splash.hitResident && creature.provokedUntil > now && creature.rewardAt <= now &&
        input.players.some((player) => player.id === creature.provokerId);
    const rewarded = credited ? rewardTownMischief(town) : town;
    const reward = rewarded.score - town.score;
    town = { ...rewarded, score: town.score };
    const patch: TownPatch = {
        id: town.nextId,
        x: creature.aim.x,
        z: creature.aim.z,
        kind,
        born: now,
        expires: now + 10
    };
    return {
        players: splash.actors.map((player) =>
            credited && player.id === creature.provokerId
                ? { ...player, score: player.score + reward }
                : player
        ),
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
