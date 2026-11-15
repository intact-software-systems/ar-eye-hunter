import { rewardTownMischief } from '../mischief.ts';
import { hasTownSight } from '../navigation.ts';
import type { TownState, TownTickInput } from '../state.ts';
import type { TownPersonality } from './state.ts';

interface ResidentTick extends TownTickInput {
    readonly resident: TownPersonality;
}
interface ResidentResult {
    readonly town: TownState;
    readonly resident: TownPersonality;
}

export function computeTownPersonalities(input: TownTickInput): TownState {
    let town = input.town;
    const personalities: TownPersonality[] = [];
    for (const resident of town.personalities) {
        const result = computeResident({ ...input, town, resident });
        town = result.town;
        personalities.push(result.resident);
    }
    return { ...town, personalities };
}

function computeResident(input: ResidentTick): ResidentResult {
    const { resident, now, player } = input;
    if (resident.stainedUntil > now) {
        return { town: input.town, resident };
    }
    const hit = player.dashTime > 0 && resident.kind !== 'inspector' &&
        Math.abs(player.x - resident.prop.x) < resident.prop.width / 2 + 0.7 &&
        Math.abs(player.z - resident.prop.z) < resident.prop.depth / 2 + 0.7;
    if (resident.phase === 'idle' && hit && resident.rewardAt <= now) {
        const town = rewardTownMischief(input.town);
        return startReaction({ ...input, town, resident: { ...resident, rewardAt: now + 30 } });
    }
    if (resident.phase === 'reacting' || resident.phase === 'rivalry') {
        return advanceReaction(input);
    }
    if (resident.phase === 'chasing') {
        const target = hasTownSight(input.town, resident, player) ? { x: player.x, z: player.z } : resident.target;
        const position = input.routes.travel({
            town: input.town,
            from: resident,
            target,
            speed: 2.5,
            step: input.step
        });
        return {
            town: input.town,
            resident: { ...resident, ...position, target, phase: now >= resident.until ? 'returning' : 'chasing' }
        };
    }
    if (resident.phase === 'returning') {
        const position = input.routes.travel({
            town: input.town,
            from: resident,
            target: resident.home,
            speed: 2.4,
            step: input.step
        });
        const home = Math.hypot(position.x - resident.home.x, position.z - resident.home.z) < 0.45;
        return { town: input.town, resident: { ...resident, ...position, phase: home ? 'idle' : 'returning' } };
    }
    if (resident.kind === 'cleaner') {
        return cleanSquare(input);
    }
    if (resident.rivalAt <= now && ['watcher', 'washer', 'silence'].includes(resident.kind)) {
        return startRivalry(input);
    }
    return { town: input.town, resident };
}

function startReaction(input: ResidentTick): ResidentResult {
    const { resident, now } = input;
    const target = resident.kind === 'gardener'
        ? { x: resident.home.x + 2.5, z: resident.home.z - 1 }
        : resident.kind === 'watcher'
        ? { x: resident.home.x + 3, z: resident.home.z - 1 }
        : resident.home;
    const bird = resident.kind === 'watcher'
        ? input.town.creatures.find((creature) => creature.kind === 'bird')
        : undefined;
    const next: TownPersonality = {
        ...resident,
        phase: bird ? 'rivalry' : 'reacting',
        rivalCreature: bird?.id ?? -1,
        startedAt: now,
        until: now + 8,
        target,
        released: false,
        collected: 0
    };
    const town = ['silence', 'mayor', 'queue'].includes(resident.kind) ? distractResidents(input) : input.town;
    return { town, resident: next };
}

function advanceReaction(input: ResidentTick): ResidentResult {
    const { resident, now, step } = input;
    if (now >= resident.until) {
        return { town: input.town, resident: { ...resident, phase: 'returning', rivalCreature: -1, released: false } };
    }
    const animal = input.town.creatures.find((creature) => creature.id === resident.rivalCreature);
    const target = resident.phase === 'rivalry' && animal ? animal : resident.target;
    const moving = resident.phase === 'rivalry' || ['gardener', 'watcher'].includes(resident.kind);
    const position = moving && now - resident.startedAt > 1.5
        ? input.routes.travel({ town: input.town, from: resident, target, speed: 2, step })
        : resident;
    const burp = resident.kind === 'cleaner' && now - resident.startedAt > 2 && !resident.released;
    return {
        town: burp ? distractResidents(input) : input.town,
        resident: { ...resident, x: position.x, z: position.z, released: resident.released || burp }
    };
}

function distractResidents(input: ResidentTick): TownState {
    const { town, resident, now } = input;
    return {
        ...town,
        npcs: town.npcs.map((npc) =>
            Math.hypot(npc.x - resident.x, npc.z - resident.z) < 7 &&
                hasTownSight(town, npc, resident) && npc.mode !== 'cleaning'
                ? { ...npc, mode: 'watching', until: now + 4, chaseUntil: 0 }
                : npc
        )
    };
}

function cleanSquare(input: ResidentTick): ResidentResult {
    const { resident, town, now, step } = input;
    const patch =
        town.patches.filter((patch) =>
            patch.expires > now && Math.hypot(patch.x - resident.home.x, patch.z - resident.home.z) < 10
        )
            .toSorted((a, b) =>
                Math.hypot(a.x - resident.x, a.z - resident.z) - Math.hypot(b.x - resident.x, b.z - resident.z)
            )[0];
    if (!patch || resident.until > now) {
        return { town, resident };
    }
    const position = input.routes.travel({ town, from: resident, target: patch, speed: 2, step });
    if (Math.hypot(position.x - patch.x, position.z - patch.z) > 0.8) {
        return { town, resident: { ...resident, ...position, target: patch } };
    }
    const cleaned = {
        ...town,
        patches: town.patches.filter((item) => item.id !== patch.id),
        cleaned: town.cleaned + 1
    };
    const next = { ...resident, ...position, collected: resident.collected + 1, until: now + 0.8 };
    return next.collected >= 3
        ? startReaction({ ...input, town: cleaned, resident: next })
        : { town: cleaned, resident: next };
}

function startRivalry(input: ResidentTick): ResidentResult {
    const { resident, town, now } = input;
    const kind = resident.kind === 'watcher' ? 'bird' : resident.kind === 'washer' ? 'dog' : 'cat';
    const creature = town.creatures.find((creature) =>
        creature.kind === kind &&
        Math.hypot(creature.x - resident.x, creature.z - resident.z) < 6 &&
        !town.personalities.some((other) => other.phase === 'rivalry' && other.rivalCreature === creature.id)
    );
    return {
        town,
        resident: {
            ...resident,
            rivalAt: now + 35,
            phase: creature ? 'rivalry' : 'idle',
            rivalCreature: creature?.id ?? -1,
            startedAt: now,
            until: creature ? now + 7 : 0
        }
    };
}
