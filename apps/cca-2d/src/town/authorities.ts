import { computeTownRescues, computeTownThaw, moveTownCompanion } from './companion.ts';
import { TOWN_POLICE_DOOR } from './map.ts';
import { TOWN_CRACKDOWN_BONUS } from './mischief.ts';
import { hasTownSight } from './navigation.ts';
import { isTownSprayed } from './props.ts';
import { advanceTownRaid } from './raid.ts';
import type { TownRoutes } from './routes.ts';
import type {
    TownCompanion,
    TownGuard,
    TownState,
    TownWorldComputed,
    TownWorldInput
} from './state.ts';

export interface TownGuardTarget extends TownCompanion {
    readonly id: string;
}
export interface TownGuardInput {
    readonly routes: TownRoutes;
    readonly town: TownState;
    readonly guard: TownGuard;
    readonly targets: readonly TownGuardTarget[];
    readonly now: number;
    readonly step: number;
}
export interface TownGuardResult {
    readonly guard: TownGuard;
    readonly frozenTarget: string | undefined;
}

export function computeTownAuthorities(input: TownWorldInput): TownWorldComputed {
    let town = advanceTownRaid(input);
    const bonus = town.raid.bonuses > input.town.raid.bonuses;
    const players = input.players.map((player) => ({
        ...computeTownThaw(player, input.now),
        score: player.score + (bonus ? TOWN_CRACKDOWN_BONUS : 0),
        rewardedThisRaid: bonus ? false : player.rewardedThisRaid
    }));
    if (town.companion && players.length > 0) {
        town = { ...town, companion: moveTownCompanion({ ...input, town, player: players[0], dash: false }) };
    }
    const policed = computeTownPolice({ ...input, town, players });
    return rescueTownPlayers({ ...input, ...policed });
}

function computeTownPolice(input: TownWorldInput): TownWorldComputed {
    const { now, step } = input;
    let { town, players } = input;
    const guards: TownGuard[] = [];
    for (const guard of town.raid.guards) {
        const targets: TownGuardTarget[] = [...players];
        if (town.companion) {
            targets.push({ ...town.companion, id: '@companion' });
        }
        const result = computeTownGuard({ routes: input.routes, town, guard, targets, now, step });
        players = players.map((player) =>
            player.id === result.frozenTarget ? { ...player, frozenUntil: now + 6 } : player
        );
        if (town.companion && result.frozenTarget === '@companion') {
            town = { ...town, companion: { ...town.companion, frozenUntil: now + 6 } };
        }
        if (
            town.raid.phase === 'active' && guard.mode === 'warning' && guard.until <= now && guard.stainedUntil <= now
        ) {
            const zap = { id: town.nextId, x: guard.x, z: guard.z, target: guard.aim, expires: now + 0.3 };
            town = { ...town, nextId: town.nextId + 1, zaps: [...town.zaps, zap] };
        }
        if (
            town.raid.phase !== 'returning' ||
            Math.hypot(result.guard.x - TOWN_POLICE_DOOR.x, result.guard.z - TOWN_POLICE_DOOR.z) > 0.45
        ) {
            guards.push(result.guard);
        }
    }
    return { town: { ...town, raid: { ...town.raid, guards } }, players };
}

function rescueTownPlayers(input: TownWorldInput): TownWorldComputed {
    const { town, players, now, step } = input;
    const actors = computeTownRescues({
        town,
        now,
        step,
        actors: [
            ...players,
            ...(town.companion
                ? [{
                    ...town.companion,
                    id: '@companion',
                    dashTime: 0,
                    rescueTarget: players[0]?.id,
                    rescueProgress: players[0]?.frozenUntil > now ? town.rescueProgress : 0,
                    rescues: 0,
                    score: 0,
                    rewardedThisRaid: true
                }]
                : [])
        ]
    });
    const rescued = players.map((player, index) => ({ ...player, ...actors[index] }));
    const companion = actors[players.length];
    return {
        players: rescued,
        town: {
            ...town,
            score: rescued.reduce((sum, player) => sum + player.score, 0),
            rescues: rescued.reduce((sum, player) => sum + player.rescues, 0),
            rescueProgress: Math.max(0, ...actors.map((actor) => actor.rescueProgress)),
            raid: { ...town.raid, rewarded: rescued[0]?.rewardedThisRaid ?? false },
            companion: town.companion && companion
                ? {
                    ...town.companion,
                    frozenUntil: companion.frozenUntil,
                    shieldUntil: companion.shieldUntil
                }
                : undefined
        }
    };
}

export function computeTownGuard(input: TownGuardInput): TownGuardResult {
    const { town, targets, now, step } = input;
    let { guard } = input;
    if (town.raid.phase === 'returning') {
        const position = input.routes.travel({ town, from: guard, target: TOWN_POLICE_DOOR, speed: 5, step });
        return { guard: { ...guard, ...position, mode: 'patrol' }, frozenTarget: undefined };
    }
    if (town.raid.phase !== 'active' || (guard.mode === 'emerging' && guard.until > now)) {
        return { guard, frozenTarget: undefined };
    }
    if (guard.stainedUntil > now) {
        guard = { ...guard, mode: 'patrol', until: 0 };
    }
    if (guard.mode === 'warning') {
        return finishTownGuardZap({ ...input, guard });
    }
    if (guard.until > now) {
        return { guard, frozenTarget: undefined };
    }
    const target = targets.filter((actor) => actor.frozenUntil <= now && actor.shieldUntil <= now)
        .toSorted((left, right) =>
            Math.hypot(left.x - guard.x, left.z - guard.z) - Math.hypot(right.x - guard.x, right.z - guard.z) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        )[0];
    if (
        target && guard.stainedUntil <= now && Math.hypot(target.x - guard.x, target.z - guard.z) < 3.2 &&
        hasTownSight(town, guard, target)
    ) {
        guard = { ...guard, mode: 'warning', target: target.id, aim: { x: target.x, z: target.z }, until: now + 0.9 };
        return { guard, frozenTarget: undefined };
    }
    const destination = target
        ? { x: target.x + Math.sin(guard.id * 2.4) * 1.2, z: target.z + Math.cos(guard.id * 2.4) * 1.2 }
        : TOWN_POLICE_DOOR;
    const speed = guard.stainedUntil > now || isTownSprayed(town, guard, now) ? 0.8 : 2.7;
    const position = input.routes.travel({ town, from: guard, target: destination, speed, step });
    return { guard: { ...guard, ...position, mode: 'patrol' }, frozenTarget: undefined };
}

function finishTownGuardZap(input: TownGuardInput): TownGuardResult {
    const { town, guard, targets, now } = input;
    if (guard.until > now) {
        return { guard, frozenTarget: undefined };
    }
    const target = targets.find((actor) => actor.id === guard.target);
    const hit = target && target.frozenUntil <= now && target.shieldUntil <= now &&
        Math.hypot(target.x - guard.aim.x, target.z - guard.aim.z) < 1 && hasTownSight(town, guard, target);
    return {
        guard: { ...guard, mode: 'cooldown', until: now + 1.3 },
        frozenTarget: hit ? target.id : undefined
    };
}
