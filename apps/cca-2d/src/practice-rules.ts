import {
    TOWN_ICE,
    type TownPoint,
    type TownPrank
} from './town/map.ts';
import { computeTownPosition } from './town/navigation.ts';
import { computeTownWaterPush, isTownSprayed } from './town/props.ts';
import type { TownRoutes } from './town/routes.ts';
import { computeTownTick } from './town/rules.ts';
import { createCleanCoat, type TownCoat } from './town/soiling.ts';
import { createTownState, type TownState } from './town/state.ts';

export interface PracticeInput {
    readonly x: number;
    readonly z: number;
    readonly dash: number;
}
export interface PracticeCloud {
    readonly id: number;
    readonly x: number;
    readonly z: number;
    readonly age: number;
}
export interface PracticeState extends TownCoat {
    readonly frozenUntil: number;
    readonly shieldUntil: number;
    readonly x: number;
    readonly z: number;
    readonly vx: number;
    readonly vz: number;
    readonly facingX: number;
    readonly facingZ: number;
    readonly elapsed: number;
    readonly cooldown: number;
    readonly dashTime: number;
    readonly consumedDash: number;
    readonly slipping: boolean;
    readonly slips: number;
    readonly pranks: number;
    readonly clouds: readonly PracticeCloud[];
    readonly town: TownState;
    readonly power: TownPrank;
    readonly dizzyUntil: number;
    readonly immuneUntil: number;
    readonly sickAt: number;
}
interface PracticeMovement extends TownPoint {
    readonly vx: number;
    readonly vz: number;
    readonly facingX: number;
    readonly facingZ: number;
    readonly dashTime: number;
    readonly slipping: boolean;
}

export function createPracticeState(): PracticeState {
    return {
        ...createCleanCoat(),
        x: 0,
        z: -2,
        frozenUntil: 0,
        shieldUntil: 0,
        vx: 0,
        vz: 0,
        facingX: 1,
        facingZ: 0,
        elapsed: 0,
        cooldown: 0,
        dashTime: 0,
        consumedDash: 0,
        slipping: false,
        slips: 0,
        pranks: 0,
        clouds: [],
        town: createTownState(),
        power: 'fart',
        dizzyUntil: 0,
        immuneUntil: 0,
        sickAt: -1
    };
}

export function computePracticeTick(
    state: PracticeState,
    input: PracticeInput,
    context: { seconds: number; routes: TownRoutes; }
): PracticeState {
    const step = Math.max(0, Math.min(context.seconds, 1 / 30));
    const dash = input.dash > state.consumedDash && state.cooldown <= 0 && state.frozenUntil <= state.elapsed;
    const movement = computePracticeMovement({ ...state, dashTime: dash ? 0.2 + step : state.dashTime }, input, step);
    const elapsed = state.elapsed + step;
    const interactions = computeTownTick({
        routes: context.routes,
        town: state.town,
        player: { ...state, ...movement },
        dash,
        now: elapsed,
        step
    });
    const clouds = state.clouds.filter((cloud) => cloud.age + step < 2.4).map((cloud) => ({
        ...cloud,
        age: cloud.age + step
    }));
    if (dash && state.power === 'fart') {
        clouds.push({ id: state.pranks + 1, x: state.x, z: state.z, age: 0 });
    }
    return {
        ...state,
        ...movement,
        ...interactions,
        elapsed,
        clouds,
        cooldown: dash ? 3 : Math.max(0, state.cooldown - step),
        consumedDash: Math.max(state.consumedDash, input.dash),
        slips: state.slips + Number(movement.slipping && !state.slipping),
        pranks: state.pranks + Number(dash)
    };
}

function computePracticeMovement(state: PracticeState, input: PracticeInput, step: number): PracticeMovement {
    if (state.frozenUntil > state.elapsed) {
        return {
            x: state.x,
            z: state.z,
            vx: 0,
            vz: 0,
            facingX: state.facingX,
            facingZ: state.facingZ,
            dashTime: 0,
            slipping: false
        };
    }
    const magnitude = Math.max(1, Math.hypot(input.x, input.z));
    const x = input.x / magnitude;
    const z = input.z / magnitude;
    const moving = Math.hypot(x, z) > 0.08;
    const facingX = moving ? x / Math.hypot(x, z) : state.facingX;
    const facingZ = moving ? z / Math.hypot(x, z) : state.facingZ;
    const dashTime = Math.max(0, state.dashTime - step);
    const slippery = isPracticeSlippery(state);
    const traction = 1 - Math.exp(-(slippery ? 1.2 : 22) * step);
    const speed = state.dizzyUntil > state.elapsed ? 2.5 : 3.6;
    const vx = dashTime > 0 ? facingX * 10 : state.vx + (x * speed - state.vx) * traction;
    const vz = dashTime > 0 ? facingZ * 10 : state.vz + (z * speed - state.vz) * traction;
    const jet = computeTownWaterPush(state.town, state, state.elapsed);
    const position = computeTownPosition(state.town, state, {
        x: (vx + (jet ? jet.x * 2 : 0)) * step,
        z: (vz + (jet ? jet.z * 2 : 0)) * step
    });
    return {
        ...position,
        vx: position.x === state.x ? 0 : vx,
        vz: position.z === state.z ? 0 : vz,
        facingX,
        facingZ,
        dashTime,
        slipping: slippery && Math.hypot(vx, vz) > 0.4
    };
}

function isPracticeSlippery(state: PracticeState): boolean {
    const onIce = Math.abs(state.x - TOWN_ICE.x) < TOWN_ICE.width / 2 &&
        Math.abs(state.z - TOWN_ICE.z) < TOWN_ICE.depth / 2;
    return onIce || isTownSprayed(state.town, state, state.elapsed) ||
        state.town.fruit.some((fruit) => Math.hypot(state.x - fruit.x, state.z - fruit.z) < 0.65) ||
        state.town.patches.some((patch) =>
            patch.kind !== 'powder' && patch.kind !== 'trash' && Math.hypot(state.x - patch.x, state.z - patch.z) < 1
        );
}
