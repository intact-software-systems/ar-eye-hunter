import { computeTownAuthorities } from './authorities.ts';
import { computeTownCreaturesForPlayers, type TownCreatureDisturbance } from './creatures/rules.ts';
import {
    addPuke,
    advanceTownDebris,
    tipTownShops
} from './mess.ts';
import { advanceTownObjects, triggerTownObjects } from './objects.ts';
import { computeTownOwnersForPlayers, witnessTownPlayer } from './owners.ts';
import { advanceTownPersonalities, triggerTownPersonalities } from './personalities/rules.ts';
import { collectTownPickup, releaseTownPrank } from './pranks.ts';
import { advanceTownProps, triggerTownProps } from './props.ts';
import { computeTownSoilingActors } from './soiling.ts';
import { advanceTownSpectacles, triggerTownSpectacles } from './spectacles/rules.ts';
import type {
    TownComputed,
    TownTickInput,
    TownWorldComputed,
    TownWorldInput,
    TownWorldPlayer
} from './state.ts';

interface TownPranksComputed extends TownWorldComputed {
    readonly disturbances: readonly TownCreatureDisturbance[];
}

/** Solo projects its player and optional companion through the canonical shared-world rules. */
export function computeTownTick(input: TownTickInput): TownComputed {
    const result = computeTownWorld({
        ...input,
        players: [{
            ...input.player,
            id: 'player',
            dash: input.dash,
            score: input.town.score,
            rescues: input.town.rescues,
            rescueTarget: '@companion',
            rescueProgress: input.town.rescueProgress,
            rewardedThisRaid: input.town.raid.rewarded
        }]
    });
    const player = result.players[0];
    return {
        town: result.town,
        power: player.power,
        stain: player.stain,
        stainedUntil: player.stainedUntil,
        messImmuneUntil: player.messImmuneUntil,
        frozenUntil: player.frozenUntil,
        shieldUntil: player.shieldUntil,
        sickAt: player.sickAt,
        dizzyUntil: player.dizzyUntil,
        immuneUntil: player.immuneUntil
    };
}

export function computeTownWorld(input: TownWorldInput): TownWorldComputed {
    const ordered = input.players.toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    let town = advanceTownDebris(input.town, input.now, input.step);
    town = advanceTownObjects(town, input.now);
    const pranks = computeTownPranks({ ...input, players: ordered, town });
    town = advanceTownProps(pranks.town, input.now);
    town = advanceTownPersonalities({ ...input, town, players: pranks.players });
    const creatures = computeTownCreaturesForPlayers({ ...input, ...pranks, town });
    let players: readonly TownWorldPlayer[] = pranks.players.map((player, index) => ({
        ...player,
        ...creatures.players[index]
    }));
    const spectacles = advanceTownSpectacles({ ...input, town: creatures.town }, players);
    const soiling = computeTownSoilingActors({ ...input, town: spectacles.town }, spectacles.players);
    town = soiling.town;
    players = soiling.actors;
    for (const [index, player] of players.entries()) {
        if (player.dash || player.score > ordered[index].score) {
            town = witnessTownPlayer({ town, player, now: input.now });
        }
    }
    const owners = computeTownOwnersForPlayers({ ...input, town, players });
    players = players.map((player, index) => ({ ...player, ...owners.players[index] }));
    const sickness = computeTownSickness({ ...input, town: owners.town, players });
    const authorities = computeTownAuthorities({ ...input, ...sickness });
    return computeTownPickups({ ...input, ...authorities });
}

function computeTownPranks(input: TownWorldInput): TownPranksComputed {
    let town = input.town;
    const players: TownWorldPlayer[] = [];
    const disturbances: TownCreatureDisturbance[] = [];
    for (const player of input.players) {
        const score = town.score;
        if (player.dash) {
            town = releaseTownPrank(town, player, input.now);
        }
        town = tipTownShops(town, player, input.now);
        town = triggerTownProps({ ...input, town, player, dash: player.dash });
        const previousObjects = town.objects;
        town = triggerTownObjects({ ...input, town, player, dash: player.dash });
        for (const object of town.objects) {
            if (object.disturbedAt !== previousObjects.find((entry) => entry.id === object.id)?.disturbedAt) {
                disturbances.push({ x: object.x, z: object.z, playerId: player.id });
            }
        }
        town = triggerTownPersonalities({ ...input, town, player, dash: player.dash });
        town = triggerTownSpectacles({ ...input, town, player, dash: player.dash, playerId: player.id });
        players.push({
            ...player,
            score: player.score + town.score - score,
            power: player.dash ? 'fart' : player.power
        });
    }
    return { town, players, disturbances };
}

function computeTownSickness(input: TownWorldInput): TownWorldComputed {
    const { now, step } = input;
    let town = input.town;
    const players: TownWorldPlayer[] = [];
    for (const player of input.players) {
        const exposed = player.immuneUntil <= now &&
            town.patches.some((patch) =>
                patch.kind === 'powder' && now - patch.born > 0.4 &&
                Math.hypot(player.x - patch.x, player.z - patch.z) < 1.8
            );
        const sickAt = exposed ? now + 2.2 : player.sickAt;
        if (sickAt >= 0 && sickAt > now - step && sickAt <= now) {
            town = addPuke(town, player, now);
        }
        players.push({
            ...player,
            sickAt,
            dizzyUntil: exposed ? now + 3.2 : player.dizzyUntil,
            immuneUntil: exposed ? now + 9 : player.immuneUntil
        });
    }
    return { town, players };
}

function computeTownPickups(input: TownWorldInput): TownWorldComputed {
    let town = input.town;
    const players: TownWorldPlayer[] = [];
    for (const player of input.players) {
        const pickup = collectTownPickup(town, player, input.now);
        town = pickup.town;
        players.push({ ...player, power: pickup.power });
    }
    return { town, players };
}
