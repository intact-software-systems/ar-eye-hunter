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
export interface PracticeState {
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
}
export interface PracticeObstacle {
    readonly x: number;
    readonly z: number;
    readonly width: number;
    readonly depth: number;
}
interface PracticePosition {
    readonly x: number;
    readonly z: number;
}
export const PRACTICE_OBSTACLES: readonly PracticeObstacle[] = [
    { x: -5, z: 3, width: 3, depth: 2.4 },
    { x: 5, z: 3, width: 3, depth: 2.4 },
    { x: -5.5, z: -5, width: 3, depth: 2.4 },
    { x: 5.5, z: -5.5, width: 3, depth: 2.4 },
    { x: 0, z: 9, width: 3.8, depth: 2.4 }
];
export const PRACTICE_ICE = { x: 0, z: 1.9, width: 4.6, depth: 4.2 };

export function createPracticeState(): PracticeState {
    return {
        x: 0,
        z: -2,
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
        clouds: []
    };
}

export function computePracticeTick(state: PracticeState, input: PracticeInput, seconds: number): PracticeState {
    const step = Math.max(0, Math.min(seconds, 1 / 30));
    const magnitude = Math.max(1, Math.hypot(input.x, input.z));
    const x = input.x / magnitude;
    const z = input.z / magnitude;
    const moving = Math.hypot(x, z) > 0.08;
    const facingX = moving ? x / Math.hypot(x, z) : state.facingX;
    const facingZ = moving ? z / Math.hypot(x, z) : state.facingZ;
    const dash = input.dash > state.consumedDash && state.cooldown <= 0;
    const dashTime = dash ? 0.2 : Math.max(0, state.dashTime - step);
    const onIce = Math.abs(state.x - PRACTICE_ICE.x) < PRACTICE_ICE.width / 2 &&
        Math.abs(state.z - PRACTICE_ICE.z) < PRACTICE_ICE.depth / 2;
    const traction = 1 - Math.exp(-(onIce ? 1.2 : 22) * step);
    const vx = dashTime > 0 ? facingX * 10 : state.vx + (x * 3.6 - state.vx) * traction;
    const vz = dashTime > 0 ? facingZ * 10 : state.vz + (z * 3.6 - state.vz) * traction;
    const position = computePracticePosition(state, vx * step, vz * step);
    const slipping = onIce && Math.hypot(vx, vz) > 0.4;
    const clouds = state.clouds.filter((cloud) => cloud.age < 2.4).map((cloud) => ({
        ...cloud,
        age: cloud.age + step
    }));
    if (dash) {
        clouds.push({ id: state.pranks + 1, x: state.x, z: state.z, age: 0 });
    }
    return {
        ...position,
        vx: position.x === state.x ? 0 : vx,
        vz: position.z === state.z ? 0 : vz,
        facingX,
        facingZ,
        elapsed: state.elapsed + step,
        cooldown: dash ? 3 : Math.max(0, state.cooldown - step),
        dashTime,
        consumedDash: Math.max(state.consumedDash, input.dash),
        slipping,
        slips: state.slips + Number(slipping && !state.slipping),
        pranks: state.pranks + Number(dash),
        clouds
    };
}

function computePracticePosition(state: PracticeState, dx: number, dz: number): PracticePosition {
    let x = Math.max(-11, Math.min(11, state.x + dx));
    let z = Math.max(-11, Math.min(11, state.z + dz));
    for (const obstacle of PRACTICE_OBSTACLES) {
        const halfWidth = obstacle.width / 2 + 0.38;
        const halfDepth = obstacle.depth / 2 + 0.38;
        if (Math.abs(x - obstacle.x) < halfWidth && Math.abs(state.z - obstacle.z) < halfDepth) {
            x = state.x;
        }
        if (Math.abs(x - obstacle.x) < halfWidth && Math.abs(z - obstacle.z) < halfDepth) {
            z = state.z;
        }
    }
    return { x, z };
}
