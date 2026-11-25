import {
    TOWN_ICE,
    type TownPoint
} from './town/map.ts';
import { computeTownPosition } from './town/navigation.ts';
import { computeTownWaterPush, isTownSprayed } from './town/props.ts';
import { computeTownTick } from './town/rules.ts';
import { createCleanCoat } from './town/soiling.ts';
import { createTownState, type TownPlayer, type TownState } from './town/state.ts';
import type { TownRoutes } from './town/town-routes.ts';

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
export interface PracticePlayer extends TownPlayer {
    readonly vx: number;
    readonly vz: number;
    readonly elapsed: number;
    readonly cooldown: number;
    readonly consumedDash: number;
    readonly slipping: boolean;
    readonly slips: number;
    readonly pranks: number;
    readonly clouds: readonly PracticeCloud[];
}
export interface PracticeState extends PracticePlayer {
    readonly town: TownState;
}
export interface PracticePlayerTickInput {
    readonly player: PracticePlayer;
    readonly town: TownState;
    readonly controls: PracticeInput;
    readonly seconds: number;
}
export interface PracticePlayerTick {
    readonly player: PracticePlayer;
    readonly dash: boolean;
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
    return { ...createPracticePlayer(), town: createTownState() };
}

export function createPracticePlayer(): PracticePlayer {
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
    const { town, ...player } = state;
    const step = Math.max(0, Math.min(context.seconds, 1 / 30));
    const advanced = computePracticePlayerTick({ player, town, controls: input, seconds: step });
    const interactions = computeTownTick({
        routes: context.routes,
        town,
        player: advanced.player,
        dash: advanced.dash,
        now: advanced.player.elapsed,
        step
    });
    return { ...advanced.player, ...interactions };
}

/** Player-local rules never advance the shared town; the world coordinator does that once. */
export function computePracticePlayerTick(
    tick: PracticePlayerTickInput
): PracticePlayerTick {
    const { player, town, controls, seconds } = tick;
    const step = Math.max(0, Math.min(seconds, 1 / 30));
    const dash = controls.dash > player.consumedDash && player.cooldown <= 0 && player.frozenUntil <= player.elapsed;
    const movement = computePracticeMovement({
        player: { ...player, dashTime: dash ? 0.2 + step : player.dashTime },
        town,
        controls,
        seconds: step
    });
    const clouds = player.clouds.filter((cloud) => cloud.age + step < 2.4).map((cloud) => ({
        ...cloud,
        age: cloud.age + step
    }));
    if (dash && player.power === 'fart') {
        clouds.push({ id: player.pranks + 1, x: player.x, z: player.z, age: 0 });
    }
    return {
        dash,
        player: {
            ...player,
            ...movement,
            elapsed: player.elapsed + step,
            clouds,
            cooldown: dash ? 3 : Math.max(0, player.cooldown - step),
            consumedDash: Math.max(player.consumedDash, controls.dash),
            slips: player.slips + Number(movement.slipping && !player.slipping),
            pranks: player.pranks + Number(dash)
        }
    };
}

function computePracticeMovement(tick: PracticePlayerTickInput): PracticeMovement {
    const { player, town, controls, seconds } = tick;
    if (player.frozenUntil > player.elapsed) {
        return {
            x: player.x,
            z: player.z,
            vx: 0,
            vz: 0,
            facingX: player.facingX,
            facingZ: player.facingZ,
            dashTime: 0,
            slipping: false
        };
    }
    const magnitude = Math.max(1, Math.hypot(controls.x, controls.z));
    const x = controls.x / magnitude;
    const z = controls.z / magnitude;
    const moving = Math.hypot(x, z) > 0.08;
    const facingX = moving ? x / Math.hypot(x, z) : player.facingX;
    const facingZ = moving ? z / Math.hypot(x, z) : player.facingZ;
    const dashTime = Math.max(0, player.dashTime - seconds);
    const slippery = isPracticeSlippery(player, town);
    const traction = 1 - Math.exp(-(slippery ? 1.2 : 22) * seconds);
    const speed = player.dizzyUntil > player.elapsed ? 2.5 : 3.6;
    const vx = dashTime > 0 ? facingX * 10 : player.vx + (x * speed - player.vx) * traction;
    const vz = dashTime > 0 ? facingZ * 10 : player.vz + (z * speed - player.vz) * traction;
    const jet = computeTownWaterPush(town, player, player.elapsed);
    const position = computeTownPosition(town, player, {
        x: (vx + (jet ? jet.x * 2 : 0)) * seconds,
        z: (vz + (jet ? jet.z * 2 : 0)) * seconds
    });
    return {
        ...position,
        vx: position.x === player.x ? 0 : vx,
        vz: position.z === player.z ? 0 : vz,
        facingX,
        facingZ,
        dashTime,
        slipping: slippery && Math.hypot(vx, vz) > 0.4
    };
}

function isPracticeSlippery(state: PracticePlayer, town: TownState): boolean {
    const onIce = Math.abs(state.x - TOWN_ICE.x) < TOWN_ICE.width / 2 &&
        Math.abs(state.z - TOWN_ICE.z) < TOWN_ICE.depth / 2;
    return onIce || isTownSprayed(town, state, state.elapsed) ||
        town.fruit.some((fruit) => Math.hypot(state.x - fruit.x, state.z - fruit.z) < 0.65) ||
        town.patches.some((patch) =>
            patch.kind !== 'powder' && patch.kind !== 'trash' && Math.hypot(state.x - patch.x, state.z - patch.z) < 1
        );
}
