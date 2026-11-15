import { TOWN_OBJECTS, type TownObjectDefinition } from './map.ts';
import { rewardTownMischief } from './mischief.ts';
import type { TownRepair, TownRepairResult } from './props.ts';
import type {
    TownPatch,
    TownState,
    TownTickInput
} from './state.ts';

export interface TownObject extends TownObjectDefinition {
    readonly damagedUntil: number;
    readonly rewardAt: number;
    readonly repair: number;
    readonly disturbedAt: number;
}

export function createTownObjects(): readonly TownObject[] {
    return TOWN_OBJECTS.map((object) => ({ ...object, damagedUntil: 0, rewardAt: 0, repair: 0, disturbedAt: -1 }));
}

export function computeTownObjects(input: TownTickInput): TownState {
    const { player, now } = input;
    let town = input.town;
    const objects: TownObject[] = [];
    for (const original of town.objects) {
        let object = original.damagedUntil <= now ? { ...original, damagedUntil: 0 } : original;
        const nearX = Math.max(0, Math.abs(player.x - object.x) - object.width / 2);
        const nearZ = Math.max(0, Math.abs(player.z - object.z) - object.depth / 2);
        const toward = (object.x - player.x) * player.facingX + (object.z - player.z) * player.facingZ;
        if (player.dashTime > 0 && object.damagedUntil === 0 && Math.hypot(nearX, nearZ) < 0.6 && toward > 0) {
            if (object.rewardAt <= now) {
                town = rewardTownMischief(town);
            }
            object = { ...object, damagedUntil: now + 24, rewardAt: now + 30, repair: 0, disturbedAt: now };
            town = scatterObjectMess(town, object, now);
        }
        objects.push(object);
    }
    return { ...town, objects };
}

export function repairTownObject(input: TownRepair): TownRepairResult {
    const { town, npc, step } = input;
    const object = town.objects.find((object) => object.owner === npc.shopId && object.damagedUntil > 0);
    if (!object) {
        return { town, npc, busy: false };
    }
    const target = { x: object.x, z: object.z - object.depth / 2 - 0.65 };
    const position = input.routes.travel({ town, from: npc, target, speed: 2.3, step });
    const near = Math.hypot(position.x - target.x, position.z - target.z) < 0.4;
    const repair = near ? object.repair + step : 0;
    const objects = town.objects.map((entry) =>
        entry.id === object.id
            ? { ...entry, repair, damagedUntil: repair >= 3 ? 0 : entry.damagedUntil }
            : entry
    );
    return { town: { ...town, objects }, npc: { ...npc, ...position, mode: 'cleaning' }, busy: true };
}

function scatterObjectMess(town: TownState, object: TownObject, now: number): TownState {
    const patches = Array.from({ length: 5 }, (_, index): TownPatch => {
        const kind = object.kind === 'bin' ? 'trash' : object.kind === 'hydrant'
            ? 'water'
            : object.kind === 'fish'
            ? 'fish'
            : index % 2 === 0
            ? 'poop'
            : 'pee';
        return {
            id: town.nextId + index,
            kind,
            born: now,
            expires: now + 14,
            x: object.x + Math.sin(index * 2.4) * (1.1 + index * 0.25),
            z: object.z - 1.2 + Math.cos(index * 2.4) * 1.5
        };
    });
    return { ...town, nextId: town.nextId + patches.length, patches: [...town.patches, ...patches] };
}
