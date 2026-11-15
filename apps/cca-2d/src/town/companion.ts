import type { TownPoint } from './map.ts';
import { hasTownSight } from './navigation.ts';
import type { TownCompanion, TownState, TownTickInput } from './state.ts';

export interface TownRescueResult {
    readonly town: TownState;
    readonly frozenUntil: number;
    readonly shieldUntil: number;
}
export interface TownRescueActor extends TownPoint {
    readonly id: string;
    readonly frozenUntil: number;
    readonly shieldUntil: number;
    readonly dashTime: number;
    readonly rescueTarget: string | undefined;
    readonly rescueProgress: number;
    readonly rescues: number;
    readonly score: number;
    readonly rewardedThisRaid: boolean;
}
export interface TownRescueInput {
    readonly town: TownState;
    readonly actors: readonly TownRescueActor[];
    readonly now: number;
    readonly step: number;
}

export function moveTownCompanion(input: TownTickInput): TownCompanion {
    const { town, player, now, step } = input;
    let companion = town.companion;
    if (companion.frozenUntil > now) {
        return companion;
    }
    if (companion.frozenUntil > 0) {
        companion = { ...companion, frozenUntil: 0, shieldUntil: now + 2.5 };
    }
    const target = player.frozenUntil > now
        ? { x: player.x - 0.8, z: player.z }
        : { x: player.x - 2.5, z: player.z - 1.5 };
    const distance = Math.hypot(target.x - companion.x, target.z - companion.z);
    if (distance < 0.3) {
        return companion;
    }
    const position = input.routes.travel({
        town,
        from: companion,
        target,
        speed: player.frozenUntil > now ? 3.3 : 2.5,
        step
    });
    return { ...companion, ...position };
}

export function rescueTownFriend(input: TownTickInput): TownRescueResult {
    const actors = computeTownRescues({
        town: input.town,
        actors: [toTownRescueActor(input, 'player'), toTownRescueActor(input, 'companion')],
        now: input.now,
        step: input.step
    });
    const [player, companion] = actors;
    return {
        frozenUntil: player.frozenUntil,
        shieldUntil: player.shieldUntil,
        town: {
            ...input.town,
            companion: {
                ...input.town.companion,
                frozenUntil: companion.frozenUntil,
                shieldUntil: companion.shieldUntil
            },
            rescueProgress: Math.max(player.rescueProgress, companion.rescueProgress),
            rescues: player.rescues,
            score: player.score,
            raid: { ...input.town.raid, rewarded: player.rewardedThisRaid }
        }
    };
}

/** Each rescuer owns progress toward one identity; the first completion frees that target exactly once. */
export function computeTownRescues(input: TownRescueInput): readonly TownRescueActor[] {
    const { now, step, town } = input;
    const actors = input.actors.map((actor) =>
        actor.frozenUntil > 0 && actor.frozenUntil <= now
            ? { ...actor, frozenUntil: 0, shieldUntil: now + 2.5 }
            : actor
    );
    const order = actors.map((actor, index) => ({ id: actor.id, index })).toSorted((
        left,
        right
    ) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const { index } of order) {
        const rescuer = actors[index];
        const target = rescuer.frozenUntil <= now && rescuer.dashTime <= 0
            ? actors.filter((actor) =>
                actor.id !== rescuer.id && actor.frozenUntil > now &&
                Math.hypot(actor.x - rescuer.x, actor.z - rescuer.z) < 1.6 && hasTownSight(town, rescuer, actor)
            )
                .toSorted((left, right) =>
                    Math.hypot(left.x - rescuer.x, left.z - rescuer.z) -
                        Math.hypot(right.x - rescuer.x, right.z - rescuer.z) ||
                    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
                )[0]
            : undefined;
        const progress = target ? (rescuer.rescueTarget === target.id ? rescuer.rescueProgress : 0) + step : 0;
        actors[index] = { ...rescuer, rescueTarget: target?.id, rescueProgress: progress };
        if (!target || progress < 1) {
            continue;
        }
        const targetIndex = actors.findIndex((actor) => actor.id === target.id);
        actors[targetIndex] = {
            ...target,
            frozenUntil: 0,
            shieldUntil: now + 2.5,
            rescueProgress: 0,
            rescueTarget: undefined
        };
        actors[index] = {
            ...rescuer,
            rescueTarget: undefined,
            rescueProgress: 0,
            rescues: rescuer.rescues + 1,
            score: rescuer.score + (rescuer.rewardedThisRaid ? 0 : 3),
            rewardedThisRaid: true
        };
    }
    return actors;
}

function toTownRescueActor(input: TownTickInput, id: 'player' | 'companion'): TownRescueActor {
    const actor = id === 'player' ? input.player : input.town.companion;
    return {
        id,
        x: actor.x,
        z: actor.z,
        frozenUntil: actor.frozenUntil,
        shieldUntil: actor.shieldUntil,
        dashTime: id === 'player' ? input.player.dashTime : 0,
        rescueTarget: id === 'player' ? 'companion' : 'player',
        rescueProgress: input.town.rescueProgress,
        rescues: id === 'player' ? input.town.rescues : 0,
        score: id === 'player' ? input.town.score : 0,
        rewardedThisRaid: id === 'player' ? input.town.raid.rewarded : true
    };
}
